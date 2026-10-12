// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackChatPanelClickMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/events')>();
  return {
    ...actual,
    trackChatPanelClick: trackChatPanelClickMock,
  };
});

import { ChatComposer, type ChatComposerHandle } from '../../src/components/ChatComposer';
import { I18nProvider } from '../../src/i18n';
import type { Locale } from '../../src/i18n/types';
import type { AppliedPluginSnapshot, Project, ProjectMetadata } from '@mish/contracts';
import { $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, HISTORY_PUSH_TAG, UNDO_COMMAND } from 'lexical';
import { $isMentionNode } from '../../src/components/composer/MentionNode';
import { composerText, getComposerEditor, pressEnter, typeAndSettle, typeInComposer } from '../helpers/lexical-composer';

const COMMUNITY_PLUGIN = {
  id: 'community-deck',
  title: 'Community Deck',
  version: '1.0.0',
  trust: 'restricted' as const,
  sourceKind: 'bundled' as const,
  source: 'bundled/community-deck',
  capabilitiesGranted: [],
  manifest: {
    name: 'community-deck',
    title: 'Community Deck',
    description: 'Official deck starter',
    od: { kind: 'skill' },
  },
  fsPath: '/plugins/community-deck',
  installedAt: 0,
  updatedAt: 0,
};

const USER_PLUGIN = {
  ...COMMUNITY_PLUGIN,
  id: 'my-export',
  title: 'My Export',
  sourceKind: 'local' as const,
  source: '/plugins/my-export',
  manifest: {
    ...COMMUNITY_PLUGIN.manifest,
    name: 'my-export',
    title: 'My Export',
    description: 'Private export workflow',
  },
};

const SKILL = {
  id: 'deck-builder',
  name: 'Deck Builder',
  description: 'Build a polished slide deck.',
  triggers: ['deck'],
  mode: 'deck' as const,
  previewType: 'html',
  designSystemRequired: false,
  defaultFor: [],
  upstream: null,
  hasBody: true,
  examplePrompt: 'Make a deck',
  aggregatesExamples: false,
};

function makeSkill(overrides: Partial<typeof SKILL>): typeof SKILL {
  return {
    ...SKILL,
    id: overrides.id ?? SKILL.id,
    name: overrides.name ?? SKILL.name,
    description: overrides.description ?? SKILL.description,
    triggers: overrides.triggers ?? SKILL.triggers,
    mode: overrides.mode ?? SKILL.mode,
    previewType: overrides.previewType ?? SKILL.previewType,
    designSystemRequired: overrides.designSystemRequired ?? SKILL.designSystemRequired,
    defaultFor: overrides.defaultFor ?? SKILL.defaultFor,
    upstream: overrides.upstream ?? SKILL.upstream,
    hasBody: overrides.hasBody ?? SKILL.hasBody,
    examplePrompt: overrides.examplePrompt ?? SKILL.examplePrompt,
    aggregatesExamples: overrides.aggregatesExamples ?? SKILL.aggregatesExamples,
  };
}

const MCP_SERVER = {
  id: 'slack',
  label: 'Slack MCP',
  transport: 'stdio' as const,
  enabled: true,
  command: 'slack-mcp',
};

const APPLY_RESULT = {
  ok: true,
  query: 'Run plugin.',
  contextItems: [],
  inputs: [],
  assets: [],
  mcpServers: [],
  trust: 'restricted',
  capabilitiesGranted: ['prompt:inject'],
  capabilitiesRequired: ['prompt:inject'],
  appliedPlugin: {
    snapshotId: 'snap-1',
    pluginId: USER_PLUGIN.id,
    pluginVersion: '1.0.0',
    manifestSourceDigest: 'a'.repeat(64),
    inputs: {},
    resolvedContext: { items: [] },
    capabilitiesGranted: ['prompt:inject'],
    capabilitiesRequired: ['prompt:inject'],
    assetsStaged: [],
    taskKind: 'new-generation',
    appliedAt: 0,
    connectorsRequired: [],
    connectorsResolved: [],
    mcpServers: [],
    status: 'fresh',
  },
  projectMetadata: {},
};

let fetchMock: ReturnType<typeof vi.fn>;
let plugins = [COMMUNITY_PLUGIN, USER_PLUGIN];
let skills = [SKILL];
let servers = [MCP_SERVER];
let openFolderPaths: string[];
let deferNextProjectPatch = false;
let rejectNextProjectPatch = false;
let commitBeforeAbortNextProjectPatch = false;
let reconcileProjectReads = false;
let failProjectReconcileRead = false;
let stallProjectReconcileRead = false;
let serverProject: Project;
let canonicalProjectDirs: Record<string, string>;
let resolveDeferredProjectPatch: (() => void) | null = null;
let referenceProjects: Array<{
  id: string;
  name: string;
  skillId: null;
  designSystemId: null;
  createdAt: number;
  updatedAt: number;
  metadata: { kind: 'prototype' };
}>;
let referenceProjectDetails: Record<string, { project: (typeof referenceProjects)[number]; resolvedDir: string | null }>;

function composerElement(
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
) {
  return (
    <ChatComposer
      projectId="project-1"
      projectFiles={[]}
      streaming={false}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onOpenMcpSettings={vi.fn()}
      skills={skills}
      {...overrides}
    />
  );
}

function renderComposer(
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
  options: { locale?: Locale } = {},
) {
  const tree = composerElement(overrides);

  return options.locale
    ? render(<I18nProvider initial={options.locale}>{tree}</I18nProvider>)
    : render(tree);
}

// Flush the composer's lazy mount fetches (MCP servers, installed plugins,
// connectors) so the @-picker lists are populated before we drive the editor.
async function flushMounts() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function stagedPluginChip(): Element | null {
  return screen
    .queryByTestId('staged-contexts')
    ?.querySelector('[data-staged-kind="plugin"]') ?? null;
}

function projectPatchBodies(): Array<{ metadata?: { linkedDirs?: string[] } }> {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === '/api/projects/project-1' && init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body ?? '{}')));
}

// The contenteditable serializes newlines as `<br>`, which jsdom's
// `.textContent` drops — so use the Lexical-aware `composerText()` helper for
// every editor-text assertion (it walks the tree and emits real `\n`s).

beforeEach(() => {
  trackChatPanelClickMock.mockClear();
  plugins = [COMMUNITY_PLUGIN, USER_PLUGIN];
  skills = [SKILL];
  servers = [MCP_SERVER];
  openFolderPaths = ['/Users/me/reference-dir'];
  deferNextProjectPatch = false;
  rejectNextProjectPatch = false;
  commitBeforeAbortNextProjectPatch = false;
  reconcileProjectReads = false;
  failProjectReconcileRead = false;
  stallProjectReconcileRead = false;
  canonicalProjectDirs = {};
  serverProject = { id: 'project-1', name: 'Project', skillId: SKILL.id, designSystemId: null, createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype' } };
  resolveDeferredProjectPatch = null;
  referenceProjects = [];
  referenceProjectDetails = {};
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/mcp/servers') {
      return new Response(JSON.stringify({ servers, templates: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/plugins') {
      return new Response(JSON.stringify({ plugins }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (
      url.includes('/api/plugins/')
      && (url.endsWith('/apply') || url.endsWith('/apply-local'))
    ) {
      return new Response(JSON.stringify(APPLY_RESULT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/skills') {
      return new Response(JSON.stringify({ skills }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/projects') {
      return new Response(JSON.stringify({ projects: referenceProjects }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/dialog/open-folder' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({ path: openFolderPaths.shift() ?? '/Users/me/reference-dir' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    if (url.startsWith('/api/skills/')) {
      const id = decodeURIComponent(url.split('/').pop() ?? '');
      const skill = skills.find((candidate) => candidate.id === id) ?? makeSkill({ id, name: id });
      return new Response(JSON.stringify({ ...skill, body: `skill body for ${id}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/projects/project-1' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body ?? '{}')) as { metadata?: unknown; skillId?: string };
      if (deferNextProjectPatch) {
        deferNextProjectPatch = false;
        await new Promise<void>((resolve, reject) => {
          const signal = init.signal;
          const abort = () => reject(new DOMException('Request aborted', 'AbortError'));
          resolveDeferredProjectPatch = () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
        resolveDeferredProjectPatch = null;
      }
      if (rejectNextProjectPatch) {
        rejectNextProjectPatch = false;
        return new Response(JSON.stringify({
          error: { message: 'directory does not exist or is not accessible' },
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      const requestedMetadata = body.metadata as ProjectMetadata | undefined;
      const linkedDirResolutions = requestedMetadata?.linkedDirs?.map((inputPath) => ({
        inputPath, storedPath: canonicalProjectDirs[inputPath] ?? inputPath,
      }));
      const responseMetadata = requestedMetadata && linkedDirResolutions
        ? { ...requestedMetadata, linkedDirs: [...new Set(linkedDirResolutions.map(({ storedPath }) => storedPath))] }
        : requestedMetadata;
      if (reconcileProjectReads) serverProject = { ...serverProject, metadata: responseMetadata ?? serverProject.metadata };
      if (commitBeforeAbortNextProjectPatch) {
        commitBeforeAbortNextProjectPatch = false;
        // The daemon committed before res.json. Headers arrived, but the body
        // stalls until abort; an independent GET sees the committed metadata.
        const response = new Response(null, { status: 200 });
        vi.spyOn(response, 'json').mockImplementation(() => new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('Response body aborted', 'AbortError'));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener('abort', abort, { once: true });
        }));
        return response;
      }
      return new Response(JSON.stringify({
        project: {
          id: 'project-1',
          name: 'Project',
          skillId: body.skillId ?? SKILL.id,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 1,
          metadata: responseMetadata ?? { kind: 'prototype' },
        },
        linkedDirResolutions,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const projectDetailMatch = /^\/api\/projects\/([^/?]+)(?:\?.*)?$/.exec(url);
    if (projectDetailMatch && init?.method !== 'PATCH') {
      const projectId = decodeURIComponent(projectDetailMatch[1]!);
      if (projectId === 'project-1' && reconcileProjectReads) {
        if (stallProjectReconcileRead) await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new DOMException('Reconciliation aborted', 'AbortError'));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        });
        return new Response(JSON.stringify({ project: serverProject }), { status: failProjectReconcileRead ? 503 : 200 });
      }
      const detail = referenceProjectDetails[projectId] ?? null;
      return new Response(JSON.stringify(detail ?? {}), {
        status: detail ? 200 : 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Any other lazy mount fetch (e.g. /api/connectors) returns an empty-OK
    // body. flushMounts() awaits these, so throwing here would surface as an
    // unhandled rejection during the await; an empty payload keeps the picker
    // lists empty without breaking the render.
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe('ChatComposer context pickers', () => {
  it('auto-stages the active workspace context and re-stages after a tab change', async () => {
    const onSend = vi.fn();
    const fileContext = {
      id: 'file:index.html',
      kind: 'file' as const,
      label: 'index.html',
      path: 'index.html',
      tabId: 'index.html',
    };
    const browserContext = {
      id: 'browser:1',
      kind: 'browser' as const,
      label: 'Dribbble',
      url: 'https://dribbble.com/',
      tabId: '__browser__:1',
    };
    const view = renderComposer({ activeWorkspaceContext: fileContext, onSend });
    await flushMounts();

    expect(screen.getByTestId('staged-contexts').textContent).toContain('Currentindex.html');
    fireEvent.click(screen.getByLabelText('Remove index.html'));
    await waitFor(() => expect(screen.queryByText('index.html')).toBeNull());

    view.rerender(composerElement({ activeWorkspaceContext: browserContext, onSend }));
    await waitFor(() => expect(screen.getByTestId('staged-contexts').textContent).toContain('CurrentDribbble'));

    await typeAndSettle('Use the current tab.');
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const meta = onSend.mock.calls[0]?.[3];
    expect(meta?.context?.workspaceItems).toEqual([browserContext]);
  });

  it('opens the @ panel even when every source is empty', async () => {
    plugins = [];
    skills = [];
    servers = [];
    renderComposer();
    await flushMounts();

    await typeAndSettle('@');

    await waitFor(() => expect(screen.getByTestId('mention-popover')).toBeTruthy());
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'All',
      'Design files',
      'Tabs',
      'Plugins',
      'Skills',
      'MCP',
      'Connectors',
    ]);
    expect(screen.getByRole('tab', { name: 'Plugins' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Skills' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'MCP' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Connectors' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Design files' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Tabs' })).toBeTruthy();
    expect(screen.getByText('Search Design Files, tabs, plugins, skills, MCP servers, and connectors.')).toBeTruthy();
  });

  it("localizes @ panel tabs and empty states in en mode", async () => {
    plugins = [];
    skills = [];
    servers = [];
    renderComposer({}, { locale: "en" });
    await flushMounts();

    await typeAndSettle('@');

    await waitFor(() => expect(screen.getByRole('tab', { name: "All" })).toBeTruthy());
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      "All",
      "Design files",
      "Tabs",
      'Plugins',
      'Skills',
      'MCP',
      "Connectors",
    ]);
    expect(screen.getByRole('tab', { name: 'Plugins' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Skills' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'MCP' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: "Connectors" })).toBeTruthy();
    expect(screen.getByRole('tab', { name: "Design files" })).toBeTruthy();
    expect(screen.getByRole('tab', { name: "Tabs" })).toBeTruthy();
    expect(screen.getByText("Search Design Files, tabs, plugins, skills, MCP servers, and connectors.")).toBeTruthy();

    await typeAndSettle('@missing');

    await waitFor(() => expect(screen.getByText("No results for “missing”.")).toBeTruthy());
  });

  it('describes /mcp slash commands as MCP actions instead of pet actions', async () => {
    renderComposer();
    await flushMounts();

    await typeAndSettle('/');

    const popover = await screen.findByTestId('slash-popover');
    const settingsRow = within(popover).getByText('/mcp').closest('button');
    const mcpRow = within(popover).getByText('/mcp slack').closest('button');
    expect(settingsRow).toBeTruthy();
    expect(mcpRow).toBeTruthy();
    expect(settingsRow?.textContent).toContain('Open MCP server settings or insert a server tool hint.');
    expect(settingsRow?.textContent).not.toContain('Toggle, adopt, or jump to pet settings.');
    expect(mcpRow?.textContent).toContain('Open MCP server settings or insert a server tool hint.');
    expect(mcpRow?.textContent).not.toContain('Toggle, adopt, or jump to pet settings.');
  });

  it('lists Design Files first in All and picks the first file with Enter', async () => {
    renderComposer({
      projectFiles: [
        {
          path: 'designs/landing.html',
          name: 'landing.html',
          kind: 'html',
          mime: 'text/html',
          mtime: 1,
          size: 128,
        },
      ],
      workspaceContexts: [
        {
          id: 'browser:__browser__:1',
          kind: 'browser' as const,
          label: 'Dribbble',
          title: 'Dribbble - Discover designers',
          url: 'https://dribbble.com/',
          tabId: '__browser__:1',
        },
      ],
    });
    await flushMounts();

    await typeAndSettle('@');

    await waitFor(() => expect(screen.getByText('designs/landing.html')).toBeTruthy());
    const labels = Array.from(
      screen.getByTestId('mention-popover').querySelectorAll('[data-testid="mention-section-label"]'),
      (node) => node.textContent,
    );
    expect(labels[0]).toBe('Design files');
    expect(labels[1]).toBe('Tabs');

    pressEnter();

    await waitFor(() => expect(composerText()).toBe('@designs/landing.html '));
    // 待发送附件已经搬进自己的托盘(设计稿组件 21):`.composer > .tray` 只装附件,
    // 不再和 plugin / skill / MCP 芯片挤在同一行。
    expect(screen.getByTestId('staged-attachments').textContent).toContain('landing.html');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/apply'))).toBe(false);
  });

  it('searches workspace tabs from @ and sends the selected tab context', async () => {
    const onSend = vi.fn();
    const browserContext = {
      id: 'browser:__browser__:1',
      kind: 'browser' as const,
      label: 'Dribbble',
      title: 'Dribbble - Discover designers',
      url: 'https://dribbble.com/',
      tabId: '__browser__:1',
    };
    renderComposer({
      onSend,
      workspaceContexts: [browserContext],
    });
    await flushMounts();

    await typeAndSettle('@drib');

    await waitFor(() => expect(screen.getByText('Dribbble')).toBeTruthy());
    const labels = Array.from(
      screen.getByTestId('mention-popover').querySelectorAll('[data-testid="mention-section-label"]'),
      (node) => node.textContent,
    );
    expect(labels[0]).toBe('Tabs');
    fireEvent.click(screen.getByText('Dribbble'));

    await waitFor(() => expect(composerText()).toBe('@Dribbble '));
    const pill = screen
      .getByTestId('chat-composer-input')
      .querySelector('[data-mention-kind]');
    expect(pill?.getAttribute('data-mention-kind')).toBe('workspace');
    expect(screen.getByTestId('staged-contexts').textContent).toContain('BrowserDribbble');

    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems).toEqual([browserContext]);
  });

  it.each(['picker', 'queued draft'] as const)('allows a removed tab to be deliberately re-added through the %s', async (route) => {
    const context = { id: 'browser:1', kind: 'browser' as const, label: 'Dribbble', url: 'https://dribbble.com/' };
    const onSend = vi.fn();
    const composerRef = createRef<ChatComposerHandle>();
    render(<ChatComposer ref={composerRef} {...composerElement({ workspaceContexts: [context], onSend }).props} />);
    await flushMounts();
    await typeAndSettle('@drib');
    fireEvent.click(await screen.findByText('Dribbble'));
    await screen.findByLabelText('Remove Dribbble');
    fireEvent.click(screen.getByLabelText('Remove Dribbble'));
    await waitFor(() => expect(screen.queryByLabelText('Remove Dribbble')).toBeNull());

    if (route === 'picker') {
      await typeAndSettle('@drib');
      fireEvent.click(await screen.findByText('Dribbble'));
    } else {
      await act(async () => { await composerRef.current?.restoreDraft({ text: '@Dribbble queued work', meta: { context: { workspaceItems: [context] } } }); });
    }

    await waitFor(() => expect(screen.getByTestId('chat-composer-input').querySelector('[data-mention-id="browser:1"]')).not.toBeNull());
    expect(screen.getByLabelText('Remove Dribbble')).toBeTruthy();
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems).toEqual([context]);
    expect(projectPatchBodies()).toEqual([]);
  });

  // Only directory-shaped contexts (`local-code` / `project`) may contribute a
  // linked dir; a `file` context never does, no matter what its `absolutePath`
  // looks like. #5517 removed the in-project working-dir row that used to drive
  // this, so it is now driven through the surviving "+" → Link local code path:
  // the linked folder deliberately collides with the active FILE context's
  // absolutePath. If a file context were ever counted as a directory owner,
  // `workspaceContextDirStillReferenced` would treat the dir as still in use and
  // swallow the unlink — the second PATCH below would never happen.
  it('never counts an active file context path as a linked dir', async () => {
    openFolderPaths = ['/Users/me/new-work-dir'];
    const onProjectMetadataChange = vi.fn();

    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({
        kind: 'prototype',
        linkedDirs: ['/Users/me/work-dir'],
      });
      return composerElement({
        activeWorkspaceContext: {
          id: 'file:index.html',
          kind: 'file',
          label: 'index.html',
          path: 'index.html',
          absolutePath: '/Users/me/new-work-dir',
          tabId: 'index.html',
        },
        projectMetadata: metadata,
        onProjectMetadataChange: (next) => {
          onProjectMetadataChange(next);
          // main 把回调从 ProjectMetadata 拓宽成整个 Project(#5379 之后的
          // 工作目录流程需要 project 层字段),这里的受控 state 仍只关心 metadata。
          if (next.metadata) setMetadata(next.metadata);
        },
      });
    }

    render(<ControlledComposer />);
    await flushMounts();

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(1);
    });
    expect(projectPatchBodies()[0]?.metadata?.linkedDirs).toEqual([
      '/Users/me/work-dir',
      '/Users/me/new-work-dir',
    ]);

    fireEvent.click(screen.getByLabelText('Remove new-work-dir'));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(2);
    });
    expect(projectPatchBodies()[1]?.metadata?.linkedDirs).toEqual(['/Users/me/work-dir']);
    expect(onProjectMetadataChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ linkedDirs: ['/Users/me/work-dir'] }),
      }),
    );
  });

  it('removes the linked dir added for a local-code context when its chip is cleared', async () => {
    const onProjectMetadataChange = vi.fn();
    renderComposer({
      projectMetadata: { kind: 'prototype' },
      onProjectMetadataChange,
    });
    await flushMounts();

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));

    await waitFor(() => {
      expect(screen.getByTestId('staged-contexts').textContent).toContain('reference-dir');
    });
    expect(projectPatchBodies()[0]?.metadata?.linkedDirs).toEqual(['/Users/me/reference-dir']);

    fireEvent.click(screen.getByLabelText('Remove reference-dir'));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(2);
    });
    expect(projectPatchBodies()[1]?.metadata?.linkedDirs).toEqual([]);
    await waitFor(() => {
      expect(screen.queryByText('reference-dir')).toBeNull();
    });
    expect(onProjectMetadataChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ linkedDirs: [] }),
      }),
    );
  });

  it('removes local-code access and next-turn context when its inline token is deleted', async () => {
    const onSend = vi.fn();
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return composerElement({ projectMetadata: metadata, onSend,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      });
    }
    render(<ControlledComposer />);
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));

    await typeAndSettle('Use only this prompt.');

    await waitFor(() => expect(projectPatchBodies()).toHaveLength(2));
    expect(projectPatchBodies()[1]?.metadata?.linkedDirs).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId('staged-contexts')?.textContent ?? '').not.toContain('reference-dir'));
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems ?? []).toEqual([]);
  });

  it('blocks the next turn until inline local-code removal is persisted without losing new text', async () => {
    const onSend = vi.fn();
    renderComposer({ projectMetadata: { kind: 'prototype' }, onSend });
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    deferNextProjectPatch = true;

    await typeAndSettle('Continue without the folder.');

    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());
    expect((screen.getByTestId('chat-send') as HTMLButtonElement).disabled).toBe(true);
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();
    await typeAndSettle('Keep this newer prompt.');
    await act(async () => { resolveDeferredProjectPatch?.(); await Promise.resolve(); });
    await waitFor(() => expect((screen.getByTestId('chat-send') as HTMLButtonElement).disabled).toBe(false));
    expect(composerText()).toBe('Keep this newer prompt.');
  });

  it('restores the inline local-code token and reports failed access removal', async () => {
    const onSend = vi.fn();
    const onShowToast = vi.fn();
    renderComposer({ projectMetadata: { kind: 'prototype' }, onSend, onShowToast });
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    rejectNextProjectPatch = true;

    await typeAndSettle('Keep my changed prompt.');

    await waitFor(() => expect(projectPatchBodies()).toHaveLength(2));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    expect(composerText()).toContain('Keep my changed prompt.');
    expect(onShowToast).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems).toEqual([
      expect.objectContaining({ absolutePath: '/Users/me/reference-dir' }),
    ]);
  });

  it('persists both inline folder removals in order while preserving the working directory', async () => {
    openFolderPaths = ['/Users/me/first-reference', '/Users/me/second-reference'];
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype', linkedDirs: ['/Users/me/work-dir'] });
      return composerElement({ projectMetadata: metadata,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      });
    }
    render(<ControlledComposer />);
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));
    await waitFor(() => expect(composerText()).toContain('@first-reference'));
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(composerText()).toContain('@second-reference'));
    deferNextProjectPatch = true;

    await typeAndSettle('Use the working directory only.');

    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());
    expect(projectPatchBodies()).toHaveLength(3);
    expect(projectPatchBodies()[2]?.metadata?.linkedDirs).toEqual(['/Users/me/work-dir', '/Users/me/second-reference']);
    await act(async () => { resolveDeferredProjectPatch?.(); await Promise.resolve(); });
    await waitFor(() => expect(projectPatchBodies()).toHaveLength(4));
    expect(projectPatchBodies()[3]?.metadata?.linkedDirs).toEqual(['/Users/me/work-dir']);
    await waitFor(() => expect(screen.queryByTestId('staged-contexts')?.textContent ?? '').not.toContain('reference'));
    expect(composerText()).toBe('Use the working directory only.');
  });

  it('keeps a newly linked folder when an earlier inline removal finishes later', async () => {
    openFolderPaths = ['/Users/me/old-reference', '/Users/me/new-reference'];
    const onProjectMetadataChange = vi.fn();
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype', linkedDirs: ['/Users/me/work-dir'] });
      return composerElement({ projectMetadata: metadata,
        onProjectMetadataChange: (project) => {
          onProjectMetadataChange(project);
          if (project.metadata) setMetadata(project.metadata);
        },
      });
    }
    render(<ControlledComposer />);
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(composerText()).toContain('@old-reference'));
    deferNextProjectPatch = true;
    await typeAndSettle('Use the new reference instead.');
    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/dialog/open-folder')).toHaveLength(2));
    // Drain the picker response so the new link has reached persistence (or
    // its serialization queue) before the earlier removal is released.
    await flushMounts();
    await act(async () => { resolveDeferredProjectPatch?.(); await Promise.resolve(); });

    await waitFor(() => expect(composerText()).toContain('@new-reference'));
    await waitFor(() => expect(onProjectMetadataChange).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ linkedDirs: ['/Users/me/work-dir', '/Users/me/new-reference'] }),
    })));
    expect(projectPatchBodies()).toHaveLength(3);
    expect(onProjectMetadataChange).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ linkedDirs: ['/Users/me/work-dir', '/Users/me/new-reference'] }),
    }));
    expect(screen.getByTestId('staged-contexts').textContent).toContain('new-reference');
    expect(screen.getByTestId('staged-contexts').textContent).not.toContain('old-reference');
  });

  it('keeps linked access when the host programmatically replaces the draft', async () => {
    const ref = createRef<ChatComposerHandle>();
    const onSend = vi.fn();
    renderComposer({ ref, projectMetadata: { kind: 'prototype' }, onSend });
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));

    await act(async () => { ref.current?.setDraft('The host supplied this prompt.'); });
    await flushMounts();

    expect(projectPatchBodies()).toHaveLength(1);
    expect(screen.getByTestId('staged-contexts').textContent).toContain('reference-dir');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems).toEqual([
      expect.objectContaining({ absolutePath: '/Users/me/reference-dir' }),
    ]);
  });

  it('does not restore a revoked context when an earlier send finishes', async () => {
    let finishSend: (() => void) | undefined;
    const onSend = vi.fn<ComponentProps<typeof ChatComposer>['onSend']>(() => new Promise<void>((resolve) => { finishSend = resolve; }));
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return composerElement({ projectMetadata: metadata, onSend,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      });
    }
    render(<ControlledComposer />);
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(finishSend).toBeTruthy());

    await typeAndSettle('Use only this newer prompt.');
    await waitFor(() => expect(projectPatchBodies()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('staged-contexts')?.textContent ?? '').not.toContain('reference-dir'));
    await act(async () => { finishSend?.(); await Promise.resolve(); });

    expect(screen.queryByTestId('staged-contexts')?.textContent ?? '').not.toContain('reference-dir');
    expect(composerText()).toBe('Use only this newer prompt.');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1]?.[3]?.context?.workspaceItems ?? []).toEqual([]);
  });

  it('waits for context removal before acknowledging an annotation send', async () => {
    const onSend = vi.fn();
    const ack = vi.fn();
    renderComposer({ projectMetadata: { kind: 'prototype' }, onSend });
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    deferNextProjectPatch = true;
    await typeAndSettle('Continue without that reference.');
    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());

    await act(async () => {
      window.dispatchEvent(new CustomEvent('mish:annotation', { detail: {
        action: 'send', note: 'Update the marked region.', ack,
      } }));
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    await act(async () => { resolveDeferredProjectPatch?.(); await Promise.resolve(); });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toContain('Update the marked region.');
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems ?? []).toEqual([]);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  it('preserves the current text selection when restoring a failed inline removal', async () => {
    renderComposer({ projectMetadata: { kind: 'prototype' } });
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    deferNextProjectPatch = true;
    await typeAndSettle('Keep the current selection.', 5);
    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());
    act(() => {
      getComposerEditor().update(() => {
        const text = $getRoot().getFirstDescendant();
        if (!$isTextNode(text)) throw new Error('Expected text node');
        text.select(5, 11);
      }, { discrete: true });
    });
    const selectionBefore = getComposerEditor().getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error('Expected range selection');
      return { anchor: { key: selection.anchor.key, offset: selection.anchor.offset },
        focus: { key: selection.focus.key, offset: selection.focus.offset } };
    });
    rejectNextProjectPatch = true;

    await act(async () => { resolveDeferredProjectPatch?.(); await Promise.resolve(); });

    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    expect(composerText()).toContain('Keep the current selection.');
    getComposerEditor().getEditorState().read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) {
        expect({ anchor: { key: selection.anchor.key, offset: selection.anchor.offset },
          focus: { key: selection.focus.key, offset: selection.focus.offset } }).toEqual(selectionBefore);
        expect(selection.isCollapsed()).toBe(false);
      }
    });
  });

  it.each(['replace', 'clear'] as const)('keeps a working-directory %s made while inline removal is pending', async (action) => {
    openFolderPaths = ['/Users/me/reference-dir', '/Users/me/new-work-dir'];
    const onProjectMetadataChange = vi.fn();
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype', linkedDirs: ['/Users/me/work-dir'] });
      return composerElement({ projectMetadata: metadata,
        onProjectMetadataChange: (project) => {
          onProjectMetadataChange(project);
          if (project.metadata) setMetadata(project.metadata);
        },
      });
    }
    render(<ControlledComposer />);
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    deferNextProjectPatch = true;
    await typeAndSettle('Continue without that reference.');
    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-working-dir'));
    fireEvent.click(await screen.findByTestId(action === 'replace'
      ? 'composer-plus-working-dir-pick'
      : 'composer-plus-working-dir-clear'));
    if (action === 'replace') {
      await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/dialog/open-folder')).toHaveLength(2));
    }
    await flushMounts();
    await act(async () => { resolveDeferredProjectPatch?.(); await Promise.resolve(); });

    const expectedDirs = action === 'replace' ? ['/Users/me/new-work-dir'] : [];
    await waitFor(() => expect(onProjectMetadataChange).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ linkedDirs: expectedDirs }),
    })));
    expect(projectPatchBodies()).toHaveLength(3);
    expect(projectPatchBodies()[2]?.metadata?.linkedDirs).toEqual(expectedDirs);
    expect(screen.queryByTestId('staged-contexts')?.textContent ?? '').not.toContain('reference-dir');
  });

  it.each(['first', 'second'] as const)('revokes only the %s of two identically labeled inline folder mentions', async (which) => {
    const first = '/Users/me/one/src';
    const second = '/Users/me/two/src';
    openFolderPaths = [first, second];
    const onSend = vi.fn();
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return composerElement({ projectMetadata: metadata, onSend,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      });
    }
    render(<ControlledComposer />);
    await flushMounts();
    await typeAndSettle('Keep this prose. ');
    for (const dir of [first, second]) {
      fireEvent.click(screen.getByTestId('chat-plus-trigger'));
      fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
      await waitFor(() => expect(screen.getByTestId('chat-composer-input').querySelector(`[data-mention-id="local-code:${dir}"]`)).not.toBeNull());
    }
    const removed = which === 'first' ? first : second;
    const survivor = which === 'first' ? second : first;
    deferNextProjectPatch = true;
    act(() => {
      getComposerEditor().update(() => {
        const paragraph = $getRoot().getFirstChild();
        if (!$isElementNode(paragraph)) throw new Error('Expected paragraph');
        const mention = paragraph.getChildren().find((node) => $isMentionNode(node) && node.getEntity().id === `local-code:${removed}`);
        if (!mention) throw new Error('Expected selected mention');
        mention.remove();
        paragraph.selectEnd();
      }, { discrete: true, tag: HISTORY_PUSH_TAG });
    });
    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());
    const selectionBefore = getComposerEditor().getEditorState().read(() => $getSelection()?.clone());
    await act(async () => { resolveDeferredProjectPatch?.(); await Promise.resolve(); });

    await waitFor(() => expect(projectPatchBodies()[2]?.metadata?.linkedDirs).toEqual([survivor]));
    expect(screen.getByTestId('chat-composer-input').querySelector(`[data-mention-id="local-code:${survivor}"]`)).not.toBeNull();
    expect(composerText()).toContain('@src');
    expect(composerText()).toContain('Keep this prose.');
    getComposerEditor().getEditorState().read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection) && $isRangeSelection(selectionBefore)) {
        expect([selection.anchor.key, selection.anchor.offset, selection.anchor.type])
          .toEqual([selectionBefore.anchor.key, selectionBefore.anchor.offset, selectionBefore.anchor.type]);
        expect([selection.focus.key, selection.focus.offset, selection.focus.type])
          .toEqual([selectionBefore.focus.key, selectionBefore.focus.offset, selectionBefore.focus.type]);
      }
    });
    expect(screen.getAllByLabelText('Remove src')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems).toEqual([
      expect.objectContaining({ absolutePath: survivor }),
    ]);
  });

  it.each(['annotation append', 'skill removal'] as const)('preserves duplicate workspace IDs through an unrelated %s', async (rewrite) => {
    const first = '/Users/me/one/src';
    const second = '/Users/me/two/src';
    openFolderPaths = [first, second];
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return composerElement({ projectMetadata: metadata,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      });
    }
    render(<ControlledComposer />);
    await flushMounts();
    await typeAndSettle('@deck');
    fireEvent.click(await screen.findByText('Deck Builder'));
    await screen.findByLabelText('Remove Deck Builder');
    for (const dir of [first, second]) {
      fireEvent.click(screen.getByTestId('chat-plus-trigger'));
      fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
      await waitFor(() => expect(screen.getByTestId('chat-composer-input').querySelector(`[data-mention-id="local-code:${dir}"]`)).not.toBeNull());
    }

    if (rewrite === 'skill removal') fireEvent.click(screen.getByLabelText('Remove Deck Builder'));
    else await act(async () => {
      window.dispatchEvent(new CustomEvent('mish:annotation', { detail: { action: 'draft', note: 'Keep this annotation.' } }));
    });

    const input = screen.getByTestId('chat-composer-input');
    await waitFor(() => expect(input.querySelector(`[data-mention-id="local-code:${second}"]`)).not.toBeNull());
    expect(input.querySelector(`[data-mention-id="local-code:${first}"]`)).not.toBeNull();
    if (rewrite === 'annotation append') expect(composerText()).toContain('Keep this annotation.');
    act(() => {
      getComposerEditor().update(() => {
        const mention = $getRoot().getAllTextNodes().find((node) => $isMentionNode(node) && node.getEntity().id === `local-code:${second}`);
        if (!mention) throw new Error('Expected second folder mention');
        mention.remove();
      }, { discrete: true });
    });
    await waitFor(() => expect(projectPatchBodies().at(-1)?.metadata?.linkedDirs).toEqual([first]));
    expect(input.querySelector(`[data-mention-id="local-code:${first}"]`)).not.toBeNull();
    expect(screen.getAllByLabelText('Remove src')).toHaveLength(1);
  });

  it('retains the complete queued payload when its folder grant is rejected', async () => {
    const composerRef = createRef<ChatComposerHandle>();
    const onSend = vi.fn();
    const onShowToast = vi.fn();
    const onRestoreQuotes = vi.fn();
    const context = { id: 'local-code:/Users/me/reference-dir', kind: 'local-code' as const, label: 'reference-dir', absolutePath: '/Users/me/reference-dir' };
    const attachment = { path: 'brief.md', name: 'brief.md', kind: 'file' as const, order: 1 };
    const mark = {
      id: 'mark-1', order: 1, filePath: 'preview.html', comment: 'Keep this mark.',
      elementId: 'hero', selector: '#hero', label: 'Hero', currentText: 'Original hero',
      pagePosition: { x: 10, y: 20, width: 30, height: 40 }, htmlHint: '<section id="hero">',
    };
    const quote = { id: 'quote-1', messageId: 'assistant-1', text: 'Keep this quote.' };
    render(<ChatComposer ref={composerRef} {...composerElement({ projectMetadata: { kind: 'prototype' }, onSend, onShowToast, onRestoreQuotes }).props} />);
    await flushMounts();
    await typeAndSettle('Old draft.');
    rejectNextProjectPatch = true;
    let restored: unknown;
    act(() => { restored = composerRef.current?.restoreDraft({
      text: '@reference-dir Keep every word.', attachments: [attachment], commentAttachments: [mark], quotes: [quote],
      meta: { context: { workspaceItems: [context] } },
    }); });

    expect(restored).toBe(true);
    expect(composerText()).toContain('Keep every word.');
    expect(screen.getByLabelText('Remove brief.md')).toBeTruthy();
    expect(onRestoreQuotes).toHaveBeenCalledWith([quote]);
    await waitFor(() => expect(onShowToast).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('chat-send-pending')).toBeNull());
    expect(composerText()).toContain('reference-dir');
    expect(composerText()).toContain('Keep every word.');
    expect(screen.queryByLabelText('Remove reference-dir')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[1]).toEqual([attachment]);
    expect(onSend.mock.calls[0]?.[2]).toEqual([mark]);
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems ?? []).toEqual([]);
  });

  it('blocks typing and Enter while restoring queued folder access without rewriting later text', async () => {
    const composerRef = createRef<ChatComposerHandle>();
    const onSend = vi.fn();
    const context = { id: 'local-code:/Users/me/reference-dir', kind: 'local-code' as const, label: 'reference-dir', absolutePath: '/Users/me/reference-dir' };
    render(<ChatComposer ref={composerRef} {...composerElement({ projectMetadata: { kind: 'prototype' }, onSend }).props} />);
    await flushMounts();
    deferNextProjectPatch = true;
    act(() => { void composerRef.current?.restoreDraft({ text: '@reference-dir Restored work.', meta: { context: { workspaceItems: [context] } } }); });

    expect(composerText()).toContain('Restored work.');
    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());
    expect(getComposerEditor().isEditable()).toBe(false);
    expect(screen.getByTestId('chat-send-pending').getAttribute('aria-busy')).toBe('true');
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { resolveDeferredProjectPatch?.(); await Promise.resolve(); });
    await waitFor(() => expect(getComposerEditor().isEditable()).toBe(true));
    act(() => {
      getComposerEditor().update(() => {
        $getRoot().selectEnd();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(' New edit.');
      }, { discrete: true });
    });
    await flushMounts();
    expect(composerText()).toContain('Restored work.');
    expect(composerText()).toContain('New edit.');
    expect(screen.getByLabelText('Remove reference-dir')).toBeTruthy();
  });

  it('aborts a stalled queued-folder grant, retains its text, and ignores late completion', async () => {
    reconcileProjectReads = true;
    const composerRef = createRef<ChatComposerHandle>();
    const onShowToast = vi.fn();
    const context = { id: 'local-code:/Users/me/reference-dir', kind: 'local-code' as const, label: 'reference-dir', absolutePath: '/Users/me/reference-dir' };
    render(<ChatComposer ref={composerRef} {...composerElement({ projectMetadata: { kind: 'prototype' }, onShowToast }).props} />);
    await flushMounts();
    vi.useFakeTimers();
    deferNextProjectPatch = true;
    await act(async () => {
      void composerRef.current?.restoreDraft({ text: '@reference-dir Keep this text.', meta: { context: { workspaceItems: [context] } } });
      await Promise.resolve();
    });
    const lateCompletion = resolveDeferredProjectPatch;
    expect(lateCompletion).toBeTruthy();
    expect(getComposerEditor().isEditable()).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    expect(getComposerEditor().isEditable()).toBe(true);
    expect(screen.queryByTestId('chat-send-pending')).toBeNull();
    expect(composerText()).toContain('reference-dir');
    expect(composerText()).toContain('Keep this text.');
    expect(screen.queryByLabelText('Remove reference-dir')).toBeNull();
    expect(onShowToast).toHaveBeenCalledTimes(1);
    const stalledRequest = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/projects/project-1' && init?.method === 'PATCH');
    expect(stalledRequest?.[1]?.signal?.aborted).toBe(true);
    await act(async () => { lateCompletion?.(); await Promise.resolve(); });
    expect(screen.queryByLabelText('Remove reference-dir')).toBeNull();
    vi.useRealTimers();
    openFolderPaths = ['/Users/me/new-folder'];
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await screen.findByLabelText('Remove new-folder');
    expect(projectPatchBodies().at(-1)?.metadata?.linkedDirs).toEqual(['/Users/me/new-folder']);
  });

  it('releases a stalled removal before the next queued folder restoration', async () => {
    reconcileProjectReads = true;
    const composerRef = createRef<ChatComposerHandle>();
    const context = { id: 'local-code:/Users/me/new-folder', kind: 'local-code' as const, label: 'new-folder', absolutePath: '/Users/me/new-folder' };
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return <ChatComposer ref={composerRef} {...composerElement({ projectMetadata: metadata,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      }).props} />;
    }
    render(<ControlledComposer />);
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await screen.findByLabelText('Remove reference-dir');
    vi.useFakeTimers();
    deferNextProjectPatch = true;
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Remove reference-dir'));
      await Promise.resolve();
    });
    expect(resolveDeferredProjectPatch).toBeTruthy();
    act(() => { void composerRef.current?.restoreDraft({ text: '@new-folder Restored work.', meta: { context: { workspaceItems: [context] } } }); });

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    expect(getComposerEditor().isEditable()).toBe(true);
    expect(screen.queryByTestId('chat-send-pending')).toBeNull();
    expect(screen.getByLabelText('Remove new-folder')).toBeTruthy();
    expect(projectPatchBodies().at(-1)?.metadata?.linkedDirs).toEqual(['/Users/me/reference-dir', '/Users/me/new-folder']);
    expect(composerText()).toContain('Restored work.');
  });

  it('reconciles a folder grant committed before the response body times out', async () => {
    const composerRef = createRef<ChatComposerHandle>();
    const context = { id: 'local-code:/Users/me/reference-dir', kind: 'local-code' as const, label: 'reference-dir', absolutePath: '/Users/me/reference-dir' };
    reconcileProjectReads = true;
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return <ChatComposer ref={composerRef} {...composerElement({ projectMetadata: metadata,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      }).props} />;
    }
    render(<ControlledComposer />);
    await flushMounts();
    vi.useFakeTimers();
    commitBeforeAbortNextProjectPatch = true;
    await act(async () => {
      composerRef.current?.restoreDraft({ text: '@reference-dir Keep this work.', meta: { context: { workspaceItems: [context] } } });
      await Promise.resolve();
    });
    expect(serverProject.metadata?.linkedDirs).toEqual(['/Users/me/reference-dir']);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    vi.useRealTimers();
    expect(screen.getByLabelText('Remove reference-dir')).toBeTruthy();
    expect(composerText()).toContain('Keep this work.');
    expect(getComposerEditor().isEditable()).toBe(true);
    openFolderPaths = ['/Users/me/new-folder'];
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await screen.findByLabelText('Remove new-folder');
    expect(projectPatchBodies().at(-1)?.metadata?.linkedDirs).toEqual(['/Users/me/reference-dir', '/Users/me/new-folder']);
    fireEvent.click(screen.getByLabelText('Remove reference-dir'));
    await waitFor(() => expect(serverProject.metadata?.linkedDirs).toEqual(['/Users/me/new-folder']));
  });

  it('reconciles a folder revoke committed before timeout without resurrecting it in the next mutation', async () => {
    reconcileProjectReads = true;
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return composerElement({ projectMetadata: metadata,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      });
    }
    render(<ControlledComposer />);
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await screen.findByLabelText('Remove reference-dir');
    vi.useFakeTimers();
    commitBeforeAbortNextProjectPatch = true;
    await act(async () => { fireEvent.click(screen.getByLabelText('Remove reference-dir')); await Promise.resolve(); });
    expect(serverProject.metadata?.linkedDirs).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    vi.useRealTimers();
    expect(screen.queryByLabelText('Remove reference-dir')).toBeNull();
    openFolderPaths = ['/Users/me/new-folder'];
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await screen.findByLabelText('Remove new-folder');
    expect(projectPatchBodies().at(-1)?.metadata?.linkedDirs).toEqual(['/Users/me/new-folder']);
    expect(serverProject.metadata?.linkedDirs).toEqual(['/Users/me/new-folder']);
  });

  it('keeps canonical folder bindings through a successful grant, next write, and revoke', async () => {
    const raw = '/tmp/reference-dir';
    const canonical = '/private/tmp/reference-dir';
    const nextDir = '/Users/me/next-folder';
    canonicalProjectDirs = { [raw]: canonical };
    reconcileProjectReads = true;
    openFolderPaths = [raw, nextDir];
    const onSend = vi.fn();
    const onShowToast = vi.fn();
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return composerElement({ projectMetadata: metadata, onSend, onShowToast,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      });
    }
    render(<ControlledComposer />);
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await screen.findByLabelText('Remove reference-dir');
    expect(serverProject.metadata?.linkedDirs).toEqual([canonical]);
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await screen.findByLabelText('Remove next-folder');
    expect(projectPatchBodies().at(-1)?.metadata?.linkedDirs).toEqual([canonical, nextDir]);
    fireEvent.click(screen.getByLabelText('Remove reference-dir'));
    await waitFor(() => expect(serverProject.metadata?.linkedDirs).toEqual([nextDir]));
    expect(screen.queryByLabelText('Remove reference-dir')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems).toEqual([
      expect.objectContaining({ absolutePath: nextDir }),
    ]);
    expect(onShowToast).not.toHaveBeenCalled();
  });

  it('restores explicit aliases with canonical identities even when the daemon deduplicates them', async () => {
    const first = '/tmp/first-alias';
    const second = '/tmp/second-alias';
    const canonical = '/private/tmp/shared-folder';
    const otherRaw = '/tmp/other-folder';
    const otherCanonical = '/private/tmp/other-folder';
    const nextDir = '/Users/me/next-folder';
    canonicalProjectDirs = { [first]: canonical, [second]: canonical, [otherRaw]: otherCanonical };
    reconcileProjectReads = true;
    const composerRef = createRef<ChatComposerHandle>();
    const onSend = vi.fn();
    const contexts = [first, second, otherRaw].map((absolutePath) => ({
      id: `local-code:${absolutePath}`, kind: 'local-code' as const,
      label: absolutePath.split('/').at(-1)!, absolutePath,
    }));
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return <ChatComposer ref={composerRef} {...composerElement({ projectMetadata: metadata, onSend,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      }).props} />;
    }
    render(<ControlledComposer />);
    await flushMounts();
    act(() => { expect(composerRef.current?.restoreDraft({
      text: '@first-alias @second-alias @other-folder Keep my work.',
      meta: { context: { workspaceItems: contexts } },
    })).toBe(true); });
    await screen.findByLabelText('Remove other-folder');
    expect(serverProject.metadata?.linkedDirs).toEqual([canonical, otherCanonical]);
    openFolderPaths = [nextDir];
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await screen.findByLabelText('Remove next-folder');
    expect(projectPatchBodies().at(-1)?.metadata?.linkedDirs).toEqual([canonical, otherCanonical, nextDir]);
    fireEvent.click(screen.getByLabelText('Remove first-alias'));
    await waitFor(() => expect(screen.queryByLabelText('Remove first-alias')).toBeNull());
    expect(serverProject.metadata?.linkedDirs).toContain(canonical);
    fireEvent.click(screen.getByLabelText('Remove second-alias'));
    await waitFor(() => expect(serverProject.metadata?.linkedDirs).toEqual([otherCanonical, nextDir]));
    expect(composerText()).toContain('Keep my work.');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems).toEqual([
      expect.objectContaining({ id: contexts[2]!.id, absolutePath: otherCanonical }),
      expect.objectContaining({ absolutePath: nextDir }),
    ]);
  });

  it('keeps a canonical grant unknown when only a reconciliation GET survives the body timeout', async () => {
    const raw = '/tmp/reference-dir';
    const canonical = '/private/tmp/reference-dir';
    canonicalProjectDirs = { [raw]: canonical };
    reconcileProjectReads = true;
    const composerRef = createRef<ChatComposerHandle>();
    const onShowToast = vi.fn();
    const onSend = vi.fn();
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return <ChatComposer ref={composerRef} {...composerElement({ projectMetadata: metadata, onSend, onShowToast,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      }).props} />;
    }
    render(<ControlledComposer />);
    await flushMounts();
    vi.useFakeTimers();
    commitBeforeAbortNextProjectPatch = true;
    await act(async () => { composerRef.current?.restoreDraft({ text: '@reference-dir Keep my work.', meta: { context: {
      workspaceItems: [{ id: `local-code:${raw}`, kind: 'local-code', label: 'reference-dir', absolutePath: raw }],
    } } }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    vi.useRealTimers();
    expect(serverProject.metadata?.linkedDirs).toEqual([canonical]);
    expect(onShowToast).toHaveBeenCalledWith('Folder access could not be confirmed. Reload this project before sending or changing folder access.');
    expect(composerText()).toContain('Keep my work.');
    expect(screen.queryByLabelText('Remove reference-dir')).toBeNull();
    expect((screen.getByTestId('chat-send') as HTMLButtonElement).disabled).toBe(true);
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();
    openFolderPaths = ['/Users/me/next-folder'];
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await flushMounts();
    expect(projectPatchBodies()).toHaveLength(1);
    expect(serverProject.metadata?.linkedDirs).toEqual([canonical]);
  });

  it('blocks sending and stale metadata writes when timed-out folder access cannot be reconciled', async () => {
    const composerRef = createRef<ChatComposerHandle>();
    const onSend = vi.fn();
    const onShowToast = vi.fn();
    const context = { id: 'local-code:/Users/me/reference-dir', kind: 'local-code' as const, label: 'reference-dir', absolutePath: '/Users/me/reference-dir' };
    reconcileProjectReads = true;
    failProjectReconcileRead = true;
    render(<ChatComposer ref={composerRef} {...composerElement({ projectMetadata: { kind: 'prototype' }, onSend, onShowToast }).props} />);
    await flushMounts();
    vi.useFakeTimers();
    commitBeforeAbortNextProjectPatch = true;
    await act(async () => {
      composerRef.current?.restoreDraft({ text: '@reference-dir Keep this work.', meta: { context: { workspaceItems: [context] } } });
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    vi.useRealTimers();
    expect(onShowToast).toHaveBeenCalledWith('Folder access could not be confirmed. Reload this project before sending or changing folder access.');
    expect(composerText()).toContain('Keep this work.');
    expect(getComposerEditor().isEditable()).toBe(true);
    expect((screen.getByTestId('chat-send') as HTMLButtonElement).disabled).toBe(true);
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();
    const writesBefore = projectPatchBodies().length;
    openFolderPaths = ['/Users/me/new-folder'];
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await flushMounts();
    expect(projectPatchBodies()).toHaveLength(writesBefore);
    expect(serverProject.metadata?.linkedDirs).toEqual(['/Users/me/reference-dir']);
  });

  it('bounds a stalled folder-state reconciliation and keeps sending blocked with its text intact', async () => {
    const composerRef = createRef<ChatComposerHandle>();
    const onSend = vi.fn();
    const onShowToast = vi.fn();
    const context = { id: 'local-code:/Users/me/reference-dir', kind: 'local-code' as const, label: 'reference-dir', absolutePath: '/Users/me/reference-dir' };
    reconcileProjectReads = true;
    stallProjectReconcileRead = true;
    render(<ChatComposer ref={composerRef} {...composerElement({ projectMetadata: { kind: 'prototype' }, onSend, onShowToast }).props} />);
    await flushMounts();
    vi.useFakeTimers();
    commitBeforeAbortNextProjectPatch = true;
    await act(async () => {
      composerRef.current?.restoreDraft({ text: '@reference-dir Keep this work.', meta: { context: { workspaceItems: [context] } } });
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    vi.useRealTimers();
    const reconciliation = fetchMock.mock.calls.find(([url, init]) => url === '/api/projects/project-1' && init?.method !== 'PATCH');
    expect(reconciliation?.[1]?.signal?.aborted).toBe(true);
    expect(onShowToast).toHaveBeenCalledWith('Folder access could not be confirmed. Reload this project before sending or changing folder access.');
    expect(composerText()).toContain('Keep this work.');
    expect(getComposerEditor().isEditable()).toBe(true);
    expect((screen.getByTestId('chat-send') as HTMLButtonElement).disabled).toBe(true);
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('serializes deliberate queued-folder restoration behind its pending access removal', async () => {
    const composerRef = createRef<ChatComposerHandle>();
    const context = { id: 'local-code:/Users/me/reference-dir', kind: 'local-code' as const, label: 'reference-dir', absolutePath: '/Users/me/reference-dir' };
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return <ChatComposer ref={composerRef} {...composerElement({ projectMetadata: metadata,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      }).props} />;
    }
    render(<ControlledComposer />);
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await screen.findByLabelText('Remove reference-dir');
    deferNextProjectPatch = true;
    fireEvent.click(screen.getByLabelText('Remove reference-dir'));
    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());
    let restoration: boolean | undefined;
    act(() => { restoration = composerRef.current?.restoreDraft({ text: '@reference-dir queued work', meta: { context: { workspaceItems: [context] } } }); });
    await act(async () => { resolveDeferredProjectPatch?.(); await restoration; });

    await waitFor(() => expect(projectPatchBodies().at(-1)?.metadata?.linkedDirs).toEqual(['/Users/me/reference-dir']));
    expect(projectPatchBodies()).toHaveLength(3);
    await waitFor(() => expect(screen.getByTestId('chat-composer-input').querySelector(`[data-mention-id="${context.id}"]`)).not.toBeNull());
    expect(screen.getByLabelText('Remove reference-dir')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove reference-dir'));
    await waitFor(() => expect(projectPatchBodies().at(-1)?.metadata?.linkedDirs).toEqual([]));
  });

  it('drops a revoked workspace token restored by undo without granting folder access again', async () => {
    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return composerElement({ projectMetadata: metadata,
        onProjectMetadataChange: (project) => { if (project.metadata) setMetadata(project.metadata); },
      });
    }
    render(<ControlledComposer />);
    await flushMounts();
    await typeAndSettle('Keep this prose. ');
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    act(() => {
      getComposerEditor().update(() => {
        $getRoot().selectEnd();
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error('Expected range selection');
        selection.insertText('Latest prose edit.');
      }, { discrete: true, tag: HISTORY_PUSH_TAG });
    });
    act(() => {
      getComposerEditor().update(() => {
        const paragraph = $getRoot().getFirstChild();
        if (!$isElementNode(paragraph)) throw new Error('Expected paragraph');
        const mention = paragraph.getChildren().find($isMentionNode);
        if (!mention) throw new Error('Expected mention');
        mention.remove();
        paragraph.selectEnd();
      }, { discrete: true, tag: HISTORY_PUSH_TAG });
    });
    await waitFor(() => expect(projectPatchBodies()[1]?.metadata?.linkedDirs).toEqual([]));
    await waitFor(() => expect(screen.queryByLabelText('Remove reference-dir')).toBeNull());

    await act(async () => { getComposerEditor().dispatchCommand(UNDO_COMMAND, undefined); });
    await flushMounts();

    expect(composerText()).toContain('Keep this prose.');
    expect(composerText()).not.toContain('@reference-dir');
    expect(screen.queryByLabelText('Remove reference-dir')).toBeNull();
    expect(projectPatchBodies()).toHaveLength(2);
    expect(composerText()).toContain('Latest prose edit.');
    await act(async () => { getComposerEditor().dispatchCommand(UNDO_COMMAND, undefined); });
    await flushMounts();
    expect(composerText()).toContain('Keep this prose.');
    expect(composerText()).not.toContain('Latest prose edit.');
    expect(composerText()).not.toContain('@reference-dir');
    expect(projectPatchBodies()).toHaveLength(2);
    // Undo never re-grants access, but an explicit picker action can.
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(projectPatchBodies()[2]?.metadata?.linkedDirs).toEqual(['/Users/me/reference-dir']));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    expect(screen.getByLabelText('Remove reference-dir')).toBeTruthy();
  });

  it('drops an undo-restored token when its pending access removal eventually succeeds', async () => {
    renderComposer({ projectMetadata: { kind: 'prototype' } });
    await flushMounts();
    await typeAndSettle('Keep this prose. ');
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    deferNextProjectPatch = true;
    act(() => {
      getComposerEditor().update(() => {
        const paragraph = $getRoot().getFirstChild();
        if (!$isElementNode(paragraph)) throw new Error('Expected paragraph');
        const mention = paragraph.getChildren().find($isMentionNode);
        if (!mention) throw new Error('Expected mention');
        mention.remove();
        paragraph.selectEnd();
      }, { discrete: true, tag: HISTORY_PUSH_TAG });
    });
    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());
    await act(async () => { getComposerEditor().dispatchCommand(UNDO_COMMAND, undefined); });
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));

    await act(async () => { resolveDeferredProjectPatch?.(); await Promise.resolve(); });

    await waitFor(() => expect(screen.queryByLabelText('Remove reference-dir')).toBeNull());
    expect(composerText()).toContain('Keep this prose.');
    expect(composerText()).not.toContain('@reference-dir');
    expect(projectPatchBodies()).toHaveLength(2);
    expect(projectPatchBodies()[1]?.metadata?.linkedDirs).toEqual([]);
  });

  it.each(['send', 'queue'] as const)('does not acknowledge an annotation %s rejected by a pending send', async (action) => {
    let finishSend: (() => void) | undefined;
    const onSend = vi.fn<ComponentProps<typeof ChatComposer>['onSend']>(() => new Promise<void>((resolve) => { finishSend = resolve; }));
    const ack = vi.fn();
    renderComposer({ onSend });
    await flushMounts();
    await typeAndSettle('Start the first turn.');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new CustomEvent('mish:annotation', { detail: {
        action, note: 'Keep this annotation for retry.', ack,
      } }));
    });

    expect(ack).toHaveBeenCalledWith({ ok: false, message: expect.any(String) });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => { finishSend?.(); await Promise.resolve(); });
  });

  it('omits an attachment removed while an annotation waits for folder access changes', async () => {
    const onSend = vi.fn();
    renderComposer({ projectMetadata: { kind: 'prototype' }, onSend });
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-local-code'));
    await waitFor(() => expect(composerText()).toContain('@reference-dir'));
    await act(async () => {
      window.dispatchEvent(new CustomEvent('mish:stage-attachment', { detail: {
        attachments: [{ path: 'reference.txt', name: 'reference.txt', kind: 'file' }],
      } }));
    });
    await screen.findByLabelText('Remove reference.txt');
    deferNextProjectPatch = true;
    await typeAndSettle('Continue without that reference.');
    await waitFor(() => expect(resolveDeferredProjectPatch).toBeTruthy());
    await act(async () => {
      window.dispatchEvent(new CustomEvent('mish:annotation', { detail: {
        action: 'send', note: 'Update the marked region.', ack: vi.fn(),
      } }));
    });
    fireEvent.click(screen.getByLabelText('Remove reference.txt'));
    await waitFor(() => expect(screen.queryByLabelText('Remove reference.txt')).toBeNull());
    await act(async () => { resolveDeferredProjectPatch?.(); await Promise.resolve(); });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[1]).toEqual([]);
    expect(onSend.mock.calls[0]?.[0]).toContain('Update the marked region.');
  });

  it('stages multiple referenced projects and links all resolved dirs together', async () => {
    const referenceA = {
      id: 'reference-a',
      name: 'Reference A',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
      metadata: { kind: 'prototype' as const },
    };
    const referenceB = {
      ...referenceA,
      id: 'reference-b',
      name: 'Reference B',
    };
    referenceProjects = [referenceA, referenceB];
    referenceProjectDetails = {
      'reference-a': {
        project: referenceA,
        resolvedDir: '/tmp/mish/reference-a',
      },
      'reference-b': {
        project: referenceB,
        resolvedDir: '/tmp/mish/reference-b',
      },
    };
    const onProjectMetadataChange = vi.fn();
    renderComposer({
      projectMetadata: { kind: 'prototype', linkedDirs: ['/Users/me/work-dir'] },
      onProjectMetadataChange,
    });
    await flushMounts();

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-reference-project'));
    await screen.findByText('Reference A');
    fireEvent.click(screen.getByText('Reference B'));
    fireEvent.click(screen.getByRole('button', { name: 'Reference project' }));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(1);
    });
    expect(projectPatchBodies()[0]?.metadata?.linkedDirs).toEqual([
      '/Users/me/work-dir',
      '/tmp/mish/reference-a',
      '/tmp/mish/reference-b',
    ]);
    await waitFor(() => {
      const stagedText = screen.getByTestId('staged-contexts').textContent ?? '';
      expect(stagedText).toContain('ProjectReference A');
      expect(stagedText).toContain('ProjectReference B');
    });
    expect(onProjectMetadataChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
        linkedDirs: [
          '/Users/me/work-dir',
          '/tmp/mish/reference-a',
          '/tmp/mish/reference-b',
        ],
      }),
      }),
    );
  });

  it('does not stage referenced project context when linking its directory is rejected', async () => {
    const referenceA = {
      id: 'reference-a',
      name: 'Reference A',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
      metadata: { kind: 'prototype' as const },
    };
    referenceProjects = [referenceA];
    referenceProjectDetails = {
      'reference-a': {
        project: referenceA,
        resolvedDir: '/tmp/mish/missing-reference-a',
      },
    };
    rejectNextProjectPatch = true;
    const onSend = vi.fn();
    renderComposer({ onSend });
    await flushMounts();
    await typeAndSettle('Review this');

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByTestId('composer-plus-reference-project'));
    await screen.findByText('Reference A');
    fireEvent.click(screen.getByRole('button', { name: 'Reference project' }));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(1);
    });
    expect(screen.queryByTestId('staged-contexts')).toBeNull();
    expect(composerText()).toBe('Review this');
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems).toBeUndefined();
  });

  it('keeps sent linked-dir workspace context visible and removable after reset', async () => {
    const onProjectMetadataChange = vi.fn();
    const onSend = vi.fn();

    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({ kind: 'prototype' });
      return composerElement({
        projectMetadata: metadata,
        onProjectMetadataChange: (next) => {
          onProjectMetadataChange(next);
          // main 把回调从 ProjectMetadata 拓宽成整个 Project(#5379 之后的
          // 工作目录流程需要 project 层字段),这里的受控 state 仍只关心 metadata。
          if (next.metadata) setMetadata(next.metadata);
        },
        onSend,
      });
    }

    render(<ControlledComposer />);
    await flushMounts();

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(1);
    });
    expect(projectPatchBodies()[0]?.metadata?.linkedDirs).toEqual(['/Users/me/reference-dir']);
    await waitFor(() => {
      expect(screen.getByTestId('staged-contexts').textContent).toContain('reference-dir');
    });

    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.workspaceItems).toEqual([
      expect.objectContaining({
        id: 'local-code:/Users/me/reference-dir',
        absolutePath: '/Users/me/reference-dir',
      }),
    ]);
    await waitFor(() => {
      expect(composerText().trim()).toBe('');
      expect(screen.getByTestId('staged-contexts').textContent).toContain('reference-dir');
    });
    // The working-dir readout that used to assert "this dir is context-only, not
    // the project's primary folder" is gone from the project composer (#5517).
    // The property itself is still pinned below: a dir promoted to primary would
    // count as still-referenced and the removal would produce no PATCH at all.

    fireEvent.click(screen.getByLabelText('Remove reference-dir'));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(2);
    });
    expect(projectPatchBodies()[1]?.metadata?.linkedDirs).toEqual([]);
    expect(screen.queryByTestId('staged-contexts')?.textContent ?? '').not.toContain('reference-dir');
    expect(onProjectMetadataChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ linkedDirs: [] }),
      }),
    );
  });

  it('does not remove a pre-existing linked dir when a matching workspace chip is cleared', async () => {
    const onProjectMetadataChange = vi.fn();
    renderComposer({
      projectMetadata: { kind: 'prototype', linkedDirs: ['/Users/me/reference-dir'] },
      onProjectMetadataChange,
    });
    await flushMounts();

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));

    await waitFor(() => {
      expect(screen.getByTestId('staged-contexts').textContent).toContain('reference-dir');
    });
    expect(projectPatchBodies()).toEqual([]);

    fireEvent.click(screen.getByLabelText('Remove reference-dir'));

    await waitFor(() => {
      expect(screen.queryByTestId('staged-contexts')?.textContent ?? '').not.toContain('reference-dir');
    });
    expect(projectPatchBodies()).toEqual([]);
    expect(onProjectMetadataChange).not.toHaveBeenCalled();
  });

  it('keeps draft text typed while linked-dir removal is pending', async () => {
    renderComposer({ projectMetadata: { kind: 'prototype' } });
    await flushMounts();

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(1);
    });

    deferNextProjectPatch = true;
    fireEvent.click(screen.getByLabelText('Remove reference-dir'));

    await waitFor(() => {
      expect(resolveDeferredProjectPatch).toBeTruthy();
    });
    await typeAndSettle('Keep the typed text after clicking remove');
    await act(async () => {
      resolveDeferredProjectPatch?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(2);
    });
    expect(composerText()).toBe('Keep the typed text after clicking remove');
  });

  // Working-dir controls now live in the "+" menu. Local-code links remain
  // independent: adding one preserves the primary dir, and removing its chip
  // unlinks only the context dir.
  it('links a local-code dir alongside the existing working dir and unlinks only that dir', async () => {
    openFolderPaths = ['/Users/me/reference-dir'];
    const onProjectMetadataChange = vi.fn();

    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({
        kind: 'prototype',
        linkedDirs: ['/Users/me/work-dir'],
      });
      return composerElement({
        projectMetadata: metadata,
        onProjectMetadataChange: (next) => {
          onProjectMetadataChange(next);
          // main 把回调从 ProjectMetadata 拓宽成整个 Project(#5379 之后的
          // 工作目录流程需要 project 层字段),这里的受控 state 仍只关心 metadata。
          if (next.metadata) setMetadata(next.metadata);
        },
      });
    }

    render(<ControlledComposer />);
    await flushMounts();

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(1);
    });
    expect(projectPatchBodies()[0]?.metadata?.linkedDirs).toEqual([
      '/Users/me/work-dir',
      '/Users/me/reference-dir',
    ]);
    await waitFor(() => {
      expect(screen.getByTestId('staged-contexts').textContent).toContain('reference-dir');
    });

    fireEvent.click(screen.getByLabelText('Remove reference-dir'));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(2);
    });
    expect(projectPatchBodies()[1]?.metadata?.linkedDirs).toEqual(['/Users/me/work-dir']);
    expect(screen.queryByTestId('staged-contexts')?.textContent ?? '').not.toContain('reference-dir');
    expect(onProjectMetadataChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ linkedDirs: ['/Users/me/work-dir'] }),
      }),
    );
  });

  // A Home-carried dir is already inside `projectMetadata.linkedDirs` before the
  // composer mounts (Home linked it at create time), so ownership has to be
  // reconstructed from `initialWorkspaceContexts`. Context-only means the chip
  // still owns it: removing the chip unlinks it, instead of it hardening into a
  // permanent project working dir. This is the mirror of "does not remove a
  // pre-existing linked dir when a matching workspace chip is cleared" below,
  // where the same path is staged later and is therefore NOT chip-owned.
  // (The working-dir readout that used to also show "not displayed as primary"
  // is gone from the project composer per #5517; the unlink is what pins it now.)
  it('treats Home-carried workspace dirs as context-only after project creation', async () => {
    const onProjectMetadataChange = vi.fn();

    function ControlledComposer() {
      const [metadata, setMetadata] = useState<ProjectMetadata>({
        kind: 'prototype',
        linkedDirs: ['/Users/me/reference-dir'],
      });
      return composerElement({
        initialWorkspaceContexts: [{
          id: 'local-code:/Users/me/reference-dir',
          kind: 'local-code',
          label: 'reference-dir',
          title: 'reference-dir',
          absolutePath: '/Users/me/reference-dir',
        }],
        projectMetadata: metadata,
        onProjectMetadataChange: (next) => {
          onProjectMetadataChange(next);
          // main 把回调从 ProjectMetadata 拓宽成整个 Project(#5379 之后的
          // 工作目录流程需要 project 层字段),这里的受控 state 仍只关心 metadata。
          if (next.metadata) setMetadata(next.metadata);
        },
      });
    }

    render(<ControlledComposer />);
    await flushMounts();

    expect(screen.getByTestId('staged-contexts').textContent).toContain('reference-dir');
    // Mounting alone must not rewrite the project — the dir is already linked.
    expect(projectPatchBodies()).toEqual([]);

    fireEvent.click(screen.getByLabelText('Remove reference-dir'));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(1);
    });
    expect(projectPatchBodies()[0]?.metadata?.linkedDirs).toEqual([]);
    expect(screen.queryByTestId('staged-contexts')?.textContent ?? '').not.toContain('reference-dir');
    expect(onProjectMetadataChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ linkedDirs: [] }),
      }),
    );
  });

  // Two cases used to live here — "keeps a promoted context dir as the working
  // dir when its chip is removed" and "preserves a promoted context dir when
  // clearing the working dir while its chip remains". Both existed only to cover
  // *promotion*: picking, as the project's working dir, a folder that a context
  // chip had already linked. Promotion is set exclusively by the in-project
  // working-dir row, which #5517 removed, so `promotedWorkspaceContextDir` can
  // no longer become non-null and the `workingDir === dir` branch of
  // `workspaceContextDirStillReferenced` is unreachable. There is no remaining
  // driver — a context dir is always excluded from `workingDir` — so the cases
  // are deleted rather than re-pointed. The neighbouring "keeps a shared linked
  // dir while another workspace item uses the same path" still covers the other,
  // still-live branch of "this dir is still referenced, don't unlink it".
  it('keeps a shared linked dir while another workspace item uses the same path', async () => {
    openFolderPaths = ['/Users/me/shared'];
    const onProjectMetadataChange = vi.fn();
    renderComposer({
      activeWorkspaceContext: {
        id: 'project:project-a',
        kind: 'project',
        label: 'Project A',
        title: 'Project A',
        path: 'project-a',
        absolutePath: '/Users/me/shared',
      },
      projectMetadata: { kind: 'prototype' },
      onProjectMetadataChange,
    });
    await flushMounts();

    fireEvent.click(screen.getByTestId('chat-plus-trigger'));
    fireEvent.click(await screen.findByText('Link local code'));

    await waitFor(() => {
      expect(projectPatchBodies()).toHaveLength(1);
    });
    expect(projectPatchBodies()[0]?.metadata?.linkedDirs).toEqual(['/Users/me/shared']);
    expect(screen.getByLabelText('Remove Project A')).toBeTruthy();

    fireEvent.click(screen.getAllByLabelText('Remove shared')[0]!);

    await waitFor(() => {
      expect(screen.queryByLabelText('Remove shared')).toBeNull();
    });
    expect(projectPatchBodies()).toHaveLength(1);
    expect(onProjectMetadataChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ linkedDirs: ['/Users/me/shared'] }),
      }),
    );
  });

  it('selects an MCP server from @ search and keeps the inline token visible', async () => {
    renderComposer();
    await flushMounts();

    await typeAndSettle('@sl');

    await waitFor(() => expect(screen.getByText('Slack MCP')).toBeTruthy());
    fireEvent.click(screen.getByText('Slack MCP'));

    await waitFor(() => expect(composerText()).toBe('@Slack MCP '));
    const pill = screen
      .getByTestId('chat-composer-input')
      .querySelector('[data-mention-kind]');
    expect(pill?.textContent).toBe('@Slack MCP');
    expect(pill?.getAttribute('data-mention-kind')).toBe('mcp');
    expect(screen.getByTestId('staged-contexts').textContent).toContain('@Slack MCP');

    fireEvent.click(screen.getByLabelText('Remove Slack MCP'));
    await waitFor(() => expect(composerText().trim()).toBe(''));
    expect(screen.queryByTestId('staged-contexts')).toBeNull();
  });

  it.each(['agency-emmpo', 'agency-watson', 'agency-cult-heroes'])(
    'stages @%s without replacing the Agency Site project skill',
    async (id) => {
      skills = [makeSkill({ id, name: id })];
      const onSend = vi.fn();
      const onProjectSkillChange = vi.fn();
      renderComposer({ currentSkillId: 'agency-site', onSend, onProjectSkillChange });
      await flushMounts();
      await typeAndSettle(`@${id}`);
      fireEvent.click(await screen.findByText(id));
      await waitFor(() => expect(composerText()).toContain(`@${id}`));
      fireEvent.click(screen.getByTestId('chat-send'));
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(onSend.mock.calls[0]?.[3]?.skillIds).toEqual([id]);
      expect(projectPatchBodies()).toEqual([]);
      expect(onProjectSkillChange).not.toHaveBeenCalled();
    },
  );

  it.each([
    { current: 'agency-site', selected: 'deck-builder' },
    { current: 'deck-builder', selected: 'agency-emmpo' },
    { current: 'agency-site', selected: 'agency-emmpo-other' },
  ])('preserves normal @skill application for $current selecting $selected', async ({ current, selected }) => {
    skills = [makeSkill({ id: selected, name: selected })];
    const onProjectSkillChange = vi.fn();
    renderComposer({ currentSkillId: current, onProjectSkillChange });
    await flushMounts();
    await typeAndSettle(`@${selected}`);
    fireEvent.click(await screen.findByText(selected));
    await waitFor(() => expect(onProjectSkillChange).toHaveBeenCalledWith(selected));
    expect(projectPatchBodies()).toContainEqual({ skillId: selected });
  });

  it('applies a skill from @ search and reports the active project skill', async () => {
    const onProjectSkillChange = vi.fn();
    renderComposer({ onProjectSkillChange });
    await flushMounts();

    await typeAndSettle('@deck');

    await waitFor(() => expect(screen.getByText('Deck Builder')).toBeTruthy());
    fireEvent.click(screen.getByText('Deck Builder'));

    await waitFor(() => expect(onProjectSkillChange).toHaveBeenCalledWith('deck-builder'));
    await waitFor(() => expect(composerText()).toBe('@Deck Builder '));
    const pill = screen
      .getByTestId('chat-composer-input')
      .querySelector('[data-mention-kind]');
    expect(pill?.textContent).toBe('@Deck Builder');
    expect(pill?.getAttribute('data-mention-kind')).toBe('skill');
    expect(screen.getByTestId('staged-contexts').textContent).toContain('@Deck Builder');

    fireEvent.click(
      within(screen.getByTestId('staged-contexts')).getByRole('button', {
        name: 'Deck Builder',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('skill-details-modal')).toBeTruthy());
    expect(screen.getByText('skill body for deck-builder')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);

    fireEvent.click(screen.getByLabelText('Remove Deck Builder'));
    await waitFor(() => expect(composerText().trim()).toBe(''));
    expect(screen.queryByTestId('staged-contexts')).toBeNull();
  });

  it('does not keep a removed @ skill marked active when the mention picker reopens', async () => {
    renderComposer({ currentSkillId: 'deck-builder' });
    await flushMounts();

    await typeAndSettle('@deck');
    await waitFor(() => expect(screen.getByText('Deck Builder')).toBeTruthy());
    fireEvent.click(screen.getByText('Deck Builder'));
    await waitFor(() => expect(composerText()).toBe('@Deck Builder '));

    typeInComposer('');
    await waitFor(() => expect(screen.queryByTestId('staged-contexts')).toBeNull());

    await typeAndSettle('@deck');
    const picker = await screen.findByTestId('mention-popover');
    const skill = within(picker).getByRole('option', { name: /Deck Builder/ });

    expect(skill.textContent).not.toContain('Active');
  });

  it('shows all matching skills and ranks exact prefix matches first', async () => {
    skills = [
      makeSkill({
        id: 'story-brief',
        name: 'Story Brief',
        description: 'Use when planning audit work.',
        triggers: ['writing'],
      }),
      ...Array.from({ length: 9 }, (_, index) =>
        makeSkill({
          id: `audit-helper-${index + 1}`,
          name: `Audit Helper ${index + 1}`,
          description: `Audit support workflow ${index + 1}.`,
          triggers: [`audit-${index + 1}`],
        }),
      ),
      makeSkill({
        id: 'accessibility-review',
        name: 'Accessibility Review',
        description: 'Audit accessible interaction details.',
        triggers: ['a11y-audit'],
      }),
    ];
    renderComposer();
    await flushMounts();

    await typeAndSettle('@audit');

    await waitFor(() => expect(screen.getByText('Audit Helper 9')).toBeTruthy());
    const skillNames = Array.from(
      screen.getByTestId('mention-popover').querySelectorAll('[data-testid="mention-item-name"]'),
      (node) => node.textContent,
    );

    expect(skillNames).toContain('Audit Helper 9');
    expect(skillNames.indexOf('Audit Helper 1')).toBeLessThan(skillNames.indexOf('Story Brief'));
    expect(skillNames.indexOf('Audit Helper 9')).toBeLessThan(skillNames.indexOf('Accessibility Review'));
  });

  it('applies a plugin from @ search and keeps the plugin token inline', async () => {
    renderComposer();
    await flushMounts();

    await typeAndSettle('@export');

    await waitFor(() => expect(screen.getByText('My Export')).toBeTruthy());
    fireEvent.click(screen.getByText('My Export'));

    await waitFor(() => expect(composerText()).toBe('@My Export '));
    const pill = screen
      .getByTestId('chat-composer-input')
      .querySelector('[data-mention-kind]');
    expect(pill?.textContent).toBe('@My Export');
    expect(pill?.getAttribute('data-mention-kind')).toBe('plugin');
  });

  it('clears the inline plugin context when the plugin token is removed', async () => {
    renderComposer();
    await flushMounts();

    await typeAndSettle('@export');

    await waitFor(() => expect(screen.getByText('My Export')).toBeTruthy());
    fireEvent.click(screen.getByText('My Export'));

    await waitFor(() => expect(composerText()).toBe('@My Export '));
    await waitFor(() => expect(stagedPluginChip()?.textContent).toContain(USER_PLUGIN.id));

    await typeAndSettle('');

    await waitFor(() => expect(stagedPluginChip()).toBeNull());
  });

  it('clears restored inline plugin context when the queued draft token is removed', async () => {
    const onSend = vi.fn();
    const composerRef = createRef<ChatComposerHandle>();
    const restoredAppliedPlugin = APPLY_RESULT.appliedPlugin as AppliedPluginSnapshot;
    render(<ChatComposer ref={composerRef} {...composerElement({ onSend }).props} />);
    await flushMounts();

    act(() => {
      composerRef.current?.restoreDraft({
        text: '@My Export queued work',
        meta: {
          appliedPluginSnapshot: restoredAppliedPlugin,
          appliedPluginSnapshotId: restoredAppliedPlugin.snapshotId,
          inlineAppliedPlugin: {
            pluginId: USER_PLUGIN.id,
            label: USER_PLUGIN.title,
          },
          context: { pluginIds: [USER_PLUGIN.id] },
        },
      });
    });

    await waitFor(() => expect(composerText()).toBe('@My Export queued work'));

    await typeAndSettle('queued work');
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.context?.pluginIds).toBeUndefined();
    expect(onSend.mock.calls[0]?.[3]?.appliedPluginSnapshot).toBeUndefined();
  });

  it('keeps restored non-inline plugin context when matching prompt text is removed', async () => {
    const onSend = vi.fn();
    const composerRef = createRef<ChatComposerHandle>();
    const restoredAppliedPlugin = APPLY_RESULT.appliedPlugin as AppliedPluginSnapshot;
    render(<ChatComposer ref={composerRef} {...composerElement({ onSend }).props} />);
    await flushMounts();

    act(() => {
      composerRef.current?.restoreDraft({
        text: '@My Export queued work',
        meta: {
          appliedPluginSnapshot: restoredAppliedPlugin,
          appliedPluginSnapshotId: restoredAppliedPlugin.snapshotId,
          context: { pluginIds: [USER_PLUGIN.id] },
        },
      });
    });

    await waitFor(() => expect(composerText()).toBe('@My Export queued work'));

    await typeAndSettle('queued work');
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]).toMatchObject({
      appliedPluginSnapshotId: restoredAppliedPlugin.snapshotId,
      appliedPluginSnapshot: expect.objectContaining({
        pluginId: USER_PLUGIN.id,
      }),
      context: { pluginIds: [USER_PLUGIN.id] },
    });
  });

  it('keeps the inline plugin context when the plugin token has trailing punctuation', async () => {
    renderComposer();
    await flushMounts();

    await typeAndSettle('@export');

    await waitFor(() => expect(screen.getByText('My Export')).toBeTruthy());
    fireEvent.click(screen.getByText('My Export'));

    await waitFor(() => expect(composerText()).toBe('@My Export '));
    await waitFor(() => expect(stagedPluginChip()?.textContent).toContain(USER_PLUGIN.id));

    await typeAndSettle('@My Export, refine this export');

    await waitFor(() => expect(composerText()).toBe('@My Export, refine this export'));
    expect(stagedPluginChip()?.textContent).toContain(USER_PLUGIN.id);
  });

  it('sends the applied plugin snapshot as per-turn context', async () => {
    const onSend = vi.fn();
    renderComposer({ onSend });
    await flushMounts();

    await typeAndSettle('@export');

    await waitFor(() => expect(screen.getByText('My Export')).toBeTruthy());
    fireEvent.click(screen.getByText('My Export'));

    await waitFor(() => expect(composerText()).toBe('@My Export '));
    // The applied-plugin chip now rides the shared staged-context row as a
    // `.staged-context--plugin` chip (rendered by the host, not PluginsSection's
    // own ContextChipStrip). It is keyed off the plugin id when no display title
    // is present in the applied snapshot.
    await waitFor(() => {
      expect(stagedPluginChip()?.textContent).toContain(USER_PLUGIN.id);
    });

    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const meta = onSend.mock.calls[0]?.[3];
    expect(meta).toMatchObject({
      appliedPluginSnapshotId: 'snap-1',
      appliedPluginSnapshot: expect.objectContaining({
        snapshotId: 'snap-1',
        pluginId: USER_PLUGIN.id,
      }),
      context: { pluginIds: [USER_PLUGIN.id] },
    });
    // After sending, the applied plugin clears, so its staged chip is gone.
    await waitFor(() => {
      expect(stagedPluginChip()).toBeNull();
    });
  });

  it('removes the inline design file token when its staged chip is removed', async () => {
    renderComposer({
      projectFiles: [
        {
          path: 'designs/landing.html',
          name: 'landing.html',
          kind: 'html',
          mime: 'text/html',
          mtime: 1,
          size: 128,
        },
      ],
    });
    await flushMounts();

    await typeAndSettle('Use @landing');

    await waitFor(() => expect(screen.getByText('designs/landing.html')).toBeTruthy());
    fireEvent.click(screen.getByText('designs/landing.html'));

    await waitFor(() => expect(composerText()).toBe('Use @designs/landing.html '));
    expect(screen.getByTestId('staged-attachments').textContent).toContain('landing.html');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Remove landing.html'));
      await Promise.resolve();
    });

    await waitFor(() => expect(composerText()).toBe('Use '));
    expect(screen.queryByTestId('staged-attachments')).toBeNull();
  });

  it('preserves surrounding draft formatting when removing a design file token', async () => {
    renderComposer({
      projectFiles: [
        {
          path: 'designs/landing.html',
          name: 'landing.html',
          kind: 'html',
          mime: 'text/html',
          mtime: 1,
          size: 128,
        },
      ],
    });
    await flushMounts();

    // Open the @ picker mid-draft and pick the file — that stages the
    // attachment AND inserts the atomic pill (typing alone never stages). The
    // surrounding `\n\n` runs are preserved as LineBreakNodes.
    await typeAndSettle('Plan:\n\n@landing');

    await waitFor(() => expect(screen.getByText('designs/landing.html')).toBeTruthy());
    fireEvent.click(screen.getByText('designs/landing.html'));

    await waitFor(() =>
      expect(composerText()).toBe('Plan:\n\n@designs/landing.html '),
    );
    expect(screen.getByTestId('staged-attachments').textContent).toContain('landing.html');

    // The user keeps typing after the trailing space; re-seed the full draft to
    // capture that, then remove the staged chip.
    await typeAndSettle('Plan:\n\n@designs/landing.html \n\nKeep spacing');
    await waitFor(() =>
      expect(composerText()).toBe('Plan:\n\n@designs/landing.html \n\nKeep spacing'),
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Remove landing.html'));
      await Promise.resolve();
    });

    await waitFor(() => expect(composerText()).toBe('Plan:\n\n\n\nKeep spacing'));
    expect(screen.queryByTestId('staged-attachments')).toBeNull();
  });

  it('removes a design file token when punctuation follows it', async () => {
    renderComposer({
      projectFiles: [
        {
          path: 'designs/landing.html',
          name: 'landing.html',
          kind: 'html',
          mime: 'text/html',
          mtime: 1,
          size: 128,
        },
      ],
    });
    await flushMounts();

    await typeAndSettle('Use @landing');

    await waitFor(() => expect(screen.getByText('designs/landing.html')).toBeTruthy());
    fireEvent.click(screen.getByText('designs/landing.html'));
    await waitFor(() => expect(composerText()).toBe('Use @designs/landing.html '));

    await typeAndSettle('Use @designs/landing.html, please');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Remove landing.html'));
      await Promise.resolve();
    });

    await waitFor(() => expect(composerText()).toBe('Use , please'));
    expect(screen.queryByTestId('staged-contexts')).toBeNull();
  });

  it('removes a quoted design file token when its chip is removed', async () => {
    renderComposer({
      projectFiles: [
        {
          path: 'designs/landing.html',
          name: 'landing.html',
          kind: 'html',
          mime: 'text/html',
          mtime: 1,
          size: 128,
        },
      ],
    });
    await flushMounts();

    await typeAndSettle('@landing');

    await waitFor(() => expect(screen.getByText('designs/landing.html')).toBeTruthy());
    fireEvent.click(screen.getByText('designs/landing.html'));
    await waitFor(() => expect(composerText()).toBe('@designs/landing.html '));

    await typeAndSettle('"@designs/landing.html"');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Remove landing.html'));
      await Promise.resolve();
    });

    await waitFor(() => expect(composerText()).toBe('""'));
    expect(screen.queryByTestId('staged-contexts')).toBeNull();
  });

  it('clears an attachment upload error after a later retry succeeds', async () => {
    let uploadAttempts = 0;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers, templates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/skills') {
        return new Response(JSON.stringify({ skills }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/projects/project-1/upload' && init?.method === 'POST') {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          return new Response(JSON.stringify({ error: 'storage offline' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          files: [{ name: 'recovered.txt', path: 'uploads/recovered.txt', size: 24 }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderComposer();
    const input = screen.getByTestId('chat-file-input') as HTMLInputElement;

    fireEvent.change(input, {
      target: {
        files: [new File(['first failure'], 'failed.txt', { type: 'text/plain' })],
      },
    });

    await waitFor(() => {
      expect(screen.getByText('File upload failed for 1 file(s). (storage offline)')).toBeTruthy();
    });
    expect(screen.queryByTestId('staged-contexts')).toBeNull();

    fireEvent.change(input, {
      target: {
        files: [new File(['retry works'], 'recovered.txt', { type: 'text/plain' })],
      },
    });

    await waitFor(() => {
      expect(screen.queryByText('File upload failed for 1 file(s). (storage offline)')).toBeNull();
    });
    expect(screen.getByTestId('staged-attachments').textContent).toContain('recovered.txt');
  });

  // The sliders "tools" popover (Official / My plugins switch, plugin search)
  // and the standalone "@" mention trigger button were removed from the
  // composer; plugins/skills/MCP are now reached via typed @-mentions and the
  // "+" menu, so their dedicated click-tracking coverage moved out with them.

  // The inline pet popover (the "Pets — wake, tuck, or pick one" button and
  // its `.composer-pet-menu` flyout) was removed from ChatComposer; only the
  // pet props survive to drive `/pet` slash handling. Assert the entry stays
  // gone even when every pet handler is wired.
  it('does not render the pet composer entry when pet handlers are wired', () => {
    renderComposer({
      petConfig: {
        adopted: false,
        enabled: false,
        petId: 'custom',
        custom: {
          name: 'Buddy',
          glyph: '🐾',
          accent: '#7c3aed',
          greeting: 'hi',
        },
      },
      onAdoptPet: vi.fn(),
      onTogglePet: vi.fn(),
      onOpenPetSettings: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: 'Pets — wake, tuck, or pick one' })).toBeNull();
    expect(screen.queryByText('Buddy')).toBeNull();
  });
});
