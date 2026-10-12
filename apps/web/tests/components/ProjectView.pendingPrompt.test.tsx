// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Brand } from '@open-design/contracts';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { admission } from '../fixtures/session-admission';
import { readSessionModelRequest, saveSessionModelRequest, type SessionModelRequest } from '../../src/runtime/workbench/session-model-request';
import { readHomeModelHandoff, writeHomeModelHandoff } from '../../src/runtime/workbench/home-model-handoff';
import { workspaceAccountScopedCacheKey } from '../../src/collab/workspace-identity';
import { streamViaDaemon } from '../../src/providers/daemon';
import { ProjectView } from '../../src/components/ProjectView';
import { BROWSER_PAGE_ARCHIVE_SCHEMA } from '../../src/components/design-browser-tools';
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
  saveMessage,
} from '../../src/state/projects';
import { fetchPreviewComments, fetchProjectFiles } from '../../src/providers/registry';
import { useProjectFileEvents } from '../../src/providers/project-events';
import { resetSharedCancellableGet } from '../../src/lib/shared-cancellable-get';
import {
  beginHomeAttachmentUploads,
  endHomeAttachmentUploads,
  resetHomeAttachmentUploads,
  settleHomeAttachmentUpload,
} from '../../src/state/home-attachment-handoff';
import {
  cancelBrandExtraction,
  continueBrandExtraction,
  extractBrandFromHtml,
  fetchBrands,
} from '../../src/runtime/brands';

const sessionModelApi = vi.hoisted(() => ({
  get: vi.fn(), put: vi.fn(),
  // AC-R02.3 select-time gate: this file exercises picker selection wiring,
  // not capability mismatches — every selection is expected to pass.
  preflight: vi.fn(async (_sessionId: string, _projectId: string, input: { agentId: string; modelId: string }) =>
    ({ agentId: input.agentId, modelId: input.modelId, ok: true, mismatches: [] })),
}));
vi.mock('../../src/providers/workbench', async importOriginal => ({ ...(await importOriginal<typeof import('../../src/providers/workbench')>()), getSessionModel: sessionModelApi.get, putSessionModel: sessionModelApi.put, postModelPreflight: sessionModelApi.preflight }));
const modelPickerSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/components/InlineModelSwitcher', () => ({ InlineModelSwitcher: (props: unknown) => { modelPickerSpy(props); return null; } }));

const brandBrowserBridgeMocks = vi.hoisted(() => ({
  getBrandBrowser: vi.fn(),
}));
const registryOriginals = vi.hoisted(() => ({
  fetchProjectFiles: null as null | ((
    projectId: string,
    options?: {
      signal?: AbortSignal;
      workspaceContext?: import('@open-design/contracts').WorkspaceCollabContext | null;
      fresh?: boolean;
      requireAuthoritative?: boolean;
    },
  ) => Promise<ProjectFile[]>),
}));

const fileWorkspaceSpy = vi.hoisted(() => vi.fn());
const chatPaneSpy = vi.hoisted(() => vi.fn());

type MockChatPaneProps = {
  onSend?: (prompt: string, attachments: [], comments: [], meta: { clientRequestId: string }) => Promise<boolean>;
  error?: string | null;
  messages?: ChatMessage[];
  sendDisabled?: boolean;
  composerFooterAccessory?: ReactNode;
  activeConversationId?: string | null;
  initialDraft?: string;
  onBrandBrowserAssistConfirm?: (card: {
    kind: 'brand-browser-assist';
    brandId: string;
    browserTabId?: string;
    url?: string;
    reason?: string;
  }) => Promise<{ ok: boolean; action?: 'opened' | 'confirmed'; message?: string } | void>;
  onContinueBrandExtraction?: () => void;
  continueBrandExtractionBusy?: boolean;
  onContinueBrandAgentExtraction?: () => void;
  continueBrandAgentExtractionBusy?: boolean;
};

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: () => undefined,
    t: (key: string) => key,
  }),
  useT: () => (key: string) => key,
}));

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

vi.mock('../../src/collab/useProjectWorkspaceScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/collab/useProjectWorkspaceScope')>()),
  useProjectWorkspaceScope: (projectId: string) => ({
    loading: false,
    scope: {
      kind: 'unbound',
      projectId,
      workspaceId: null,
      context: null,
    },
  }),
}));

vi.mock('../../src/runtime/brands', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/brands')>(
    '../../src/runtime/brands',
  );
  return {
    ...actual,
    cancelBrandExtraction: vi.fn().mockResolvedValue({ ok: true, status: 'failed' }),
    continueBrandExtraction: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        id: 'brand-retry',
        projectId: 'brand-retry',
        conversationId: 'conv-brand-retry',
        sourceUrl: 'https://economist.com/',
        status: 'extracting',
        designSystemId: 'user:brand-retry',
      },
    }),
    extractBrandFromHtml: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        id: 'brand-retry',
        brand: null,
        designSystemId: 'user:brand-retry',
        projectId: 'brand-retry',
        files: [],
      },
    }),
    fetchBrands: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../src/runtime/brand-browser-bridge', () => ({
  BRAND_BROWSER_TAB_ID: '__browser__:1',
  getBrandBrowser: brandBrowserBridgeMocks.getBrandBrowser,
}));

// ProjectView also mounts `useDesignMdState` (the Continue-in-CLI staleness
// chip), which reads the same project file list through `fetchProjectFiles` so
// the two share ONE request in the browser instead of opening two (W82). These
// cases measure ProjectView's own file reads through the mocked reader, above
// the layer where that sharing happens, so the hook is stubbed out here to keep
// the mocked call sequence describing ProjectView alone. The hook's own
// behaviour is covered by tests/hooks/useDesignMdState.test.tsx.
vi.mock('../../src/hooks/useDesignMdState', () => ({
  useDesignMdState: () => ({
    exists: false,
    generatedAt: null,
    transcriptMessageCount: null,
    designSystemId: null,
    currentArtifact: null,
    isStale: false,
    staleReason: null,
    loading: false,
    error: null,
    refresh: async () => {},
  }),
  computeStale: () => ({ isStale: false, staleReason: null }),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  registryOriginals.fetchProjectFiles = actual.fetchProjectFiles;
  return {
    ...actual,
    deletePreviewComment: vi.fn(),
    fetchDesignSystem: vi.fn(),
    fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
    fetchPreviewComments: vi.fn(),
    fetchProjectFiles: vi.fn(actual.fetchProjectFiles),
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
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});

vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
}));

vi.mock('../../src/components/AvatarMenu', () => ({
  AvatarMenu: () => null,
}));

vi.mock('../../src/components/FileWorkspace', () => ({
  DESIGN_SYSTEM_TAB: '__design_system__',
  FileWorkspace: (props: {
    openRequest?: { name: string } | null;
    browserOpenRequest?: { tabId?: string; url: string; nonce: number } | null;
    onBrandExtractionStopRequest?: () => void;
    designSystemEditable?: boolean;
    filesRefreshKey?: number;
    filesGeneration?: number;
    files?: ProjectFile[];
    onRefreshFiles?: (options?: { fresh?: boolean }) => Promise<{
      acceptedGeneration: number | null;
    }>;
  }) => {
    fileWorkspaceSpy(props);
    return <div data-testid="file-workspace" />;
  },
}));

vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: (props: MockChatPaneProps) => {
    chatPaneSpy(props);
    return (
      <>
        {props.composerFooterAccessory}
        <div data-testid="chat-error">{props.error ?? ''}</div>
        <button data-testid="send-model-request" disabled={props.sendDisabled} onClick={() => void props.onSend?.('Send model request', [], [], { clientRequestId: 'model-request' })}>Send</button>
        <div data-testid="active-conversation">{props.activeConversationId ?? ''}</div>
        <div data-testid="chat-message-content">
          {props.messages?.map((message) => message.content).join('\n') ?? ''}
        </div>
        <textarea
          data-testid="chat-composer-input"
          readOnly
          value={props.initialDraft ?? ''}
        />
      </>
    );
  },
}));

const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);
const mockedFetchProjectFiles = vi.mocked(fetchProjectFiles);
const mockedUseProjectFileEvents = vi.mocked(useProjectFileEvents);
const mockedCancelBrandExtraction = vi.mocked(cancelBrandExtraction);
const mockedContinueBrandExtraction = vi.mocked(continueBrandExtraction);
const mockedExtractBrandFromHtml = vi.mocked(extractBrandFromHtml);
const mockedFetchBrands = vi.mocked(fetchBrands);
const mockedSaveMessage = vi.mocked(saveMessage);

const config: AppConfig = {
  mode: 'api',
  apiProtocol: 'openai',
  apiKey: 'byok-test-key',
  baseUrl: 'https://api.openai.com/v1',
  model: 'api-model',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

const project = (id: string, pendingPrompt?: string): Project => ({
  id,
  name: `Project ${id}`,
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
  ...(pendingPrompt ? { pendingPrompt } : {}),
});

const conversation = (projectId: string): Conversation => ({
  id: `conv-${projectId}`,
  projectId,
  title: null,
  createdAt: 1,
  updatedAt: 1,
});

function projectViewElement(
  currentProject: Project,
  onClearPendingPrompt = vi.fn(),
  overrides: Partial<ComponentProps<typeof ProjectView>> = {},
) {
  return (
    <ProjectView
      project={currentProject}
      routeFileName={null}
      config={config}
      agents={[{ id: 'byok-opencode', name: 'BYOK OpenCode', bin: 'opencode', available: true, models: [] }] as AgentInfo[]}
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
      onClearPendingPrompt={onClearPendingPrompt}
      onTouchProject={vi.fn()}
      onProjectChange={vi.fn()}
      onProjectsRefresh={vi.fn()}
      {...overrides}
    />
  );
}

function renderProjectView(
  currentProject: Project,
  onClearPendingPrompt = vi.fn(),
  overrides: Partial<ComponentProps<typeof ProjectView>> = {},
) {
  return render(projectViewElement(currentProject, onClearPendingPrompt, overrides));
}

describe('ProjectView pending prompt seeding', () => {
  beforeEach(() => {
    sessionModelApi.get.mockImplementation(async (sessionId: string, projectId: string) => ({ sessionId, projectId, revision: 0, choice: null, updatedAt: 0 }));
    sessionModelApi.put.mockImplementation(async (sessionId: string, projectId: string, input: import('@open-design/contracts').PutSessionModel) => ({ sessionId, projectId, revision: input.expectedRevision + 1, choice: { agentId: input.agentId, modelId: input.modelId, ...(input.byokBinding ? { byokBinding: input.byokBinding } : {}) }, updatedAt: 0 }));
    vi.mocked(streamViaDaemon).mockImplementation(async options => { options.onRunCreated?.('accepted-run'); });
    window.sessionStorage.clear();
    window.localStorage.clear();
    mockedListConversations.mockImplementation(async (projectId) => [
      conversation(projectId),
    ]);
    mockedCreateConversation.mockImplementation(async (projectId) =>
      conversation(projectId),
    );
    mockedListMessages.mockResolvedValue([]);
    mockedFetchPreviewComments.mockResolvedValue([]);
    mockedFetchProjectFiles.mockResolvedValue([]);
    mockedFetchBrands.mockResolvedValue([]);
    brandBrowserBridgeMocks.getBrandBrowser.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    resetHomeAttachmentUploads();
    resetSharedCancellableGet();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('refuses a new Bedrock request before saving a session model', async () => {
    renderProjectView(project('bedrock-new'), vi.fn(), { config: { ...config, apiProtocol: 'bedrock', apiKey: '', model: 'anthropic.claude-test' } });
    await waitFor(() => expect(screen.getByTestId('active-conversation').textContent).toBe('conv-bedrock-new'));
    await waitFor(() => expect(screen.getByTestId('send-model-request')).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByTestId('send-model-request'));
    await waitFor(() => expect(screen.getByTestId('chat-error').textContent).toBe('AWS Bedrock BYOK chat requires AWS credential signing and is not supported by the current API-key proxy.'));
    expect(sessionModelApi.put).not.toHaveBeenCalled();
    expect(streamViaDaemon).not.toHaveBeenCalled();
  });

  it('recovers an attempted request from its accepted snapshot after Settings switches to Bedrock', async () => {
    const projectId = 'bedrock-retained';
    saveSessionModelRequest({ snapshot: { projectId, sessionId: `conv-${projectId}`, revision: 7, choice: { agentId: 'codex', modelId: 'accepted-model' }, updatedAt: 1 }, reasoning: null, serviceTier: null, attempted: true }, 'model-request', workspaceAccountScopedCacheKey(null));
    renderProjectView(project(projectId), vi.fn(), { config: { ...config, apiProtocol: 'bedrock', apiKey: '', model: 'anthropic.claude-test' }, agents: [{ id: 'codex', name: 'Codex', bin: 'codex', available: true, models: [] }] as AgentInfo[] });
    await waitFor(() => expect(screen.getByTestId('active-conversation').textContent).toBe(`conv-${projectId}`));
    await waitFor(() => expect(screen.getByTestId('send-model-request')).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByTestId('send-model-request'));
    await waitFor(() => expect(streamViaDaemon).toHaveBeenCalledTimes(1));
    expect(streamViaDaemon).toHaveBeenCalledWith(expect.objectContaining({ clientRequestId: 'model-request', model: 'accepted-model', agentId: 'codex', expectedModelRevision: 7 }));
    expect(sessionModelApi.put).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-error').textContent).toBe('');
  });

  it.each([true, false])('reuses an attempted BYOK request without memory extraction when carrier availability is %s', async (available) => {
    const projectId = `byok-retained-${available}`;
    const sessionId = `conv-${projectId}`;
    const scope = workspaceAccountScopedCacheKey(null);
    const retained: SessionModelRequest = {
      snapshot: {
        projectId, sessionId, revision: 7, updatedAt: 1,
        choice: { agentId: 'byok-opencode', modelId: 'accepted-byok-model', byokBinding: {
          protocol: 'openai', baseUrl: config.baseUrl, requiresApiKey: true,
        } },
      },
      reasoning: null, serviceTier: null, attempted: true,
      byokMediaDefaults: { imageModel: 'accepted-image-model', videoModel: 'accepted-video-model' },
    };
    saveSessionModelRequest(retained, 'model-request', scope);
    // A later saved session pair must not replace the already-attempted tuple.
    sessionModelApi.get.mockResolvedValue({
      projectId, sessionId, revision: 9, updatedAt: 2,
      choice: { agentId: 'codex', modelId: 'later-model' },
    });
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);
    renderProjectView(project(projectId), vi.fn(), { agents: [
      { id: 'byok-opencode', name: 'BYOK OpenCode', bin: 'opencode', available, models: [] },
      { id: 'codex', name: 'Codex', bin: 'codex', available: true, models: [] },
    ] as AgentInfo[] });
    await waitFor(() => expect(modelPickerSpy.mock.calls.at(-1)?.[0]?.config.agentId).toBe('codex'));
    await waitFor(() => expect(screen.getByTestId('send-model-request')).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByTestId('send-model-request'));
    await waitFor(() => expect(streamViaDaemon).toHaveBeenCalledTimes(1));
    expect(streamViaDaemon).toHaveBeenCalledWith(expect.objectContaining({
      clientRequestId: 'model-request', expectedModelRevision: 7,
      agentId: 'byok-opencode', model: 'accepted-byok-model',
      byokBinding: retained.snapshot.choice!.byokBinding,
      byokMediaDefaults: retained.byokMediaDefaults,
      reasoning: null, serviceTier: null,
    }));
    expect(sessionModelApi.put).not.toHaveBeenCalled();
    expect(readSessionModelRequest(projectId, sessionId, 'model-request', scope)).toEqual(retained);
    expect(fetchMock).not.toHaveBeenCalledWith('/api/memory/extract', expect.any(Object));
    expect(screen.getByTestId('chat-error').textContent).toBe('');
  });

  it.each([false, true])('sends a session-only keyless provider absent from Settings (lost acknowledgement: %s)', async lostAck => {
    const projectId = `session-keyless-${lostAck}`;
    const sessionId = `conv-${projectId}`;
    const snapshot = { projectId, sessionId, revision: 4, updatedAt: 1,
      choice: { agentId: 'byok-opencode', modelId: 'llama3.2', byokBinding: {
        protocol: 'ollama' as const, baseUrl: 'http://localhost:11434/v1', requiresApiKey: false,
      } },
    };
    sessionModelApi.get.mockResolvedValue(snapshot);
    const globalDefaults: AppConfig = { ...config, mode: 'daemon', agentId: 'codex',
      agentModels: { codex: { model: 'global-model' } }, apiProtocolConfigs: {}, byokProviderConfigDrafts: {},
    };
    const before = JSON.stringify(globalDefaults);
    const actual = await vi.importActual<typeof import('../../src/providers/daemon')>('../../src/providers/daemon');
    vi.mocked(streamViaDaemon).mockImplementation(actual.streamViaDaemon);
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/runs' && options?.method === 'POST') {
        bodies.push(JSON.parse(options.body as string));
        // The daemon has accepted the first request; only its acknowledgement is lost.
        if (lostAck && bodies.length === 1) throw new Error('lost acknowledgement');
        return Response.json({ runId: 'accepted-keyless-run', conversationId: sessionId, reused: bodies.length > 1 }, { status: 202 });
      }
      if (url.includes('/events')) return new Response('event: end\ndata: {"status":"succeeded","artifactCount":0}\n\n');
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const onOpenSettings = vi.fn();
    let view = renderProjectView(project(projectId), vi.fn(), { config: globalDefaults, onOpenSettings });
    await waitFor(() => expect(modelPickerSpy.mock.calls.at(-1)?.[0]?.config.model).toBe('llama3.2'));
    await waitFor(() => expect(screen.getByTestId('send-model-request')).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByTestId('send-model-request'));
    await waitFor(() => expect(bodies).toHaveLength(1));
    const expected = { clientRequestId: 'model-request', projectId, conversationId: sessionId,
      agentId: 'byok-opencode', model: 'llama3.2', expectedModelRevision: 4,
      byokBinding: snapshot.choice.byokBinding, reasoning: null, serviceTier: null,
      byokProvider: { ...snapshot.choice.byokBinding, model: 'llama3.2', apiKey: '' },
    };
    expect(bodies[0]).toMatchObject(expected);
    expect(JSON.stringify(bodies[0])).not.toContain(config.apiKey!);
    if (lostAck) {
      await waitFor(() => expect(screen.getByTestId('chat-error')).toHaveTextContent('lost acknowledgement'));
      const retained = readSessionModelRequest(projectId, sessionId, 'model-request', workspaceAccountScopedCacheKey(null));
      expect(retained).toMatchObject({ snapshot, attempted: true });
      view.unmount();
      view = renderProjectView(project(projectId), vi.fn(), { config: globalDefaults, onOpenSettings });
      await waitFor(() => expect(screen.getByTestId('send-model-request')).toHaveProperty('disabled', false));
      fireEvent.click(screen.getByTestId('send-model-request'));
      await waitFor(() => expect(bodies).toHaveLength(2));
      expect(bodies[1]).toMatchObject(expected);
      expect(bodies[1]?.message).toEqual(bodies[0]?.message);
      expect(bodies[1]?.currentPrompt).toEqual(bodies[0]?.currentPrompt);
      expect(bodies[1]?.priorTranscript).toEqual(bodies[0]?.priorTranscript);
    }
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/memory/extract')).toHaveLength(1);
    expect(sessionModelApi.put).not.toHaveBeenCalled();
    expect(JSON.stringify(globalDefaults)).toBe(before);
  });

  it('prefills an ordinary draft once and clears its persisted pending prompt', async () => {
    const onClearPendingPrompt = vi.fn();
    renderProjectView(project('with-prompt', 'Use this prompt'), onClearPendingPrompt);

    await waitFor(() => {
      expect(composerValue()).toBe('Use this prompt');
    });
    expect(onClearPendingPrompt).toHaveBeenCalledTimes(1);
  });
  it('keeps the ordinary seeded draft after clearing and does not resurrect it on reentry', async () => {
    let savedProject = project('ordinary-reentry', 'Old pending prompt');
    const clear = vi.fn(() => { savedProject = project('ordinary-reentry'); });
    const view = renderProjectView(savedProject, clear); await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    view.rerender(projectViewElement(savedProject, clear)); expect(composerValue()).toBe('Old pending prompt'); view.unmount();
    renderProjectView(savedProject, clear); await waitFor(() => expect(composerValue()).toBe('')); expect(clear).toHaveBeenCalledTimes(1);
  });
  it('retains a recoverable Home handoff when the auto-send flag is absent', async () => {
    const projectId = 'manual-home-recovery'; const scope = workspaceAccountScopedCacheKey(null);
    writeHomeModelHandoff({ projectId, sessionId: `conv-${projectId}`, choice: { agentId: 'codex', modelId: 'default' }, modelRevision: 0, modelSaveFailed: true, prompt: 'Retain Home recovery', autoSend: false, workingDirReady: false, batchIds: [], completedBatchIds: [], attachments: [], ready: false }, scope);
    const clear = vi.fn(); renderProjectView(project(projectId, 'Retain Home recovery'), clear); await waitFor(() => expect(composerValue()).toBe('Retain Home recovery'));
    expect(clear).not.toHaveBeenCalled(); expect(readHomeModelHandoff(projectId, scope)?.prompt).toBe('Retain Home recovery'); expect(streamViaDaemon).not.toHaveBeenCalled();
  });
  it('clears a ready manual handoff after seeding and does not resurrect its prompt on reentry', async () => {
    const projectId = 'ready-manual-home'; const scope = workspaceAccountScopedCacheKey(null);
    writeHomeModelHandoff({ projectId, sessionId: `conv-${projectId}`, choice: { agentId: 'codex', modelId: 'default' }, modelRevision: 1, modelSaveFailed: false, prompt: 'Manual seed', autoSend: false, workingDirReady: true, batchIds: [], completedBatchIds: [], attachments: [], ready: true }, scope);
    let savedProject = project(projectId, 'Manual seed');
    const clear = vi.fn(() => { savedProject = project(projectId); });
    const view = renderProjectView(savedProject, clear);
    await waitFor(() => expect(composerValue()).toBe('Manual seed'));
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(readHomeModelHandoff(projectId, scope)).toBeNull(); expect(streamViaDaemon).not.toHaveBeenCalled();
    view.rerender(projectViewElement(savedProject, clear)); expect(composerValue()).toBe('Manual seed'); view.unmount();
    renderProjectView(savedProject, clear); await waitFor(() => expect(composerValue()).toBe('')); expect(clear).toHaveBeenCalledTimes(1);
  });

  it('commits refreshed file metadata and its generation key atomically', async () => {
    const oldFile: ProjectFile = {
      name: 'index.html',
      path: 'index.html',
      size: 100,
      mtime: 1_000,
      kind: 'html',
      mime: 'text/html',
    };
    const newFile: ProjectFile = { ...oldFile, size: 120, mtime: 2_000 };
    mockedFetchProjectFiles.mockResolvedValueOnce([oldFile]);

    renderProjectView(project('atomic-files'));
    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([oldFile]);
      expect(props?.filesRefreshKey).toBe(0);
    });

    let resolveRefresh!: (files: ProjectFile[]) => void;
    mockedFetchProjectFiles.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const handleProjectEvent = mockedUseProjectFileEvents.mock.calls.at(-1)?.[2] as
      | ((event: { type: 'file-changed'; path: string; kind: 'change' }) => void)
      | undefined;
    expect(handleProjectEvent).toBeTypeOf('function');
    const callsBeforeEvent = fileWorkspaceSpy.mock.calls.length;

    act(() => {
      handleProjectEvent?.({ type: 'file-changed', path: 'index.html', kind: 'change' });
    });
    await waitFor(() => expect(mockedFetchProjectFiles).toHaveBeenCalledTimes(2));

    const pendingCalls = fileWorkspaceSpy.mock.calls.slice(callsBeforeEvent);
    expect(pendingCalls.some(([props]) => (
      props.filesRefreshKey === 1 && props.files?.[0]?.mtime === oldFile.mtime
    ))).toBe(false);

    resolveRefresh([newFile]);
    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.filesRefreshKey).toBe(1);
      expect(props?.files).toEqual([newFile]);
    });
  });

  it('advances the accepted file generation for a fresh same-key revalidation', async () => {
    const oldFile: ProjectFile = {
      name: 'index.html',
      path: 'index.html',
      size: 100,
      mtime: 1_000,
      kind: 'html',
      mime: 'text/html',
    };
    const recreatedFile: ProjectFile = { ...oldFile, size: 120, mtime: 2_000 };
    mockedFetchProjectFiles
      .mockResolvedValueOnce([oldFile])
      .mockResolvedValueOnce([recreatedFile]);

    renderProjectView(project('same-key-generation'));
    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([oldFile]);
      expect(props?.filesRefreshKey).toBe(0);
      expect(props?.filesGeneration).toBe(1);
    });

    const onRefreshFiles = fileWorkspaceSpy.mock.calls.at(-1)?.[0]?.onRefreshFiles;
    expect(onRefreshFiles).toBeTypeOf('function');
    let refreshResult: { acceptedGeneration: number | null } | undefined;
    await act(async () => {
      refreshResult = await onRefreshFiles?.({ fresh: true });
    });

    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([recreatedFile]);
      expect(props?.filesRefreshKey).toBe(0);
      expect(props?.filesGeneration).toBe(2);
    });
    expect(refreshResult).toEqual({ acceptedGeneration: 2 });
    expect(mockedFetchProjectFiles.mock.calls.at(-1)?.[1]?.fresh).toBe(true);
  });

  it('does not force a preview refresh when SSE-ready reconciliation finds the same files', async () => {
    const file: ProjectFile = {
      name: 'index.html',
      path: 'index.html',
      size: 100,
      mtime: 1_000,
      kind: 'html',
      mime: 'text/html',
    };
    mockedFetchProjectFiles.mockResolvedValue([file]);

    renderProjectView(project('sse-ready-same-files'));
    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([file]);
      expect(props?.filesRefreshKey).toBe(0);
    });

    const options = mockedUseProjectFileEvents.mock.calls.at(-1)?.[3];
    await act(async () => {
      options?.onReady?.();
    });

    await waitFor(() => expect(mockedFetchProjectFiles).toHaveBeenCalledTimes(2));
    const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
    expect(props?.files).toEqual([file]);
    expect(props?.filesRefreshKey).toBe(0);
    expect(mockedFetchProjectFiles.mock.calls.at(-1)?.[1]).toMatchObject({
      fresh: true,
      requireAuthoritative: true,
    });
  });

  it('refreshes the preview when SSE-ready reconciliation finds changed files', async () => {
    const oldFile: ProjectFile = {
      name: 'index.html',
      path: 'index.html',
      size: 100,
      mtime: 1_000,
      kind: 'html',
      mime: 'text/html',
    };
    const changedFile: ProjectFile = {
      ...oldFile,
      size: 120,
      mtime: 2_000,
    };
    mockedFetchProjectFiles
      .mockResolvedValueOnce([oldFile])
      .mockResolvedValue([changedFile]);

    renderProjectView(project('sse-ready-changed-files'));
    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([oldFile]);
      expect(props?.filesRefreshKey).toBe(0);
    });

    const options = mockedUseProjectFileEvents.mock.calls.at(-1)?.[3];
    await act(async () => {
      options?.onReady?.();
    });

    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([changedFile]);
      expect(props?.filesRefreshKey).toBe(1);
    });
  });

  it('does not advance the file generation when a fresh revalidation fails', async () => {
    const file: ProjectFile = {
      name: 'index.html',
      path: 'index.html',
      size: 100,
      mtime: 1_000,
      kind: 'html',
      mime: 'text/html',
    };
    mockedFetchProjectFiles
      .mockResolvedValueOnce([file])
      .mockRejectedValueOnce(new Error('files unavailable'));

    renderProjectView(project('failed-generation'));
    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([file]);
      expect(props?.filesGeneration).toBe(1);
    });

    const onRefreshFiles = fileWorkspaceSpy.mock.calls.at(-1)?.[0]?.onRefreshFiles;
    await expect(onRefreshFiles?.({ fresh: true })).resolves.toEqual({
      acceptedGeneration: null,
    });

    const finalProps = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
    expect(finalProps?.files).toEqual([file]);
    expect(finalProps?.filesRefreshKey).toBe(0);
    expect(finalProps?.filesGeneration).toBe(1);
    expect(mockedFetchProjectFiles.mock.calls.at(-1)?.[1]).toMatchObject({
      fresh: true,
      requireAuthoritative: true,
    });
  });

  it('forces a fresh project-files read when a file event races an older in-flight read', async () => {
    const oldFile: ProjectFile = {
      name: 'index.html',
      path: 'index.html',
      size: 100,
      mtime: 1_000,
      kind: 'html',
      mime: 'text/html',
    };
    const newFile: ProjectFile = { ...oldFile, size: 120, mtime: 2_000 };
    const actualFetchProjectFiles = registryOriginals.fetchProjectFiles;
    if (!actualFetchProjectFiles) throw new Error('expected actual fetchProjectFiles');
    mockedFetchProjectFiles.mockImplementation(actualFetchProjectFiles);
    resetSharedCancellableGet();

    let fileReads = 0;
    let phase: 'initial' | 'older-inflight' | 'fresh' = 'initial';
    let olderInflightReads = 0;
    let resolveOlderRead!: () => void;
    const olderRead = new Promise<void>((resolve) => {
      resolveOlderRead = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
      if (!url.endsWith('/api/projects/inflight-files/files')) {
        return new Response('', { status: 404 });
      }
      fileReads += 1;
      if (phase === 'older-inflight') {
        olderInflightReads += 1;
        await olderRead;
        return new Response(JSON.stringify({ files: [oldFile] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        files: [phase === 'fresh' ? newFile : oldFile],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    renderProjectView(project('inflight-files'));
    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([oldFile]);
      expect(props?.filesRefreshKey).toBe(0);
    });

    resetSharedCancellableGet();
    phase = 'older-inflight';
    const onRefreshFiles = fileWorkspaceSpy.mock.calls.at(-1)?.[0]?.onRefreshFiles;
    expect(onRefreshFiles).toBeTypeOf('function');
    const olderRefresh = onRefreshFiles?.();
    await waitFor(() => expect(olderInflightReads).toBe(1));

    phase = 'fresh';
    const handleProjectEvent = mockedUseProjectFileEvents.mock.calls.at(-1)?.[2] as
      | ((event: { type: 'file-changed'; path: string; kind: 'change' }) => void)
      | undefined;
    act(() => {
      handleProjectEvent?.({ type: 'file-changed', path: 'index.html', kind: 'change' });
    });

    await waitFor(() => expect(fileReads).toBeGreaterThan(olderInflightReads + 1));
    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([newFile]);
      expect(props?.filesRefreshKey).toBe(1);
    });

    resolveOlderRead();
    await olderRefresh;
    await Promise.resolve();
    const finalProps = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
    expect(finalProps?.files).toEqual([newFile]);
    expect(finalProps?.filesRefreshKey).toBe(1);
  });

  it('bypasses a settled project-files result still inside the shared one-second TTL', async () => {
    const oldFile: ProjectFile = {
      name: 'index.html',
      path: 'index.html',
      size: 100,
      mtime: 1_000,
      kind: 'html',
      mime: 'text/html',
    };
    const newFile: ProjectFile = { ...oldFile, size: 120, mtime: 2_000 };
    const actualFetchProjectFiles = registryOriginals.fetchProjectFiles;
    if (!actualFetchProjectFiles) throw new Error('expected actual fetchProjectFiles');
    mockedFetchProjectFiles.mockImplementation(actualFetchProjectFiles);
    resetSharedCancellableGet();

    let fileReads = 0;
    let servedFiles = [oldFile];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
      if (!url.endsWith('/api/projects/settled-files/files')) {
        return new Response('', { status: 404 });
      }
      fileReads += 1;
      return new Response(JSON.stringify({ files: servedFiles }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    renderProjectView(project('settled-files'));
    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([oldFile]);
      expect(props?.filesRefreshKey).toBe(0);
    });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    const cachedReadCount = fileReads;
    expect(cachedReadCount).toBeGreaterThan(0);

    servedFiles = [newFile];
    const handleProjectEvent = mockedUseProjectFileEvents.mock.calls.at(-1)?.[2] as
      | ((event: { type: 'file-changed'; path: string; kind: 'change' }) => void)
      | undefined;
    act(() => {
      handleProjectEvent?.({ type: 'file-changed', path: 'index.html', kind: 'change' });
    });

    await waitFor(() => expect(fileReads).toBeGreaterThan(cachedReadCount));
    expect(mockedFetchProjectFiles.mock.calls.some(([, options]) => options?.fresh === true)).toBe(true);
    await waitFor(() => {
      const props = fileWorkspaceSpy.mock.calls.at(-1)?.[0];
      expect(props?.files).toEqual([newFile]);
      expect(props?.filesRefreshKey).toBe(1);
    });
  });

  it.each([true, false])('sends the accepted Home brief binding in the run body (automatic: %s)', async automatic => {
    const projectId = `home-accepted-brief-${automatic}`;
    const sessionId = `conv-${projectId}`;
    const prompt = 'Send model request';
    const designBrief = { id: 'brief_home_accepted', revision: 2, hash: 'b'.repeat(64) };
    writeHomeModelHandoff({
      projectId, sessionId, choice: null, modelRevision: 0, modelSaveFailed: false,
      prompt, designBrief, autoSend: true, workingDirReady: true,
      batchIds: [], completedBatchIds: [], attachments: [], ready: true,
    }, workspaceAccountScopedCacheKey(null));
    if (automatic) window.sessionStorage.setItem(`od:auto-send-first:${projectId}`, '1');
    const actual = await vi.importActual<typeof import('../../src/providers/daemon')>('../../src/providers/daemon');
    vi.mocked(streamViaDaemon).mockImplementation(actual.streamViaDaemon);
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/runs' && options?.method === 'POST') {
        bodies.push(JSON.parse(options.body as string));
        return Response.json({ error: 'fixture-rejection' }, { status: 422 });
      }
      return Response.json({});
    }));
    renderProjectView(project(projectId, prompt));
    if (!automatic) {
      await waitFor(() => expect(screen.getByTestId('send-model-request')).toHaveProperty('disabled', false));
      fireEvent.click(screen.getByTestId('send-model-request'));
    }
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ projectId, conversationId: sessionId, currentPrompt: prompt, brief: designBrief });
    expect(readHomeModelHandoff(projectId, workspaceAccountScopedCacheKey(null))?.designBrief).toEqual(designBrief);
  });

  it('saves the actual seed choice before send and retains Home input until a run is admitted', async () => {
    const projectId = 'model-admission';
    const onClearPendingPrompt = vi.fn();
    vi.mocked(streamViaDaemon).mockImplementation(async () => {});
    window.sessionStorage.setItem(`od:auto-send-first:${projectId}`, '1');
    window.sessionStorage.setItem(`od:auto-send-prompt:${projectId}`, 'Retain this input');
    renderProjectView(project(projectId, 'Retain this input'), onClearPendingPrompt);
    await waitFor(() => expect(streamViaDaemon).toHaveBeenCalledTimes(1));
    expect(sessionModelApi.put).toHaveBeenCalledWith(`conv-${projectId}`, projectId, expect.objectContaining({ agentId: 'byok-opencode', modelId: 'api-model', expectedRevision: 0 }), null);
    const sent = vi.mocked(streamViaDaemon).mock.calls[0]![0];
    expect(sent).toMatchObject({ conversationId: `conv-${projectId}`, agentId: 'byok-opencode', model: 'api-model', expectedModelRevision: 1, byokBinding: expect.objectContaining({ baseUrl: config.baseUrl }) });
    expect(sessionModelApi.put.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(streamViaDaemon).mock.invocationCallOrder[0]!);
    expect(window.sessionStorage.getItem(`od:auto-send-first:${projectId}`)).toBe('1');
    expect(onClearPendingPrompt).not.toHaveBeenCalled();
    act(() => sent.onRunCreated?.('actual-accepted-run'));
    expect(window.sessionStorage.getItem(`od:auto-send-first:${projectId}`)).toBeNull();
    expect(onClearPendingPrompt).toHaveBeenCalledTimes(1);
    const frozenAdmission = { ...admission, runId: 'actual-accepted-run', projectId, sessionId: `conv-${projectId}`, requested: { agentId: 'byok-opencode', modelId: 'api-model', byokBinding: sent.byokBinding! }, effectiveModel: 'api-model', replayNotice: null };
    act(() => sent.onModelAdmission?.(frozenAdmission));
    await waitFor(() => expect(chatPaneSpy.mock.calls.at(-1)?.[0]?.messages?.find((message: ChatMessage) => message.role === 'assistant')?.modelAdmission).toEqual(frozenAdmission));
    act(() => modelPickerSpy.mock.calls.at(-1)?.[0]?.onAgentChange('claude'));
    await waitFor(() => expect(sessionModelApi.put).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(modelPickerSpy.mock.calls.at(-1)?.[0]?.config.agentId).toBe('claude'));
    expect(chatPaneSpy.mock.calls.at(-1)?.[0]?.messages?.find((message: ChatMessage) => message.role === 'assistant')?.modelAdmission?.requested).toEqual(frozenAdmission.requested);
  });
  it('does not send or consume Home input when the legacy seed model PUT fails', async () => {
    const projectId = 'model-failed-put';
    sessionModelApi.put.mockRejectedValue(new Error('offline'));
    const onClearPendingPrompt = vi.fn();
    window.sessionStorage.setItem(`od:auto-send-first:${projectId}`, '1');
    window.sessionStorage.setItem(`od:auto-send-prompt:${projectId}`, 'Retain failed input');
    renderProjectView(project(projectId, 'Retain failed input'), onClearPendingPrompt);
    await waitFor(() => expect(sessionModelApi.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(chatPaneSpy.mock.calls.at(-1)?.[0]?.error).toBe('sessionModel.error'));
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(`od:auto-send-prompt:${projectId}`)).toBe('Retain failed input');
    expect(onClearPendingPrompt).not.toHaveBeenCalled();
  });

  it('auto-sends the Home-carried workspace context with the first user message', async () => {
    const projectId = 'with-context';
    const workspaceItem = {
      id: 'project:reference-a',
      kind: 'project',
      label: 'Reference A',
      title: 'Reference A',
      path: 'reference-a',
      absolutePath: '/tmp/open-design/missing-reference-a',
    };
    window.sessionStorage.setItem(`od:auto-send-first:${projectId}`, '1');
    window.sessionStorage.setItem(
      `od:auto-send-context:${projectId}`,
      JSON.stringify({ workspaceItems: [workspaceItem] }),
    );

    renderProjectView(project(projectId, 'Use the reference project'));

    await waitFor(() => {
      expect(mockedSaveMessage).toHaveBeenCalled();
    });
    const userMessageCall = mockedSaveMessage.mock.calls.find(
      ([, , message]) => message.role === 'user',
    );
    expect(userMessageCall?.[0]).toBe(projectId);
    expect(userMessageCall?.[1]).toBe(`conv-${projectId}`);
    expect(userMessageCall?.[2]).toEqual(expect.objectContaining({
      role: 'user',
      content: 'Use the reference project',
      runContext: {
        workspaceItems: [workspaceItem],
      },
    }));
  });

  it('auto-sends the session-carried prompt when the project projection drops pendingPrompt', async () => {
    const projectId = 'with-session-prompt';
    const prompt = 'Create the artifact after the project list refreshes';
    window.sessionStorage.setItem(`od:auto-send-first:${projectId}`, '1');
    window.sessionStorage.setItem(`od:auto-send-prompt:${projectId}`, prompt);

    renderProjectView(project(projectId));

    await waitFor(() => {
      expect(mockedSaveMessage).toHaveBeenCalled();
    });
    const userMessageCall = mockedSaveMessage.mock.calls.find(
      ([, , message]) => message.role === 'user',
    );
    expect(userMessageCall?.[2]).toEqual(expect.objectContaining({
      role: 'user',
      content: prompt,
    }));
    expect(window.sessionStorage.getItem(`od:auto-send-first:${projectId}`)).toBeNull();
    expect(window.sessionStorage.getItem(`od:auto-send-prompt:${projectId}`)).toBeNull();
  });

  it('keeps the Home auto-send pending when preflight rejects transiently, then retries after recovery', async () => {
    const projectId = 'auto-send-retry';
    const currentProject = project(projectId, 'Create the artifact');
    const onClearPendingPrompt = vi.fn();
    const onOpenSettings = vi.fn();
    window.sessionStorage.setItem(`od:auto-send-first:${projectId}`, '1');

    const view = renderProjectView(currentProject, onClearPendingPrompt, {
      config: {
        ...config,
        apiKey: '',
      },
      onOpenSettings,
    });

    await waitFor(() => expect(screen.getByTestId('session-model-status').getAttribute('role')).toBe('alert'));
    fireEvent.click(screen.getByRole('button', { name: 'sessionModel.settings' }));
    expect(onOpenSettings).toHaveBeenCalledWith('execution');
    expect(mockedSaveMessage).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(`od:auto-send-first:${projectId}`)).toBe('1');

    view.rerender(projectViewElement(currentProject, onClearPendingPrompt, {
      config,
      onOpenSettings,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'sessionModel.retry' }));

    await waitFor(() => {
      expect(mockedSaveMessage).toHaveBeenCalled();
    });
    expect(window.sessionStorage.getItem(`od:auto-send-first:${projectId}`)).toBeNull();
  });

  it('holds the Home auto-send until the picked batch finishes uploading', async () => {
    // OPEND-2585. The project frame now opens while the Home batch is still
    // going up, so the auto-send is the only thing left waiting on it. If it
    // fired on the first frame the user's prompt would go out with none of the
    // files they attached to it.
    const projectId = 'auto-send-uploading-batch';
    const prompt = '我上传了多少个文件';
    window.sessionStorage.setItem(`od:auto-send-first:${projectId}`, '1');
    window.sessionStorage.setItem(`od:auto-send-prompt:${projectId}`, prompt);
    beginHomeAttachmentUploads(projectId, [
      new File(['a'], 'shot-0.png', { type: 'image/png' }),
      new File(['b'], 'shot-1.png', { type: 'image/png' }),
    ]);

    renderProjectView(project(projectId));

    // The conversation has resolved and messages have loaded — everything the
    // auto-send waits on EXCEPT the uploads. It must still not have fired.
    await screen.findByText(`conv-${projectId}`);
    await waitFor(() => expect(chatPaneSpy).toHaveBeenCalled());
    expect(mockedSaveMessage).not.toHaveBeenCalled();
    // The composer is reachable now, which it never was behind the old
    // hand-off screen. A second prompt sent here would consume the turn the
    // Home prompt is queued for, so the send waits with it.
    expect(chatPaneSpy.mock.calls.at(-1)?.[0]?.sendDisabled).toBe(true);

    // The uploads answer, in the order the user picked the files.
    window.sessionStorage.setItem(
      `od:auto-send-attachments:${projectId}`,
      JSON.stringify([
        { path: 'attachments/shot-0.png', name: 'shot-0.png', kind: 'image', size: 1 },
        { path: 'attachments/shot-1.png', name: 'shot-1.png', kind: 'image', size: 1 },
      ]),
    );
    await act(async () => {
      settleHomeAttachmentUpload(projectId, 0);
      settleHomeAttachmentUpload(projectId, 1);
      endHomeAttachmentUploads(projectId);
      await Promise.resolve();
    });

    await waitFor(() => expect(mockedSaveMessage).toHaveBeenCalled());
    expect(chatPaneSpy.mock.calls.at(-1)?.[0]?.sendDisabled).toBe(false);
    const userMessageCall = mockedSaveMessage.mock.calls.find(
      ([, , message]) => message.role === 'user',
    );
    expect(userMessageCall?.[2]).toEqual(expect.objectContaining({
      role: 'user',
      content: prompt,
      // The paths the server gave back, not the local names the frame drew.
      attachments: [
        expect.objectContaining({ path: 'attachments/shot-0.png' }),
        expect.objectContaining({ path: 'attachments/shot-1.png' }),
      ],
    }));
  });

  it('does not prefill when re-entering a project after the pending prompt was cleared', async () => {
    renderProjectView(project('cleared'));

    await waitFor(() => {
      expect(composerValue()).toBe('');
    });
  });

  it('refreshes design systems when a brand project references a missing backing system', async () => {
    const onDesignSystemsRefresh = vi.fn();
    renderProjectView(
      {
        ...project('brand-draft'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-draft',
          brandDesignSystemId: 'user:brand-draft',
        },
      },
      vi.fn(),
      { onDesignSystemsRefresh },
    );

    await waitFor(() => expect(onDesignSystemsRefresh).toHaveBeenCalledTimes(1));
  });

  it('auto-opens a draft design system tab before the registry summary refreshes', async () => {
    renderProjectView(
      {
        ...project('brand-draft-open'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-draft-open',
          brandSourceUrl: 'https://kestrel.example/',
          brandDesignSystemId: 'user:brand-draft-open',
        },
      },
    );

    await waitFor(() => {
      expect(
        fileWorkspaceSpy.mock.calls.some(([props]) =>
          props.openRequest?.name === '__design_system__',
        ),
      ).toBe(true);
    });
  });

  it('auto-opens the design system tab once a brand extraction backing system is available', async () => {
    renderProjectView(
      {
        ...project('brand-ready'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-ready',
          brandDesignSystemId: 'user:brand-ready',
        },
      },
      vi.fn(),
      {
        designSystems: [
          {
            id: 'user:brand-ready',
            title: 'Brand Ready',
            category: 'Brands',
            summary: '',
            swatches: [],
            surface: 'web',
            body: '# Brand Ready',
            source: 'user',
            status: 'draft',
            isEditable: true,
          } as DesignSystemSummary,
        ],
      },
    );

    await waitFor(() => {
      expect(
        fileWorkspaceSpy.mock.calls.some(([props]) =>
          props.openRequest?.name === '__design_system__',
        ),
      ).toBe(true);
    });
  });

  // recvqb6mfyqXLD: a design system materialized from a teammate's team share
  // is only mutable by whoever can manage that share — the same server-side
  // verdict (`canMutateUserDesignSystem`) mirrored onto the design system's
  // `canMutate` field. This tab is a genuinely separate surface from
  // `DesignSystemsTab`'s own team-tab pane (fixed earlier): `projectCollab
  // .viewerOnly` does not catch it, because team-sharing a design system does
  // not also register its backing project as team-shared at the project-
  // collab/hub level, so `designSystemEditable` needs its own signal off the
  // `designSystems` list this project's design-system tab already reads.
  it('disables the in-project design system tab for a team-synced design system the caller may not manage', async () => {
    renderProjectView(
      {
        ...project('teammate-ds-project'),
        designSystemId: 'user:teammate-ds',
        metadata: {
          kind: 'other',
          importedFrom: 'design-system',
          entryFile: 'DESIGN.md',
          sourceFileName: 'user:teammate-ds',
        },
      },
      vi.fn(),
      {
        designSystems: [
          {
            id: 'user:teammate-ds',
            title: 'Teammate DS',
            category: 'Custom',
            summary: '',
            swatches: [],
            surface: 'web',
            body: '# Teammate DS',
            source: 'user',
            status: 'draft',
            isEditable: true,
            teamSynced: true,
            canMutate: false,
          } as DesignSystemSummary,
        ],
      },
    );

    await waitFor(() => {
      expect(fileWorkspaceSpy.mock.calls.length).toBeGreaterThan(0);
    });
    expect(fileWorkspaceSpy.mock.calls.at(-1)?.[0].designSystemEditable).toBe(false);
  });

  it('keeps the in-project design system tab editable for the caller\'s own (non-team-synced) design system', async () => {
    renderProjectView(
      {
        ...project('my-ds-project'),
        designSystemId: 'user:my-ds',
        metadata: {
          kind: 'other',
          importedFrom: 'design-system',
          entryFile: 'DESIGN.md',
          sourceFileName: 'user:my-ds',
        },
      },
      vi.fn(),
      {
        designSystems: [
          {
            id: 'user:my-ds',
            title: 'My DS',
            category: 'Custom',
            summary: '',
            swatches: [],
            surface: 'web',
            body: '# My DS',
            source: 'user',
            status: 'draft',
            isEditable: true,
          } as DesignSystemSummary,
        ],
      },
    );

    await waitFor(() => {
      expect(fileWorkspaceSpy.mock.calls.length).toBeGreaterThan(0);
    });
    expect(fileWorkspaceSpy.mock.calls.at(-1)?.[0].designSystemEditable).toBe(true);
  });

  it('stops a programmatic brand extraction and returns to the draft design system tab', async () => {
    const onDesignSystemsRefresh = vi.fn();
    const onProjectsRefresh = vi.fn();
    renderProjectView(
      {
        ...project('brand-stop'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-stop',
          brandSourceUrl: 'https://kestrel.example/',
          brandDesignSystemId: 'user:brand-stop',
        },
      },
      vi.fn(),
      { onDesignSystemsRefresh, onProjectsRefresh },
    );

    await waitFor(() => {
      expect(fileWorkspaceSpy.mock.calls.at(-1)?.[0].onBrandExtractionStopRequest).toBeTypeOf('function');
    });
    expect(fileWorkspaceSpy.mock.calls.at(-1)?.[0].designSystemEditable).toBe(false);
    fileWorkspaceSpy.mock.calls.at(-1)?.[0].onBrandExtractionStopRequest?.();

    await waitFor(() => expect(mockedCancelBrandExtraction).toHaveBeenCalledWith('brand-stop'));
    await waitFor(() => expect(onDesignSystemsRefresh).toHaveBeenCalled());
    await waitFor(() => {
      expect(
        fileWorkspaceSpy.mock.calls.some(([props]) =>
          props.openRequest?.name === '__design_system__',
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(
        fileWorkspaceSpy.mock.calls.some(([props]) =>
          props.designSystemEditable === true && props.openRequest?.name === '__design_system__',
        ),
      ).toBe(true);
    });
  });

  it('continues a programmatic brand extraction from the next-step action', async () => {
    const onDesignSystemsRefresh = vi.fn();
    const onProjectsRefresh = vi.fn();
    renderProjectView(
      {
        ...project('brand-retry'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-retry',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-retry',
        },
      },
      vi.fn(),
      { onDesignSystemsRefresh, onProjectsRefresh },
    );

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction).toBeTypeOf('function');
    });
    chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction?.();

    await waitFor(() => expect(mockedContinueBrandExtraction).toHaveBeenCalledWith('brand-retry'));
    await waitFor(() => expect(onDesignSystemsRefresh).toHaveBeenCalled());
    await waitFor(() => expect(onProjectsRefresh).toHaveBeenCalled());
    await waitFor(() => {
      expect(
        fileWorkspaceSpy.mock.calls.some(([props]) =>
          props.openRequest?.name === 'brand.html',
        ),
      ).toBe(true);
    });
  });

  it('switches to the replacement conversation returned by a brand extraction retry', async () => {
    const projectId = 'brand-retry-missing';
    const replacementConversation = {
      ...conversation(projectId),
      id: 'conv-brand-replacement',
      title: 'Brand retry',
    };
    mockedListConversations
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([replacementConversation]);
    mockedCreateConversation.mockResolvedValueOnce({
      ...conversation(projectId),
      id: 'conv-brand-empty',
      title: 'Empty fallback',
    });
    mockedListMessages.mockImplementation(async (_projectId, conversationId) => {
      if (conversationId === 'conv-brand-replacement') {
        return [
          {
            id: 'replacement-transcript',
            role: 'assistant',
            content: 'Replacement retry transcript loaded',
            createdAt: 3,
          },
        ];
      }
      return [];
    });
    mockedContinueBrandExtraction.mockResolvedValueOnce({
      ok: true,
      result: {
        id: projectId,
        projectId,
        conversationId: 'conv-brand-replacement',
        sourceUrl: 'https://economist.com/',
        status: 'extracting',
        designSystemId: `user:${projectId}`,
      },
    });

    renderProjectView(
      {
        ...project(projectId),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: projectId,
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: `user:${projectId}`,
        },
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('active-conversation').textContent).toBe('conv-brand-empty');
    });
    chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction?.();

    await waitFor(() => {
      expect(mockedContinueBrandExtraction).toHaveBeenCalledWith(projectId);
    });
    await waitFor(() => {
      expect(mockedListMessages).toHaveBeenCalledWith(projectId, 'conv-brand-replacement', null, expect.any(AbortSignal));
    });
    await waitFor(() => {
      expect(screen.getByTestId('active-conversation').textContent).toBe('conv-brand-replacement');
    });
    await waitFor(() => {
      expect(screen.getByTestId('chat-message-content').textContent).toContain(
        'Replacement retry transcript loaded',
      );
    });
  });

  it('opens the browser assist tab from the assist card action without extracting yet', async () => {
    renderProjectView(
      {
        ...project('brand-open'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-open',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-open',
        },
      },
    );

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].onBrandBrowserAssistConfirm).toBeTypeOf('function');
    });
    const result = await chatPaneSpy.mock.calls.at(-1)?.[0].onBrandBrowserAssistConfirm?.({
      kind: 'brand-browser-assist',
      brandId: 'brand-open',
      browserTabId: '__browser__:1',
      url: 'https://economist.com/',
      reason: 'Cloudflare',
    });

    expect(result).toEqual({ ok: true, action: 'opened' });
    expect(mockedExtractBrandFromHtml).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        fileWorkspaceSpy.mock.calls.some(([props]) =>
          props.browserOpenRequest?.tabId === '__browser__:1' &&
          props.browserOpenRequest.url === 'https://economist.com/',
        ),
      ).toBe(true);
    });
  });

  it('continues a blocked brand extraction from the unblocked Browser tab DOM when available', async () => {
    const onDesignSystemsRefresh = vi.fn();
    const onProjectsRefresh = vi.fn();
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce('<html><head><title>Economist</title></head><body><h1>Economist</h1></body></html>')
      .mockResolvedValueOnce('body { color: #111111; background: #ffffff; }');
    brandBrowserBridgeMocks.getBrandBrowser.mockReturnValue({
      isDesktopWebview: true,
      getURL: () => 'https://economist.com/',
      executeJavaScript,
    });

    renderProjectView(
      {
        ...project('brand-retry'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-retry',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-retry',
        },
      },
      vi.fn(),
      { onDesignSystemsRefresh, onProjectsRefresh },
    );

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction).toBeTypeOf('function');
    });
    chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction?.();

    await waitFor(() => {
      expect(mockedExtractBrandFromHtml).toHaveBeenCalledWith('brand-retry', {
        html: '<html><head><title>Economist</title></head><body><h1>Economist</h1></body></html>',
        css: 'body { color: #111111; background: #ffffff; }',
        baseUrl: 'https://economist.com/',
      });
    });
    expect(mockedContinueBrandExtraction).toHaveBeenCalledWith('brand-retry');
    await waitFor(() => expect(onDesignSystemsRefresh).toHaveBeenCalled());
    await waitFor(() => expect(onProjectsRefresh).toHaveBeenCalled());
    await waitFor(() => {
      expect(
        fileWorkspaceSpy.mock.calls.some(([props]) =>
          props.openRequest?.name === 'brand.html',
        ),
      ).toBe(true);
    });
  });

  it('continues to the current Browser tab when a saved page archive is stale', async () => {
    const onDesignSystemsRefresh = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/raw/browser/latest-page-snapshot.json')) {
        return new Response(JSON.stringify({
          schema: BROWSER_PAGE_ARCHIVE_SCHEMA,
          capturedAt: 123,
          title: 'Stale wall',
          url: 'https://economist.com/',
          baseUrl: 'https://economist.com/',
          htmlFile: 'browser/page-archive/stale.html',
          cssFile: 'browser/page-archive/stale.css',
          manifestFile: 'browser/latest-page-snapshot.json',
          resources: [],
        }), { status: 200 });
      }
      if (url.includes('/raw/browser/page-archive/stale.html')) {
        return new Response('<html><body>Human verification required</body></html>', { status: 200 });
      }
      if (url.includes('/raw/browser/page-archive/stale.css')) {
        return new Response('body { color: #888888; }', { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    mockedExtractBrandFromHtml
      .mockResolvedValueOnce({
        ok: false,
        error: 'Programmatic extraction blocked by Cloudflare.',
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          id: 'brand-retry',
          brand: {
            name: 'Economist',
            tagline: '',
            description: '',
            sourceUrl: 'https://economist.com/',
            logo: { primary: null, alternates: [], notes: '' },
            colors: [],
            typography: {
              display: { family: 'serif', fallbacks: [], weights: [400] },
              body: { family: 'serif', fallbacks: [], weights: [400] },
            },
            voice: {
              adjectives: [],
              tone: '',
              messagingPillars: [],
              vocabulary: { use: [], avoid: [] },
            },
            imagery: { style: '', subjects: [], treatment: '', avoid: [] },
            layout: { radius: '0', borderWeight: '1px', spacing: 'normal', postureRules: [] },
          } satisfies Brand,
          designSystemId: 'user:brand-retry',
          projectId: 'brand-retry',
          files: [],
        },
      });
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce('<html><head><title>Economist</title></head><body><h1>Current page</h1></body></html>')
      .mockResolvedValueOnce('body { color: #111111; background: #ffffff; }');
    brandBrowserBridgeMocks.getBrandBrowser.mockReturnValue({
      isDesktopWebview: true,
      getURL: () => 'https://economist.com/',
      executeJavaScript,
    });

    renderProjectView(
      {
        ...project('brand-retry'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-retry',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-retry',
        },
      },
      vi.fn(),
      { onDesignSystemsRefresh },
    );

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction).toBeTypeOf('function');
    });
    chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction?.();

    await waitFor(() => {
      expect(mockedExtractBrandFromHtml).toHaveBeenCalledTimes(2);
    });
    expect(mockedExtractBrandFromHtml).toHaveBeenNthCalledWith(1, 'brand-retry', {
      html: '<html><body>Human verification required</body></html>',
      css: 'body { color: #888888; }',
      baseUrl: 'https://economist.com/',
    });
    expect(mockedExtractBrandFromHtml).toHaveBeenNthCalledWith(2, 'brand-retry', {
      html: '<html><head><title>Economist</title></head><body><h1>Current page</h1></body></html>',
      css: 'body { color: #111111; background: #ffffff; }',
      baseUrl: 'https://economist.com/',
    });
    expect(mockedContinueBrandExtraction).toHaveBeenCalledWith('brand-retry');
    await waitFor(() => expect(onDesignSystemsRefresh).toHaveBeenCalled());
    fetchSpy.mockRestore();
  });

  it('continues browser DOM extraction after a www redirect from the source URL', async () => {
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce('<html><head><title>The Economist</title></head><body><h1>The Economist</h1></body></html>')
      .mockResolvedValueOnce('body { color: #e3120b; background: #ffffff; }');
    brandBrowserBridgeMocks.getBrandBrowser.mockReturnValue({
      isDesktopWebview: true,
      getURL: () => 'https://www.economist.com/',
      executeJavaScript,
    });

    renderProjectView(
      {
        ...project('brand-retry'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-retry',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-retry',
        },
      },
    );

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction).toBeTypeOf('function');
    });
    chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction?.();

    await waitFor(() => {
      expect(mockedExtractBrandFromHtml).toHaveBeenCalledWith('brand-retry', {
        html: '<html><head><title>The Economist</title></head><body><h1>The Economist</h1></body></html>',
        css: 'body { color: #e3120b; background: #ffffff; }',
        baseUrl: 'https://www.economist.com/',
      });
    });
    expect(mockedContinueBrandExtraction).toHaveBeenCalledWith('brand-retry');
  });

  it('continues browser DOM extraction after a same-site locale redirect from the source URL', async () => {
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce('<html><head><title>Example</title></head><body><h1>Example</h1></body></html>')
      .mockResolvedValueOnce('body { color: #1f2937; background: #ffffff; }');
    brandBrowserBridgeMocks.getBrandBrowser.mockReturnValue({
      isDesktopWebview: true,
      getURL: () => 'https://example.com/en/',
      executeJavaScript,
    });

    renderProjectView(
      {
        ...project('brand-retry'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-retry',
          brandSourceUrl: 'https://example.com/',
          brandDesignSystemId: 'user:brand-retry',
        },
      },
    );

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction).toBeTypeOf('function');
    });
    chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction?.();

    await waitFor(() => {
      expect(mockedExtractBrandFromHtml).toHaveBeenCalledWith('brand-retry', {
        html: '<html><head><title>Example</title></head><body><h1>Example</h1></body></html>',
        css: 'body { color: #1f2937; background: #ffffff; }',
        baseUrl: 'https://example.com/en/',
      });
    });
    expect(mockedContinueBrandExtraction).toHaveBeenCalledWith('brand-retry');
  });

  it('falls back to programmatic retry when the Browser tab is on another origin', async () => {
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce('<html><head><title>Wrong</title></head><body><h1>Wrong</h1></body></html>')
      .mockResolvedValueOnce('body { color: #111111; background: #ffffff; }');
    brandBrowserBridgeMocks.getBrandBrowser.mockReturnValue({
      isDesktopWebview: true,
      getURL: () => 'https://wrong.example/',
      executeJavaScript,
    });

    renderProjectView(
      {
        ...project('brand-retry'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-retry',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-retry',
        },
      },
    );

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction).toBeTypeOf('function');
    });
    chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction?.();

    await waitFor(() => expect(mockedContinueBrandExtraction).toHaveBeenCalledWith('brand-retry'));
    expect(mockedExtractBrandFromHtml).not.toHaveBeenCalled();
  });

  it('falls back to programmatic retry when the Browser tab is same-origin but off-path', async () => {
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce('<html><head><title>Login</title></head><body><h1>Login</h1></body></html>')
      .mockResolvedValueOnce('body { color: #111111; background: #ffffff; }');
    brandBrowserBridgeMocks.getBrandBrowser.mockReturnValue({
      isDesktopWebview: true,
      getURL: () => 'https://economist.com/login?next=/',
      executeJavaScript,
    });

    renderProjectView(
      {
        ...project('brand-retry'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-retry',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-retry',
        },
      },
    );

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction).toBeTypeOf('function');
    });
    chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction?.();

    await waitFor(() => expect(mockedContinueBrandExtraction).toHaveBeenCalledWith('brand-retry'));
    expect(mockedExtractBrandFromHtml).not.toHaveBeenCalled();
  });

  it('falls back to programmatic retry when the Browser tab DOM read fails', async () => {
    const executeJavaScript = vi.fn().mockRejectedValueOnce(new Error('bridge timed out'));
    brandBrowserBridgeMocks.getBrandBrowser.mockReturnValue({
      isDesktopWebview: true,
      getURL: () => 'https://economist.com/',
      executeJavaScript,
    });

    renderProjectView(
      {
        ...project('brand-retry'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-retry',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-retry',
        },
      },
    );

    await waitFor(() => {
      expect(chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction).toBeTypeOf('function');
    });
    chatPaneSpy.mock.calls.at(-1)?.[0].onContinueBrandExtraction?.();

    await waitFor(() => expect(mockedContinueBrandExtraction).toHaveBeenCalledWith('brand-retry'));
    expect(mockedExtractBrandFromHtml).not.toHaveBeenCalled();
  });

  it('does not duplicate a persisted browser-assist card already in the conversation', async () => {
    mockedFetchBrands.mockResolvedValue([
      {
        meta: {
          id: 'brand-blocked',
          sourceUrl: 'https://economist.com/',
          createdAt: 1,
          updatedAt: 2,
          status: 'failed',
          blocked: true,
          blockedReason: 'Cloudflare',
          designSystemId: 'user:brand-blocked',
        },
        brand: null,
      },
    ]);
    mockedListMessages.mockResolvedValueOnce([
      {
        id: 'existing-assist',
        role: 'assistant',
        content:
          'chat.brandBrowserAssistMessage\n\n<od-card type="brand-browser-assist">{"brandId":"brand-blocked","browserTabId":"__browser__:1","url":"https://economist.com/","reason":"Cloudflare"}</od-card>',
        createdAt: 2,
      },
    ]);

    renderProjectView(
      {
        ...project('brand-blocked'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-blocked',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-blocked',
        },
      },
    );

    await waitFor(() => expect(mockedFetchBrands).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    expect(
      mockedSaveMessage.mock.calls.some((call) =>
        String(call[2]?.content ?? '').includes('<od-card type="brand-browser-assist"'),
      ),
    ).toBe(false);
  });

  it('lets a terminal failed poll supersede a local retry status override', async () => {
    mockedFetchBrands.mockResolvedValue([
      {
        meta: {
          id: 'brand-retry',
          sourceUrl: 'https://economist.com/',
          createdAt: 1,
          updatedAt: 2,
          status: 'failed',
          designSystemId: 'user:brand-retry',
        },
        brand: null,
      },
    ]);

    renderProjectView(
      {
        ...project('brand-retry'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-retry',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-retry',
        },
      },
    );

    await waitFor(() => {
      expect(fileWorkspaceSpy.mock.calls.at(-1)?.[0].designSystemEditable).toBe(true);
    });
    const callsBeforeContinue = fileWorkspaceSpy.mock.calls.length;

    latestChatPaneProps().onContinueBrandExtraction?.();

    await waitFor(() => expect(mockedContinueBrandExtraction).toHaveBeenCalledWith('brand-retry'));
    await waitFor(() => {
      const callsAfterContinue = fileWorkspaceSpy.mock.calls.slice(callsBeforeContinue);
      expect(callsAfterContinue.some(([props]) => props.designSystemEditable === false)).toBe(true);
      expect(fileWorkspaceSpy.mock.calls.at(-1)?.[0].designSystemEditable).toBe(true);
    });
  });

  it('dedupes rapid programmatic brand continuation before the busy rerender lands', async () => {
    let resolveContinue:
      | ((value: Awaited<ReturnType<typeof continueBrandExtraction>>) => void)
      | undefined;
    mockedContinueBrandExtraction.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveContinue = resolve;
      }),
    );

    renderProjectView(
      {
        ...project('brand-retry'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-retry',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-retry',
        },
      },
    );

    await waitFor(() => expect(latestChatPaneProps().onContinueBrandExtraction).toBeTruthy());
    const { onContinueBrandExtraction } = latestChatPaneProps();
    onContinueBrandExtraction?.();
    onContinueBrandExtraction?.();

    await waitFor(() => {
      expect(mockedContinueBrandExtraction).toHaveBeenCalledTimes(1);
      expect(latestChatPaneProps().continueBrandExtractionBusy).toBe(true);
    });

    resolveContinue?.({
      ok: true,
      result: {
        id: 'brand-retry',
        projectId: 'brand-retry',
        conversationId: 'conv-brand-retry',
        sourceUrl: 'https://economist.com/',
        status: 'extracting',
        designSystemId: 'user:brand-retry',
      },
    });

    await waitFor(() => {
      expect(latestChatPaneProps().continueBrandExtractionBusy).toBe(false);
    });
  });

  it('refreshes brand.html when the brand extraction reaches a failed terminal state', async () => {
    mockedFetchBrands.mockResolvedValue([
      {
        meta: {
          id: 'brand-failed',
          sourceUrl: 'https://economist.com/',
          createdAt: 1,
          updatedAt: 2,
          status: 'failed',
          designSystemId: 'user:brand-failed',
        },
        brand: null,
      },
    ]);

    renderProjectView(
      {
        ...project('brand-failed'),
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandId: 'brand-failed',
          brandSourceUrl: 'https://economist.com/',
          brandDesignSystemId: 'user:brand-failed',
        },
      },
    );

    await waitFor(() => {
      expect(fileWorkspaceSpy.mock.calls.some(([props]) => (props.filesRefreshKey ?? 0) > 0)).toBe(true);
    });
  });

  it('does not leak a prior project prompt into a template project without one', async () => {
    const first = project('source', 'Old seed');
    const second = {
      ...project('template'),
      metadata: { kind: 'template' as const, templateId: 'tmpl-1' },
    };
    const view = renderProjectView(first);

    await waitFor(() => {
      expect(composerValue()).toBe('Old seed');
    });

    view.rerender(
      <ProjectView
        project={second}
        routeFileName={null}
        config={config}
        agents={[]}
        skills={[]}
        designTemplates={[]}
        designSystems={[]}
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
      />,
    );

    await waitFor(() => {
      expect(composerValue()).toBe('');
    });
  });
});

function composerValue(): string {
  return (screen.getByTestId('chat-composer-input') as HTMLTextAreaElement)
    .value;
}

function latestChatPaneProps(): MockChatPaneProps {
  const latest = chatPaneSpy.mock.calls.at(-1);
  if (!latest) throw new Error('ChatPane was not rendered');
  return latest[0] as MockChatPaneProps;
}
