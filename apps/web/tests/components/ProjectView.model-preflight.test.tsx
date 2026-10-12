// @vitest-environment jsdom
import { getSessionModelFixture, resetSessionModelApiFixture } from '../fixtures/session-model-api';
/**
 * AC-R02.3 — the model/attachment capability preflight must actually gate a
 * real send from ProjectView, not just exist as an unused export (review
 * finding: zero production call sites for `SessionModelPreflightBanner` /
 * `postModelPreflight`).
 *
 * Structured like `opend-2614-send-paints-before-preflight.test.tsx`: the
 * preflight check runs in the same post-paint, awaited, retract-on-reject
 * slot as the AMR balance gate, so a mismatch never discards the drafted
 * prompt (the painted turn is retracted, exactly like a rejected AMR gate),
 * and the mismatch itself renders through `SessionModelPreflightBanner`.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type ModelPreflightResult,
  type WorkspaceCollabContext,
} from '@mish/contracts';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectView } from '../../src/components/ProjectView';
import type { ProjectWorkspaceScopeState } from '../../src/collab/useProjectWorkspaceScope';
import { resetWorkspaceContextCache } from '../../src/collab/useWorkspaceContext';
import { streamViaDaemon } from '../../src/providers/daemon';
import { postModelPreflight } from '../../src/providers/workbench';
import { checkAmrBalanceGate } from '../../src/runtime/amr-balance-gate';
import {
  createConversation,
  listConversations,
  listMessages,
  loadTabs,
} from '../../src/state/projects';
import {
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

const PROJECT_ID = 'model-preflight-project';
const TEAM_WORKSPACE = 'nt3itfm1b95puq5w33tvzu44';
const TEAM_MEMBER = 'member-sender';
const PROMPT = 'draft a landing page';

const CALLER_CONTEXT: WorkspaceCollabContext = {
  workspaceId: TEAM_WORKSPACE,
  workspaceType: 'team',
  workspaceMemberId: TEAM_MEMBER,
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
  billingState: 'active',
  planId: 'team_pro',
  providerMode: 'platform_credits',
  seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 2 }),
  permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }),
} as WorkspaceCollabContext;

const workspaceScopeMocks = vi.hoisted(() => ({
  projectScope: { loading: true, scope: null } as ProjectWorkspaceScopeState,
  ambientContext: null as WorkspaceCollabContext | null,
  billingResponse: null as unknown,
}));
const chatPaneSpy = vi.hoisted(() => vi.fn());
const projectCollabMocks = vi.hoisted(() => ({
  writerAuthority: 'allowed' as 'allowed' | 'denied' | 'pending',
  viewerOnly: false,
}));

beforeEach(() => { resetSessionModelApiFixture(); window.sessionStorage.clear(); });

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
  useWorkspaceBillingResponse: () => workspaceScopeMocks.billingResponse,
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
  fetchAmrWalletSnapshot: vi.fn().mockResolvedValue(null),
  formatVelaBalanceUsd: (value: string | null) => `$${value ?? '0'}`,
  fetchVelaLoginStatus: vi.fn().mockResolvedValue({ loggedIn: true }),
  startVelaLogin: vi.fn(),
  cancelVelaLogin: vi.fn(),
  canUpgradeVelaPlan: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/runtime/amr-balance-gate', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/amr-balance-gate')>(
    '../../src/runtime/amr-balance-gate',
  );
  return { ...actual, checkAmrBalanceGate: vi.fn().mockResolvedValue({ kind: 'allow' }) };
});

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
}));

vi.mock('../../src/runtime/amr-low-balance-plan', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/runtime/amr-low-balance-plan')
  >('../../src/runtime/amr-low-balance-plan');
  return { ...actual, resolveAmrPlan: vi.fn().mockResolvedValue('pro') };
});

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
vi.mock('../../src/components/FileWorkspace', () => ({
  DESIGN_SYSTEM_TAB: '__design_system__',
  FileWorkspace: () => <div data-testid="file-workspace" />,
}));
vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: (props: {
    messages?: ChatMessage[];
    streaming?: boolean;
    sendDisabled?: boolean;
    error?: string | null;
    onStop?: () => void;
    queuedItems?: Array<{ prompt: string }>;
    composerFooterAccessory?: ReactNode;
    onSend?: (
      prompt: string,
      attachments: Array<{ path: string; name: string; kind: 'image' | 'file'; size?: number }>,
      commentAttachments: [],
    ) => unknown;
  }) => {
    chatPaneSpy(props);
    return (
      <div>
        <div data-testid="transcript">
          {(props.messages ?? [])
            .map((message) => `${message.role}:${message.content}`)
            .join('|')}
        </div>
        <div data-testid="streaming">{props.streaming ? 'yes' : 'no'}</div>
        <div data-testid="conversation-error">{props.error ?? ''}</div>
        <button
          type="button"
          data-testid="normal-send"
          disabled={props.sendDisabled}
          onClick={() => props.onSend?.(PROMPT, [], [])}
        >
          send
        </button>
        {/* Exercises the same send path with an image attachment staged,
         *  for the "preflight call failed, images present" fail-closed gate. */}
        <button
          type="button"
          data-testid="send-with-image"
          disabled={props.sendDisabled}
          onClick={() =>
            props.onSend?.(PROMPT, [{ path: 'photo.png', name: 'photo.png', kind: 'image', size: 1024 }], [])
          }
        >
          send with image
        </button>
        {/* The real ChatPane renders this in the composer footer — that is
         *  where SessionModelStatus / SessionModelPreflightBanner actually
         *  live, so the mock must render it too or the banner assertions
         *  below would pass vacuously (never finding the real component). */}
        {props.composerFooterAccessory}
      </div>
    );
  },
}));

const mockedStreamViaDaemon = vi.mocked(streamViaDaemon);
const mockedCheckAmrBalanceGate = vi.mocked(checkAmrBalanceGate);
const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedLoadTabs = vi.mocked(loadTabs);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);
const mockedFetchProjectFiles = vi.mocked(fetchProjectFiles);
const mockedFetchBrands = vi.mocked(fetchBrands);
const mockedPostModelPreflight = vi.mocked(postModelPreflight);

/** AMR on a daemon runtime, same shape as the OPEND-2614 fixture. */
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

const project = (): Project => ({
  id: PROJECT_ID,
  name: 'Model Preflight',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
  metadata: { kind: 'prototype' },
  workspaceId: TEAM_WORKSPACE,
});

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/workspace/context')) {
        return new Response(JSON.stringify({ context: CALLER_CONTEXT }), { status: 200 });
      }
      if (url.includes('/workspace-scope')) {
        return new Promise<Response>(() => {});
      }
      return new Response('{}', { status: 200 });
    }),
  );
}

function renderProjectView(overrides: Partial<ComponentProps<typeof ProjectView>> = {}) {
  return render(
    <ProjectView
      project={project()}
      routeFileName={null}
      config={config}
      agents={[{ id: 'amr', name: 'amr', available: true }] as unknown as AgentInfo[]}
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
    />,
  );
}

async function clickSendWhenReady() {
  await screen.findByTestId('normal-send');
  await waitFor(() =>
    expect((screen.getByTestId('normal-send') as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByTestId('normal-send'));
}

function transcript(): string {
  return screen.getByTestId('transcript').textContent ?? '';
}

const ok: ModelPreflightResult = { agentId: 'amr', modelId: 'default', ok: true, mismatches: [] };
const mismatch: ModelPreflightResult = {
  agentId: 'amr',
  modelId: 'default',
  ok: false,
  mismatches: [{ code: 'model-unavailable', message: 'Model "default" is not available for amr' }],
};

describe('AC-R02.3 model preflight gates a real ProjectView send', () => {
  beforeEach(() => {
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
    mockedPostModelPreflight.mockResolvedValue(ok);
    workspaceScopeMocks.projectScope = { loading: true, scope: null };
    workspaceScopeMocks.ambientContext = CALLER_CONTEXT;
    workspaceScopeMocks.billingResponse = null;
    projectCollabMocks.writerAuthority = 'allowed';
    projectCollabMocks.viewerOnly = false;
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetWorkspaceContextCache();
  });

  it('fixture self-check: a normal send actually calls the model preflight with the candidate agent/model', async () => {
    renderProjectView();
    await clickSendWhenReady();
    await waitFor(() => expect(mockedPostModelPreflight).toHaveBeenCalledTimes(1));
    const [sessionId, projectId, request] = mockedPostModelPreflight.mock.calls[0]!;
    // Regression guard for the (sessionId, projectId) argument order — the
    // conversation id, not the project id, is the session scope.
    expect(sessionId).toBe(`conv-${PROJECT_ID}`);
    expect(projectId).toBe(PROJECT_ID);
    expect(request).toMatchObject({ agentId: 'amr' });
  });

  it('an ok preflight lets the send proceed to the daemon run as before', async () => {
    renderProjectView();
    await clickSendWhenReady();
    await waitFor(() => expect(mockedPostModelPreflight).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(transcript()).toContain(`user:${PROMPT}`));
    expect(screen.queryByTestId('session-model-preflight-mismatch')).toBeNull();
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
  });

  it('a mismatch retracts the painted turn, surfaces the banner, and never starts a run', async () => {
    mockedPostModelPreflight.mockResolvedValue(mismatch);
    renderProjectView();
    await clickSendWhenReady();

    await waitFor(() => expect(mockedPostModelPreflight).toHaveBeenCalledTimes(1));
    // The turn paints optimistically (same pattern as the AMR gate), then is
    // retracted once the mismatch comes back — never left to look like a
    // silently-dropped or still-running turn.
    await waitFor(() => expect(transcript()).not.toContain(`user:${PROMPT}`));
    await waitFor(() =>
      expect(screen.getByTestId('session-model-preflight-mismatch-model-unavailable')).toBeTruthy(),
    );
    expect(screen.getByTestId('streaming').textContent).toBe('no');
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    // AMR's own balance gate must never even be reached for a send the
    // capability preflight already refused.
    expect(mockedCheckAmrBalanceGate).not.toHaveBeenCalled();
  });

  // BLOCK #1 (captain-integration preflight fixer review): `handleSend` used
  // to call `sessionModel.ensureSaved()` — which PUTs the candidate choice —
  // BEFORE this preflight check, so a rejected preflight still left the
  // incompatible model persisted. `workbench.preflight.modelUnavailable`'s
  // copy ("Keeping your previous model choice") was therefore a lie: by the
  // time it rendered, the previous choice was already overwritten. The fix
  // moves the check ahead of `ensureSaved()`, so a rejection never reaches
  // the PUT at all.
  it('OPEND preflight-before-persist: a mismatch never PUTs the rejected candidate model', async () => {
    mockedPostModelPreflight.mockResolvedValue(mismatch);
    renderProjectView();
    await clickSendWhenReady();
    await waitFor(() => expect(mockedPostModelPreflight).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(transcript()).not.toContain(`user:${PROMPT}`));
    // Give any (incorrect) in-flight PUT a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saved = await getSessionModelFixture(`conv-${PROJECT_ID}`, PROJECT_ID, CALLER_CONTEXT);
    expect(saved.revision).toBe(0);
    expect(saved.choice).toBeNull();
  });

  it('a failed preflight CALL (network/service error) fails open and still starts the run', async () => {
    mockedPostModelPreflight.mockRejectedValue(new Error('network down'));
    renderProjectView();
    await clickSendWhenReady();
    await waitFor(() => expect(mockedPostModelPreflight).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(transcript()).toContain(`user:${PROMPT}`));
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
  });

  // BLOCK #2: daemon run admission does not itself reject image attachments
  // for an agent without `supportsImagePaths` — it silently passes an empty
  // attachment list through. Failing open on a failed preflight CALL (as the
  // test above does, correctly, for a text-only send) would therefore
  // silently drop the user's images with no indication anything went wrong.
  it('a failed preflight CALL with image attachments staged fails CLOSED: no send, no persist, a truthful error', async () => {
    mockedPostModelPreflight.mockRejectedValue(new Error('network down'));
    renderProjectView();
    await screen.findByTestId('send-with-image');
    await waitFor(() =>
      expect((screen.getByTestId('send-with-image') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('send-with-image'));
    await waitFor(() => expect(mockedPostModelPreflight).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-error').textContent).toBe(
        'workbench.preflight.verificationFailed',
      ),
    );
    expect(transcript()).not.toContain(`user:${PROMPT}`);
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    const saved = await getSessionModelFixture(`conv-${PROJECT_ID}`, PROJECT_ID, CALLER_CONTEXT);
    expect(saved.revision).toBe(0);
  });
});

// AC-R02.3 select-time gate: a picker selection is itself preflighted (no
// attachments) before it is ever persisted, so an incompatible model never
// reaches the session's saved choice in the first place — there is nothing
// to restore later, because nothing bad was ever saved. A preflight result
// must also never gate a send for a model the user has since switched away
// from.
describe('AC-R02.3 select-time gate: a picker selection never persists until it passes preflight', () => {
  const agentsWithAltModel = [{
    id: 'amr',
    name: 'amr',
    available: true,
    models: [
      { id: 'default', label: 'Default', default: true },
      { id: 'alt-model', label: 'Alt Model' },
    ],
  }] as unknown as AgentInfo[];

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    resetWorkspaceContextCache();
    stubFetch();
    mockedListConversations.mockImplementation(async (projectId: string) => [conversation(projectId)]);
    mockedCreateConversation.mockImplementation(async (projectId: string) => conversation(projectId));
    mockedListMessages.mockResolvedValue([]);
    mockedFetchPreviewComments.mockResolvedValue([]);
    mockedFetchProjectFiles.mockResolvedValue([]);
    mockedFetchBrands.mockResolvedValue([]);
    mockedStreamViaDaemon.mockResolvedValue(undefined);
    mockedCheckAmrBalanceGate.mockResolvedValue({ kind: 'allow' });
    workspaceScopeMocks.projectScope = { loading: true, scope: null };
    workspaceScopeMocks.ambientContext = CALLER_CONTEXT;
    workspaceScopeMocks.billingResponse = null;
    projectCollabMocks.writerAuthority = 'allowed';
    projectCollabMocks.viewerOnly = false;
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetWorkspaceContextCache();
  });

  function switchToAltModel() {
    // ProjectView renders InlineModelSwitcher with `showExecutionOptions`, so
    // model selection goes through the searchable `SearchableModelSelect`
    // listbox (`inline-model-switcher-agent-model`), not the plain compact
    // list (that shape only renders `compact && !showExecutionOptions`).
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-model'));
    const popover = screen.getByTestId('inline-model-switcher-agent-model-popover');
    fireEvent.click(within(popover).getByRole('option', { name: 'Alt Model' }));
  }

  it('picker selects an incompatible model: no PUT, the previous selection stays active, and the banner shows the mismatch', async () => {
    mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, request: { modelId: string }) =>
      request.modelId === 'alt-model' ? mismatch : ok);
    renderProjectView({ agents: agentsWithAltModel });

    // Establish A (the default model) as the session's persisted choice via
    // one ordinary successful send.
    await clickSendWhenReady();
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
    const afterFirstSend = await getSessionModelFixture(`conv-${PROJECT_ID}`, PROJECT_ID, CALLER_CONTEXT);
    expect(afterFirstSend.choice).toMatchObject({ agentId: 'amr', modelId: 'default' });

    // Pick B (alt-model) in the switcher. The select-time gate preflights
    // this CANDIDATE (no attachments) before it is ever persisted — unlike
    // the old synchronous `controller.select`, a rejection here must never
    // reach the PUT at all.
    switchToAltModel();
    await waitFor(() =>
      expect(screen.getByTestId('session-model-preflight-mismatch-model-unavailable')).toBeTruthy(),
    );

    // The session's persisted (and displayed) model is still A — nothing
    // was ever restored, because nothing bad was ever saved.
    const afterRejectedPick = await getSessionModelFixture(`conv-${PROJECT_ID}`, PROJECT_ID, CALLER_CONTEXT);
    expect(afterRejectedPick.choice).toMatchObject({ agentId: 'amr', modelId: 'default' });
    expect(afterRejectedPick.revision).toBe(afterFirstSend.revision);
  });

  it('picker selects a model when the preflight CALL itself fails (network): no PUT, previous selection stays active', async () => {
    mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, request: { modelId: string }) =>
      request.modelId === 'alt-model' ? Promise.reject(new Error('offline')) : ok);
    renderProjectView({ agents: agentsWithAltModel });

    await clickSendWhenReady();
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
    const afterFirstSend = await getSessionModelFixture(`conv-${PROJECT_ID}`, PROJECT_ID, CALLER_CONTEXT);

    switchToAltModel();
    await waitFor(() =>
      expect(screen.getByTestId('session-model-preflight-verification-failed')).toBeTruthy(),
    );
    const afterFailedPick = await getSessionModelFixture(`conv-${PROJECT_ID}`, PROJECT_ID, CALLER_CONTEXT);
    expect(afterFailedPick.choice).toMatchObject({ agentId: 'amr', modelId: 'default' });
    expect(afterFailedPick.revision).toBe(afterFirstSend.revision);
  });

  // A send never runs while a picker check is pending. It waits for the check
  // to settle (round 3 of AC-R02.3: no refusal for picker churn). This check
  // fails, so the previous choice stays selected (use-session-model.ts) and
  // the send goes out once, on that kept choice.
  it('a send fired while a picker check is still pending waits, then runs once on the choice the check leaves selected', async () => {
    let releaseAlt: (value: ModelPreflightResult) => void = () => {};
    mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, request: { modelId: string }) =>
      request.modelId === 'alt-model' ? new Promise<ModelPreflightResult>((resolve) => { releaseAlt = resolve; }) : ok);
    renderProjectView({ agents: agentsWithAltModel });
    await screen.findByTestId('normal-send');
    await waitFor(() => expect((screen.getByTestId('normal-send') as HTMLButtonElement).disabled).toBe(false));

    switchToAltModel();
    await waitFor(() => expect(mockedPostModelPreflight.mock.calls.some(([, , request]) => (request as { modelId: string }).modelId === 'alt-model')).toBe(true));
    // Drive the handler even if the button reflects a busy state, so the
    // handler-level guard is what is under test.
    const sendButton = screen.getByTestId('normal-send') as HTMLButtonElement;
    sendButton.disabled = false;
    fireEvent.click(sendButton);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
    expect(transcript()).not.toContain(`user:${PROMPT}`);

    releaseAlt(mismatch);
    await waitFor(() => expect(screen.getByTestId('session-model-preflight-mismatch-model-unavailable')).toBeTruthy());
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
    expect(mockedStreamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'amr', model: 'default' });
  });

  // The composer's half of that contract (ChatComposer.send-wait-edits.test.tsx):
  // a send that waited out a picker check and then went out resolves as sent,
  // so the composer clears only the payload it carried and keeps edits made
  // during the wait.
  it('a send that waits for a picker check resolves as sent once it runs, so the composer clears only what it carried', async () => {
    let releaseAlt: (value: ModelPreflightResult) => void = () => {};
    mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, request: { modelId: string }) =>
      request.modelId === 'alt-model' ? new Promise<ModelPreflightResult>((resolve) => { releaseAlt = resolve; }) : ok);
    renderProjectView({ agents: agentsWithAltModel });
    await screen.findByTestId('normal-send');
    await waitFor(() => expect((screen.getByTestId('normal-send') as HTMLButtonElement).disabled).toBe(false));

    switchToAltModel();
    await waitFor(() => expect(mockedPostModelPreflight.mock.calls.some(([, , request]) => (request as { modelId: string }).modelId === 'alt-model')).toBe(true));
    const onSend = (chatPaneSpy.mock.calls.at(-1)?.[0] as { onSend: (prompt: string, attachments: [], comments: []) => Promise<unknown> }).onSend;
    let outcome: Promise<unknown> = Promise.resolve('not-sent');
    await act(async () => { outcome = onSend(PROMPT, [], []); });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mockedStreamViaDaemon).not.toHaveBeenCalled();

    releaseAlt(mismatch);
    expect(await outcome).toBeUndefined();
    expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
  });

  // The stale "default" result must never clear a send on "alt-model". The
  // send starts over on the live choice: a fresh send-time preflight for
  // alt-model, then one run on alt-model.
  it('a model switch during a pending send-time preflight discards the stale result and sends once on the new model after re-checking it', async () => {
    let resolveFirst!: (value: ModelPreflightResult) => void;
    mockedPostModelPreflight.mockImplementation(async (_sessionId, _projectId, request: { modelId: string }) => {
      if (request.modelId === 'default') return new Promise<ModelPreflightResult>((resolve) => { resolveFirst = resolve; });
      return ok; // the picker's own select-time gate for alt-model passes immediately
    });
    renderProjectView({ agents: agentsWithAltModel });

    await clickSendWhenReady();
    await waitFor(() => expect(mockedPostModelPreflight).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.objectContaining({ modelId: 'default' }), expect.anything(),
    ));

    // Switch models while that first (send-time) preflight call for "default"
    // is still in flight. The picker's OWN select-time gate for "alt-model"
    // resolves immediately as `ok`, so this persists.
    switchToAltModel();
    await waitFor(async () => {
      const afterSwitch = await getSessionModelFixture(`conv-${PROJECT_ID}`, PROJECT_ID, CALLER_CONTEXT);
      expect(afterSwitch.choice).toMatchObject({ agentId: 'amr', modelId: 'alt-model' });
    });

    // Resolve the stale "default" send-time check as OK — it must not be
    // read as clearance to send with the now-live "alt-model" choice.
    resolveFirst(ok);
    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1);
    expect(mockedStreamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'amr', model: 'alt-model' });
    // The re-check ran against alt-model with this send's attachments field.
    expect(mockedPostModelPreflight.mock.calls.some(([, , request]) =>
      (request as { modelId: string; attachments?: unknown[] }).modelId === 'alt-model'
      && Array.isArray((request as { attachments?: unknown[] }).attachments))).toBe(true);
    expect(screen.queryByTestId('session-model-preflight-mismatch')).toBeNull();
  });
});

vi.mock('../../src/providers/workbench', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/providers/workbench')>();
  const fixture = await import('../fixtures/session-model-api');
  return {
    ...actual,
    getSessionModel: fixture.getSessionModelFixture,
    putSessionModel: fixture.putSessionModelFixture,
    postModelPreflight: vi.fn(),
  };
});
