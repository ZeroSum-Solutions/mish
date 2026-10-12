// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { Profiler, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DESIGN_SYSTEM_STATUS_WAIT_MS } from '../../src/components/FileWorkspace';
import { ProjectView } from '../../src/components/ProjectView';
import type {
  AgentInfo,
  AppConfig,
  ChatMessage,
  Conversation,
  DesignSystemSummary,
  Project,
  ProjectFile,
  SkillSummary,
} from '../../src/types';
import {
  createConversation,
  listConversations,
  listMessages,
  loadTabs,
} from '../../src/state/projects';
import {
  fetchPreviewComments,
  fetchProjectFiles,
  fetchProjectFileText,
} from '../../src/providers/registry';

// The Design system tab's generation affordances need a run really in flight
// in the ACTIVE conversation and a publish state KNOWN to be draft. These
// tests render the real FileWorkspace, so the signal ProjectView derives is
// checked together with the decision FileWorkspace makes from it.

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: () => undefined,
    t: (key: string) => key,
  }),
  useT: () => (key: string) => key,
}));

// Lets one test resolve the project's workspace scope to "unbound" so
// ProjectView may seed a conversation for a project that has none. Every
// other test uses the real hook.
const workspaceScopeOverride = vi.hoisted(() => ({ unbound: false }));
vi.mock('../../src/collab/useProjectWorkspaceScope', async () => {
  const actual = await vi.importActual<typeof import('../../src/collab/useProjectWorkspaceScope')>(
    '../../src/collab/useProjectWorkspaceScope',
  );
  return {
    ...actual,
    useProjectWorkspaceScope: (...args: Parameters<typeof actual.useProjectWorkspaceScope>) => {
      const state = actual.useProjectWorkspaceScope(...args);
      return workspaceScopeOverride.unbound
        ? { loading: false, scope: { kind: 'unbound' } as unknown as typeof state.scope }
        : state;
    },
  };
});

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
}));

vi.mock('../../src/providers/anthropic', () => ({
  streamMessage: vi.fn(),
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(),
  listActiveChatRuns: vi.fn().mockResolvedValue([]),
  listProjectRuns: vi.fn().mockResolvedValue([]),
  publishDaemonRunFinishedEvent: vi.fn(),
  reattachDaemonRun: vi.fn(),
  streamViaDaemon: vi.fn(),
}));

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    deletePreviewComment: vi.fn(),
    fetchDesignSystem: vi.fn(),
    fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
    fetchPreviewComments: vi.fn(),
    fetchProjectFiles: vi.fn().mockResolvedValue([]),
    fetchProjectFileText: vi.fn().mockResolvedValue(null),
    fetchProjectFolders: vi.fn().mockResolvedValue([]),
    fetchSkill: vi.fn(),
    getTemplate: vi.fn(),
    patchPreviewCommentStatus: vi.fn(),
    upsertPreviewComment: vi.fn(),
    writeProjectTextFile: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    cacheTabsLocally: vi.fn((_projectId: string, state: { tabs: string[]; active: string | null }) => state),
    createConversation: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    loadTabs: vi.fn(),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    persistTabsToDaemonNow: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});

vi.mock('../../src/components/AppChromeHeader', async () => ({
  ...(await vi.importActual<typeof import('../../src/components/AppChromeHeader')>(
    '../../src/components/AppChromeHeader',
  )),
  AppChromeHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
}));

vi.mock('../../src/components/AvatarMenu', () => ({
  AvatarMenu: () => null,
}));

vi.mock('../../src/components/DesignBrowserPanel', () => ({
  DesignBrowserPanel: () => <div data-testid="design-browser-panel" />,
  labelFromUrl: (url: string) => url,
}));

vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));

// ChatPane's `loading` is ProjectView's "the active conversation's transcript
// has not been loaded yet" — exposed so a test can see that window.
vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: ({ loading }: { loading?: boolean }) => (
    <div data-testid="chat-pane" data-transcript-loading={loading ? 'true' : 'false'} />
  ),
}));

const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedLoadTabs = vi.mocked(loadTabs);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);
const mockedFetchProjectFiles = vi.mocked(fetchProjectFiles);
const mockedFetchProjectFileText = vi.mocked(fetchProjectFileText);

const CREATING = 'ds.creatingProjectTitle';
const EXTRACTING = 'ds.extractionRunningTitle';
const EXTRACTION_COMPLETE = 'ds.extractionCompleteTitle';
const PREPARING = 'ds.workspacePreparing';

const config: AppConfig = {
  mode: 'api',
  apiKey: '',
  baseUrl: '',
  model: '',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

const DS_ID = 'user:atlas-moxie-tl02';
const project: Project = {
  id: 'ds-atlas-moxie-tl02',
  name: 'Moxie',
  skillId: null,
  designSystemId: DS_ID,
  createdAt: 1,
  updatedAt: 1,
  metadata: {
    kind: 'other',
    importedFrom: 'design-system',
    entryFile: 'DESIGN.md',
    sourceFileName: DS_ID,
  },
};

function conversation(id: string): Conversation {
  return { id, projectId: project.id, title: null, createdAt: 1, updatedAt: 1 };
}

function kit(status: 'draft' | 'published'): DesignSystemSummary {
  return {
    id: DS_ID,
    title: 'Moxie',
    category: 'Custom',
    summary: 'Kit.',
    swatches: [],
    surface: 'web',
    source: 'user',
    status,
    isEditable: true,
    projectId: project.id,
  };
}

function file(name: string): ProjectFile {
  const html = name.endsWith('.html');
  return {
    name,
    path: name,
    type: 'file',
    size: 1,
    mtime: 1,
    mime: html ? 'text/html' : 'text/plain',
    kind: html ? 'html' : 'text',
  };
}

const COMPLETED_KIT_FILES = [file('DESIGN.md'), file('system/kit.html'), file('system/variables.css')];
// A genuinely new kit: only its source context exists so far.
const SOURCE_ONLY_FILES = [file('context/source-context.md')];

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: 1,
    ...overrides,
  } as ChatMessage;
}

function initialDraftTranscript(): ChatMessage[] {
  return [
    message('user-1', { role: 'user', content: 'Create the design system' }),
    message('assistant-1', { runStatus: 'running', runId: 'run-initial' }),
  ];
}

interface ViewProps {
  designSystems: DesignSystemSummary[];
  routeConversationId?: string | null;
  /** App's "catalog read has not finished" flag. */
  designSystemsLoading?: boolean;
  onDesignSystemsRefresh?: () => Promise<void>;
}

/**
 * A design-system catalog whose read has not finished: App reports it as
 * loading, and the targeted refresh ProjectView issues for a missing entry
 * stays pending until `finish()`.
 */
function slowCatalog() {
  let finishRefresh: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  return {
    refresh: vi.fn(() => pending),
    finish: () => finishRefresh(),
  };
}

function view(props: ViewProps) {
  return (
    <ProjectView
      project={project}
      routeFileName={null}
      routeConversationId={props.routeConversationId ?? null}
      config={config}
      agents={[] as AgentInfo[]}
      skills={[] as SkillSummary[]}
      designTemplates={[] as SkillSummary[]}
      designSystems={props.designSystems}
      designSystemsLoading={props.designSystemsLoading ?? false}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onRefreshAgents={vi.fn()}
      onOpenSettings={vi.fn()}
      onBack={vi.fn()}
      onClearPendingPrompt={vi.fn()}
      onTouchProject={vi.fn()}
      onProjectChange={vi.fn()}
      onProjectsRefresh={vi.fn()}
      onDesignSystemsRefresh={props.onDesignSystemsRefresh}
    />
  );
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('ProjectView design-system generation signal', () => {
  beforeEach(() => {
    mockedListConversations.mockResolvedValue([conversation('conv-1')]);
    mockedCreateConversation.mockResolvedValue(conversation('conv-1'));
    mockedListMessages.mockResolvedValue([]);
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
    mockedFetchPreviewComments.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    workspaceScopeOverride.unbound = false;
  });

  // Startup of an installed, published kit while the design-system list is
  // still loading. Every commit is read, because the bug was a transient
  // placeholder that later gave way to the kit.
  async function expectNoGenerationUiDuringSlowListStartup(transcript: ChatMessage[]) {
    mockedFetchProjectFiles.mockResolvedValue(COMPLETED_KIT_FILES);
    mockedListMessages.mockResolvedValue(transcript);
    const commits: string[] = [];
    let container: HTMLElement | null = null;
    const recordCommit = () => {
      if (container) commits.push(container.textContent ?? '');
    };
    const catalog = slowCatalog();
    const tree = (designSystems: DesignSystemSummary[], loading: boolean) => (
      <Profiler id="startup" onRender={recordCommit}>
        {view({ designSystems, designSystemsLoading: loading, onDesignSystemsRefresh: catalog.refresh })}
      </Profiler>
    );
    const rendered = render(tree([], true));
    container = rendered.container;
    commits.push(container.textContent ?? '');

    await waitFor(() =>
      expect(container?.querySelector('[data-testid="design-system-project-tab"]')).toBeTruthy());
    await waitFor(() => expect(mockedListMessages).toHaveBeenCalled());
    await settle();
    // The registry finally answers: the kit is installed and published.
    rendered.rerender(tree([kit('published')], false));
    await act(async () => {
      catalog.finish();
    });
    await settle();

    expect(commits.length).toBeGreaterThan(1);
    for (const text of commits) {
      expect(text).not.toContain(CREATING);
      expect(text).not.toContain(EXTRACTING);
    }
    expect(
      container.querySelector('[data-testid="design-system-project-tab"]')?.getAttribute('aria-selected'),
    ).toBe('true');
    // The published kit view itself is on screen, not just free of
    // generation text.
    expect(container.querySelector('[data-testid="design-system-project-tab-panel"]')).toBeTruthy();
    expect(container.textContent).not.toContain(PREPARING);
    expect(
      container.querySelector('[data-testid="design-system-publish"]')?.getAttribute('aria-label'),
    ).toBe('ds.unpublishDesignSystem');
  }

  it('never shows generation UI while an installed kit starts up with a slow design-system list', async () => {
    await expectNoGenerationUiDuringSlowListStartup([]);
  });

  it('does not treat an unknown publish state as a draft being created, even with a run in flight', async () => {
    await expectNoGenerationUiDuringSlowListStartup([
      message('user-1', { role: 'user', content: 'Tighten the spacing scale' }),
      message('assistant-1', { runStatus: 'running', runId: 'run-revise' }),
    ]);
  });

  it('shows the creating placeholder while a real initial draft is generating', async () => {
    mockedFetchProjectFiles.mockResolvedValue(SOURCE_ONLY_FILES);
    mockedListMessages.mockResolvedValue(initialDraftTranscript());
    const { container } = render(view({ designSystems: [kit('draft')] }));

    await waitFor(() => expect(container.textContent).toContain(CREATING));
  });

  // A genuinely new draft whose run is in flight before the design-system list
  // answers: its (empty) kit reads can resolve first. The panel must hold a
  // neutral loading state rather than flash the finished kit view
  // ("Extraction complete") and then flip back to the creating placeholder.
  it("holds a neutral loading state, not the finished kit, until a new draft's status is known", async () => {
    mockedFetchProjectFiles.mockResolvedValue(SOURCE_ONLY_FILES);
    mockedListMessages.mockResolvedValue(initialDraftTranscript());
    const commits: string[] = [];
    let container: HTMLElement | null = null;
    const recordCommit = () => {
      if (container) commits.push(container.textContent ?? '');
    };
    const catalog = slowCatalog();
    const tree = (designSystems: DesignSystemSummary[], loading: boolean) => (
      <Profiler id="new-draft" onRender={recordCommit}>
        {view({ designSystems, designSystemsLoading: loading, onDesignSystemsRefresh: catalog.refresh })}
      </Profiler>
    );
    const rendered = render(tree([], true));
    container = rendered.container;
    commits.push(container.textContent ?? '');

    await waitFor(() => expect(mockedListMessages).toHaveBeenCalled());
    await waitFor(() => expect(mockedFetchProjectFileText).toHaveBeenCalled());
    // Let the empty kit reads resolve while the status is still unknown.
    await settle();
    expect(container.querySelector('[data-testid="design-system-project-tab"]')).toBeTruthy();
    expect(container.textContent).not.toContain(EXTRACTION_COMPLETE);
    expect(container.textContent).not.toContain(CREATING);

    rendered.rerender(tree([kit('draft')], false));
    await act(async () => {
      catalog.finish();
    });
    await waitFor(() => expect(container?.textContent).toContain(CREATING));
    await settle();

    const firstCreating = commits.findIndex((text) => text.includes(CREATING));
    expect(firstCreating).toBeGreaterThanOrEqual(0);
    for (const text of commits.slice(0, firstCreating)) {
      expect(text).not.toContain(EXTRACTION_COMPLETE);
    }
  });

  // "Preparing" waits for loads to FINISH, never for them to succeed. Each of
  // these leaves it and lands on the kit view — never the creating
  // placeholder for a kit whose status is not known to be a draft.
  async function expectKitViewAfterSettling(container: HTMLElement) {
    await waitFor(() => expect(container.textContent).not.toContain(PREPARING));
    await settle();
    expect(container.textContent).not.toContain(PREPARING);
    expect(container.textContent).not.toContain(CREATING);
    expect(container.textContent).not.toContain(EXTRACTING);
    expect(container.querySelector('[data-testid="design-system-project-tab-panel"]')).toBeTruthy();
  }

  it('leaves preparing when the transcript fetch fails and the catalog settles', async () => {
    mockedFetchProjectFiles.mockResolvedValue(COMPLETED_KIT_FILES);
    mockedListMessages.mockRejectedValue(new Error('transcript unavailable'));
    const catalog = slowCatalog();
    const { container, rerender } = render(
      view({ designSystems: [], designSystemsLoading: true, onDesignSystemsRefresh: catalog.refresh }),
    );

    await waitFor(() => expect(mockedListMessages).toHaveBeenCalled());
    rerender(view({ designSystems: [], designSystemsLoading: false, onDesignSystemsRefresh: catalog.refresh }));
    await act(async () => {
      catalog.finish();
    });
    await expectKitViewAfterSettling(container);
  });

  it('does not flash the finished kit when an empty conversation list precedes a new draft run', async () => {
    workspaceScopeOverride.unbound = true;
    mockedFetchProjectFiles.mockResolvedValue(SOURCE_ONLY_FILES);
    // The project has no conversations yet; ProjectView seeds one.
    mockedListConversations.mockResolvedValue([]);
    let finishCreate: (value: Conversation) => void = () => {};
    mockedCreateConversation.mockImplementation(
      () => new Promise<Conversation>((resolve) => {
        finishCreate = resolve;
      }),
    );
    mockedListMessages.mockResolvedValue(initialDraftTranscript());
    const catalog = slowCatalog();
    const commits: string[] = [];
    let container: HTMLElement | null = null;
    const recordCommit = () => {
      if (container) commits.push(container.textContent ?? '');
    };
    const tree = (designSystems: DesignSystemSummary[], loading: boolean) => (
      <Profiler id="empty-conversations" onRender={recordCommit}>
        {view({ designSystems, designSystemsLoading: loading, onDesignSystemsRefresh: catalog.refresh })}
      </Profiler>
    );
    const rendered = render(tree([], true));
    container = rendered.container;
    commits.push(container.textContent ?? '');

    await waitFor(() => expect(mockedListConversations).toHaveBeenCalled());
    await settle();
    expect(container.textContent).not.toContain(EXTRACTION_COMPLETE);

    // The seeded conversation lands and its run starts; then the draft entry
    // arrives from the catalog.
    await waitFor(() => expect(mockedCreateConversation).toHaveBeenCalled());
    await act(async () => {
      finishCreate(conversation('conv-1'));
    });
    await settle();
    rendered.rerender(tree([kit('draft')], false));
    await act(async () => {
      catalog.finish();
    });
    await waitFor(() => expect(container?.textContent).toContain(CREATING));

    const firstCreating = commits.findIndex((text) => text.includes(CREATING));
    for (const text of commits.slice(0, firstCreating)) {
      expect(text).not.toContain(EXTRACTION_COMPLETE);
    }
  });

  it('shows the kit view when the catalog read fails and the kit is absent, with a run in flight', async () => {
    mockedFetchProjectFiles.mockResolvedValue(SOURCE_ONLY_FILES);
    mockedListMessages.mockResolvedValue(initialDraftTranscript());
    // A failed catalog read lands as an empty list and the refresh rejects.
    const refresh = vi.fn(() => Promise.reject(new Error('catalog unavailable')));
    const { container } = render(
      view({ designSystems: [], designSystemsLoading: false, onDesignSystemsRefresh: refresh }),
    );

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(mockedListMessages).toHaveBeenCalled());
    await expectKitViewAfterSettling(container);
  });

  it('shows the kit view when the catalog loads without this kit, with a run in flight', async () => {
    mockedFetchProjectFiles.mockResolvedValue(SOURCE_ONLY_FILES);
    mockedListMessages.mockResolvedValue(initialDraftTranscript());
    const otherKit: DesignSystemSummary = { ...kit('draft'), id: 'user:someone-else', projectId: 'ds-other' };
    const refresh = vi.fn(() => Promise.resolve());
    const { container } = render(
      view({ designSystems: [otherKit], designSystemsLoading: false, onDesignSystemsRefresh: refresh }),
    );

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(mockedListMessages).toHaveBeenCalled());
    await expectKitViewAfterSettling(container);
  });

  it('falls back to the kit view when the status never settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockedFetchProjectFiles.mockResolvedValue(SOURCE_ONLY_FILES);
      mockedListMessages.mockResolvedValue(initialDraftTranscript());
      const catalog = slowCatalog();
      const { container } = render(
        view({ designSystems: [], designSystemsLoading: true, onDesignSystemsRefresh: catalog.refresh }),
      );

      await waitFor(() => expect(container.textContent).toContain(PREPARING));
      expect(container.textContent).not.toContain(CREATING);
      await act(async () => {
        vi.advanceTimersByTime(DESIGN_SYSTEM_STATUS_WAIT_MS);
      });
      await expectKitViewAfterSettling(container);
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches straight to the creating placeholder when a published kit turns draft during a run', async () => {
    mockedFetchProjectFiles.mockResolvedValue(SOURCE_ONLY_FILES);
    mockedListMessages.mockResolvedValue(initialDraftTranscript());
    let recording = false;
    const commits: string[] = [];
    let container: HTMLElement | null = null;
    const recordCommit = () => {
      if (recording && container) commits.push(container.textContent ?? '');
    };
    const tree = (designSystems: DesignSystemSummary[]) => (
      <Profiler id="published-to-draft" onRender={recordCommit}>
        {view({ designSystems })}
      </Profiler>
    );
    const rendered = render(tree([kit('published')]));
    container = rendered.container;
    await waitFor(() => expect(mockedListMessages).toHaveBeenCalled());
    await settle();
    expect(container.textContent).not.toContain(CREATING);

    recording = true;
    rendered.rerender(tree([kit('draft')]));
    await settle();
    expect(commits.length).toBeGreaterThan(0);
    // The very first commit after the registry change already reflects it.
    expect(commits[0]).toContain(CREATING);
    for (const text of commits) expect(text).not.toContain(EXTRACTION_COMPLETE);
  });

  it('clears the preparing safety-net timer on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      mockedFetchProjectFiles.mockResolvedValue(SOURCE_ONLY_FILES);
      mockedListMessages.mockResolvedValue(initialDraftTranscript());
      const catalog = slowCatalog();
      const { container, unmount } = render(
        view({ designSystems: [], designSystemsLoading: true, onDesignSystemsRefresh: catalog.refresh }),
      );
      await waitFor(() => expect(container.textContent).toContain(PREPARING));
      const safetyNetCall = setTimeoutSpy.mock.results.findIndex(
        (_result, index) => setTimeoutSpy.mock.calls[index]?.[1] === DESIGN_SYSTEM_STATUS_WAIT_MS,
      );
      expect(safetyNetCall).toBeGreaterThanOrEqual(0);
      const timerId = setTimeoutSpy.mock.results[safetyNetCall]?.value;

      unmount();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await act(async () => {
        vi.advanceTimersByTime(DESIGN_SYSTEM_STATUS_WAIT_MS * 2);
      });
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not show generation UI from the previous conversation while the new transcript loads', async () => {
    mockedFetchProjectFiles.mockResolvedValue(SOURCE_ONLY_FILES);
    mockedListConversations.mockResolvedValue([conversation('conv-1'), conversation('conv-2')]);
    mockedListMessages.mockImplementation(async (_projectId: string, conversationId: string) => {
      if (conversationId === 'conv-1') return initialDraftTranscript();
      // conv-2's transcript never arrives during this test.
      return new Promise<ChatMessage[]>(() => {});
    });
    // Read the DOM at every commit. The stale-transcript window (the active
    // conversation already switched, the old transcript not yet cleared) lasts
    // a single commit that the message-load effect replaces right away.
    let recording = false;
    const commits: Array<{ transcriptLoading: boolean; text: string }> = [];
    const recordCommit = () => {
      if (!recording) return;
      commits.push({
        transcriptLoading:
          container.querySelector('[data-testid="chat-pane"]')?.getAttribute('data-transcript-loading') === 'true',
        text: container.textContent ?? '',
      });
    };
    const tree = (routeConversationId: string) => (
      <Profiler id="switch" onRender={recordCommit}>
        {view({ designSystems: [kit('draft')], routeConversationId })}
      </Profiler>
    );
    const { container, rerender } = render(tree('conv-1'));
    await waitFor(() => expect(container.textContent).toContain(CREATING));

    recording = true;
    rerender(tree('conv-2'));
    await waitFor(() =>
      expect(mockedListMessages.mock.calls.some((call) => call[1] === 'conv-2')).toBe(true));
    await settle();

    const loadingCommits = commits.filter((commit) => commit.transcriptLoading);
    expect(loadingCommits.length).toBeGreaterThan(0);
    for (const commit of loadingCommits) {
      expect(commit.text).not.toContain(CREATING);
      expect(commit.text).not.toContain(EXTRACTING);
    }
    expect(container.textContent).not.toContain(CREATING);
  });
});
