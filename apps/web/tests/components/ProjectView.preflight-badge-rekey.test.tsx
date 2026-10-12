// @vitest-environment jsdom
import { resetSessionModelApiFixture } from '../fixtures/session-model-api';
/**
 * AC-R02.3 fixer follow-up (BLOCK #3 of the captain-integration preflight
 * review): `inlineSwitcherAttachmentWarning` in `ProjectView.tsx` reshapes the
 * last `modelPreflight` result into `InlineModelSwitcher`'s per-model-row
 * warning contract, keyed off the CURRENT `config.agentModels[agentId].model`
 * — not off the agent/model the preflight result was actually computed
 * against. Switching models after a rejected send (with no new send yet)
 * changes `config` without re-running the check, so the stale result's
 * `unsupportedModelIds` silently relabels itself onto whatever model is newly
 * selected.
 *
 * `InlineModelSwitcher` itself never renders this badge for the exact prop
 * shape ProjectView passes it (`compact` + `showExecutionOptions`, see
 * `InlineModelSwitcher.tsx` — the badge only exists in the plain
 * `compact && !showExecutionOptions` branch), so this spec mocks the
 * component to capture the `attachmentWarning` prop directly rather than
 * hunting for a badge DOM node that cannot appear in production today. That
 * keeps the spec pinned to the exact computation this fix touches.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type ModelPreflightRequest,
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

const PROJECT_ID = 'preflight-badge-rekey-project';
const TEAM_WORKSPACE = 'nt3itfm1b95puq5w33tvzu45';
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
const inlineSwitcherSpy = vi.hoisted(() => vi.fn());

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
    viewerOnly: false,
    writerAuthority: 'allowed' as const,
    isOwner: true,
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
    sendDisabled?: boolean;
    composerFooterAccessory?: ReactNode;
    onSend?: (prompt: string, attachments: [], commentAttachments: []) => unknown;
  }) => (
    <div>
      <button
        type="button"
        data-testid="normal-send"
        disabled={props.sendDisabled}
        onClick={() => props.onSend?.(PROMPT, [], [])}
      >
        send
      </button>
      {props.composerFooterAccessory}
    </div>
  ),
}));

// Captures exactly the prop this fix changes (`attachmentWarning`), and lets
// the test flip the candidate model without fighting `InlineModelSwitcher`'s
// own AMR plan-tier gating — that machinery is orthogonal to the re-keying
// bug under test.
vi.mock('../../src/components/InlineModelSwitcher', () => ({
  InlineModelSwitcher: (props: {
    config: AppConfig;
    attachmentWarning?: { unsupportedModelIds: ReadonlySet<string>; reason: string };
    onAgentModelChange: (id: string, choice: { model?: string }) => void;
  }) => {
    inlineSwitcherSpy(props.attachmentWarning);
    return (
      <button
        type="button"
        data-testid="switch-to-model-b"
        onClick={() => props.onAgentModelChange('amr', { model: 'model-b' })}
      >
        switch
      </button>
    );
  },
}));

const mockedStreamViaDaemon = vi.mocked(streamViaDaemon);
const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);
const mockedFetchProjectFiles = vi.mocked(fetchProjectFiles);
const mockedFetchBrands = vi.mocked(fetchBrands);
const mockedPostModelPreflight = vi.mocked(postModelPreflight);
const mockedCheckAmrBalanceGate = vi.mocked(checkAmrBalanceGate);

const config: AppConfig = {
  mode: 'daemon',
  apiProtocol: 'openai',
  apiKey: '',
  baseUrl: '',
  model: 'deepseek-v4-flash',
  agentId: 'amr',
  agentModels: { amr: { model: 'model-a' } },
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
  name: 'Preflight Badge Rekey',
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

describe('AC-R02.3 inline-switcher attachment-warning badge re-keys on model switch', () => {
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
    // Echoes the request's own agent/model back into a rejected result, the
    // same way the real daemon endpoint does (`preflightResultSchema` always
    // carries the agentId/modelId it was asked to check). Only "model-a" is
    // rejected — AC-R02.3's select-time gate now preflights a picker
    // selection BEFORE it persists, so "model-b" must pass here or the
    // switch in the second test below would never take effect at all.
    mockedPostModelPreflight.mockImplementation(async (
      _sessionId: string,
      _projectId: string,
      request: ModelPreflightRequest,
    ) => request.modelId === 'model-a' ? {
      agentId: request.agentId,
      modelId: request.modelId,
      ok: false,
      mismatches: [{ code: 'model-unavailable' as const, message: `Model "${request.modelId}" is not available for ${request.agentId}` }],
    } : { agentId: request.agentId, modelId: request.modelId, ok: true, mismatches: [] });
    workspaceScopeMocks.projectScope = { loading: true, scope: null };
    workspaceScopeMocks.ambientContext = CALLER_CONTEXT;
    workspaceScopeMocks.billingResponse = null;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetWorkspaceContextCache();
  });

  it('a mismatch badges the CANDIDATE model the preflight actually checked (model-a)', async () => {
    renderProjectView();
    await clickSendWhenReady();
    await waitFor(() => expect(mockedPostModelPreflight).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const latest = inlineSwitcherSpy.mock.calls.at(-1)?.[0] as
        | { unsupportedModelIds: ReadonlySet<string> }
        | undefined;
      expect(latest?.unsupportedModelIds.has('model-a')).toBe(true);
    });
  });

  it('switching models after the rejected send clears the stale badge instead of relabeling it onto the new model', async () => {
    renderProjectView();
    await clickSendWhenReady();
    await waitFor(() => expect(mockedPostModelPreflight).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const latest = inlineSwitcherSpy.mock.calls.at(-1)?.[0] as
        | { unsupportedModelIds: ReadonlySet<string> }
        | undefined;
      expect(latest?.unsupportedModelIds.has('model-a')).toBe(true);
    });

    fireEvent.click(screen.getByTestId('switch-to-model-b'));

    // The stale `modelPreflight` (computed for model-a) must not relabel
    // itself onto model-b just because `config` now points at it — the badge
    // should disappear entirely until a new send actually checks model-b.
    await waitFor(() => {
      const latest = inlineSwitcherSpy.mock.calls.at(-1)?.[0];
      expect(latest).toBeUndefined();
    });
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
