// @vitest-environment jsdom
import { resetSessionModelApiFixture } from '../fixtures/session-model-api';
//
// A send from Home must identify its caller to the daemon.
//
// REPRODUCTION (upstream Beta 0.16.2-beta.147, macOS, team workspace): on
// Home, click the 「水面焦散」 example-prompt card — which seeds the composer with
// the 「WebGL 体验」 plugin chip, a 「水面焦散」 template chip and the plugin's
// description as the prompt — then press send. The send fails immediately with
//
//     daemon 401: {"error":{"code":"WORKSPACE_CONTEXT_REQUIRED","message":"workspace context is required"}}
//
// and `run_id: n/a`, because the refusal happens before the run is created.
//
// That string is produced in exactly one place in the repo — the `!createResp.ok`
// branch of the `POST /api/runs` create fetch in `providers/daemon.ts` — so the
// refused call is run creation, gated by `enforceWorkspaceResourceMutation
// ('project', …)` (apps/daemon/src/server.ts wires it via
// `createEnforceWorkspaceProjectMutation`).
//
// The cause is on this side of the wire. Home creates the project WITH the
// caller's workspace headers, so #6201 binds it to the team workspace; the
// follow-on auto-send then went out with NO headers, because it took its
// identity from the project's own workspace scope — an async read that is still
// in flight when the auto-send fires (its gate is `messagesInitialized` +
// `activeConversationId`, never the scope). Every OTHER project write in
// ProjectView (`patchProject`, `uploadProjectFiles`, the comment writes) already
// asserts the caller's own context; run creation was the one that did not.
//
// Nothing here is AMR-specific — the same null identity is passed on the
// CLI-agent and BYOK-OpenCode branches alike — but the report is an AMR run on a
// team workspace, and AMR is also where the second consequence shows up: the
// pre-run balance gate receives the same null and silently prices the run
// against the ACCOUNT wallet instead of the team's.

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type ModelPreflightResult,
  type PreviewComment,
  type WorkspaceCollabContext,
} from '@mish/contracts';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectView } from '../../src/components/ProjectView';
import type { ProjectWorkspaceScopeState } from '../../src/collab/useProjectWorkspaceScope';
import { resetWorkspaceContextCache } from '../../src/collab/useWorkspaceContext';
import { streamViaDaemon } from '../../src/providers/daemon';
import { useProjectFileEvents } from '../../src/providers/project-events';
import { postModelPreflight } from '../../src/providers/workbench';
import { checkAmrBalanceGate } from '../../src/runtime/amr-balance-gate';
import {
  createConversation,
  listConversations,
  listMessages,
  loadTabs,
  persistTabsToDaemonNow,
  ProjectConversationsHttpError,
  ProjectMessageListError,
} from '../../src/state/projects';
import {
  deletePreviewComment,
  fetchPreviewComments,
  fetchProjectFiles,
} from '../../src/providers/registry';
import { fetchBrands } from '../../src/runtime/brands';
import type {
  AgentInfo,
  AppConfig,
  ChatMessage,
  Conversation,
  DesignSystemSummary,
  Project,
  SkillSummary,
} from '../../src/types';

const PROJECT_ID = 'caustic-pool-project';
/** The team workspace from the report. */
const TEAM_WORKSPACE = 'nt3itfm1b95puq5w33tvzu44';
const TEAM_MEMBER = 'member-sender';
/** The 「水面焦散」 card's seeded prompt. */
const SEED_PROMPT =
  '自包含 WebGL2 主视觉：由域扭曲涟漪织成的动态水面焦散；点击水面掉涟漪。无网格、无贴图。';

const CALLER_CONTEXT: WorkspaceCollabContext = {
  workspaceId: TEAM_WORKSPACE,
  workspaceType: 'team',
  workspaceMemberId: TEAM_MEMBER,
  role: 'member',
  memberStatus: 'active',
  lifecycleState: 'active',
  billingState: 'active',
  planId: 'team_pro',
  providerMode: 'platform_credits',
  seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 2 }),
  permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
} as WorkspaceCollabContext;

const PERSONAL_CONTEXT: WorkspaceCollabContext = {
  ...CALLER_CONTEXT,
  workspaceId: 'personal-workspace',
  workspaceType: 'personal',
  workspaceMemberId: 'personal-member',
  planId: 'plus',
} as WorkspaceCollabContext;

const workspaceScopeMocks = vi.hoisted(() => ({
  projectScope: { loading: true, scope: null } as ProjectWorkspaceScopeState,
  ambientContext: null as WorkspaceCollabContext | null,
}));
const chatPaneSpy = vi.hoisted(() => vi.fn());
const fileWorkspaceSpy = vi.hoisted(() => vi.fn());
const resourceContextObservations = vi.hoisted(
  () => [] as Array<WorkspaceCollabContext | null>,
);
const projectCollabMocks = vi.hoisted(() => ({
  writerAuthority: 'allowed' as 'allowed' | 'denied' | 'pending',
  viewerOnly: false,
}));

beforeEach(() => { resetSessionModelApiFixture(); window.sessionStorage.clear(); });

const modelPickerSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/components/InlineModelSwitcher', () => ({ InlineModelSwitcher: (props: unknown) => { modelPickerSpy(props); return null; } }));
vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'zh-CN', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));

vi.mock('../../src/router', () => ({ navigate: vi.fn() }));

vi.mock('../../src/providers/anthropic', () => ({ streamMessage: vi.fn() }));

vi.mock('../../src/collab/useWorkspaceContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/collab/useWorkspaceContext')>()),
  useWorkspaceContext: () => ({
    context: workspaceScopeMocks.ambientContext,
    loading: false,
  }),
}));

vi.mock('../../src/collab/useProjectWorkspaceScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/collab/useProjectWorkspaceScope')>()),
  useProjectWorkspaceScope: () => workspaceScopeMocks.projectScope,
}));

vi.mock('../../src/collab/useProjectCollab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/collab/useProjectCollab')>()),
  useProjectCollab: () => ({
    enabled: true,
    member: null,
    present: [],
    publishedVersion: null,
    syncState: null,
    viewerOnly: projectCollabMocks.viewerOnly,
    writerAuthority: projectCollabMocks.writerAuthority,
    isOwner: projectCollabMocks.writerAuthority === 'allowed',
    ownerDisplayName: null,
    ownerRole: null,
    downloadPending: false,
    reportChange: () => undefined,
    requestPublish: () => undefined,
    refreshPresence: () => undefined,
    checkStatusNow: () => undefined,
  }),
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(),
  listActiveChatRuns: vi.fn().mockResolvedValue([]),
  listProjectRuns: vi.fn().mockResolvedValue([]),
  publishDaemonRunFinishedEvent: vi.fn(),
  reattachDaemonRun: vi.fn(),
  streamViaDaemon: vi.fn(),
}));

// The balance gate is not what is under test; it must simply allow the send so
// the run POST is reached. Its ARGUMENT is asserted below.
vi.mock('../../src/runtime/amr-balance-gate', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/amr-balance-gate')>(
    '../../src/runtime/amr-balance-gate',
  );
  return { ...actual, checkAmrBalanceGate: vi.fn().mockResolvedValue({ kind: 'allow' }) };
});

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
}));

vi.mock('../../src/runtime/brands', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/brands')>(
    '../../src/runtime/brands',
  );
  return { ...actual, fetchBrands: vi.fn().mockResolvedValue([]) };
});

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    deletePreviewComment: vi.fn(),
    fetchDesignSystem: vi.fn(),
    fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
    fetchPreviewComments: vi.fn().mockResolvedValue([]),
    fetchProjectFiles: vi.fn().mockResolvedValue([]),
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
    createConversation: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    persistTabsToDaemonNow: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});

vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/FileWorkspace', async () => {
  const { useProjectCollabContext } = await import('../../src/collab/collab-context');
  return {
    DESIGN_SYSTEM_TAB: '__design_system__',
    FileWorkspace: (props: {
      onTabsStateChange?: (state: { tabs: string[]; active: string | null }) => void;
    }) => {
      fileWorkspaceSpy(props);
      const { onTabsStateChange } = props;
      const { workspaceContext } = useProjectCollabContext();
      resourceContextObservations.push(workspaceContext);
      return (
        <div data-testid="file-workspace">
          <button
            type="button"
            data-testid="queue-tab-write"
            onClick={() => onTabsStateChange?.({
              tabs: ['index.html'],
              active: 'index.html',
            })}
          >
            queue tab write
          </button>
          <button
            type="button"
            data-testid="queue-alt-tab-write"
            onClick={() => onTabsStateChange?.({
              tabs: ['index.html', 'about.html'],
              active: 'about.html',
            })}
          >
            queue alternate tab write
          </button>
        </div>
      );
    },
  };
});
vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));
vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: (props: {
    composerFooterAccessory?: ReactNode;
    activeConversationId?: string | null;
    conversations?: Conversation[];
    loading?: boolean;
    messages?: ChatMessage[];
    messagesConversationId?: string | null;
    previewComments?: unknown[];
    onDeleteComment?: (commentId: string) => void;
    onSelectConversation?: (conversationId: string) => void;
    sendDisabled?: boolean;
    queuedItems?: Array<{ prompt: string }>;
    onSend?: (
      prompt: string,
      attachments: [],
      commentAttachments: [],
    ) => unknown;
  }) => {
    chatPaneSpy(props);
    return (
      <div>
        {props.composerFooterAccessory}
        <div data-testid="active-conversation">{props.activeConversationId ?? ''}</div>
        <div data-testid="transcript">{props.messages?.map((message) => message.content).join('\n')}</div>
        <button
          type="button"
          data-testid="normal-send"
          disabled={props.sendDisabled}
          onClick={() => props.onSend?.('normal prompt', [], [])}
        >
          send
        </button>
      </div>
    );
  },
}));

const mockedStreamViaDaemon = vi.mocked(streamViaDaemon);
const mockedCheckAmrBalanceGate = vi.mocked(checkAmrBalanceGate);
const mockedPostModelPreflight = vi.mocked(postModelPreflight);
const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedLoadTabs = vi.mocked(loadTabs);
const mockedPersistTabsToDaemonNow = vi.mocked(persistTabsToDaemonNow);
const mockedDeletePreviewComment = vi.mocked(deletePreviewComment);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);
const mockedFetchProjectFiles = vi.mocked(fetchProjectFiles);
const mockedFetchBrands = vi.mocked(fetchBrands);
const mockedUseProjectFileEvents = vi.mocked(useProjectFileEvents);

/** AMR on a daemon runtime — the reported configuration. */
const config: AppConfig = {
  mode: 'daemon',
  apiProtocol: 'openai',
  apiKey: '',
  baseUrl: '',
  model: 'deepseek-v4-flash',
  agentId: 'amr',
  skillId: null,
  designSystemId: null,
};

const conversation = (projectId: string): Conversation => ({
  id: `conv-${projectId}`,
  projectId,
  title: null,
  createdAt: 1,
  updatedAt: 1,
});

const previewComment = (id: string, note: string, updatedAt: number): PreviewComment => ({
  id,
  projectId: PROJECT_ID,
  conversationId: `conv-${PROJECT_ID}`,
  filePath: 'index.html',
  elementId: 'hero',
  selector: '#hero',
  label: 'Hero',
  text: 'Hero',
  position: { x: 0, y: 0, width: 100, height: 40 },
  htmlHint: '<section id="hero">Hero</section>',
  note,
  status: 'open',
  createdAt: 1,
  updatedAt,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

/**
 * The project Home just created from the example card: bound to the team
 * workspace, carrying the seeded prompt and the applied plugin.
 */
const project = (): Project => ({
  id: PROJECT_ID,
  name: 'Caustic Pool',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
  pendingPrompt: SEED_PROMPT,
  metadata: { kind: 'prototype', pluginId: 'example-web-prototype' },
  // The daemon's read model of the project's single `workspace_projects` row,
  // carried on the project record itself (`Project.workspaceId`). Home created
  // this project in the caller's workspace, so it names that workspace.
  workspaceId: TEAM_WORKSPACE,
} as Project);

/**
 * Answer the caller-identity read, and leave the PROJECT-scope read pending
 * forever. That is the window the auto-send fires in: `useProjectWorkspaceScope`
 * needs a round trip, while the auto-send gate only waits for the conversation
 * and message reads.
 */
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/workspace/context')) {
        return new Response(JSON.stringify({ context: CALLER_CONTEXT }), { status: 200 });
      }
      if (url.includes('/workspace-scope')) {
        // Never settles — the scope is unread at send time.
        return new Promise<Response>(() => {});
      }
      return new Response('{}', { status: 200 });
    }),
  );
}

function projectViewElement(overrides: Partial<ComponentProps<typeof ProjectView>> = {}) {
  return (
    <ProjectView
      project={project()}
      routeFileName={null}
      config={config}
      agents={[{
        id: 'amr',
        name: 'amr',
        available: true,
        models: [{
          id: 'deepseek-v4-flash',
          label: 'DeepSeek V4 Flash',
          default: true,
        }],
      }] as unknown as AgentInfo[]}
      skills={[] as SkillSummary[]}
      designTemplates={[] as SkillSummary[]}
      designSystems={[] as DesignSystemSummary[]}
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
      {...overrides}
    />
  );
}

function renderProjectView(overrides: Partial<ComponentProps<typeof ProjectView>> = {}) {
  return render(projectViewElement(overrides));
}

describe('a Home auto-send identifies its caller before the project scope resolves', () => {
  beforeEach(() => {
    resourceContextObservations.length = 0;
    window.sessionStorage.clear();
    window.localStorage.clear();
    resetWorkspaceContextCache();
    stubFetch();
    mockedListConversations.mockImplementation(async (projectId: string) => [
      conversation(projectId),
    ]);
    mockedCreateConversation.mockImplementation(async (projectId: string) =>
      conversation(projectId),
    );
    mockedListMessages.mockResolvedValue([]);
    mockedFetchPreviewComments.mockResolvedValue([]);
    mockedFetchProjectFiles.mockResolvedValue([]);
    mockedFetchBrands.mockResolvedValue([]);
    mockedStreamViaDaemon.mockResolvedValue(undefined);
    mockedCheckAmrBalanceGate.mockResolvedValue({ kind: 'allow' });
    workspaceScopeMocks.projectScope = { loading: true, scope: null };
    workspaceScopeMocks.ambientContext = CALLER_CONTEXT;
    projectCollabMocks.writerAuthority = 'allowed';
    projectCollabMocks.viewerOnly = false;
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
    // Home's hand-off: this flag is what makes ProjectView fire the seeded
    // prompt without a second click.
    window.sessionStorage.setItem(`od:auto-send-first:${PROJECT_ID}`, '1');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetWorkspaceContextCache();
  });

  // RED before the fix: `workspaceContext` is null, so `POST /api/runs` carries
  // no `x-od-workspace-*` and the daemon refuses the send with 401
  // WORKSPACE_CONTEXT_REQUIRED.
  it('passes the caller\'s workspace context to POST /api/runs', async () => {
    mockedCheckAmrBalanceGate.mockImplementation(async (scope) =>
      scope
        ? { kind: 'allow' }
        : {
            kind: 'hard',
            reason: 'insufficient',
            snapshot: {
              status: 'available',
              profile: 'prod',
              user: null,
              balanceUsd: '0',
              updatedAt: null,
              fetchedAt: new Date().toISOString(),
              stale: false,
              source: 'vela_api',
            },
          } as never,
    );
    renderProjectView();

    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalled());
    expect(mockedCheckAmrBalanceGate).toHaveBeenCalledWith({
      workspaceType: 'team',
      workspaceId: TEAM_WORKSPACE,
      workspaceMemberId: TEAM_MEMBER,
    }, 'deepseek-v4-flash');
    const options = mockedStreamViaDaemon.mock.calls[0]?.[0];
    expect(
      options?.workspaceContext,
      'a run POST with no workspace context is refused 401 WORKSPACE_CONTEXT_REQUIRED '
        + 'on a workspace-bound project',
    ).toEqual(CALLER_CONTEXT);
  });

  it('keeps fetch headers while using the project-authoritative raw URL for auto-open analysis', async () => {
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    mockedFetchProjectFiles.mockResolvedValue([
      { name: 'index.html', path: 'index.html', kind: 'html', size: 100, mtime: 2 },
      { name: 'src/app.jsx', path: 'src/app.jsx', kind: 'text', size: 100, mtime: 2 },
    ] as never);
    mockedStreamViaDaemon.mockImplementation(async (options) => {
      options.handlers.onAgentEvent({
        kind: 'tool_use',
        id: 'write-jsx',
        name: 'Write',
        input: { file_path: 'src/app.jsx', content: 'export default function App() {}' },
      });
      options.handlers.onAgentEvent({
        kind: 'tool_result',
        toolUseId: 'write-jsx',
        content: 'written',
        isError: false,
      });
      options.handlers.onDone('done');
    });

    renderProjectView();

    const fetchMock = vi.mocked(globalThis.fetch);
    await waitFor(() => {
      const rawCall = fetchMock.mock.calls.find(([input]) =>
        String(input).includes(`/api/projects/${PROJECT_ID}/raw/index.html`),
      );
      expect(rawCall).toBeDefined();
      expect(String(rawCall?.[0])).toBe(`/api/projects/${PROJECT_ID}/raw/index.html`);
      expect(rawCall?.[1]).toEqual(expect.objectContaining({
        headers: expect.objectContaining({
          'x-od-workspace-id': TEAM_WORKSPACE,
          'x-od-workspace-member-id': TEAM_MEMBER,
        }),
      }));
    });
  });

  it('hydrates the persisted transcript without waiting for preview comments', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    const comments = deferred<Awaited<ReturnType<typeof fetchPreviewComments>>>();
    const failedAssistant: ChatMessage = {
      id: 'failed-amr-assistant',
      role: 'assistant',
      content: '',
      createdAt: 1,
      runStatus: 'failed',
      agentId: 'amr',
      events: [{
        kind: 'status',
        label: 'error',
        detail: 'Sign in required.',
        code: 'AMR_AUTH_REQUIRED',
      }],
    };
    mockedListMessages.mockResolvedValue([failedAssistant]);
    mockedFetchPreviewComments.mockReturnValue(comments.promise);

    renderProjectView();

    await waitFor(() => {
      const latest = chatPaneSpy.mock.calls.at(-1)?.[0];
      expect(latest?.loading).toBe(false);
      expect(latest?.messagesConversationId).toBe(`conv-${PROJECT_ID}`);
      expect(latest?.messages).toEqual([failedAssistant]);
    });
    expect(mockedFetchPreviewComments).toHaveBeenCalledTimes(1);

    comments.resolve([]);
  });

  it('automatically reloads a transiently unavailable transcript without another user action', async () => {
    vi.useFakeTimers();
    const persisted: ChatMessage = {
      id: 'persisted-after-outage', role: 'assistant', content: 'Recovered conversation', createdAt: 1,
    };
    mockedListMessages.mockRejectedValueOnce(
      new ProjectMessageListError('Network unavailable', null, null, true),
    ).mockResolvedValue([persisted]);
    const view = renderProjectView({ project: { ...project(), pendingPrompt: '' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // A failed read must never become an empty, sendable conversation.
    expect(mockedListMessages).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('normal-send')).toBeDisabled();
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(mockedListMessages).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(mockedListMessages).toHaveBeenCalledTimes(2);
    expect(view.getByTestId('transcript').textContent).toBe('Recovered conversation');
    expect(view.getByTestId('normal-send')).not.toBeDisabled();
    expect(chatPaneSpy.mock.calls.at(-1)?.[0].loading).toBe(false);
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(mockedListMessages).toHaveBeenCalledTimes(2);
  });

  it('does not retry an authoritative transcript that loaded successfully', async () => {
    vi.useFakeTimers();
    const persisted: ChatMessage = {
      id: 'persisted-on-first-read', role: 'assistant', content: 'Existing conversation', createdAt: 1,
    };
    mockedListMessages.mockResolvedValue([persisted]);
    const view = renderProjectView({ project: { ...project(), pendingPrompt: '' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(view.getByTestId('transcript').textContent).toBe('Existing conversation');
    expect(view.getByTestId('normal-send')).not.toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(mockedListMessages).toHaveBeenCalledTimes(1);
  });

  it('stops automatically reloading after three transient transcript retries', async () => {
    vi.useFakeTimers();
    mockedListMessages.mockRejectedValue(
      new ProjectMessageListError('Network unavailable', null, null, true),
    );
    const view = renderProjectView({ project: { ...project(), pendingPrompt: '' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    for (const [delay, count] of [[500, 2], [1_000, 3], [2_000, 4]] as const) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
      expect(mockedListMessages).toHaveBeenCalledTimes(count);
    }
    expect(view.getByTestId('normal-send')).toBeDisabled();
    expect(chatPaneSpy.mock.calls.at(-1)?.[0].loading).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mockedListMessages).toHaveBeenCalledTimes(4);
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])('does not automatically repeat an HTTP %i transcript refusal', async (status) => {
    vi.useFakeTimers();
    // Even a server's generic retryable bit cannot make unchanged credentials
    // or a missing conversation recover by replaying the same GET.
    mockedListMessages.mockRejectedValue(
      new ProjectMessageListError('Transcript refused', status, 'WORKSPACE_CONTEXT_REQUIRED', true),
    );
    const view = renderProjectView({ project: { ...project(), pendingPrompt: '' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(view.getByTestId('normal-send')).toBeDisabled();
    expect(chatPaneSpy.mock.calls.at(-1)?.[0].loading).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mockedListMessages).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending automatic transcript retry when the project unmounts', async () => {
    vi.useFakeTimers();
    mockedListMessages.mockRejectedValue(
      new ProjectMessageListError('Network unavailable', null, null, true),
    );
    const view = renderProjectView({ project: { ...project(), pendingPrompt: '' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockedListMessages).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mockedListMessages).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('settles a hung transcript read within the original budget (retry: %s)', async (retry) => {
    vi.useFakeTimers();
    mockedListMessages.mockReturnValue(new Promise(() => {}));
    if (retry) {
      mockedListMessages.mockRejectedValueOnce(
        new ProjectMessageListError('Network unavailable', null, null, true),
      );
    }
    const view = renderProjectView({ project: { ...project(), pendingPrompt: '' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(chatPaneSpy.mock.calls.at(-1)?.[0].loading).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(chatPaneSpy.mock.calls.at(-1)?.[0].loading).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(chatPaneSpy.mock.calls.at(-1)?.[0].loading).toBe(false);
    expect(view.getByTestId('normal-send')).toBeDisabled();
    expect(mockedListMessages).toHaveBeenCalledTimes(retry ? 2 : 1);
    expect(mockedListMessages.mock.calls.at(-1)?.[3]?.aborted).toBe(true);
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
  });

  it('starts the pending Home send only once after automatic transcript recovery', async () => {
    vi.useFakeTimers();
    mockedListMessages.mockRejectedValueOnce(
      new ProjectMessageListError('Network unavailable', null, null, true),
    ).mockResolvedValue([]);
    renderProjectView();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockedListMessages).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
  });

  it.each(['retry-delay', 'request'] as const)(
    'cancels a transcript %s on a conversation switch and ignores the old result',
    async (phase) => {
      vi.useFakeTimers();
      const oldRead = deferred<ChatMessage[]>();
      mockedListConversations.mockResolvedValue([
        conversation(PROJECT_ID),
        { ...conversation(PROJECT_ID), id: 'conv-second' },
      ]);
      mockedListMessages.mockImplementation(async (_projectId, conversationId) => {
        if (conversationId === 'conv-second') {
          return [{ id: 'second-message', role: 'assistant', content: 'Second conversation', createdAt: 2 }];
        }
        if (phase === 'retry-delay') {
          throw new ProjectMessageListError('Network unavailable', null, null, true);
        }
        return oldRead.promise;
      });
      const view = renderProjectView({ project: { ...project(), pendingPrompt: '' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const oldSignal = mockedListMessages.mock.calls[0]?.[3];
      expect(oldSignal?.aborted).toBe(false);

      await act(async () => {
        chatPaneSpy.mock.calls.at(-1)?.[0].onSelectConversation?.('conv-second');
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(oldSignal?.aborted).toBe(true);
      expect(view.getByTestId('transcript').textContent).toBe('Second conversation');
      await act(async () => {
        oldRead.resolve([{ id: 'stale', role: 'assistant', content: 'Stale result', createdAt: 1 }]);
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(view.getByTestId('transcript').textContent).toBe('Second conversation');
      expect(mockedListMessages).toHaveBeenCalledTimes(2);
    },
  );

  it('retains the same readable principal transcript during refresh and clears it if reload fails', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    const persistedMessage: ChatMessage = {
      id: 'persisted-assistant',
      role: 'assistant',
      content: 'Persisted answer',
      createdAt: 1,
    };
    mockedListMessages.mockResolvedValueOnce([persistedMessage]);
    const view = renderProjectView({
      project: { ...project(), pendingPrompt: '' },
    });

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([persistedMessage]);
    });

    const reload = deferred<ChatMessage[]>();
    mockedListMessages.mockReturnValueOnce(reload.promise);
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: {
          ...CALLER_CONTEXT,
          role: 'admin',
          permissions: buildWorkspacePermissions({
            role: 'admin',
            lifecycleState: 'active',
          }),
        } as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    view.rerender(projectViewElement({
      project: { ...project(), pendingPrompt: '' },
    }));

    await waitFor(() => expect(mockedListMessages).toHaveBeenCalledTimes(2));
    try {
      // Scope confirms the same active workspace member with a different role.
      // Keep their history visible, but wait for the fresh read before sending.
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([persistedMessage]);
      expect(view.getByTestId('normal-send')).toBeDisabled();
      fireEvent.click(view.getByTestId('normal-send'));
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        reload.reject(new Error('workspace directory unavailable'));
        await reload.promise.catch(() => undefined);
      });
    }

    expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([]);
    expect(chatPaneSpy.mock.calls.at(-1)?.[0].messagesConversationId).toBeNull();
    expect(view.getByTestId('normal-send')).toBeDisabled();
    fireEvent.click(view.getByTestId('normal-send'));
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
  });

  it('keeps a cold Home run attached when an empty authority refresh settles after stream events', async () => {
    const activeStream = deferred<void>();
    let runOptions: Parameters<typeof streamViaDaemon>[0] | undefined;
    mockedStreamViaDaemon.mockImplementation((options) => {
      runOptions = options;
      return activeStream.promise;
    });

    const view = renderProjectView();

    await waitFor(() => expect(runOptions).toBeDefined());
    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([
        expect.objectContaining({ role: 'user', content: SEED_PROMPT }),
        expect.objectContaining({ role: 'assistant', runStatus: 'running' }),
      ]);
    });

    const authorityReload = deferred<ChatMessage[]>();
    mockedListMessages.mockReturnValueOnce(authorityReload.promise);
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: {
          ...CALLER_CONTEXT,
          role: 'admin',
          permissions: buildWorkspacePermissions({
            role: 'admin',
            lifecycleState: 'active',
          }),
        } as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    await act(async () => {
      view.rerender(projectViewElement());
    });

    await waitFor(() => expect(mockedListMessages).toHaveBeenCalledTimes(2));
    const expectedOutput = 'The first packaged run is still live.';
    await act(async () => {
      runOptions?.onRunCreated?.('run-first-home');
      runOptions?.onRunStatus?.('running');
      runOptions?.handlers.onAgentEvent({ kind: 'text', text: expectedOutput });
      runOptions?.handlers.onAgentEvent({
        kind: 'tool_use',
        id: 'write-index',
        name: 'Write',
        input: { file_path: 'index.html', content: '<main>ready</main>' },
      });
    });

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([
        expect.objectContaining({ role: 'user', content: SEED_PROMPT }),
        expect.objectContaining({
          role: 'assistant',
          runId: 'run-first-home',
          events: expect.arrayContaining([
            expect.objectContaining({ kind: 'text', text: expectedOutput }),
          ]),
        }),
      ]);
    });

    await act(async () => {
      authorityReload.resolve([]);
      await authorityReload.promise;
    });

    expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([
      expect.objectContaining({ role: 'user', content: SEED_PROMPT }),
      expect.objectContaining({
        role: 'assistant',
        runId: 'run-first-home',
        events: expect.arrayContaining([
          expect.objectContaining({ kind: 'text', text: expectedOutput }),
        ]),
      }),
    ]);

    activeStream.resolve();
  });

  it('keeps a terminal cold Home run attached when the empty refresh outlives its controller', async () => {
    const activeStream = deferred<void>();
    let runOptions: Parameters<typeof streamViaDaemon>[0] | undefined;
    mockedStreamViaDaemon.mockImplementation((options) => {
      runOptions = options;
      return activeStream.promise;
    });

    const view = renderProjectView();
    await waitFor(() => expect(runOptions).toBeDefined());

    const authorityReload = deferred<ChatMessage[]>();
    mockedListMessages.mockReturnValueOnce(authorityReload.promise);
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: {
          ...CALLER_CONTEXT,
          role: 'admin',
          permissions: buildWorkspacePermissions({
            role: 'admin',
            lifecycleState: 'active',
          }),
        } as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    await act(async () => {
      view.rerender(projectViewElement());
    });
    await waitFor(() => expect(mockedListMessages).toHaveBeenCalledTimes(2));

    const expectedOutput = 'The terminal first run stays visible.';
    await act(async () => {
      runOptions?.onRunCreated?.('run-terminal-home');
      runOptions?.onRunStatus?.('running');
      runOptions?.handlers.onAgentEvent({ kind: 'text', text: expectedOutput });
      runOptions?.handlers.onAgentEvent({
        kind: 'tool_use',
        id: 'write-terminal-index',
        name: 'Write',
        input: { file_path: 'index.html', content: '<main>complete</main>' },
      });
      runOptions?.onRunStatus?.('succeeded');
    });

    await act(async () => {
      authorityReload.resolve([]);
      await authorityReload.promise;
      runOptions?.handlers.onDone('');
    });

    expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([
      expect.objectContaining({ role: 'user', content: SEED_PROMPT }),
      expect.objectContaining({
        role: 'assistant',
        runId: 'run-terminal-home',
        endedAt: expect.any(Number),
        events: expect.arrayContaining([
          expect.objectContaining({ kind: 'text', text: expectedOutput }),
        ]),
      }),
    ]);

    activeStream.resolve();
  });

  it('does not restore a cold Home run after project authority is revoked', async () => {
    const activeStream = deferred<void>();
    let runOptions: Parameters<typeof streamViaDaemon>[0] | undefined;
    mockedStreamViaDaemon.mockImplementation((options) => {
      runOptions = options;
      return activeStream.promise;
    });

    const view = renderProjectView();
    await waitFor(() => expect(runOptions).toBeDefined());

    workspaceScopeMocks.ambientContext = null;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: null,
      failure: 'forbidden',
    };
    await act(async () => {
      view.rerender(projectViewElement());
    });

    await waitFor(() => expect(mockedListMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([]);
    });

    await act(async () => {
      runOptions?.onRunCreated?.('run-revoked-home');
      runOptions?.handlers.onAgentEvent({
        kind: 'text',
        text: 'This output belongs to the revoked authority.',
      });
      runOptions?.handlers.onAgentEvent({
        kind: 'tool_use',
        id: 'revoked-write',
        name: 'Write',
        input: { file_path: 'index.html', content: '<main>private</main>' },
      });
    });

    expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([]);
    activeStream.resolve();
  });

  it('reuses one Home handoff identity across ProjectView remounts', async () => {
    const firstView = renderProjectView();
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
    const firstRun = mockedStreamViaDaemon.mock.calls[0]?.[0];
    firstView.unmount();

    window.sessionStorage.setItem(`od:auto-send-first:${PROJECT_ID}`, '1');
    renderProjectView();
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(2));
    const replayedRun = mockedStreamViaDaemon.mock.calls[1]?.[0];

    expect({
      clientRequestId: replayedRun?.clientRequestId,
      userMessageId: replayedRun?.userMessageId,
      assistantMessageId: replayedRun?.assistantMessageId,
    }).toEqual({
      clientRequestId: firstRun?.clientRequestId,
      userMessageId: firstRun?.userMessageId,
      assistantMessageId: firstRun?.assistantMessageId,
    });
    expect(firstRun?.clientRequestId).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(firstRun?.userMessageId).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(firstRun?.assistantMessageId).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('keeps Home handoff identities within the daemon limit for a maximum-length project id', async () => {
    const maximumLengthProjectId = 'p'.repeat(128);
    window.sessionStorage.setItem(`od:auto-send-first:${maximumLengthProjectId}`, '1');

    renderProjectView({
      project: {
        ...project(),
        id: maximumLengthProjectId,
      },
    });

    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
    const run = mockedStreamViaDaemon.mock.calls[0]?.[0];
    const ids = [run?.clientRequestId, run?.userMessageId, run?.assistantMessageId];

    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(id?.length).toBeLessThanOrEqual(128);
    }
  });

  it('does not let the initial comments read replace a newer SSE refresh', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    const initialComments = deferred<Awaited<ReturnType<typeof fetchPreviewComments>>>();
    const staleComment = previewComment('comment-stale', 'stale initial read', 1);
    const freshComment = previewComment('comment-fresh', 'fresh SSE read', 2);
    mockedFetchPreviewComments
      .mockReturnValueOnce(initialComments.promise)
      .mockResolvedValueOnce([freshComment]);

    renderProjectView();

    await waitFor(() => {
      expect(mockedUseProjectFileEvents).toHaveBeenCalled();
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].loading).toBe(false);
    });
    const handleProjectEvent = mockedUseProjectFileEvents.mock.calls.at(-1)?.[2];
    await act(async () => {
      handleProjectEvent?.({ type: 'comment-changed', projectId: PROJECT_ID });
    });

    await waitFor(() => {
      expect(mockedFetchPreviewComments).toHaveBeenCalledTimes(2);
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].previewComments).toEqual([freshComment]);
    });

    await act(async () => {
      initialComments.resolve([staleComment]);
      await initialComments.promise;
    });
    expect(chatPaneSpy.mock.calls.at(-1)?.[0].previewComments).toEqual([freshComment]);
  });

  it('does not let the initial comments read resurrect a locally deleted comment', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    const initialComments = deferred<Awaited<ReturnType<typeof fetchPreviewComments>>>();
    const deletedComment = previewComment('comment-deleted', 'deleted locally', 1);
    mockedFetchPreviewComments.mockReturnValue(initialComments.promise);
    mockedDeletePreviewComment.mockResolvedValue(true);

    renderProjectView();

    const onDeleteComment = await waitFor(() => {
      const latest = chatPaneSpy.mock.calls.at(-1)?.[0];
      expect(latest?.loading).toBe(false);
      expect(latest?.onDeleteComment).toEqual(expect.any(Function));
      return latest?.onDeleteComment;
    });
    await act(async () => {
      onDeleteComment?.(deletedComment.id);
      await Promise.resolve();
    });
    expect(mockedDeletePreviewComment).toHaveBeenCalledWith(
      PROJECT_ID,
      `conv-${PROJECT_ID}`,
      deletedComment.id,
      CALLER_CONTEXT,
    );

    await act(async () => {
      initialComments.resolve([deletedComment]);
      await initialComments.promise;
    });
    expect(chatPaneSpy.mock.calls.at(-1)?.[0].previewComments).toEqual([]);
  });

  it('reuses the matching Home Team preflight while the project scope read is pending', async () => {
    window.sessionStorage.setItem(
      `od:auto-send-amr-gate-witness:${PROJECT_ID}`,
      JSON.stringify({
        workspaceType: 'team',
        workspaceId: TEAM_WORKSPACE,
        workspaceMemberId: TEAM_MEMBER,
      }),
    );

    renderProjectView();

    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalled());
    expect(mockedCheckAmrBalanceGate).not.toHaveBeenCalled();
    expect(mockedStreamViaDaemon.mock.calls[0]?.[0].workspaceContext).toEqual(
      CALLER_CONTEXT,
    );
  });

  it('keeps Team billing scope when its scope read is temporarily unavailable', async () => {
    workspaceScopeMocks.projectScope = {
      loading: false,
      failure: 'unavailable',
      scope: {
        kind: 'unavailable',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'personal',
        context: null,
      },
    };

    renderProjectView();

    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalled());
    expect(mockedCheckAmrBalanceGate).toHaveBeenCalledWith({
      workspaceType: 'team',
      workspaceId: TEAM_WORKSPACE,
      workspaceMemberId: TEAM_MEMBER,
    }, 'deepseek-v4-flash');
    expect(mockedStreamViaDaemon.mock.calls[0]?.[0].workspaceContext).toEqual(
      CALLER_CONTEXT,
    );
  });

  it('consumes the Home handoff after an unavailable AMR gate durably queues it and starts it once after recovery', async () => {
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'personal',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    mockedCheckAmrBalanceGate.mockResolvedValue({ kind: 'unavailable' });

    const stableOverrides: Partial<ComponentProps<typeof ProjectView>> = {
      project: project(),
      agents: [{
        id: 'amr',
        name: 'amr',
        available: true,
        models: [{
          id: 'deepseek-v4-flash',
          label: 'DeepSeek V4 Flash',
          default: true,
        }],
      }] as unknown as AgentInfo[],
      skills: [] as SkillSummary[],
      designTemplates: [] as SkillSummary[],
      designSystems: [] as DesignSystemSummary[],
      onModeChange: vi.fn(),
      onAgentChange: vi.fn(),
      onAgentModelChange: vi.fn(),
      onRefreshAgents: vi.fn(),
      onOpenSettings: vi.fn(),
      onBack: vi.fn(),
      onClearPendingPrompt: vi.fn(),
      onTouchProject: vi.fn(),
      onProjectChange: vi.fn(),
      onProjectsRefresh: vi.fn(),
    };
    const view = renderProjectView(stableOverrides);

    await waitFor(() => {
      const latest = chatPaneSpy.mock.calls.at(-1)?.[0];
      expect(latest?.queuedItems).toHaveLength(1);
    });
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    // Queue persistence is not run admission; preserve the Home receipt.
    expect(window.sessionStorage.getItem(`od:auto-send-first:${PROJECT_ID}`)).toBe('1');

    mockedCheckAmrBalanceGate.mockResolvedValue({ kind: 'allow' });
    mockedStreamViaDaemon.mockImplementation(async options => { options.onRunCreated?.('run-home-recovered'); });
    // Change the conversation picker explicitly; Settings defaults do not replace pins.
    await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('codex'); });
    // Deterministic rather than timing-flaky: wait for the select-time picker
    // preflight to settle (the "checking" banner to clear) before asserting
    // on the drain it gates, instead of racing the queue-drain effect against
    // whichever of the two microtask chains (preflight settle vs. the
    // `waitFor` poll below) happens to run first.
    await waitFor(() => expect(view.queryByTestId('session-model-preflight-checking')).toBeNull());
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const latest = chatPaneSpy.mock.calls.at(-1)?.[0];
      expect(latest?.queuedItems).toHaveLength(0);
    });
    expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(`od:auto-send-first:${PROJECT_ID}`)).toBeNull();
    expect(mockedStreamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'codex', expectedModelRevision: 2 });
  });

  // AC-R02.3 queued-send invariant: a queued send is never dropped, never sent
  // twice, and never sent on a choice other than the one current when it
  // dispatches. These tests hold the send-time preflight of queued send A and
  // the select-time picker check of a NEW choice on manual deferreds, so each
  // interleaving is driven explicitly instead of by microtask timing.
  describe('a queued send racing a picker check', () => {
    type PreflightInput = { agentId: string; modelId: string; attachments?: unknown[] };
    const passing = (input: PreflightInput): ModelPreflightResult =>
      ({ agentId: input.agentId, modelId: input.modelId, ok: true, mismatches: [] });
    // `vi.clearAllMocks` keeps implementations; restore the file-wide default.
    afterEach(() => { mockedPostModelPreflight.mockImplementation(async (_s, _p, input) => passing(input)); });

    /**
     * Queues the Home handoff behind an unavailable AMR gate, then switches
     * the picker to codex, which lifts the AMR pause and starts draining the
     * item as send A. Returns once A is parked inside its send-time preflight
     * (a call that carries `attachments`; picker checks do not).
     */
    async function queueSendAWaitingInItsPreflight() {
      workspaceScopeMocks.projectScope = {
        loading: false,
        scope: {
          kind: 'team',
          projectId: PROJECT_ID,
          workspaceId: TEAM_WORKSPACE,
          visibility: 'personal',
          context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
        },
      };
      mockedCheckAmrBalanceGate.mockResolvedValue({ kind: 'unavailable' });
      const view = renderProjectView();
      await waitFor(() => expect(chatPaneSpy.mock.calls.at(-1)?.[0]?.queuedItems).toHaveLength(1));
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();

      mockedCheckAmrBalanceGate.mockResolvedValue({ kind: 'allow' });
      mockedStreamViaDaemon.mockImplementation(async options => { options.onRunCreated?.('run-after-picker-race'); });
      const sendTimeA = deferred<ModelPreflightResult>();
      const pickerChecks: Array<{ input: PreflightInput; result: ReturnType<typeof deferred<ModelPreflightResult>> }> = [];
      const sendTimeInputs: PreflightInput[] = [];
      mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, input: PreflightInput) => {
        if ('attachments' in input) {
          sendTimeInputs.push(input);
          // Only A's first send-time check is held; any re-drain passes.
          return sendTimeInputs.length === 1 ? sendTimeA.promise : passing(input);
        }
        // The codex selection that unpauses the queue passes at once; every
        // later picker check is held until the test settles it.
        if (input.agentId === 'codex') return passing(input);
        const result = deferred<ModelPreflightResult>();
        pickerChecks.push({ input, result });
        return result.promise;
      });

      await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('codex'); });
      await waitFor(() => expect(sendTimeInputs).toHaveLength(1));
      expect(sendTimeInputs[0]?.agentId).toBe('codex');
      return { view, sendTimeA, pickerChecks, sendTimeInputs };
    }

    /** Lets every resolved mock and scheduled re-render run to completion. */
    async function settle() {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    }

    // A finds the check pending after its preflight and waits inside
    // `handleSend` for it to settle, then starts over on the settled choice.
    it('holds a queued send while the picker preflight is checking and starts it exactly once after it settles', async () => {
      const { view, sendTimeA, pickerChecks, sendTimeInputs } = await queueSendAWaitingInItsPreflight();

      await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('claude'); });
      await waitFor(() => expect(view.queryByTestId('session-model-preflight-checking')).not.toBeNull());
      expect(pickerChecks).toHaveLength(1);

      // A's preflight for codex passes while the claude check is pending: A
      // must not go out on codex.
      await act(async () => { sendTimeA.resolve(passing(sendTimeInputs[0]!)); });
      await settle();
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
      expect(sendTimeInputs).toHaveLength(1);
      expect(chatPaneSpy.mock.calls.at(-1)?.[0]?.queuedItems).toHaveLength(1);

      await act(async () => { pickerChecks[0]!.result.resolve(passing(pickerChecks[0]!.input)); });
      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
      await settle();
      expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
      expect(mockedStreamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'claude' });
      expect(sendTimeInputs.map(input => input.agentId)).toEqual(['codex', 'claude']);
      expect(chatPaneSpy.mock.calls.at(-1)?.[0]?.queuedItems).toHaveLength(0);
    });

    it('re-drains a queued send whose preflight outlived a picker check that changed the choice', async () => {
      const { view, sendTimeA, pickerChecks, sendTimeInputs } = await queueSendAWaitingInItsPreflight();

      await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('claude'); });
      await waitFor(() => expect(pickerChecks).toHaveLength(1));
      // The claude check settles while A still waits on its codex preflight.
      await act(async () => { pickerChecks[0]!.result.resolve(passing(pickerChecks[0]!.input)); });
      await waitFor(() => expect(view.queryByTestId('session-model-preflight-checking')).toBeNull());
      await settle();
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();

      // A's codex result is now stale. A must not be dropped: the queue
      // re-drains it once, on claude. The re-drain must come from A's own
      // refusal, inside this act, not from whatever unrelated render happens
      // to follow later; so assert it before any further wait.
      await act(async () => { sendTimeA.resolve(passing(sendTimeInputs[0]!)); });
      expect(sendTimeInputs.map(input => input.agentId)).toEqual(['codex', 'claude']);
      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
      await settle();
      expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
      expect(mockedStreamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'claude' });
      expect(chatPaneSpy.mock.calls.at(-1)?.[0]?.queuedItems).toHaveLength(0);
    });

    // UX contract (use-session-model.ts `runPickerPreflight`): a failed picker
    // check leaves the previously saved choice selected and only reports the
    // mismatch. So the held send goes out once, on that unchanged choice.
    it('sends a held queued send once on the unchanged choice when the picker check fails', async () => {
      const { view, sendTimeA, pickerChecks, sendTimeInputs } = await queueSendAWaitingInItsPreflight();

      await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('claude'); });
      await waitFor(() => expect(view.queryByTestId('session-model-preflight-checking')).not.toBeNull());
      await act(async () => { sendTimeA.resolve(passing(sendTimeInputs[0]!)); });
      await settle();
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();

      await act(async () => {
        pickerChecks[0]!.result.resolve({
          agentId: pickerChecks[0]!.input.agentId,
          modelId: pickerChecks[0]!.input.modelId,
          ok: false,
          mismatches: [{ code: 'model-unavailable', message: 'claude is not available' }],
        });
      });
      await waitFor(() => expect(view.queryByTestId('session-model-preflight-mismatch')).not.toBeNull());
      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
      await settle();
      expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
      expect(mockedStreamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'codex' });
      expect(chatPaneSpy.mock.calls.at(-1)?.[0]?.queuedItems).toHaveLength(0);
    });

    // ── Round 3: picker churn is absorbed inside `handleSend` ──────────────
    // `handleSend` no longer refuses a send because the model choice is
    // moving. It waits for the picker to settle and sends once, on the
    // settled choice, whoever the caller is.

    type ComposerProps = {
      onSend?: (prompt: string, attachments: [], commentAttachments: []) => Promise<unknown>;
      onSendQueuedNow?: (id: string) => void;
      queuedItems?: Array<{ id: string }>;
      error?: string | null;
    };
    const latestChatPane = () => chatPaneSpy.mock.calls.at(-1)?.[0] as ComposerProps | undefined;

    /** A settled team project with no Home handoff: the composer is idle. */
    async function renderIdleConversation(overrides: Partial<ComponentProps<typeof ProjectView>> = {}) {
      window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
      workspaceScopeMocks.projectScope = {
        loading: false,
        scope: {
          kind: 'team',
          projectId: PROJECT_ID,
          workspaceId: TEAM_WORKSPACE,
          visibility: 'personal',
          context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
        },
      };
      mockedStreamViaDaemon.mockImplementation(async options => { options.onRunCreated?.('run-round-3'); });
      const view = renderProjectView({ project: { ...project(), pendingPrompt: '' }, ...overrides });
      await waitFor(() => expect(latestChatPane()?.onSend).toBeTypeOf('function'));
      await waitFor(() => expect(modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange).toBeTypeOf('function'));
      await settle();
      return view;
    }

    /** Routes preflight calls: picker checks for `heldAgent` wait on a deferred; everything else passes. */
    function holdPickerCheckFor(heldAgent: string) {
      const held = deferred<ModelPreflightResult>();
      const sendTimeInputs: PreflightInput[] = [];
      mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, input: PreflightInput) => {
        if ('attachments' in input) { sendTimeInputs.push(input); return passing(input); }
        return input.agentId === heldAgent ? held.promise : passing(input);
      });
      return { held, sendTimeInputs };
    }

    it('waits out a picker check pending when the composer sends, then sends once on the settled choice', async () => {
      const view = await renderIdleConversation();
      const { held } = holdPickerCheckFor('codex');
      await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('codex'); });
      await waitFor(() => expect(view.queryByTestId('session-model-preflight-checking')).not.toBeNull());

      let outcome: unknown = 'pending';
      await act(async () => { void latestChatPane()!.onSend!('composer prompt', [], []).then(result => { outcome = result; }); });
      await settle();
      expect(outcome).toBe('pending');
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();

      await act(async () => { held.resolve({ agentId: 'codex', modelId: 'default', ok: true, mismatches: [] }); });
      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
      await settle();
      expect(outcome).toBeUndefined();
      expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
      expect(mockedStreamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'codex' });
    });

    it('re-checks and sends on the new choice when it changes during the AMR balance gate', async () => {
      await renderIdleConversation();
      const { sendTimeInputs } = holdPickerCheckFor('none');
      const gate = deferred<Awaited<ReturnType<typeof checkAmrBalanceGate>>>();
      mockedCheckAmrBalanceGate.mockImplementationOnce(() => gate.promise);

      let outcome: unknown = 'pending';
      await act(async () => { void latestChatPane()!.onSend!('gate prompt', [], []).then(result => { outcome = result; }); });
      await waitFor(() => expect(mockedCheckAmrBalanceGate).toHaveBeenCalledTimes(1));
      expect(sendTimeInputs.map(input => input.agentId)).toEqual(['amr']);

      // The picker moves to codex while the AMR send waits on its balance gate.
      await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('codex'); });
      await settle();
      await act(async () => { gate.resolve({ kind: 'allow' } as Awaited<ReturnType<typeof checkAmrBalanceGate>>); });
      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
      await settle();
      expect(outcome).toBeUndefined();
      expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
      expect(mockedStreamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'codex' });
      // The attachment preflight ran again, for the live choice.
      expect(sendTimeInputs.map(input => input.agentId)).toEqual(['amr', 'codex']);
    });

    it('stops with a visible error and keeps the draft when the choice keeps changing', async () => {
      await renderIdleConversation();
      const agentsInTurn = ['codex', 'claude'];
      let switches = 0;
      mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, input: PreflightInput) => {
        if (!('attachments' in input)) return passing(input);
        // Every send-time check sees the picker move to another model.
        modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange(agentsInTurn[switches++ % 2]!);
        await new Promise(resolve => setTimeout(resolve, 20));
        return passing(input);
      });

      let outcome: unknown = 'pending';
      await act(async () => { void latestChatPane()!.onSend!('restless prompt', [], []).then(result => { outcome = result; }); });
      await waitFor(() => expect(outcome).toBe('restore-draft'), { timeout: 4000 });
      expect(latestChatPane()?.error).toBe('workbench.preflight.choiceKeptChanging');
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
      // The first attempt plus three restarts, then the send stops.
      expect(switches).toBe(4);
    });

    it('lets "Send now" start nothing while the auto drain already sends that item', async () => {
      const { sendTimeA, sendTimeInputs } = await queueSendAWaitingInItsPreflight();
      const queued = latestChatPane()?.queuedItems ?? [];
      expect(queued).toHaveLength(1);
      await act(async () => { latestChatPane()!.onSendQueuedNow!(queued[0]!.id); });
      await settle();
      await act(async () => { sendTimeA.resolve(passing(sendTimeInputs[0]!)); });
      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
      await settle();
      expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
      expect(sendTimeInputs).toHaveLength(1);
      expect(latestChatPane()?.queuedItems).toHaveLength(0);
    });

    it('resumes a Home auto-send whose painted turn outlived a picker check that changed the choice', async () => {
      workspaceScopeMocks.projectScope = {
        loading: false,
        scope: {
          kind: 'team',
          projectId: PROJECT_ID,
          workspaceId: TEAM_WORKSPACE,
          visibility: 'personal',
          context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
        },
      };
      mockedStreamViaDaemon.mockImplementation(async options => { options.onRunCreated?.('run-home-after-picker'); });
      const homeSendTime = deferred<ModelPreflightResult>();
      const sendTimeInputs: PreflightInput[] = [];
      mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, input: PreflightInput) => {
        if (!('attachments' in input)) return passing(input);
        sendTimeInputs.push(input);
        return sendTimeInputs.length === 1 ? homeSendTime.promise : passing(input);
      });
      renderProjectView();
      // Home's first send waits in its (post-paint) send-time preflight on amr.
      await waitFor(() => expect(sendTimeInputs).toHaveLength(1));
      expect(sendTimeInputs[0]?.agentId).toBe('amr');
      await waitFor(() => expect(modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange).toBeTypeOf('function'));

      // A picker check for codex starts and settles while Home waits.
      await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('codex'); });
      await settle();
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();

      // Home's amr result is stale; the send must still go out, once, on codex,
      // driven by the send itself rather than by some later render.
      await act(async () => { homeSendTime.resolve(passing(sendTimeInputs[0]!)); });
      expect(sendTimeInputs.map(input => input.agentId)).toEqual(['amr', 'codex']);
      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
      await settle();
      expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
      expect(mockedStreamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'codex' });
    });

    it('sends design-system feedback once on the settled choice when a picker check is pending', async () => {
      const view = await renderIdleConversation();
      const { held } = holdPickerCheckFor('codex');
      await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('codex'); });
      await waitFor(() => expect(view.queryByTestId('session-model-preflight-checking')).not.toBeNull());

      const needsWork = fileWorkspaceSpy.mock.calls.at(-1)?.[0]?.onDesignSystemNeedsWork as
        (section: string, feedback: string, files: string[]) => { status: string } | void;
      let task: { status: string } | void = undefined;
      await act(async () => { task = needsWork('Colors', 'Warmer neutrals', []); });
      expect(task).toMatchObject({ status: 'sent' });
      await settle();
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();

      await act(async () => { held.resolve({ agentId: 'codex', modelId: 'default', ok: true, mismatches: [] }); });
      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
      await settle();
      expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
      expect(mockedStreamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'codex' });
    });

    it('puts design-system feedback back to queued when its send is refused', async () => {
      const onProjectChange = vi.fn();
      await renderIdleConversation({ onProjectChange });
      mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, input: PreflightInput) =>
        'attachments' in input
          ? { agentId: input.agentId, modelId: input.modelId, ok: false, mismatches: [{ code: 'model-unavailable', message: 'gone' }] }
          : passing(input));
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0] as {
        onDesignSystemNeedsWork: (section: string, feedback: string, files: string[]) => { status: string } | void;
        onDesignSystemReviewDecision: (section: string, decision: 'needs-work', details?: Record<string, unknown>) => void;
      };
      await act(async () => {
        const task = props.onDesignSystemNeedsWork('Colors', 'Warmer neutrals', []);
        // FileWorkspace records the sent task right after, as it does in the app.
        props.onDesignSystemReviewDecision('Colors', 'needs-work', { feedback: 'Warmer neutrals', files: [], agentTask: task });
      });
      await waitFor(() => {
        const review = onProjectChange.mock.calls.at(-1)?.[0]?.metadata?.designSystemReview;
        expect(review?.Colors?.agentTask).toMatchObject({ status: 'queued' });
      });
      const review = onProjectChange.mock.calls.at(-1)?.[0]?.metadata?.designSystemReview;
      expect(review.Colors).toMatchObject({ decision: 'needs-work', feedback: 'Warmer neutrals' });
      expect(review.Colors.agentTask.prompt).toContain('Warmer neutrals');
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    });

    // ── Round 4: bounded waits, one send per conversation, withdrawn rows ──

    const lastUserPrompt = (call: unknown[] | undefined) =>
      ((call?.[0] as { history?: Array<{ role: string; content: string }> } | undefined)?.history ?? [])
        .filter(message => message.role === 'user').at(-1)?.content;

    it('ends a composer send waiting on a picker check when the view unmounts, keeping the draft', async () => {
      const view = await renderIdleConversation();
      holdPickerCheckFor('codex');
      await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('codex'); });
      await waitFor(() => expect(view.queryByTestId('session-model-preflight-checking')).not.toBeNull());
      let outcome: unknown = 'pending';
      await act(async () => { void latestChatPane()!.onSend!('unmounted prompt', [], []).then(result => { outcome = result; }); });
      await settle();
      expect(outcome).toBe('pending');
      view.unmount();
      await waitFor(() => expect(outcome).toBe('restore-draft'), { timeout: 2000 });
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    });

    it('makes "Send now" on another row go next instead of overlapping the in-flight queued send', async () => {
      workspaceScopeMocks.projectScope = {
        loading: false,
        scope: {
          kind: 'team',
          projectId: PROJECT_ID,
          workspaceId: TEAM_WORKSPACE,
          visibility: 'personal',
          context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
        },
      };
      mockedCheckAmrBalanceGate.mockResolvedValue({ kind: 'unavailable' });
      renderProjectView();
      await waitFor(() => expect(latestChatPane()?.queuedItems).toHaveLength(1));
      // A second row, parked by the same unavailable gate.
      await act(async () => { await latestChatPane()!.onSend!('second row', [], []); });
      await waitFor(() => expect(latestChatPane()?.queuedItems).toHaveLength(2));
      const [rowA, rowB] = latestChatPane()!.queuedItems!;

      mockedCheckAmrBalanceGate.mockResolvedValue({ kind: 'allow' });
      mockedStreamViaDaemon.mockImplementation(async options => { options.onRunCreated?.(`run-${mockedStreamViaDaemon.mock.calls.length}`); });
      const sendTimeA = deferred<ModelPreflightResult>();
      const sendTimeInputs: PreflightInput[] = [];
      mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, input: PreflightInput) => {
        if (!('attachments' in input)) return passing(input);
        sendTimeInputs.push(input);
        return sendTimeInputs.length === 1 ? sendTimeA.promise : passing(input);
      });
      await act(async () => { modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('codex'); });
      await waitFor(() => expect(sendTimeInputs).toHaveLength(1));

      // Row A is in flight. "Send now" on row B must not start a second send.
      await act(async () => { latestChatPane()!.onSendQueuedNow!(rowB!.id); });
      await settle();
      expect(sendTimeInputs).toHaveLength(1);
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
      expect(latestChatPane()!.queuedItems!.map(item => item.id)).toEqual([rowB!.id, rowA!.id]);

      await act(async () => { sendTimeA.resolve(passing(sendTimeInputs[0]!)); });
      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalled());
      expect(lastUserPrompt(mockedStreamViaDaemon.mock.calls[0])).toBe(SEED_PROMPT);
    });

    it('drops a queued send whose row is deleted while it waits, before it is sent', async () => {
      const { sendTimeA, sendTimeInputs } = await queueSendAWaitingInItsPreflight();
      const rowA = latestChatPane()!.queuedItems![0]!;
      const remove = (chatPaneSpy.mock.calls.at(-1)?.[0] as { onRemoveQueuedSend?: (id: string) => void }).onRemoveQueuedSend!;
      await act(async () => { remove(rowA.id); });
      expect(latestChatPane()?.queuedItems).toHaveLength(0);

      await act(async () => { sendTimeA.resolve(passing(sendTimeInputs[0]!)); });
      await settle();
      expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    });

    it('drops a queued send whose row is edited while it waits, before it is sent', async () => {
      const { sendTimeA, sendTimeInputs } = await queueSendAWaitingInItsPreflight();
      const rowA = latestChatPane()!.queuedItems![0]!;
      const update = (chatPaneSpy.mock.calls.at(-1)?.[0] as {
        onUpdateQueuedSend?: (id: string, update: { prompt: string; attachments: []; commentAttachments: [] }) => void;
      }).onUpdateQueuedSend!;
      await act(async () => { update(rowA.id, { prompt: 'edited prompt', attachments: [], commentAttachments: [] }); });

      await act(async () => { sendTimeA.resolve(passing(sendTimeInputs[0]!)); });
      await settle();
      // The old text never goes out; releasing the withdrawn claim re-drains at
      // once, so the edited row goes out without waiting on unrelated renders.
      expect(mockedStreamViaDaemon.mock.calls.map(lastUserPrompt)).toEqual(['edited prompt']);
    });

    it('keeps a newer review decision when a feedback send is refused later', async () => {
      const onProjectChange = vi.fn();
      await renderIdleConversation({ onProjectChange });
      const refusal = deferred<ModelPreflightResult>();
      mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, input: PreflightInput) =>
        'attachments' in input ? refusal.promise : passing(input));
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0] as {
        onDesignSystemNeedsWork: (section: string, feedback: string, files: string[]) => { status: string } | void;
        onDesignSystemReviewDecision: (section: string, decision: 'looks-good' | 'needs-work', details?: Record<string, unknown>) => void;
      };
      let task: { status: string } | void = undefined;
      await act(async () => {
        task = props.onDesignSystemNeedsWork('Colors', 'Warmer neutrals', []);
        // FileWorkspace records the sent task right after, as it does in the app.
        props.onDesignSystemReviewDecision('Colors', 'needs-work', { feedback: 'Warmer neutrals', files: [], agentTask: task });
      });
      // The user then marks the section as fine while the send still waits.
      await act(async () => { props.onDesignSystemReviewDecision('Colors', 'looks-good'); });
      await act(async () => {
        refusal.resolve({ agentId: 'amr', modelId: 'default', ok: false, mismatches: [{ code: 'model-unavailable', message: 'gone' }] });
      });
      await settle();
      const review = onProjectChange.mock.calls.at(-1)?.[0]?.metadata?.designSystemReview;
      expect(review?.Colors).toMatchObject({ decision: 'looks-good' });
      expect(review?.Colors?.agentTask).toBeUndefined();
    });
  });

  it('keeps an explicitly Personal project on the Personal preflight', async () => {
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'personal',
        projectId: PROJECT_ID,
        workspaceId: PERSONAL_CONTEXT.workspaceId,
        visibility: 'personal',
        context: PERSONAL_CONTEXT as WorkspaceCollabContext & { workspaceType: 'personal' },
      },
    };

    renderProjectView({
      project: {
        ...project(),
        workspaceId: PERSONAL_CONTEXT.workspaceId,
      },
    });

    await waitFor(() => {
      expect(mockedCheckAmrBalanceGate).toHaveBeenCalledWith({
        workspaceType: 'personal',
        workspaceId: PERSONAL_CONTEXT.workspaceId,
        workspaceMemberId: PERSONAL_CONTEXT.workspaceMemberId,
      }, 'deepseek-v4-flash');
    });
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalled());
  });

  it('uses an exact Personal witness to preflight and adopt a confirmed unbound Home project', async () => {
    workspaceScopeMocks.ambientContext = PERSONAL_CONTEXT;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'unbound',
        projectId: PROJECT_ID,
        workspaceId: null,
        context: null,
      },
    };

    renderProjectView({
      project: {
        ...project(),
        workspaceId: undefined,
      },
    });

    await waitFor(() => {
      expect(mockedCheckAmrBalanceGate).toHaveBeenCalledWith({
        workspaceType: 'personal',
        workspaceId: PERSONAL_CONTEXT.workspaceId,
        workspaceMemberId: PERSONAL_CONTEXT.workspaceMemberId,
      }, 'deepseek-v4-flash');
    });
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalled());
    expect(mockedStreamViaDaemon.mock.calls[0]?.[0].workspaceContext).toEqual(
      PERSONAL_CONTEXT,
    );
    await waitFor(() => {
      expect(
        chatPaneSpy.mock.calls.at(-1)?.[0].amrAuthRetryPersonalAdoptionWitness,
      ).toEqual({
        workspaceIdentityKey:
          'personal-workspace:personal:personal-member:member:active:active:true:true',
        workspaceId: PERSONAL_CONTEXT.workspaceId,
        workspaceMemberId: PERSONAL_CONTEXT.workspaceMemberId,
        workspaceType: 'personal',
        memberStatus: 'active',
      });
    });
  });

  it.each([
    ['a Team caller', CALLER_CONTEXT],
    ['no caller', null],
  ])(
    'does not inspect the account wallet for an unbound normal send from %s',
    async (_label, ambientContext) => {
      window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
      workspaceScopeMocks.ambientContext = ambientContext;
      workspaceScopeMocks.projectScope = {
        loading: false,
        scope: {
          kind: 'unbound',
          projectId: PROJECT_ID,
          workspaceId: null,
          context: null,
        },
      };

      const view = renderProjectView({
        project: {
          ...project(),
          pendingPrompt: '',
          workspaceId: undefined,
        },
      });
      const send = await waitFor(() => {
        const candidate = view.getByTestId('normal-send');
        expect(candidate).not.toBeDisabled();
        return candidate;
      });
      fireEvent.click(send);

      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalled());
      expect(mockedCheckAmrBalanceGate).not.toHaveBeenCalled();
      expect(mockedStreamViaDaemon.mock.calls[0]?.[0].workspaceContext).toBeNull();
    },
  );
});

describe('a Home auto-send observes a project billing scope that settles after mount', () => {
  beforeEach(() => {
    resourceContextObservations.length = 0;
    window.sessionStorage.clear();
    window.localStorage.clear();
    resetWorkspaceContextCache();
    mockedListConversations.mockImplementation(async (projectId: string) => [
      conversation(projectId),
    ]);
    mockedCreateConversation.mockImplementation(async (projectId: string) =>
      conversation(projectId),
    );
    mockedListMessages.mockResolvedValue([]);
    mockedFetchPreviewComments.mockResolvedValue([]);
    mockedFetchBrands.mockResolvedValue([]);
    mockedCheckAmrBalanceGate.mockResolvedValue({ kind: 'allow' });
    workspaceScopeMocks.projectScope = { loading: true, scope: null };
    workspaceScopeMocks.ambientContext = CALLER_CONTEXT;
    projectCollabMocks.writerAuthority = 'allowed';
    projectCollabMocks.viewerOnly = false;
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetWorkspaceContextCache();
  });

  it('preflights and auto-sends with the latest settled Team billing scope', async () => {
    // Keep every prop that participates in `handleSend` or the auto-send effect
    // referentially stable across the rerender. The project billing scope is the
    // only dependency allowed to change in this regression.
    const stableOverrides: Partial<ComponentProps<typeof ProjectView>> = {
      project: project(),
      agents: [{
        id: 'amr',
        name: 'amr',
        available: true,
        models: [{
          id: 'deepseek-v4-flash',
          label: 'DeepSeek V4 Flash',
          default: true,
        }],
      }] as unknown as AgentInfo[],
      skills: [] as SkillSummary[],
      designTemplates: [] as SkillSummary[],
      designSystems: [] as DesignSystemSummary[],
      onModeChange: vi.fn(),
      onAgentChange: vi.fn(),
      onAgentModelChange: vi.fn(),
      onRefreshAgents: vi.fn(),
      onOpenSettings: vi.fn(),
      onBack: vi.fn(),
      onClearPendingPrompt: vi.fn(),
      onTouchProject: vi.fn(),
      onProjectChange: vi.fn(),
      onProjectsRefresh: vi.fn(),
    };
    const view = renderProjectView(stableOverrides);
    await waitFor(() => expect(mockedListMessages).toHaveBeenCalled());
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();

    // Add the Home hand-off only after mount, then settle the project scope to
    // the SAME context object already used for run identity. That keeps
    // `projectRunWorkspaceContext` referentially stable, so only the billing
    // context changed. Without the `handleSend` billing dependency, the effect
    // dispatches through a callback that still holds its mount-time `null`.
    // The effect also lists the billing context it reads directly instead of
    // relying on that callback's identity as a transitive dependency.
    window.sessionStorage.setItem(`od:auto-send-first:${PROJECT_ID}`, '1');
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'personal',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    view.rerender(projectViewElement(stableOverrides));

    await waitFor(() => {
      expect(mockedCheckAmrBalanceGate).toHaveBeenCalledWith({
        workspaceType: 'team',
        workspaceId: TEAM_WORKSPACE,
        workspaceMemberId: TEAM_MEMBER,
      }, 'deepseek-v4-flash');
    });
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalled());
  });

  it('auto-sends a cold unbound local project through the account-scoped Cloud lane', async () => {
    window.sessionStorage.setItem(`od:auto-send-first:${PROJECT_ID}`, '1');
    workspaceScopeMocks.ambientContext = null;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'unbound',
        projectId: PROJECT_ID,
        workspaceId: null,
        context: null,
      },
    };
    mockedStreamViaDaemon.mockImplementation(async options => { options.onRunCreated?.('run-cold-admitted'); });
    const stableOverrides: Partial<ComponentProps<typeof ProjectView>> = {
      project: { ...project(), workspaceId: undefined },
    };
    renderProjectView(stableOverrides);

    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
    // Home already performed the account-scoped balance gate. ProjectView
    // must not duplicate it while handing off the accepted first prompt.
    expect(mockedCheckAmrBalanceGate).not.toHaveBeenCalled();
    expect(mockedStreamViaDaemon.mock.calls[0]?.[0].workspaceContext).toBeNull();
    expect(window.sessionStorage.getItem(`od:auto-send-first:${PROJECT_ID}`)).toBeNull();
  });

  it('reconciles files and comments with the exact Team scope when the project event stream becomes ready', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };

    renderProjectView({
      project: { ...project(), pendingPrompt: '' },
    });
    await waitFor(() => {
      expect(mockedUseProjectFileEvents).toHaveBeenCalledWith(
        PROJECT_ID,
        true,
        expect.any(Function),
        expect.objectContaining({ onReady: expect.any(Function) }),
        CALLER_CONTEXT,
      );
    });

    const options = mockedUseProjectFileEvents.mock.calls.at(-1)?.[3];
    mockedFetchProjectFiles.mockClear();
    mockedFetchPreviewComments.mockClear();
    await act(async () => {
      options?.onReady?.();
    });

    await waitFor(() => {
      expect(mockedFetchProjectFiles).toHaveBeenCalledWith(PROJECT_ID, {
        fresh: true,
        requireAuthoritative: true,
        workspaceContext: CALLER_CONTEXT,
      });
    });
    await waitFor(() => {
      expect(mockedFetchPreviewComments).toHaveBeenCalledWith(
        PROJECT_ID,
        `conv-${PROJECT_ID}`,
        CALLER_CONTEXT,
      );
    });
  });

  it('keeps established project data while the same workspace authority object settles', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    mockedListMessages.mockResolvedValue([{
      id: 'existing-message',
      role: 'assistant',
      content: 'existing transcript',
      createdAt: 1,
    } as never]);

    const view = renderProjectView({
      project: {
        ...project(),
        pendingPrompt: '',
      },
    });
    await waitFor(() => expect(mockedListMessages).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedLoadTabs).toHaveBeenCalledTimes(1));
    const establishedResourceContext = resourceContextObservations.find(
      (context) => context?.workspaceId === TEAM_WORKSPACE,
    );
    expect(establishedResourceContext).toBeTruthy();

    const conversationsPending = deferred<Conversation[]>();
    const messagesPending = deferred<never[]>();
    mockedListConversations.mockImplementationOnce(() => conversationsPending.promise);
    mockedListMessages.mockImplementationOnce(() => messagesPending.promise);

    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'personal',
        context: {
          ...CALLER_CONTEXT,
          permissions: { ...CALLER_CONTEXT.permissions },
        } as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    await act(async () => {
      view.rerender(projectViewElement({
        project: {
          ...project(),
          pendingPrompt: '',
        },
      }));
    });

    expect(
      mockedListConversations,
      'same project/workspace/member revalidation must not restart the conversation load',
    ).toHaveBeenCalledTimes(1);
    expect(
      mockedListMessages,
      'same project/workspace/member revalidation must not blank and reload the transcript',
    ).toHaveBeenCalledTimes(1);
    expect(
      mockedLoadTabs,
      'same project/workspace/member revalidation must not clear and rehydrate open tabs',
    ).toHaveBeenCalledTimes(1);
    expect(
      resourceContextObservations.at(-1),
      'FileWorkspace/FileViewer consumers must keep one canonical context object',
    ).toBe(establishedResourceContext);
  });

  it('keeps the selected conversation when the same project authority identity refreshes', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    mockedListConversations.mockReset();
    mockedListMessages.mockReset();
    mockedListMessages.mockResolvedValue([]);
    workspaceScopeMocks.ambientContext = CALLER_CONTEXT;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    const availableConversations = [
      { ...conversation(PROJECT_ID), id: 'conv-first' },
      { ...conversation(PROJECT_ID), id: 'conv-second', createdAt: 2, updatedAt: 2 },
    ];
    mockedListConversations.mockResolvedValue(availableConversations);

    const stableProject = { ...project(), pendingPrompt: '' };
    const view = renderProjectView({ project: stableProject });
    await waitFor(() => expect(mockedListConversations).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].activeConversationId).toBe('conv-first');
    });

    await act(async () => {
      chatPaneSpy.mock.calls.at(-1)?.[0].onSelectConversation?.('conv-second');
    });
    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].activeConversationId).toBe('conv-second');
    });

    const refreshedContext = {
      ...CALLER_CONTEXT,
      workspaceMemberId: 'member-revalidated',
    } as WorkspaceCollabContext & { workspaceType: 'team' };
    workspaceScopeMocks.ambientContext = refreshedContext;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: refreshedContext,
      },
    };
    await act(async () => {
      view.rerender(projectViewElement({ project: stableProject }));
    });

    await waitFor(() => expect(mockedListConversations).toHaveBeenCalledTimes(2));
    expect(chatPaneSpy.mock.calls.at(-1)?.[0].activeConversationId).toBe('conv-second');
  });

  it('clears an established transcript when the project authority is revoked', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    mockedListConversations.mockReset();
    mockedListMessages.mockReset();
    mockedListConversations.mockImplementation(async (projectId: string) => [
      conversation(projectId),
    ]);
    mockedListMessages
      .mockResolvedValueOnce([{
        id: 'workspace-a-message',
        role: 'assistant',
        content: 'Workspace A secret',
        createdAt: 1,
      } as never])
      .mockRejectedValueOnce(new Error('workspace access forbidden'));
    workspaceScopeMocks.ambientContext = CALLER_CONTEXT;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };

    const stableProject = { ...project(), pendingPrompt: '' };
    const view = renderProjectView({ project: stableProject });
    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([
        expect.objectContaining({ content: 'Workspace A secret' }),
      ]);
    });

    workspaceScopeMocks.ambientContext = null;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: null,
      failure: 'forbidden',
    };
    await act(async () => {
      view.rerender(projectViewElement({ project: stableProject }));
    });

    await waitFor(() => expect(mockedListMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].messages).toEqual([]);
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].sendDisabled).toBe(true);
    });
  });

  it('clears established conversation metadata when revalidation is forbidden', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    mockedListConversations.mockReset();
    mockedListMessages.mockReset();
    mockedListConversations
      .mockResolvedValueOnce([{
        ...conversation(PROJECT_ID),
        title: 'Workspace A secret title',
      }])
      .mockRejectedValueOnce(
        new ProjectConversationsHttpError(403, 'workspace access forbidden'),
      );
    mockedListMessages.mockResolvedValue([]);
    workspaceScopeMocks.ambientContext = CALLER_CONTEXT;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };

    const stableProject = { ...project(), pendingPrompt: '' };
    const view = renderProjectView({ project: stableProject });
    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].conversations).toEqual([
        expect.objectContaining({ title: 'Workspace A secret title' }),
      ]);
    });

    workspaceScopeMocks.ambientContext = null;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: null,
      failure: 'forbidden',
    };
    await act(async () => {
      view.rerender(projectViewElement({ project: stableProject }));
    });

    await waitFor(() => expect(mockedListConversations).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].conversations).toEqual([]);
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].activeConversationId).toBeNull();
    });
  });

  it('flushes project A tabs with A authority after rendering project B', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    projectCollabMocks.writerAuthority = 'allowed';
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    const projectA: Project = {
      ...project(),
      pendingPrompt: '',
    };
    const projectBContext: WorkspaceCollabContext = {
      ...CALLER_CONTEXT,
      workspaceId: 'workspace-b',
      workspaceMemberId: 'member-b',
      teamId: 'workspace-b',
      teamName: 'Workspace B',
    };
    const projectB: Project = {
      ...projectA,
      id: 'project-b',
      name: 'Project B',
      workspaceId: projectBContext.workspaceId,
    };
    const stableOverrides: Partial<ComponentProps<typeof ProjectView>> = {
      project: projectA,
      onModeChange: vi.fn(),
      onAgentChange: vi.fn(),
      onAgentModelChange: vi.fn(),
      onRefreshAgents: vi.fn(),
      onOpenSettings: vi.fn(),
      onBack: vi.fn(),
      onClearPendingPrompt: vi.fn(),
      onTouchProject: vi.fn(),
      onProjectChange: vi.fn(),
      onProjectsRefresh: vi.fn(),
    };
    const view = renderProjectView(stableOverrides);
    await waitFor(() => expect(mockedLoadTabs).toHaveBeenCalledTimes(1));

    fireEvent.click(view.getByTestId('queue-tab-write'));
    expect(mockedPersistTabsToDaemonNow).not.toHaveBeenCalled();

    workspaceScopeMocks.ambientContext = projectBContext;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: projectB.id,
        workspaceId: projectBContext.workspaceId,
        visibility: 'personal',
        context: projectBContext as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    view.rerender(projectViewElement({
      ...stableOverrides,
      project: projectB,
    }));

    await waitFor(() => {
      expect(mockedPersistTabsToDaemonNow).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({
          tabs: ['index.html'],
          active: 'index.html',
        }),
        CALLER_CONTEXT,
      );
    });
  });

  it('keeps a read-only Team member tab-local and never sends a daemon PUT', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    projectCollabMocks.writerAuthority = 'denied';
    projectCollabMocks.viewerOnly = true;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };

    const view = renderProjectView({
      project: { ...project(), pendingPrompt: '' },
      routeFileName: 'index.html',
    });
    await waitFor(() => expect(mockedLoadTabs).toHaveBeenCalledTimes(1));
    expect(mockedLoadTabs).toHaveBeenCalledWith(
      PROJECT_ID,
      CALLER_CONTEXT,
      { reconcileNewerCacheToDaemon: false },
    );
    vi.useFakeTimers();
    fireEvent.click(view.getByTestId('queue-alt-tab-write'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(mockedPersistTabsToDaemonNow).not.toHaveBeenCalled();
  });

  it.each(['pending', 'denied'] as const)(
    'does not treat a missing local workspaceId as unbound when Team writer authority is %s',
    async (writerAuthority) => {
      window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
      projectCollabMocks.writerAuthority = writerAuthority;
      projectCollabMocks.viewerOnly = writerAuthority === 'denied';
      workspaceScopeMocks.projectScope = {
        loading: false,
        scope: {
          kind: 'team',
          projectId: PROJECT_ID,
          workspaceId: TEAM_WORKSPACE,
          visibility: 'team',
          context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
        },
      };

      const view = renderProjectView({
        project: {
          ...project(),
          pendingPrompt: '',
          workspaceId: undefined,
        },
      });
      await waitFor(() => expect(mockedLoadTabs).toHaveBeenCalledTimes(1));
      expect(mockedLoadTabs).toHaveBeenCalledWith(
        PROJECT_ID,
        CALLER_CONTEXT,
        { reconcileNewerCacheToDaemon: false },
      );
      vi.useFakeTimers();
      fireEvent.click(view.getByTestId('queue-alt-tab-write'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      expect(mockedPersistTabsToDaemonNow).not.toHaveBeenCalled();
    },
  );

  it('coalesces confirmed-writer tab changes into one daemon PUT', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    projectCollabMocks.writerAuthority = 'allowed';
    const view = renderProjectView({
      project: { ...project(), pendingPrompt: '' },
    });
    await waitFor(() => expect(mockedLoadTabs).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();

    fireEvent.click(view.getByTestId('queue-tab-write'));
    fireEvent.click(view.getByTestId('queue-alt-tab-write'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(mockedPersistTabsToDaemonNow).toHaveBeenCalledTimes(1);
    expect(mockedPersistTabsToDaemonNow).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        tabs: ['index.html', 'about.html'],
        active: 'about.html',
      }),
      CALLER_CONTEXT,
    );
    vi.useRealTimers();
  });

  it('does not rewrite an unchanged routed tab for a confirmed writer', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    projectCollabMocks.writerAuthority = 'allowed';
    mockedLoadTabs.mockResolvedValueOnce({
      tabs: ['index.html'],
      active: 'index.html',
      hasSavedState: true,
    });

    renderProjectView({
      project: { ...project(), pendingPrompt: '' },
      routeFileName: 'index.html',
    });
    await waitFor(() => expect(mockedLoadTabs).toHaveBeenCalledTimes(1));
    expect(mockedPersistTabsToDaemonNow).not.toHaveBeenCalled();
  });

  it('writes one changed routed tab for a confirmed writer', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    projectCollabMocks.writerAuthority = 'allowed';

    renderProjectView({
      project: { ...project(), pendingPrompt: '' },
      routeFileName: 'index.html',
    });
    await waitFor(() => expect(mockedLoadTabs).toHaveBeenCalledTimes(1));
    expect(mockedPersistTabsToDaemonNow).toHaveBeenCalledTimes(1);
    expect(mockedPersistTabsToDaemonNow).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        tabs: ['index.html'],
        active: 'index.html',
      }),
      CALLER_CONTEXT,
    );
  });

  it('starts daemon tab persistence only after Team writer authority is allowed', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    projectCollabMocks.writerAuthority = 'pending';
    projectCollabMocks.viewerOnly = false;
    const stableOverrides = {
      project: { ...project(), pendingPrompt: '' },
    };
    const view = renderProjectView(stableOverrides);
    await waitFor(() => expect(mockedLoadTabs).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();

    fireEvent.click(view.getByTestId('queue-tab-write'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(mockedPersistTabsToDaemonNow).not.toHaveBeenCalled();

    projectCollabMocks.writerAuthority = 'allowed';
    view.rerender(projectViewElement(stableOverrides));
    fireEvent.click(view.getByTestId('queue-alt-tab-write'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(mockedPersistTabsToDaemonNow).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('preserves Personal project daemon tab persistence', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    projectCollabMocks.writerAuthority = 'denied';
    workspaceScopeMocks.ambientContext = PERSONAL_CONTEXT;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'personal',
        projectId: PROJECT_ID,
        workspaceId: PERSONAL_CONTEXT.workspaceId,
        visibility: 'personal',
        context: PERSONAL_CONTEXT as WorkspaceCollabContext & { workspaceType: 'personal' },
      },
    };
    const view = renderProjectView({
      project: {
        ...project(),
        pendingPrompt: '',
        workspaceId: PERSONAL_CONTEXT.workspaceId,
      },
    });
    await waitFor(() => expect(mockedLoadTabs).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    fireEvent.click(view.getByTestId('queue-tab-write'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(mockedPersistTabsToDaemonNow).toHaveBeenCalledTimes(1);
    expect(mockedPersistTabsToDaemonNow.mock.calls[0]?.[2]).toEqual(PERSONAL_CONTEXT);
  });

  it('preserves anonymous unbound project daemon tab persistence', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    projectCollabMocks.writerAuthority = 'pending';
    workspaceScopeMocks.ambientContext = null;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'unbound',
        projectId: PROJECT_ID,
        workspaceId: null,
        context: null,
      },
    };
    const view = renderProjectView({
      project: {
        ...project(),
        pendingPrompt: '',
        workspaceId: undefined,
      },
    });
    await waitFor(() => expect(mockedLoadTabs).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    fireEvent.click(view.getByTestId('queue-tab-write'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(mockedPersistTabsToDaemonNow).toHaveBeenCalledTimes(1);
    expect(mockedPersistTabsToDaemonNow.mock.calls[0]?.[2]).toBeNull();
  });

  it('gates bound-project SSE until exact project authority exists', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    workspaceScopeMocks.ambientContext = null;
    workspaceScopeMocks.projectScope = { loading: true, scope: null };
    const stableProject = { ...project(), pendingPrompt: '' };
    const view = renderProjectView({ project: stableProject });

    await waitFor(() => expect(mockedUseProjectFileEvents).toHaveBeenCalled());
    expect(mockedUseProjectFileEvents.mock.calls.at(-1)?.[1]).toBe(false);

    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'team',
        projectId: PROJECT_ID,
        workspaceId: TEAM_WORKSPACE,
        visibility: 'team',
        context: CALLER_CONTEXT as WorkspaceCollabContext & { workspaceType: 'team' },
      },
    };
    view.rerender(projectViewElement({ project: stableProject }));
    expect(mockedUseProjectFileEvents.mock.calls.at(-1)?.[1]).toBe(true);

    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: null,
      failure: 'forbidden',
    };
    view.rerender(projectViewElement({ project: stableProject }));
    expect(mockedUseProjectFileEvents.mock.calls.at(-1)?.[1]).toBe(false);
  });

  it('does not treat a missing local workspaceId as settled unbound SSE authority', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    workspaceScopeMocks.ambientContext = null;
    workspaceScopeMocks.projectScope = { loading: true, scope: null };

    renderProjectView({
      project: {
        ...project(),
        pendingPrompt: '',
        workspaceId: undefined,
      },
    });

    await waitFor(() => expect(mockedUseProjectFileEvents).toHaveBeenCalled());
    expect(mockedUseProjectFileEvents.mock.calls.at(-1)?.[1]).toBe(false);
  });

  it('enables SSE for a settled Personal project scope', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    workspaceScopeMocks.ambientContext = PERSONAL_CONTEXT;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'personal',
        projectId: PROJECT_ID,
        workspaceId: PERSONAL_CONTEXT.workspaceId,
        visibility: 'personal',
        context: PERSONAL_CONTEXT as WorkspaceCollabContext & { workspaceType: 'personal' },
      },
    };

    renderProjectView({
      project: {
        ...project(),
        pendingPrompt: '',
        workspaceId: undefined,
      },
    });
    await waitFor(() => expect(mockedUseProjectFileEvents).toHaveBeenCalled());
    expect(mockedUseProjectFileEvents.mock.calls.at(-1)?.[1]).toBe(true);
  });

  it('keeps anonymous unbound project SSE enabled', async () => {
    window.sessionStorage.removeItem(`od:auto-send-first:${PROJECT_ID}`);
    workspaceScopeMocks.ambientContext = null;
    workspaceScopeMocks.projectScope = {
      loading: false,
      scope: {
        kind: 'unbound',
        projectId: PROJECT_ID,
        workspaceId: null,
        context: null,
      },
    };

    renderProjectView({
      project: {
        ...project(),
        pendingPrompt: '',
        workspaceId: undefined,
      },
    });
    await waitFor(() => expect(mockedUseProjectFileEvents).toHaveBeenCalled());
    expect(mockedUseProjectFileEvents.mock.calls.at(-1)?.[1]).toBe(true);
  });
});


vi.mock('../../src/providers/workbench', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/providers/workbench')>();
  const fixture = await import('../fixtures/session-model-api');
  return {
    ...actual, getSessionModel: fixture.getSessionModelFixture, putSessionModel: fixture.putSessionModelFixture,
    // AC-R02.3 select-time gate: this file exercises picker/run-identity
    // wiring, not capability mismatches — every picker selection here is
    // expected to pass by default. Wrapped in `vi.fn` (rather than a bare
    // async function) so a single test can override one call with
    // `mockImplementationOnce`/`mockReturnValueOnce` to hold the check
    // pending, without disturbing every other test's pass-through default.
    postModelPreflight: vi.fn(async (_sessionId: string, _projectId: string, input: { agentId: string; modelId: string }) =>
      ({ agentId: input.agentId, modelId: input.modelId, ok: true, mismatches: [] })),
  };
});
