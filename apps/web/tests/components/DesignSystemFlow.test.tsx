import { WorkbenchIntake, useWorkbenchIntake } from '../../src/components/WorkbenchIntake';
import { IntakeStore } from '../../src/runtime/intake/intake-store';
import type { IntakeBatchSnapshot } from '@open-design/contracts';
import { createDropCoordinator } from '../../src/runtime/intake/drop-coordinator';
// @vitest-environment jsdom

import { advanceWorkspaceAccountGeneration } from '../../src/collab/workspace-identity';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type ConnectorDetail,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import {
  buildDesignSystemPackageAuditRepairPrompt,
  summarizeDesignSystemPackageAudit,
} from '../../src/runtime/design-system-package-audit';
import {
  DesignSystemCreationFlow,
  DesignSystemDetailView,
} from '../../src/components/DesignSystemFlow';
import { CONNECTORS_CHANGED_EVENT } from '../../src/components/connectors-events';
import type {
  AgentInfo,
  AppConfig,
  ChatMessage,
  Conversation,
  DesignSystemDetail,
  DesignSystemSummary,
  Project,
  ProjectFile,
} from '../../src/types';
import { I18nProvider } from '../../src/i18n';

const mocks = vi.hoisted(() => ({
  connectConnector: vi.fn(),
  createDesignSystemDraft: vi.fn(),
  disconnectConnector: vi.fn(),
  ensureDesignSystemWorkspace: vi.fn(),
  fetchConnectorStatuses: vi.fn(),
  fetchDesignSystem: vi.fn(),
  fetchDesignSystemRevisions: vi.fn(),
  fetchProjectDesignSystemPackageAudit: vi.fn(),
  fetchProjectFiles: vi.fn(),
  fileWorkspaceProps: vi.fn(),
  getProject: vi.fn(),
  openFolderDialog: vi.fn(),
  patchProject: vi.fn(),
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  listMessages: vi.fn(),
  loadTabs: vi.fn(),
  patchConversation: vi.fn(),
  saveMessage: vi.fn(),
  saveTabs: vi.fn(),
  streamViaDaemon: vi.fn(),
  getSessionModel: vi.fn(),
  putSessionModel: vi.fn(),
  postModelPreflight: vi.fn(),
  uploadProjectFile: vi.fn(),
  writeProjectTextFile: vi.fn(),
}));

// Off by default: only the picker-pending parity case below mounts the real
// `InlineModelSwitcher` that `composerFooterAccessory` carries.
const chatPaneHarness = vi.hoisted(() => ({ renderComposerAccessory: false, sendOutcomes: [] as unknown[] }));

// Off by default. The give-up cases below hold a picker check "pending" and
// decide how its wait ends, which the real picker cannot do on demand.
const sessionModelOverride = vi.hoisted(() => ({
  pickerPending: false,
  whenPickerSettled: null as null | (() => Promise<'settled' | 'cancelled' | 'timed-out'>),
  /** Re-renders the flow so a changed override reaches its render-time refs. */
  rerender: () => {},
}));
vi.mock('../../src/runtime/workbench/use-session-model', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/runtime/workbench/use-session-model')>();
  const { useState } = await import('react');
  return {
    ...actual,
    useSessionModel: (...args: Parameters<typeof actual.useSessionModel>) => {
      const [, setTick] = useState(0);
      sessionModelOverride.rerender = () => setTick((tick) => tick + 1);
      const model = actual.useSessionModel(...args);
      return {
        ...model,
        ...(sessionModelOverride.pickerPending ? { pickerPreflight: { status: 'checking' as const, choice: model.state.choice! } } : {}),
        ...(sessionModelOverride.whenPickerSettled ? { whenPickerSettled: sessionModelOverride.whenPickerSettled } : {}),
      };
    },
  };
});

const workspaceContextState = vi.hoisted(() => ({
  context: null as WorkspaceCollabContext | null,
}));

vi.mock('../../src/collab/useWorkspaceContext', async importOriginal => ({
  // The real `InlineModelSwitcher` (picker-pending case) reads pure helpers.
  ...(await importOriginal<typeof import('../../src/collab/useWorkspaceContext')>()),
  useWorkspaceContext: () => ({
    context: workspaceContextState.context,
    loading: false,
  }),
  // Read by the real `InlineModelSwitcher` the picker-pending case mounts.
  useWorkspaceBillingResponse: () => null,
}));

vi.mock('../../src/providers/workbench', async importOriginal => ({ ...(await importOriginal<typeof import('../../src/providers/workbench')>()), getSessionModel: mocks.getSessionModel, putSessionModel: mocks.putSessionModel, postModelPreflight: mocks.postModelPreflight }));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: ({
    composerFooterAccessory,
    error,
    initialDraft,
    messages,
    onNewConversation,
    onSelectConversation,
    onSend,
    projectFileNames,
    onRequestOpenFile,
    sendDisabled,
  }: {
    composerFooterAccessory?: import('react').ReactNode;
    error?: string | null;
    initialDraft?: string;
    messages?: ChatMessage[];
    onNewConversation?: () => void;
    onSelectConversation?: (conversationId: string) => void;
    onSend: (prompt: string, attachments: unknown[], commentAttachments: unknown[]) => unknown;
    projectFileNames?: Set<string>;
    onRequestOpenFile?: (name: string) => void;
    sendDisabled?: boolean;
  }) => { const intake = useWorkbenchIntake(); return (
    <>
      {chatPaneHarness.renderComposerAccessory ? composerFooterAccessory : null}
      {error ? <div role="alert">{error}</div> : null}
      {initialDraft ? <div data-testid="chat-initial-draft">{initialDraft}</div> : null}
      <div
        data-testid="design-system-chat-state"
        data-send-disabled={sendDisabled ? 'true' : 'false'}
      >
        {messages?.map((message) => <span key={message.id}>{message.content}</span>)}
      </div>
      <button data-testid="attach-design-system-file" onClick={() => intake?.add([new File(['original'], 'ds-notes.zip')])}>Attach</button>
      <div data-testid="chat-file-names">{[...(projectFileNames ?? [])].join(',')}</div>
      <button
        type="button"
        data-testid="chat-open-file"
        onClick={() => onRequestOpenFile?.('index.html')}
      >
        open file
      </button>
      <button
        type="button"
        data-testid="new-conversation"
        onClick={() => onNewConversation?.()}
      >
        New
      </button>
      <button
        type="button"
        data-testid="select-other-conversation"
        onClick={() => onSelectConversation?.('conv-other')}
      >
        Select other
      </button>
      <button
        type="button"
        data-testid="design-system-chat-send"
        onClick={() => { chatPaneHarness.sendOutcomes.push(onSend('Update the design tokens', [], [])); }}
      >
        send
      </button>
      {/* AC-R02.3 fail-closed gate: exercises the same send path with an
       *  image attachment staged, for the "preflight call failed, images
       *  present" case. */}
      <button
        type="button"
        data-testid="design-system-chat-send-with-image"
        onClick={() => onSend('Update the design tokens', [{ path: 'photo.png', name: 'photo.png', kind: 'image', size: 1024 }], [])}
      >
        send with image
      </button>
    </>
  ); },
}));

vi.mock('../../src/components/FileWorkspace', () => ({
  DESIGN_SYSTEM_TAB: '__design_system__',
  FileWorkspace: (props: {
    files?: ProjectFile[];
    filesGeneration?: number;
    onRefreshFiles?: (options?: { fresh?: boolean }) => Promise<{
      acceptedGeneration: number | null;
    }> | void;
    openRequest?: { name: string } | null;
  }) => {
    mocks.fileWorkspaceProps(props);
    const {
      files = [],
      filesGeneration,
      onRefreshFiles,
      openRequest,
    } = props;
    return (
      <div
        data-testid="design-system-files"
        data-file-names={files.map((file) => file.name).join(',')}
        data-files-generation={filesGeneration ?? ''}
        data-open-request={openRequest?.name ?? ''}
      >
        <button
          type="button"
          data-testid="refresh-design-system-files"
          onClick={() => void onRefreshFiles?.()}
        >
          refresh files
        </button>
        <button
          type="button"
          data-testid="fresh-refresh-design-system-files"
          onClick={() => void onRefreshFiles?.({ fresh: true })}
        >
          fresh refresh files
        </button>
      </div>
    );
  },
}));

vi.mock('../../src/providers/daemon', async importOriginal => ({
  // The real `InlineModelSwitcher` (picker-pending case) reads display helpers.
  ...(await importOriginal<typeof import('../../src/providers/daemon')>()),
  streamViaDaemon: (...args: unknown[]) => mocks.streamViaDaemon(...args),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    connectConnector: mocks.connectConnector,
    createDesignSystemDraft: mocks.createDesignSystemDraft,
    disconnectConnector: mocks.disconnectConnector,
    ensureDesignSystemWorkspace: mocks.ensureDesignSystemWorkspace,
    fetchDesignSystem: mocks.fetchDesignSystem,
    fetchDesignSystemRevisions: mocks.fetchDesignSystemRevisions,
    fetchProjectDesignSystemPackageAudit: mocks.fetchProjectDesignSystemPackageAudit,
    fetchProjectFiles: mocks.fetchProjectFiles,
    fetchConnectorStatuses: mocks.fetchConnectorStatuses,
    openFolderDialog: mocks.openFolderDialog,
    uploadProjectFile: mocks.uploadProjectFile,
    writeProjectTextFile: mocks.writeProjectTextFile,
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    createConversation: mocks.createConversation,
    getProject: mocks.getProject,
    listConversations: mocks.listConversations,
    listMessages: mocks.listMessages,
    loadTabs: mocks.loadTabs,
    patchConversation: mocks.patchConversation,
    patchProject: mocks.patchProject,
    saveMessage: mocks.saveMessage,
    saveTabs: mocks.saveTabs,
  };
});

afterEach(() => {
  cleanup();
  chatPaneHarness.renderComposerAccessory = false;
  chatPaneHarness.sendOutcomes = [];
  sessionModelOverride.pickerPending = false;
  sessionModelOverride.whenPickerSettled = null;
  sessionModelOverride.rerender = () => {};
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

beforeEach(() => {
  sessionStorage.clear();
  mocks.getSessionModel.mockImplementation(async (sessionId: string, projectId: string) => ({ sessionId, projectId, revision: 0, choice: null, updatedAt: 0 }));
  mocks.putSessionModel.mockImplementation(async (sessionId: string, projectId: string, input: import('@open-design/contracts').PutSessionModel) => ({ sessionId, projectId, revision: input.expectedRevision + 1, choice: { agentId: input.agentId, modelId: input.modelId, ...(input.byokBinding ? { byokBinding: input.byokBinding } : {}) }, updatedAt: 0 }));
  mocks.postModelPreflight.mockImplementation(async (sessionId: string, projectId: string, input: { agentId: string; modelId: string }) => ({ agentId: input.agentId, modelId: input.modelId, ok: true, mismatches: [] }));
  workspaceContextState.context = null;
  mocks.connectConnector.mockResolvedValue({ connector: null });
  mocks.disconnectConnector.mockResolvedValue(null);
  mocks.fetchDesignSystem.mockResolvedValue(null);
  mocks.fetchDesignSystemRevisions.mockResolvedValue([]);
  mocks.fetchProjectDesignSystemPackageAudit.mockResolvedValue(null);
  mocks.fetchProjectFiles.mockResolvedValue([]);
  mocks.getProject.mockResolvedValue(null);
  mocks.fetchConnectorStatuses.mockResolvedValue({});
  mocks.createConversation.mockResolvedValue(null);
  mocks.listConversations.mockResolvedValue([]);
  mocks.listMessages.mockResolvedValue([]);
  mocks.loadTabs.mockResolvedValue({ tabs: [], active: null });
  mocks.patchConversation.mockResolvedValue(null);
  mocks.saveMessage.mockResolvedValue(null);
  mocks.saveTabs.mockResolvedValue(null);
  mocks.streamViaDaemon.mockImplementation(async () => {});
  mocks.openFolderDialog.mockResolvedValue(null);
  mocks.uploadProjectFile.mockImplementation(async (_projectId: string, file: File, desiredName?: string) => ({
    name: desiredName ?? file.name,
    size: file.size,
    mtime: 1,
    kind: 'code',
    mime: file.type || 'text/plain',
  }));
  mocks.writeProjectTextFile.mockImplementation(async (_projectId: string, name: string) => ({
    name,
    size: 1,
    mtime: 1,
    kind: 'document',
    mime: 'text/markdown',
  }));
});

function teamContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'workspace-a',
    workspaceType: 'team',
    workspaceMemberId: 'member-a',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'team_plus',
    providerMode: 'platform_credits',
    teamId: 'team-a',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 3, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }),
  };
}

function continueToGeneration() {
  fireEvent.click(screen.getByRole('button', { name: /^(continue to generation|generate)$/i }));
}

function confirmExtraction() {
  const button = screen.queryByRole('button', { name: /extract design system/i });
  if (button) fireEvent.click(button);
}

function addSourceUrl(value: string) {
  const input = screen.getByPlaceholderText('https://github.com/org/repo') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  const addButton = input.closest('.ds-resource-inline')?.querySelector('button') as HTMLButtonElement | null;
  fireEvent.click(addButton!);
}

function mockBrandExtractProject(project: Project) {
  mocks.getProject.mockResolvedValue(project);
  const designSystemId = project.designSystemId ?? `user:${project.id}`;
  const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
    if (typeof input === 'string' && input.startsWith('/api/brands')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: designSystemId.replace(/^user:/, ''),
          projectId: project.id,
          conversationId: `conv-${project.id}`,
          sourceUrl: 'designmd://source-material',
          status: 'extracting',
        }),
      } as unknown as Response;
    }
    if (typeof input === 'string' && input.includes('/figma/import')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          snapshotDir: 'figma',
          files: ['figma/tree.json', 'figma/tokens.json', 'figma/DESIGN-context.md'],
          inventory: {
            name: 'Product Design',
            pages: 1,
            frames: 2,
            components: ['Primary Button', 'Dashboard Card'],
            colors: ['#FF6A3D'],
            fonts: ['Inter'],
            imageCount: 0,
          },
          contextPath: 'figma/DESIGN-context.md',
          suggestedPrompt: 'Use the locally parsed Figma summaries.',
          label: 'product-design.fig',
        }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('design system package audit helpers', () => {
  it('summarizes passing audits and builds repair prompts for findings', () => {
    expect(summarizeDesignSystemPackageAudit({
      ok: true,
      projectPath: '/tmp/ds',
      filesInspected: 12,
      errors: [],
      warnings: [],
    })).toBe('Package audit passed (12 files inspected).');

    const failingAudit = {
      ok: false,
      projectPath: '/tmp/ds',
      filesInspected: 8,
      errors: [{
        severity: 'error' as const,
        code: 'ui_kit_index_missing_runtime_bootstrap',
        message: 'ui_kits/app/index.html must mount the kit.',
        path: 'ui_kits/app/index.html',
      }],
      warnings: [{
        severity: 'warning' as const,
        code: 'missing_source_component_examples',
        message: 'Copy source examples into source_examples/.',
        path: 'source_examples/',
      }, {
        severity: 'warning' as const,
        code: 'missing_build_assets',
        message: 'Preserve runtime icons under build/.',
        path: 'build/',
      }, {
        severity: 'warning' as const,
        code: 'readme_missing_package_reuse_guide',
        message: 'README.md should work as a Claude Design package guide.',
        path: 'README.md',
      }, {
        severity: 'warning' as const,
        code: 'readme_missing_preview_manifest',
        message: 'README.md should list preview cards.',
        path: 'README.md',
      }, {
        severity: 'warning' as const,
        code: 'missing_skill_frontmatter',
        message: 'SKILL.md should include YAML frontmatter.',
        path: 'SKILL.md',
      }],
    };

    expect(summarizeDesignSystemPackageAudit(failingAudit)).toContain(
      'Package audit found 1 error and 5 warnings',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'tools connectors design-system-package-audit --path . --fail-on-warnings',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'Treat every error and warning as blocking',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'preserve representative originals under root `build/`',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'copy them byte-for-byte from captured context snapshots',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'copy substantive original component snapshots into `source_examples/`',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'Targeted repair actions:',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'Rebuild `ui_kits/app/index.html` as a runnable UI-kit entry',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'Rewrite `SKILL.md` as a discoverable skill package',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'Rewrite `README.md` as a Claude Design package guide',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'Add a `## Preview Manifest` section to `README.md`',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      'copying originals from `context/.../files/build/...` into root `build/` byte-for-byte',
    );
    expect(buildDesignSystemPackageAuditRepairPrompt(failingAudit)).toContain(
      '[warning] missing_source_component_examples source_examples/',
    );
  });
});

describe('DesignSystemCreationFlow', () => {
  // The unified flow (commit a05e3a29d) replaces the legacy 5-step generation
  // pipeline (createDesignSystemDraft → ensureDesignSystemWorkspace → source
  // manifest → prepare) with a two-phase brand extraction: submitting a website
  // POSTs /api/brands, which creates the backing project + conversation
  // immediately and lets the programmatic extraction register user:<id> in the
  // background.
  // Source-material specs below exercise the current handoff by staging files
  // into the backing brand project after kickoff and before navigation.
  it('renders the new create surface copy with the active non-English locale', () => {
    render(
      <I18nProvider initial="en">
        <DesignSystemCreationFlow onBack={() => {}} onCreated={() => {}} />
      </I18nProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Extract from GitHub, websites, or source material' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Continue to generation/ })).toBeTruthy();
    expect(screen.getByText('Start from a brand')).toBeTruthy();
    // `dsCreate.sourceSectionTitle`, `dsCreate.continueToGeneration`, and
    // value is literally the English string. Under zh-CN (now removed) those
    // three had real Chinese copy, so this test could assert "the bare English
    // specific keys genuinely IS the English string, so that negative check
    // would just contradict the positive assertions above; dropped rather than
    // asserting something the app doesn't do.
  });

  it('extracts a design system from a website via POST /api/brands and opens the backing project', async () => {
    const project: Project = {
      id: 'brand-acme-com',
      name: 'acme.com',
      skillId: 'brand-extract',
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
      metadata: { kind: 'other' },
    };
    mocks.getProject.mockResolvedValue(project);
    const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
      if (typeof input === 'string' && input.startsWith('/api/brands')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'acme-com',
            projectId: project.id,
            conversationId: 'conv-acme',
            sourceUrl: 'https://acme.com',
            status: 'extracting',
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const onCreated = vi.fn();
    const onSystemsRefresh = vi.fn();

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={onCreated}
        onSystemsRefresh={onSystemsRefresh}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo'), {
      target: { value: 'https://acme.com' },
    });
    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project.id, project, 'conv-acme'));
    expect(fetchMock).toHaveBeenCalledWith('/api/brands', expect.objectContaining({ method: 'POST' }));
    const requestInit = fetchMock.mock.calls.find(([url]) => url === '/api/brands')?.[1] as unknown as { body: string };
    expect(JSON.parse(requestInit.body)).toMatchObject({ url: 'https://acme.com' });
    expect(onSystemsRefresh).toHaveBeenCalled();
    // The legacy 5-step pipeline must no longer run.
    expect(mocks.createDesignSystemDraft).not.toHaveBeenCalled();
    expect(mocks.ensureDesignSystemWorkspace).not.toHaveBeenCalled();
  });

  it('keeps GitHub-only source links out of website brand extraction', async () => {
    const project: Project = {
      id: 'brand-github',
      name: 'GitHub Design System',
      skillId: 'brand-extract',
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
      metadata: { kind: 'brand', importedFrom: 'brand-extraction' },
    };
    const fetchMock = mockBrandExtractProject(project);
    const onCreated = vi.fn();

    render(<DesignSystemCreationFlow onBack={() => {}} onCreated={onCreated} />);

    addSourceUrl('git@github.com:example-org/example-repo.git');
    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const requestInit = fetchMock.mock.calls.find(([url]) => url === '/api/brands')?.[1] as
      | { body: string }
      | undefined;
    expect(requestInit).toBeTruthy();
    const body = JSON.parse(requestInit!.body) as { url?: string; designMd?: string };
    expect(body.url).toBeUndefined();
    expect(body.designMd).toEqual(expect.stringContaining('https://github.com/example-org/example-repo'));
    expect(body.designMd).toEqual(expect.stringContaining('GitHub repositories: https://github.com/example-org/example-repo'));
  });

  it('keeps protocol-less website paths as website URLs', async () => {
    const project: Project = {
      id: 'brand-example',
      name: 'Example Design System',
      skillId: 'brand-extract',
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
      metadata: { kind: 'brand', importedFrom: 'brand-extraction' },
    };
    const fetchMock = mockBrandExtractProject(project);

    render(<DesignSystemCreationFlow onBack={() => {}} onCreated={() => {}} />);

    addSourceUrl('example.com/pricing');
    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/brands', expect.anything()));
    const requestInit = fetchMock.mock.calls.find(([url]) => url === '/api/brands')?.[1] as
      | { body: string }
      | undefined;
    expect(requestInit).toBeTruthy();
    expect(JSON.parse(requestInit!.body)).toMatchObject({
      url: 'https://example.com/pricing',
    });
  });

  it('creates from pasted DESIGN.md without requiring a website', async () => {
    const project: Project = {
      id: 'brand-heritage',
      name: 'Heritage Design System',
      skillId: 'brand-extract',
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
      metadata: { kind: 'brand', importedFrom: 'brand-extraction' },
    };
    mocks.getProject.mockResolvedValue(project);
    const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
      if (typeof input === 'string' && input.startsWith('/api/brands')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'heritage',
            projectId: project.id,
            conversationId: 'conv-heritage',
            sourceUrl: 'designmd://heritage',
            status: 'extracting',
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const onCreated = vi.fn();

    render(<DesignSystemCreationFlow onBack={() => {}} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'A newsroom product with a precise editorial voice.' },
    });
    fireEvent.change(screen.getByPlaceholderText(/name: Heritage/i), {
      target: {
        value: [
          '---',
          'name: Heritage',
          'colors:',
          '  primary: "#1A1C1E"',
          '  tertiary: "#B8422E"',
          '---',
          '',
          '## Overview',
          'Editorial design system.',
        ].join('\n'),
      },
    });
    expect(
      (screen.getByRole('button', { name: /continue to generation/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project.id, project, 'conv-heritage'));
    const requestInit = fetchMock.mock.calls.find(([url]) => url === '/api/brands')?.[1] as unknown as { body: string };
    expect(JSON.parse(requestInit.body)).toMatchObject({
      description: 'A newsroom product with a precise editorial voice.',
      designMd: expect.stringContaining('name: Heritage'),
    });
    expect(JSON.parse(requestInit.body)).not.toHaveProperty('url');
  });

  it('previews pasted DESIGN.md as a component kit and returns to edit mode', () => {
    render(<DesignSystemCreationFlow onBack={() => {}} onCreated={() => {}} />);

    const designMd = [
      '---',
      'name: Heritage',
      'colors:',
      '  primary: "#1A1C1E"',
      '  tertiary: "#B8422E"',
      '  background: "#FFFFFF"',
      '---',
      '',
      '## Overview',
      'Editorial design system.',
      '',
      '## Typography',
      '- **Display:** Public Sans — 700',
      '- **Body:** Public Sans — 400',
    ].join('\n');

    fireEvent.change(screen.getByPlaceholderText(/name: Heritage/i), {
      target: { value: designMd },
    });
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));

    expect(screen.getByText('DESIGN.md preview')).toBeTruthy();
    expect(screen.getByText(/Heritage .* component kit/i)).toBeTruthy();
    expect(screen.getByText('colorPrimary')).toBeTruthy();
    expect(screen.getByText('#1a1c1e')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^dark$/i }));
    expect(screen.getByRole('button', { name: /^dark$/i }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect((screen.getByPlaceholderText(/name: Heritage/i) as HTMLTextAreaElement).value).toBe(designMd);
  });

  it('can copy an unpublished reference and restores the current draft when clearing it', async () => {
    const clay: DesignSystemSummary = {
      id: 'clay',
      title: 'Clay',
      summary: 'Friendly tactile product UI.',
      category: 'Product',
      swatches: ['#f4efe7', '#25211d'],
      source: 'user',
      status: 'draft',
    };
    const designSystems: DesignSystemSummary[] = [clay];
    const draft = [
      '---',
      'name: Manual Draft',
      'colors:',
      '  primary: "#123456"',
      '---',
      '',
      '## Overview',
      'A pasted draft the user is still editing.',
    ].join('\n');

    mocks.fetchDesignSystem.mockResolvedValue({
      ...clay,
      body: '# Clay reference\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
    } satisfies DesignSystemDetail);

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        designSystems={designSystems}
      />,
    );

    const textarea = screen.getByPlaceholderText(/name: Heritage/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: draft } });

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    fireEvent.click(await screen.findByTestId('project-ds-picker-option-clay'));

    await waitFor(() => expect(textarea.value).toBe('# Clay reference\n'));

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    fireEvent.click(await screen.findByTestId('project-ds-picker-clear'));

    await waitFor(() => expect(textarea.value).toBe(draft));
  });

  it('creates from a brand description by sending a fallback DESIGN.md', async () => {
    const project: Project = {
      id: 'brand-description-only',
      name: 'Description Design System',
      skillId: 'brand-extract',
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
      metadata: { kind: 'brand', importedFrom: 'brand-extraction' },
    };
    mocks.getProject.mockResolvedValue(project);
    const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
      if (typeof input === 'string' && input.startsWith('/api/brands')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'description-only',
            projectId: project.id,
            conversationId: 'conv-description-only',
            sourceUrl: 'designmd://description-only',
            status: 'extracting',
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const onCreated = vi.fn();

    render(<DesignSystemCreationFlow onBack={() => {}} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'A newsroom product with a precise editorial voice.' },
    });
    expect(
      (screen.getByRole('button', { name: /continue to generation/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project.id, project, 'conv-description-only'));
    const requestInit = fetchMock.mock.calls.find(([url]) => url === '/api/brands')?.[1] as unknown as { body: string };
    const body = JSON.parse(requestInit.body) as { url?: string; description?: string; designMd?: string };
    expect(body).not.toHaveProperty('url');
    expect(body.description).toBe('A newsroom product with a precise editorial voice.');
    expect(body.designMd).toContain('A newsroom product with a precise editorial voice.');
    expect(body.designMd).toContain('## Source Material');
  });

  it('requires source material before extracting and surfaces a kickoff failure', async () => {
    const onCreated = vi.fn();
    render(<DesignSystemCreationFlow onBack={() => {}} onCreated={onCreated} />);

    // The action stays disabled until at least one source field is provided.
    expect(
      (screen.getByRole('button', { name: /continue to generation/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'url is required' }),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);

    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo'), {
      target: { value: 'https://acme.com' },
    });
    expect(
      (screen.getByRole('button', { name: /continue to generation/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(screen.getAllByText('url is required').length).toBeGreaterThan(0));
    const toast = document.querySelector('.od-toast.placement-top.tone-error');
    expect(toast?.textContent).toContain('url is required');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it.skip('opens the project as soon as the workspace exists and prepares the first chat task afterward', async () => {
    const system: DesignSystemDetail = {
      id: 'user:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-acme-design-system',
    };
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    let resolveManifestWrite: (file: {
      name: string;
      size: number;
      mtime: number;
      kind: 'document';
      mime: string;
    }) => void = () => {};
    mocks.writeProjectTextFile.mockReturnValueOnce(new Promise((resolve) => {
      resolveManifestWrite = resolve;
    }));
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });
    const onCreated = vi.fn();
    const onProjectPrepared = vi.fn();

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={onCreated}
        onProjectPrepared={onProjectPrepared}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: {
        value: 'Acme: analytics workspace for operations teams',
      },
    });
    continueToGeneration();
    continueToGeneration();

    await waitFor(() => expect(screen.getByText('Opening project...')).toBeTruthy());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project.id, project, `conv-${project.id}`));
    expect(screen.queryByText('Creating your design system...')).toBeNull();
    expect(screen.queryByText('Opening project chat...')).toBeNull();
    expect(screen.queryByText('Updated todos')).toBeNull();
    expect(mocks.patchProject).not.toHaveBeenCalled();
    expect(onProjectPrepared).not.toHaveBeenCalled();

    resolveManifestWrite({
      name: 'context/source-context.md',
      size: 1,
      mtime: 1,
      kind: 'document',
      mime: 'text/markdown',
    });
    await waitFor(() => expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Create this project as a complete Mishh Mashh design system workspace.'),
      }),
    ));
    await waitFor(() => expect(onProjectPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        id: project.id,
        pendingPrompt: 'Create this project as a design system.',
      }),
    ));
  });

  it.skip('creates a project-backed design system and hands the first task to the normal project chat', async () => {
    const system: DesignSystemDetail = {
      id: 'user:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-acme-design-system',
    };
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    const onCreated = vi.fn();
    const onSystemsRefresh = vi.fn();

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={onCreated}
        onSystemsRefresh={onSystemsRefresh}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: {
        value: 'Acme: analytics workspace for operations teams',
      },
    });
    continueToGeneration();
    continueToGeneration();

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project.id, project, `conv-${project.id}`));

    expect(mocks.createDesignSystemDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Acme Design System',
        status: 'draft',
        surface: 'web',
        artifactMode: 'agent-managed',
      }),
    );
    expect(mocks.ensureDesignSystemWorkspace).toHaveBeenCalledWith(system.id);
    await waitFor(() => expect(mocks.writeProjectTextFile).toHaveBeenCalled());
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('## Review Contract'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('Canonical design-system title: Acme Design System'),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Create this project as a complete Mishh Mashh design system workspace.'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Design system workspace title:\nAcme Design System'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Do not derive the title from URL protocol text such as `https`.'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Read `context/source-context.md` before drafting'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Do not ask setup or clarification questions during design-system generation.'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Do not emit `<question-form>`, "Quick brief — 30 seconds"'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('All GitHub extraction, website/source URL review, local evidence intake, source reading, design-system construction, package audit, and final artifact writes must happen inside this project workspace and this project chat run.'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('A Claude Design-quality package'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('preview/colors-primary.html'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('ui_kits/app/'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('ui_kits/app/components/'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('AssistantsList.jsx'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('MessageBubble.jsx'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('do not write one-line placeholder components'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('must load `../../colors_and_type.css`'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('must load/import/compose the modular component files'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('must mount/render the composed interface'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('app shell component must compose the role components'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('include React, ReactDOM, and Babel standalone scripts'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Claude-style UI-kit entry contract:'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('<script type="text/babel" src="components/App.jsx"></script>'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining("const root = ReactDOM.createRoot(document.getElementById('root'));"),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('root.render(<App />);'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Write `README.md` as a reusable package guide'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Include a source-backed Product Overview/Product Context section'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('expose each loaded component as `window.ComponentName`'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('do not leave manifest text pointing to older preview names'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('representative set instead of collapsing everything into one generic logo or font'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('preserve representative files under `build/` as Claude Design does'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Claude-style build asset contract:'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('copy representative runtime assets there with their original filenames'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Copy those runtime assets byte-for-byte from the captured `context/.../files/...` snapshots.'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Do not satisfy build/runtime icon evidence by only renaming those files into `assets/`'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('ui_kits/app/README.md` should document the kit structure'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('preview/brand-assets.html` must visibly load the preserved files'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('bind them in `colors_and_type.css` with `@font-face`'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Preserve high-signal source component examples'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('concrete `## Preview Manifest` section'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('lists each generated `preview/*.html` card by exact path'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Do not replace captured source examples with tiny filename-only stubs'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('source_examples/SelectModelButton.tsx'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Include YAML frontmatter with `name`, `description`, and `user-invocable`'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('reusable sections for `What is inside`, `Source context`, `When to use this skill`, `How to use`, and `Design system highlights`'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('read README.md, DESIGN.md, colors_and_type.css, preview/, assets/, build/, fonts/, source_examples/, and ui_kits/app/'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('name or model high-signal source components from the evidence'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('tools connectors design-system-package-audit --path . --fail-on-warnings'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Fix every audit error and design-quality warning'),
      }),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('tools connectors design-system-package-audit --path . --fail-on-warnings'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('fix every reported error or warning'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('All GitHub extraction, website/source URL review, local evidence intake, source reading, design-system construction, package audit, and artifact writes should happen inside this project workspace.'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('ui_kits/app/components/'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('must load `../../colors_and_type.css`'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('must load/import/compose the modular component files'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('must mount/render the composed interface'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('app shell component must compose those roles'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('ui_kits/app/README.md` should explain structure'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('include React, ReactDOM, and Babel standalone scripts'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('Claude-style UI-kit entry contract:'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('<script type="text/babel" src="components/App.jsx"></script>'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining("const root = ReactDOM.createRoot(document.getElementById('root'));"),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('root.render(<App />);'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('expose each loaded component as `window.ComponentName`'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('assistant/list rail'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('message bubble/comment'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('must describe the final focused preview cards'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('README.md should include a source-backed Product Overview/Product Context section'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('colors_and_type.css must bind those files with @font-face'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('concrete `## Preview Manifest` listing every generated `preview/*.html` card'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('SKILL.md should include YAML frontmatter'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('Claude-style reusable skill sections: What is inside, Source context, When to use this skill, How to use, and Design system highlights'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('README.md, DESIGN.md, colors_and_type.css, preview/, assets/, build/, fonts/, source_examples/, and ui_kits/app/'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('source_examples/ or equivalent root/nested source files'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('not tiny stubs that only share the component name'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('explicitly label or model source-backed modules'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('Placeholder component shells are not sufficient'),
    );
    expect(window.sessionStorage.getItem(`od:auto-send-first:${project.id}`)).toBe('1');
    expect(window.sessionStorage.getItem(`od:auto-send-prompt:${project.id}`)).toContain(
      'context/source-context.md',
    );
    expect(onCreated).toHaveBeenCalledWith(project.id, project, `conv-${project.id}`);
    expect(onSystemsRefresh).toHaveBeenCalled();
  });

  it.each(['upload', 'manifest', 'patch', 'model-put'] as const)('fences staged brand setup after account boundary during %s', async phase => {
    const project: Project = { id: 'scoped-brand', name: 'Scoped brand', skillId: null, designSystemId: 'user:scoped-brand', createdAt: 1, updatedAt: 1 };
    const config: AppConfig = { mode: 'daemon', apiKey: '', baseUrl: '', model: '', agentId: 'codex', agentModels: {}, skillId: null, designSystemId: null };
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    mockBrandExtractProject(project);
    mocks.openFolderDialog.mockResolvedValue('/original/code');
    mocks.uploadProjectFile.mockImplementation(async (_projectId: string, file: File, desiredName?: string) => { if (phase === 'upload') await gate; return { name: desiredName ?? file.name, size: file.size, mtime: 1, kind: 'code', mime: 'text/css' }; });
    mocks.writeProjectTextFile.mockImplementation(async (_projectId: string, name: string) => { if (phase === 'manifest') await gate; return { name, size: 1, mtime: 1, kind: 'document', mime: 'text/markdown' }; });
    mocks.patchProject.mockImplementation(async () => { if (phase === 'patch') await gate; return project; });
    mocks.putSessionModel.mockImplementation(async (sessionId: string, projectId: string, input: import('@open-design/contracts').PutSessionModel) => {
      if (phase === 'model-put') await gate;
      return { sessionId, projectId, revision: 1, choice: { agentId: input.agentId, modelId: input.modelId }, updatedAt: 0 };
    });
    const onCreated = vi.fn(); const onProjectPrepared = vi.fn();
    const { container } = render(<DesignSystemCreationFlow config={config} onBack={() => {}} onCreated={onCreated} onProjectPrepared={onProjectPrepared} />);
    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), { target: { value: 'A scoped brand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Browse folder' })); await screen.findByText('/original/code');
    if (phase === 'upload') fireEvent.change(container.querySelector('input[webkitdirectory]')!, { target: { files: [new File(['a'], 'one.css'), new File(['b'], 'two.css')] } });
    continueToGeneration(); confirmExtraction();
    await waitFor(() => expect(phase === 'upload' ? mocks.uploadProjectFile : phase === 'manifest' ? mocks.writeProjectTextFile : phase === 'patch' ? mocks.patchProject : mocks.putSessionModel).toHaveBeenCalled());
    const before = { ...sessionStorage };
    advanceWorkspaceAccountGeneration('same-brand-account-sign-out'); advanceWorkspaceAccountGeneration('same-brand-account-sign-in');
    await act(async () => { release(); await gate; });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(onProjectPrepared).not.toHaveBeenCalled(); expect(onCreated).not.toHaveBeenCalled();
    expect({ ...sessionStorage }).toEqual(before);
    expect(screen.queryByText('home-handoff-scope-changed')).toBeNull();
    if (phase === 'upload') { expect(mocks.uploadProjectFile).toHaveBeenCalledTimes(1); expect(mocks.writeProjectTextFile).not.toHaveBeenCalled(); }
    if (phase === 'upload' || phase === 'manifest') expect(mocks.patchProject).not.toHaveBeenCalled();
    if (phase !== 'model-put') expect(mocks.putSessionModel).not.toHaveBeenCalled();
  });

  it.each(['competing-first', 'empty-list'])('preserves brand creation seed during staging (%s)', async listCase => {
    const project: Project = { id: 'created-brand', name: 'Created brand', skillId: null, designSystemId: 'user:created-brand', createdAt: 1, updatedAt: 1 };
    const config: AppConfig = { mode: 'daemon', apiKey: '', baseUrl: '', model: '', agentId: 'codex', agentModels: {}, skillId: null, designSystemId: null };
    mockBrandExtractProject(project);
    mocks.listConversations.mockResolvedValue(listCase === 'empty-list' ? [] : [{ id: 'competing-seed', projectId: project.id, title: 'Other', createdAt: 2, updatedAt: 2 }]);
    mocks.createConversation.mockResolvedValue({ id: 'replacement-seed', projectId: project.id });
    mocks.openFolderDialog.mockResolvedValue('/selected/code');
    mocks.patchProject.mockResolvedValue(project);
    const onCreated = vi.fn();
    render(<DesignSystemCreationFlow config={config} onBack={() => {}} onCreated={onCreated} />);
    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), { target: { value: 'A created brand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Browse folder' }));
    await screen.findByText('/selected/code');
    continueToGeneration(); confirmExtraction();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mocks.putSessionModel).toHaveBeenCalledWith('conv-created-brand', project.id, { agentId: 'codex', modelId: 'default', expectedRevision: 0 }, null);
    expect(mocks.listConversations).not.toHaveBeenCalled();
    expect(mocks.createConversation).not.toHaveBeenCalled();
    const records = Object.keys(sessionStorage).filter(key => key.startsWith('od:home-model-handoff:'));
    expect(records).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(records[0]!)!).sessionId).toBe('conv-created-brand');
    expect(onCreated.mock.calls[0]?.[2]).toBe('conv-created-brand');
  });

  it('links a local code folder into the design-system project so the agent can read it', async () => {
    const system: DesignSystemDetail = {
      id: 'user:folder-design-system',
      title: 'Folder Design System',
      category: 'Custom',
      summary: 'Folder product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Folder Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-folder-design-system',
    };
    const project: Project = {
      id: 'ds-folder-design-system',
      name: 'Folder Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mockBrandExtractProject(project);
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });
    mocks.openFolderDialog.mockResolvedValue('/Users/qingyu/work/comfyui');

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'ComfyUI: node-based image workflow editor' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse folder' }));

    await waitFor(() => expect(screen.getByText('/Users/qingyu/work/comfyui')).toBeTruthy());
    expect(screen.queryByTestId('ds-source-upload-loading')).toBeNull();

    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(mocks.patchProject).toHaveBeenCalled());
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        metadata: expect.objectContaining({
          linkedDirs: ['/Users/qingyu/work/comfyui'],
        }),
        pendingPrompt: expect.stringContaining('Read the linked local code folders'),
      }),
      null,
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('tools connectors local-design-context --path'),
      }),
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('/Users/qingyu/work/comfyui'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('## Local Folder Intake Runbook'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('tools connectors local-design-context --path'),
      undefined,
      null,
    );
  });

  it('copies browser-selected local code folder files into the design-system project context', async () => {
    const system: DesignSystemDetail = {
      id: 'user:snapshot-design-system',
      title: 'Snapshot Design System',
      category: 'Custom',
      summary: 'Snapshot product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Snapshot Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-snapshot-design-system',
    };
    const project: Project = {
      id: 'ds-snapshot-design-system',
      name: 'Snapshot Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.listConversations.mockResolvedValue([{ id: 'actual-ds-seed', projectId: project.id, title: 'Design system', createdAt: 1, updatedAt: 1 }]);
    mockBrandExtractProject(project);
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });
    const onCreated = vi.fn();

    const { container } = render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={onCreated}
      />,
    );
    const localCodeInput = container.querySelector('input[webkitdirectory]') as HTMLInputElement | null;
    const tokenFile = new File([':root { --brand: #d86a4a; }'], 'tokens.css', { type: 'text/css' });
    Object.defineProperty(tokenFile, 'webkitRelativePath', { value: 'comfyui/src/tokens.css' });

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'Snapshot: product UI with tokens' },
    });
    fireEvent.change(localCodeInput!, { target: { files: [tokenFile] } });
    expect(screen.getByText('1 local code files selected')).toBeTruthy();
    expect(screen.queryByTestId('ds-source-upload-loading')).toBeNull();

    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(mocks.uploadProjectFile).toHaveBeenCalled());
    expect(mocks.uploadProjectFile).toHaveBeenCalledWith(
      project.id,
      tokenFile,
      'context/local-code/comfyui/src/tokens.css',
      null,
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('context/local-code/comfyui/src/tokens.css'),
      }),
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('context/local-code/comfyui/src/tokens.css'),
      undefined,
      null,
    );
    expect(window.sessionStorage.getItem(`od:auto-send-first:${project.id}`)).toBe('1');
    expect(window.sessionStorage.getItem(`od:auto-send-prompt:${project.id}`)).toContain(
      'context/source-context.md',
    );
    expect(onCreated).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ id: project.id }),
      `conv-${project.id}`,
    );
  });

  it('shows global loading as soon as a large file-picker selection returns', async () => {
    const { container } = render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const localCodeInput = container.querySelector('input[webkitdirectory]') as HTMLInputElement | null;
    const tokenFiles = Array.from({ length: 25 }, (_, index) => {
      const file = new File([`:root { --brand-${index}: #d86a4a; }`], `tokens-${index}.css`, {
        type: 'text/css',
      });
      Object.defineProperty(file, 'webkitRelativePath', { value: `comfyui/src/tokens-${index}.css` });
      return file;
    });

    fireEvent.change(localCodeInput!, { target: { files: tokenFiles } });

    expect(screen.getByTestId('ds-source-upload-loading').textContent).toContain('Adding source material...');
    expect(screen.queryByText('25 local code files selected')).toBeNull();
    await waitFor(() => expect(screen.getByText('25 local code files selected')).toBeTruthy(), { timeout: 2000 });
    await waitFor(() => expect(screen.queryByTestId('ds-source-upload-loading')).toBeNull(), { timeout: 2500 });
  });

  it('shows global loading when the folder picker returns before files are enumerated', async () => {
    const { container } = render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const localCodeInput = container.querySelector('input[webkitdirectory]') as HTMLInputElement | null;
    const tokenFiles = Array.from({ length: 25 }, (_, index) => {
      const file = new File([`:root { --brand-${index}: #d86a4a; }`], `tokens-${index}.css`, {
        type: 'text/css',
      });
      Object.defineProperty(file, 'webkitRelativePath', { value: `comfyui/src/tokens-${index}.css` });
      return file;
    });

    fireEvent.click(localCodeInput!);
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    fireEvent(window, new Event('focus'));

    await waitFor(() => {
      expect(screen.getByTestId('ds-source-upload-loading').textContent).toContain('Adding source material...');
    });
    expect(screen.queryByText('25 local code files selected')).toBeNull();

    fireEvent.change(localCodeInput!, { target: { files: tokenFiles } });

    await waitFor(() => expect(screen.getByText('25 local code files selected')).toBeTruthy(), { timeout: 2000 });
    await waitFor(() => expect(screen.queryByTestId('ds-source-upload-loading')).toBeNull(), { timeout: 2500 });
  });

  it('primes global loading while the folder picker is still open', async () => {
    const { container } = render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const localCodeInput = container.querySelector('input[webkitdirectory]') as HTMLInputElement | null;
    const tokenFiles = Array.from({ length: 25 }, (_, index) => {
      const file = new File([`:root { --brand-${index}: #d86a4a; }`], `tokens-${index}.css`, {
        type: 'text/css',
      });
      Object.defineProperty(file, 'webkitRelativePath', { value: `comfyui/src/tokens-${index}.css` });
      return file;
    });

    fireEvent.click(localCodeInput!);

    await waitFor(() => {
      expect(screen.getByTestId('ds-source-upload-loading').textContent).toContain('Adding source material...');
    }, { timeout: 1000 });

    fireEvent.change(localCodeInput!, { target: { files: tokenFiles } });

    await waitFor(() => expect(screen.getByText('25 local code files selected')).toBeTruthy(), { timeout: 2000 });
    await waitFor(() => expect(screen.queryByTestId('ds-source-upload-loading')).toBeNull(), { timeout: 2500 });
  });

  it('preserves native code and fig source drops under the global intake coordinator', async () => {
    const intake = vi.fn(); const coordinator = createDropCoordinator({ getSnapshot: () => 'shell', onDrop: intake }); const dispose = coordinator.mount(document);
    try {
      const { container } = render(<DesignSystemCreationFlow onBack={() => {}} onCreated={() => {}} />);
      const code = container.querySelector('input[webkitdirectory]')!.closest('.ds-drop-zone')!;
      fireEvent.drop(code, { dataTransfer: { types: ['Files'], files: [new File(['body{}'], 'style.css')], items: [] } });
      await screen.findByText('1 local code files selected');
      const fig = screen.getByText('Drop .fig here or browse').closest('label')!;
      fireEvent.drop(fig, { dataTransfer: { types: ['Files'], files: [new File(['fig'], 'native.fig')], items: [] } });
      await screen.findByText('native.fig'); expect(intake).not.toHaveBeenCalled();
      fireEvent.drop(document.body, { dataTransfer: { types: ['Files'], files: [new File(['fallback'], 'shell.zip')], items: [] } }); expect(intake).toHaveBeenCalledTimes(1);
    } finally { dispose(); }
  });

  it('shows a recoverable error when a dragged local code entry cannot be read', async () => {
    const { container } = render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const dropZone = container.querySelector('input[webkitdirectory]')?.closest('.ds-drop-zone') as HTMLElement | null;

    fireEvent.drop(dropZone!, {
      dataTransfer: {
        files: [],
        items: [
          {
            webkitGetAsEntry: () => ({
              isFile: true,
              isDirectory: false,
              name: 'stale-token.css',
              file: (_done: (file: File) => void, fail?: (error: DOMException) => void) => {
                fail?.(new DOMException('missing', 'NotFoundError'));
              },
            }),
          },
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Could not read one or more dropped files or folders/).length).toBeGreaterThan(0);
    });
    expect(document.querySelector('.od-toast.placement-top.tone-error')?.textContent).toContain(
      'Could not read one or more dropped files or folders',
    );
    expect(screen.queryByText(/local code files selected/)).toBeNull();
  });

  it('shows a global loading state while local source files are being read', async () => {
    const { container } = render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const dropZone = container.querySelector('input[webkitdirectory]')?.closest('.ds-drop-zone') as HTMLElement | null;
    const tokenFiles = Array.from({ length: 25 }, (_, index) => (
      new File([`:root { --brand-${index}: #d86a4a; }`], `tokens-${index}.css`, { type: 'text/css' })
    ));
    let resolveRead!: () => void;
    const readReady = new Promise<void>((resolve) => {
      resolveRead = resolve;
    });

    fireEvent.drop(dropZone!, {
      dataTransfer: {
        files: [],
        items: [
          ...tokenFiles.map((tokenFile) => ({
            webkitGetAsEntry: () => ({
              isFile: true,
              isDirectory: false,
              name: tokenFile.name,
              file: (done: (file: File) => void) => {
                void readReady.then(() => done(tokenFile));
              },
            }),
          })),
        ],
      },
    });

    expect(screen.queryByTestId('ds-source-upload-loading')).toBeNull();
    resolveRead();

    await waitFor(() => {
      expect(screen.getByTestId('ds-source-upload-loading').textContent).toContain('Adding source material...');
    });
    await waitFor(() => expect(screen.getByText('25 local code files selected')).toBeTruthy());
    await waitFor(() => expect(screen.queryByTestId('ds-source-upload-loading')).toBeNull());
  });

  it('recursively reads a dragged local code folder into the design-system project context', async () => {
    const system: DesignSystemDetail = {
      id: 'user:dragged-folder-design-system',
      title: 'Dragged Folder Design System',
      category: 'Custom',
      summary: 'Dragged folder workspace.',
      swatches: [],
      surface: 'web',
      body: '# Dragged Folder Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-dragged-folder-design-system',
    };
    const project: Project = {
      id: 'ds-dragged-folder-design-system',
      name: 'Dragged Folder Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mockBrandExtractProject(project);
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    const { container } = render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const dropZone = container.querySelector('input[webkitdirectory]')?.closest('.ds-drop-zone') as HTMLElement | null;
    const tokenFile = new File([':root { --brand: #d86a4a; }'], 'tokens.css', { type: 'text/css' });
    const buttonFile = new File(['export function Button() {}'], 'Button.tsx', { type: 'text/typescript' });
    const srcEntries = [
      { isFile: true, isDirectory: false, name: 'tokens.css', file: (done: (file: File) => void) => done(tokenFile) },
      { isFile: true, isDirectory: false, name: 'Button.tsx', file: (done: (file: File) => void) => done(buttonFile) },
    ];
    const srcDirectory = {
      isFile: false,
      isDirectory: true,
      name: 'src',
      createReader: () => {
        let read = false;
        return {
          readEntries: (done: (entries: typeof srcEntries) => void) => {
            const entries = read ? [] : srcEntries;
            read = true;
            done(entries);
          },
        };
      },
    };
    const rootDirectory = {
      isFile: false,
      isDirectory: true,
      name: 'comfyui',
      createReader: () => {
        let read = false;
        return {
          readEntries: (done: (entries: [typeof srcDirectory] | []) => void) => {
            const entries: [typeof srcDirectory] | [] = read ? [] : [srcDirectory];
            read = true;
            done(entries);
          },
        };
      },
    };

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'Dragged: product UI with tokens and components' },
    });
    fireEvent.drop(dropZone!, {
      dataTransfer: {
        files: [],
        items: [
          {
            webkitGetAsEntry: () => rootDirectory,
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByText('2 local code files selected')).toBeTruthy());

    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(mocks.uploadProjectFile).toHaveBeenCalledTimes(2));
    expect(mocks.uploadProjectFile).toHaveBeenCalledWith(
      project.id,
      tokenFile,
      'context/local-code/comfyui/src/tokens.css',
      null,
    );
    expect(mocks.uploadProjectFile).toHaveBeenCalledWith(
      project.id,
      buttonFile,
      'context/local-code/comfyui/src/Button.tsx',
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('context/local-code/comfyui/src/Button.tsx'),
      undefined,
      null,
    );
  });

  it('parses .fig files locally into project context summaries without uploading the source file', async () => {
    const system: DesignSystemDetail = {
      id: 'user:figma-design-system',
      title: 'Figma Design System',
      category: 'Custom',
      summary: 'Figma-backed workspace.',
      swatches: [],
      surface: 'web',
      body: '# Figma Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-figma-design-system',
    };
    const project: Project = {
      id: 'ds-figma-design-system',
      name: 'Figma Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const fetchMock = mockBrandExtractProject(project);
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const figInput = screen
      .getByText('Drop .fig here or browse')
      .closest('label')
      ?.querySelector('input') as HTMLInputElement | null;
    const figFile = new File([
      '{"name":"Primary Button","fontFamily":"Inter","name":"Dashboard Card","fill":"#FF6A3D"}',
    ], 'product-design.fig', { type: 'application/octet-stream' });

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'Figma: product UI with button and dashboard components' },
    });
    fireEvent.change(figInput!, { target: { files: [figFile] } });
    expect(screen.getByText('product-design.fig')).toBeTruthy();

    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/${encodeURIComponent(project.id)}/figma/import`,
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('figma/DESIGN-context.md'),
      undefined,
      null,
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Each .fig was decoded into a real design snapshot'),
      }),
      null,
    );
    expect(mocks.uploadProjectFile).not.toHaveBeenCalled();
  });

  it('uploads brand assets into the design-system project context', async () => {
    const system: DesignSystemDetail = {
      id: 'user:asset-design-system',
      title: 'Asset Design System',
      category: 'Custom',
      summary: 'Asset-backed workspace.',
      swatches: [],
      surface: 'web',
      body: '# Asset Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-asset-design-system',
    };
    const project: Project = {
      id: 'ds-asset-design-system',
      name: 'Asset Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mockBrandExtractProject(project);
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const assetInput = screen
      .getByTestId('ds-asset-dropzone')
      .querySelector('input[type="file"]') as HTMLInputElement | null;
    const logoFile = new File(['<svg />'], 'logo.svg', { type: 'image/svg+xml' });
    const fontFile = new File(['font-data'], 'brand.woff2', { type: 'font/woff2' });

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'Assets: product brand with custom logo and font' },
    });
    fireEvent.change(assetInput!, { target: { files: [logoFile, fontFile] } });
    expect(screen.getByText('logo.svg')).toBeTruthy();
    expect(screen.getByText('brand.woff2')).toBeTruthy();
    expect(screen.queryByTestId('ds-source-upload-loading')).toBeNull();

    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(mocks.uploadProjectFile).toHaveBeenCalledTimes(2));
    expect(mocks.uploadProjectFile).toHaveBeenCalledWith(project.id, logoFile, 'assets/logo.svg', null);
    expect(mocks.uploadProjectFile).toHaveBeenCalledWith(project.id, fontFile, 'assets/brand.woff2', null);
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('assets/logo.svg'),
      undefined,
      null,
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Use uploaded brand assets in `assets/`'),
      }),
      null,
    );
  });

  it.skip('infers a product title from a GitHub URL instead of the URL protocol', async () => {
    const system: DesignSystemDetail = {
      id: 'user:cherry-studio-design-system',
      title: 'Cherry Studio Design System',
      category: 'Custom',
      summary: 'https://github.com/cherryhq/cherry-studio',
      swatches: [],
      surface: 'web',
      body: '# Cherry Studio Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-cherry-studio-design-system',
    };
    const project: Project = {
      id: 'ds-cherry-studio-design-system',
      name: 'Cherry Studio Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        onSystemsRefresh={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'https://github.com/cherryhq/cherry-studio' },
    });
    continueToGeneration();
    continueToGeneration();

    await waitFor(() => expect(mocks.createDesignSystemDraft).toHaveBeenCalled());

    expect(mocks.createDesignSystemDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Cherry Studio Design System',
      }),
    );
    expect(mocks.createDesignSystemDraft).not.toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'https Design System',
      }),
    );
    await waitFor(() => expect(mocks.writeProjectTextFile).toHaveBeenCalled());
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('Canonical design-system title: Cherry Studio Design System'),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Design system workspace title:\nCherry Studio Design System'),
      }),
    );
  });

  it.skip('adds website source links with Enter and keeps them out of GitHub intake', async () => {
    const system: DesignSystemDetail = {
      id: 'user:open-design-website-design-system',
      title: 'Mishh Mashh Website Design System',
      category: 'Custom',
      summary: 'Mishh Mashh website source.',
      swatches: [],
      surface: 'web',
      body: '# Mishh Mashh Website Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-open-design-website-design-system',
    };
    const project: Project = {
      id: 'ds-open-design-website-design-system',
      name: 'Mishh Mashh Website Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const onBeforeGenerate = vi.fn();
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        onBeforeGenerate={onBeforeGenerate}
      />,
    );

    const sourceInput = screen.getByPlaceholderText('https://example.com or https://github.com/owner/repo') as HTMLInputElement;
    fireEvent.change(sourceInput, { target: { value: 'open-design.ai' } });
    fireEvent.keyDown(sourceInput, { key: 'Enter', code: 'Enter' });

    const previewLink = screen.getByRole('link', { name: 'Open open-design.ai' }) as HTMLAnchorElement;
    expect(previewLink.href).toBe('https://open-design.ai/');
    expect(sourceInput.value).toBe('');

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'Mishh Mashh website source' },
    });
    continueToGeneration();
    continueToGeneration();

    await waitFor(() => expect(mocks.createDesignSystemDraft).toHaveBeenCalled());
    expect(onBeforeGenerate).toHaveBeenCalledWith(expect.objectContaining({
      sourceCount: 1,
      sourceUrlCount: 1,
      githubRepoCount: 0,
    }));
    const draftInput = mocks.createDesignSystemDraft.mock.calls[0]?.[0];
    expect(draftInput?.provenance?.sourceUrls).toEqual(['https://open-design.ai']);
    expect(draftInput?.provenance?.githubUrls).toBeUndefined();

    await waitFor(() => expect(mocks.writeProjectTextFile).toHaveBeenCalled());
    const sourceManifestCall = mocks.writeProjectTextFile.mock.calls.find(
      (call) => call[0] === project.id && call[1] === 'context/source-context.md',
    );
    expect(sourceManifestCall?.[2]).toEqual(expect.stringContaining('## Source Links'));
    expect(sourceManifestCall?.[2]).toEqual(expect.stringContaining('- https://open-design.ai'));
    expect(sourceManifestCall?.[2]).not.toEqual(expect.stringContaining('GitHub Connector Intake Runbook'));
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Use the linked website/source URLs as public style and product references'),
      }),
    );
  });

  it.skip('allows GitHub repo links without Composio by using local GitHub intake', () => {
    const onOpenConnectorsTab = vi.fn();
    const config = {
      composio: { apiKeyConfigured: false },
    } as AppConfig;

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        config={config}
        onOpenConnectorsTab={onOpenConnectorsTab}
      />,
    );

    const input = screen.getByPlaceholderText('https://github.com/org/repo') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(screen.getByText('GitHub access: Auto')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show access methods' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Configure Composio' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show access methods' }));
    expect(screen.getByText('This device')).toBeTruthy();
    expect(screen.getByText('Mishh Mashh account')).toBeTruthy();
    expect(screen.getByText('Connector platform')).toBeTruthy();
    expect(screen.getByText('Coming soon')).toBeTruthy();
    expect(screen.getByText('Not configured')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'https://github.com/example-org/example-repo/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByText('example-org/example-repo')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Configure Composio' }));

    expect(onOpenConnectorsTab).toHaveBeenCalledTimes(1);
    expect(mocks.fetchConnectorStatuses).not.toHaveBeenCalled();
  });

  it('stops checking GitHub connector if the status request hangs', async () => {
    vi.useFakeTimers();
    mocks.fetchConnectorStatuses.mockReturnValue(new Promise(() => {}));
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        config={config}
      />,
    );

    expect(screen.getByText('GitHub access: Auto')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show access methods' }));
    expect(screen.queryByText('Checking GitHub connector')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.queryByText('Checking GitHub connector')).toBeNull();
    expect(screen.getByText(/Could not finish checking GitHub connector/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect via Composio' })).toBeTruthy();
    expect(mocks.fetchConnectorStatuses.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
  });

  it('surfaces GitHub connector status errors from the connector status endpoint', async () => {
    mocks.fetchConnectorStatuses.mockResolvedValue({
      github: {
        status: 'error',
        lastError: 'GitHub authorization expired. Reconnect GitHub.',
      },
    });
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        config={config}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show access methods' }));
    await waitFor(() => expect(screen.getByText('Needs attention')).toBeTruthy());
    expect(screen.getByText('GitHub authorization expired. Reconnect GitHub.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect via Composio' })).toBeTruthy();
  });

  it.skip('keeps GitHub repo links available and shows connected connector status', async () => {
    const connectedConnector: ConnectorDetail = {
      id: 'github',
      name: 'GitHub',
      provider: 'Composio',
      category: 'Code',
      status: 'connected',
      tools: [],
      accountLabel: 'qiongyu1999',
    };
    mocks.fetchConnectorStatuses.mockResolvedValue({ github: { status: 'available' } });
    mocks.connectConnector.mockResolvedValue({
      connector: connectedConnector,
      auth: { kind: 'connected' },
    });
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;
    const onConnectorsChanged = vi.fn();
    window.addEventListener(CONNECTORS_CHANGED_EVENT, onConnectorsChanged);

    try {
      render(
        <DesignSystemCreationFlow
          onBack={() => {}}
          onCreated={() => {}}
          config={config}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Show access methods' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Connect via Composio' })).toBeTruthy());
      expect((screen.getByPlaceholderText('https://example.com or https://github.com/owner/repo') as HTMLInputElement).disabled).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Connect via Composio' }));

      await waitFor(() => expect(mocks.connectConnector).toHaveBeenCalledWith('github'));
      await waitFor(() => expect(screen.getByText(/Connected as qiongyu1999/i)).toBeTruthy());
      await waitFor(() => expect(onConnectorsChanged).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
      const input = screen.getByPlaceholderText('https://example.com or https://github.com/owner/repo') as HTMLInputElement;
      expect(input.disabled).toBe(false);

      fireEvent.change(input, { target: { value: 'https://github.com/example-org/example-repo/' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));

      expect(screen.getByText('example-org/example-repo')).toBeTruthy();
      expect(input.value).toBe('');
    } finally {
      window.removeEventListener(CONNECTORS_CHANGED_EVENT, onConnectorsChanged);
    }
  });

  it('hides Composio connection ids in the connected GitHub label', async () => {
    mocks.fetchConnectorStatuses.mockResolvedValue({
      github: { status: 'connected', accountLabel: 'ca_6U6mv_8IzMVR' },
    });
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        config={config}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show access methods' }));
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
    expect(screen.queryByText(/ca_6U6mv_8IzMVR/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('keeps a manual GitHub authorization action when the automatic popup is blocked', async () => {
    const availableConnector: ConnectorDetail = {
      id: 'github',
      name: 'GitHub',
      provider: 'Composio',
      category: 'Code',
      status: 'available',
      tools: [],
    };
    mocks.fetchConnectorStatuses.mockResolvedValue({ github: { status: 'available' } });
    mocks.connectConnector.mockResolvedValue({
      connector: availableConnector,
      auth: {
        kind: 'redirect_required',
        redirectUrl: 'https://example.com/oauth',
        expiresAt: '2099-05-08T10:00:00.000Z',
      },
      error: 'Popup blocked. Allow popups for Mishh Mashh and try again.',
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({ closed: false } as Window));
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;

    try {
      render(
        <DesignSystemCreationFlow
          onBack={() => {}}
          onCreated={() => {}}
          config={config}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Show access methods' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Connect via Composio' })).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Connect via Composio' }));

      await waitFor(() => expect(screen.getByText('Pending')).toBeTruthy());
      expect(screen.getByText('Popup blocked. Allow popups for Mishh Mashh and try again.')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Open authorization' }));

      expect(openSpy).toHaveBeenCalledWith('https://example.com/oauth', '_blank');
    } finally {
      openSpy.mockRestore();
    }
  });

  it('records connected GitHub repository sources in the project source manifest', async () => {
    const availableConnector: ConnectorDetail = {
      id: 'github',
      name: 'GitHub',
      provider: 'Composio',
      category: 'Code',
      status: 'connected',
      accountLabel: 'qiongyu1999',
      tools: [],
    };
    const system: DesignSystemDetail = {
      id: 'user:github-design-system',
      title: 'Github Design System',
      category: 'Custom',
      summary: 'GitHub-backed workspace.',
      swatches: [],
      surface: 'web',
      body: '# Github Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-github-design-system',
    };
    const project: Project = {
      id: 'ds-github-design-system',
      name: 'Github Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.fetchConnectorStatuses.mockResolvedValue({
      github: { status: 'connected', accountLabel: 'qiongyu1999' },
    });
    mockBrandExtractProject(project);
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        config={config}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show access methods' }));
    await waitFor(() => expect(screen.getByText(/Connected as qiongyu1999/i)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'GitHub: product workspace' },
    });
    addSourceUrl('https://github.com/example-org/example-repo');
    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(mocks.writeProjectTextFile).toHaveBeenCalled());
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('Connector status: connected as qiongyu1999.'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('https://github.com/example-org/example-repo'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('GitHub Connector Intake Runbook'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('"$OD_NODE_BIN" "$OD_BIN" tools connectors github-design-context --repo \'https://github.com/example-org/example-repo\' --output context/github/example-org-example-repo.md'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).not.toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('--require-connector'),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('GitHub repository intake is required before drafting the design system'),
      }),
      null,
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Do not call GitHub connector tree/content/raw tools directly from the agent.'),
      }),
      null,
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('The command tries this-device access first'),
      }),
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('GitHub evidence must come from the bounded `github-design-context` command'),
      undefined,
      null,
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Do not call GitHub connector tree/content/raw tools directly from the agent.'),
      }),
      null,
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Treat `Read method: git-clone` as the preferred this-device path.'),
      }),
      null,
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('selects design-system-relevant source files plus available logos/icons/fonts'),
      }),
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('assets/, build/, fonts/, and context/ should preserve logos'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('Claude-style build asset contract:'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('copy representative runtime assets there with their original filenames'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('Copy those runtime assets byte-for-byte from the captured `context/.../files/...` snapshots.'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('Do not satisfy build/runtime icon evidence by only renaming those files into `assets/`'),
      undefined,
      null,
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('preview/brand-assets.html should visibly reference preserved files'),
      undefined,
      null,
    );
  });

  it('does not leak Composio connected-account ids into the project source manifest', async () => {
    const system: DesignSystemDetail = {
      id: 'user:github-internal-account-design-system',
      title: 'GitHub Internal Account Design System',
      category: 'Custom',
      summary: 'GitHub-backed workspace.',
      swatches: [],
      surface: 'web',
      body: '# GitHub Internal Account Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-github-internal-account-design-system',
    };
    const project: Project = {
      id: 'ds-github-internal-account-design-system',
      name: 'GitHub Internal Account Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.fetchConnectorStatuses.mockResolvedValue({
      github: { status: 'connected', accountLabel: 'ca_6U6mv_8IzMVR' },
    });
    mockBrandExtractProject(project);
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        config={config}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show access methods' }));
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'GitHub: product workspace' },
    });
    addSourceUrl('https://github.com/example-org/example-repo');
    continueToGeneration();
    confirmExtraction();

    await waitFor(() => expect(mocks.writeProjectTextFile).toHaveBeenCalled());
    const sourceManifestCall = mocks.writeProjectTextFile.mock.calls.find(
      (call) => call[0] === project.id && call[1] === 'context/source-context.md',
    );
    expect(sourceManifestCall?.[2]).toEqual(expect.stringContaining('Connector status: connected.'));
    expect(sourceManifestCall?.[2]).not.toEqual(expect.stringContaining('ca_6U6mv_8IzMVR'));
  });
});

describe('DesignSystemDetailView', () => {
  it('keeps a fresh R2 file snapshot when an older R1 resolves afterward', async () => {
    const system: DesignSystemDetail = {
      id: 'user:refresh-race-design-system',
      title: 'Refresh Race Design System',
      category: 'Custom',
      summary: 'Exercises file refresh ordering.',
      swatches: [],
      surface: 'web',
      body: '# Refresh Race Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-refresh-race',
    };
    const project: Project = {
      id: 'ds-refresh-race',
      name: 'Refresh Race Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const initialFile: ProjectFile = {
      name: 'initial.html',
      size: 10,
      mtime: 1,
      kind: 'html',
      mime: 'text/html',
    };
    const staleR1File: ProjectFile = { ...initialFile, name: 'stale-r1.html', mtime: 2 };
    const freshR2File: ProjectFile = { ...initialFile, name: 'fresh-r2.html', mtime: 3 };
    let resolveR1!: (files: ProjectFile[]) => void;
    let resolveR2!: (files: ProjectFile[]) => void;
    const r1 = new Promise<ProjectFile[]>((resolve) => { resolveR1 = resolve; });
    const r2 = new Promise<ProjectFile[]>((resolve) => { resolveR2 = resolve; });

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [initialFile] });
    mocks.fetchProjectFiles
      .mockImplementationOnce(() => r1)
      .mockImplementationOnce(() => r2);

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={{ mode: 'daemon', agentId: 'opencode' } as AppConfig}
        agents={[]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Design Files' }));
    const workspace = await screen.findByTestId('design-system-files');
    await waitFor(() => expect(workspace.getAttribute('data-file-names')).toBe('initial.html'));
    const initialGeneration = Number(workspace.getAttribute('data-files-generation'));

    const onRefreshFiles = mocks.fileWorkspaceProps.mock.calls.at(-1)?.[0]?.onRefreshFiles as
      | ((options?: { fresh?: boolean }) => Promise<{ acceptedGeneration: number | null }>)
      | undefined;
    const r1Refresh = onRefreshFiles?.();
    const r2Refresh = onRefreshFiles?.({ fresh: true });
    await waitFor(() => expect(mocks.fetchProjectFiles).toHaveBeenCalledTimes(2));

    resolveR2([freshR2File]);
    await expect(r2Refresh).resolves.toEqual({ acceptedGeneration: initialGeneration + 1 });
    await waitFor(() => {
      expect(workspace.getAttribute('data-file-names')).toBe('fresh-r2.html');
      expect(Number(workspace.getAttribute('data-files-generation'))).toBe(initialGeneration + 1);
    });

    resolveR1([staleR1File]);
    await expect(r1Refresh).resolves.toEqual({ acceptedGeneration: null });
    await Promise.resolve();

    expect(workspace.getAttribute('data-file-names')).toBe('fresh-r2.html');
    expect(Number(workspace.getAttribute('data-files-generation'))).toBe(initialGeneration + 1);
  });

  it('keeps the current file snapshot and generation when an authoritative refresh fails', async () => {
    const system: DesignSystemDetail = {
      id: 'user:failed-refresh-design-system',
      title: 'Failed Refresh Design System',
      category: 'Custom',
      summary: 'Exercises authoritative refresh failure.',
      swatches: [],
      surface: 'web',
      body: '# Failed Refresh Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-failed-refresh',
    };
    const project: Project = {
      id: system.projectId!,
      name: system.title,
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
    };
    const file: ProjectFile = {
      name: 'kept.html',
      size: 10,
      mtime: 1,
      kind: 'html',
      mime: 'text/html',
    };
    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [file] });
    mocks.fetchProjectFiles.mockRejectedValueOnce(new Error('files unavailable'));

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={{ mode: 'daemon', agentId: 'opencode' } as AppConfig}
        agents={[]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Design Files' }));
    const workspace = await screen.findByTestId('design-system-files');
    await waitFor(() => expect(workspace.getAttribute('data-file-names')).toBe('kept.html'));
    const generationBeforeFailure = workspace.getAttribute('data-files-generation');
    const onRefreshFiles = mocks.fileWorkspaceProps.mock.calls.at(-1)?.[0]?.onRefreshFiles as
      | ((options?: { fresh?: boolean }) => Promise<{ acceptedGeneration: number | null }>)
      | undefined;

    await expect(onRefreshFiles?.({ fresh: true })).resolves.toEqual({
      acceptedGeneration: null,
    });

    expect(mocks.fetchProjectFiles).toHaveBeenCalledWith(project.id, {
      fresh: true,
      requireAuthoritative: true,
    });
    expect(workspace.getAttribute('data-file-names')).toBe('kept.html');
    expect(workspace.getAttribute('data-files-generation')).toBe(generationBeforeFailure);
  });

  it.each(['system', 'workspace'] as const)(
    'ignores an in-flight file refresh after the %s identity changes',
    async (switchKind) => {
      const makeSystem = (suffix: string): DesignSystemDetail => ({
        id: `user:scope-${suffix}`,
        title: `Scope ${suffix}`,
        category: 'Custom',
        summary: 'Exercises file refresh lifetime isolation.',
        swatches: [],
        surface: 'web',
        body: `# Scope ${suffix}\n`,
        source: 'user',
        status: 'draft',
        isEditable: true,
        projectId: `ds-scope-${suffix}`,
      });
      const makeProject = (system: DesignSystemDetail): Project => ({
        id: system.projectId!,
        name: system.title,
        skillId: null,
        designSystemId: system.id,
        createdAt: 1,
        updatedAt: 1,
      });
      const systemA = makeSystem('a');
      const systemB = makeSystem('b');
      const projectA = makeProject(systemA);
      const projectB = makeProject(systemB);
      const fileA: ProjectFile = {
        name: 'scope-a.html',
        size: 10,
        mtime: 1,
        kind: 'html',
        mime: 'text/html',
      };
      const fileB: ProjectFile = { ...fileA, name: 'scope-b.html', mtime: 2 };
      const staleFile: ProjectFile = { ...fileA, name: 'late-scope-a.html', mtime: 3 };
      const contextA = { ...teamContext(), workspaceId: 'workspace-a', teamId: 'team-a' };
      const contextB = { ...teamContext(), workspaceId: 'workspace-b', teamId: 'team-b' };
      let resolveStale!: (files: ProjectFile[]) => void;
      const staleRefresh = new Promise<ProjectFile[]>((resolve) => { resolveStale = resolve; });

      workspaceContextState.context = switchKind === 'workspace' ? contextA : null;
      mocks.fetchDesignSystem.mockImplementation(async (systemId: string) => (
        systemId === systemB.id ? systemB : systemA
      ));
      mocks.ensureDesignSystemWorkspace.mockImplementation(async (
        systemId: string,
        context: WorkspaceCollabContext | null,
      ) => {
        const useB = systemId === systemB.id || context?.workspaceId === contextB.workspaceId;
        return useB
          ? { project: projectB, files: [fileB] }
          : { project: projectA, files: [fileA] };
      });
      mocks.fetchProjectFiles.mockImplementationOnce(() => staleRefresh);

      const renderDetail = (systemId: string) => (
        <DesignSystemDetailView
          id={systemId}
          selectedId={systemId}
          config={{ mode: 'daemon', agentId: 'opencode' } as AppConfig}
          agents={[]}
          onBack={() => {}}
          onSetDefault={() => {}}
        />
      );
      const { rerender } = render(renderDetail(systemA.id));
      fireEvent.click(await screen.findByRole('button', { name: 'Design Files' }));
      let workspace = await screen.findByTestId('design-system-files');
      await waitFor(() => expect(workspace.getAttribute('data-file-names')).toBe('scope-a.html'));
      fireEvent.click(screen.getByTestId('refresh-design-system-files'));
      await waitFor(() => expect(mocks.fetchProjectFiles).toHaveBeenCalledTimes(1));

      if (switchKind === 'workspace') workspaceContextState.context = contextB;
      rerender(renderDetail(switchKind === 'system' ? systemB.id : systemA.id));
      workspace = await screen.findByTestId('design-system-files');
      await waitFor(() => expect(workspace.getAttribute('data-file-names')).toBe('scope-b.html'));
      const generationAfterSwitch = workspace.getAttribute('data-files-generation');

      resolveStale([staleFile]);
      await Promise.resolve();
      await Promise.resolve();

      expect(workspace.getAttribute('data-file-names')).toBe('scope-b.html');
      expect(workspace.getAttribute('data-files-generation')).toBe(generationAfterSwitch);
    },
  );

  it('opens chat file links through the Files tab workspace (#5611 round 9)', async () => {
    // The design-system chat must thread the workspace's known-file set and
    // an opener into ChatPane; without them a current-project file link is
    // classified but the click stays inert (opener undefined). The opener
    // must also switch to the Files tab, where the FileWorkspace consuming
    // the open request actually mounts.
    const system: DesignSystemDetail = {
      id: 'user:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-acme-design-system',
    };
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const workspaceFile: ProjectFile = {
      name: 'index.html',
      path: 'index.html',
      type: 'file',
      size: 100,
      mtime: 1,
      kind: 'html',
      mime: 'text/html',
    };
    const config: AppConfig = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: '',
      model: '',
      agentId: 'opencode',
      agentModels: {},
      skillId: null,
      designSystemId: null,
    };

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [workspaceFile] });
    mocks.listConversations.mockResolvedValue([
      { id: 'conv-design-system', projectId: project.id, title: 'Design system', createdAt: 1, updatedAt: 1 },
    ]);

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={config}
        agents={[{ id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    await screen.findByText('Acme Design System');

    // The known-file set reaches the chat pane…
    await waitFor(() =>
      expect(screen.getByTestId('chat-file-names').textContent).toContain('index.html'),
    );

    // …and the opener switches to the Files tab and hands the workspace the
    // open request.
    expect(screen.queryByTestId('design-system-files')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-open-file'));
    const workspace = await screen.findByTestId('design-system-files');
    expect(workspace.getAttribute('data-open-request')).toBe('index.html');
  });

  // recvqb6mfyqXLD: `canMutate` mirrors the daemon's own `canMutateUserDesignSystem`
  // PATCH/DELETE verdict onto the GET response — false only for a team-synced
  // design system the caller (a plain member, not the original sharer or a
  // workspace owner/admin) may not manage. This surface is the direct
  // `/design-systems/:id` route (e.g. the Library's "Open design system"
  // link), separate from — and previously ungated unlike — DesignSystemsTab's
  // own team-tab detail pane.
  it('disables the Publish toggle, DESIGN.md save, and revision accept/reject when canMutate is false', async () => {
    const system: DesignSystemDetail = {
      id: 'user:teammate-ds',
      title: 'Teammate Design System',
      category: 'Custom',
      summary: 'Synced from a teammate.',
      swatches: [],
      surface: 'web',
      body: '# Teammate Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      teamSynced: true,
      canMutate: false,
      projectId: 'ds-teammate-design-system',
    };
    const project: Project = {
      id: 'ds-teammate-design-system',
      name: 'Teammate Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const config: AppConfig = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: '',
      model: '',
      agentId: 'opencode',
      agentModels: {},
      skillId: null,
      designSystemId: null,
    };

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.fetchDesignSystemRevisions.mockResolvedValue([
      {
        id: 'rev-1',
        designSystemId: system.id,
        status: 'pending',
        feedback: 'Tighten the spacing scale.',
        baseBody: system.body,
        proposedBody: `${system.body}\nMore.`,
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
      },
    ]);

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={null}
        config={config}
        agents={[{ id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    await screen.findByText('Teammate Design System');

    expect(screen.getByRole('checkbox', { name: 'Published' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save DESIGN.md' })).toBeDisabled();

    const acceptButton = await screen.findByRole('button', { name: /Accept/i });
    const rejectButton = screen.getByRole('button', { name: /Reject/i });
    expect(acceptButton).toBeDisabled();
    expect(rejectButton).toBeDisabled();
  });

  it('keeps the Publish toggle and DESIGN.md save enabled for the caller\'s own design system', async () => {
    const system: DesignSystemDetail = {
      id: 'user:my-design-system',
      title: 'My Design System',
      category: 'Custom',
      summary: 'Authored by the caller.',
      swatches: [],
      surface: 'web',
      body: '# My Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-my-design-system',
    };
    const project: Project = {
      id: 'ds-my-design-system',
      name: 'My Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const config: AppConfig = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: '',
      model: '',
      agentId: 'opencode',
      agentModels: {},
      skillId: null,
      designSystemId: null,
    };

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={null}
        config={config}
        agents={[{ id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    await screen.findByText('My Design System');

    expect(screen.getByRole('checkbox', { name: 'Published' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save DESIGN.md' })).not.toBeDisabled();
  });

  it('does not silently seed audit repair prompts into the composer after manual runs', async () => {
    const system: DesignSystemDetail = {
      id: 'user:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-acme-design-system',
    };
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const config: AppConfig = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: '',
      model: '',
      agentId: 'opencode',
      agentModels: {},
      skillId: null,
      designSystemId: null,
    };

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.listConversations.mockResolvedValue([
      { id: 'conv-design-system', projectId: project.id, title: 'Design system', createdAt: 1, updatedAt: 1 },
    ]);
    mocks.fetchProjectDesignSystemPackageAudit.mockResolvedValue({
      ok: false,
      projectPath: '/tmp/ds',
      filesInspected: 12,
      errors: [{
        severity: 'error',
        code: 'missing_required_file',
        message: 'README.md is missing.',
        path: 'README.md',
      }],
      warnings: [],
    });
    mocks.streamViaDaemon.mockImplementation(async (options: {
      handlers: { onDone: () => void };
      onRunCreated?: (runId: string) => void;
    }) => {
      options.onRunCreated?.('run-design-system');
      options.handlers.onDone();
    });

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={config}
        agents={[{ id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    await screen.findByText('Acme Design System');
    fireEvent.click(screen.getByTestId('design-system-chat-send'));

    await waitFor(() =>
      expect(mocks.fetchProjectDesignSystemPackageAudit).toHaveBeenCalledWith(project.id, null),
    );
    await waitFor(() =>
      expect(screen.getAllByText(/Package audit found 1 error/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId('chat-initial-draft')?.textContent ?? '').not.toContain(
      'Fix the design-system package audit findings below.',
    );
  });

  // AC-R02.3 — the model/attachment capability preflight must actually gate
  // a real send from this flow too (review finding: zero production call
  // sites for `SessionModelPreflightBanner` / `postModelPreflight`).
  describe('AC-R02.3 model preflight gates a real send', () => {
    const system: DesignSystemDetail = {
      id: 'user:preflight-design-system',
      title: 'Preflight Design System',
      category: 'Custom',
      summary: 'Exercises the model/attachment preflight gate.',
      swatches: [],
      surface: 'web',
      body: '# Preflight Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-preflight-design-system',
    };
    const project: Project = {
      id: 'ds-preflight-design-system',
      name: 'Preflight Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const config: AppConfig = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: '',
      model: '',
      agentId: 'opencode',
      agentModels: {},
      skillId: null,
      designSystemId: null,
    };

    function renderAndSend(agents: AgentInfo[] = [{ id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]) {
      mocks.fetchDesignSystem.mockResolvedValue(system);
      mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
      mocks.listConversations.mockResolvedValue([
        { id: 'conv-design-system', projectId: project.id, title: 'Design system', createdAt: 1, updatedAt: 1 },
      ]);
      mocks.fetchProjectDesignSystemPackageAudit.mockResolvedValue(null);
      mocks.streamViaDaemon.mockImplementation(async (options: {
        handlers: { onDone: () => void };
        onRunCreated?: (runId: string) => void;
      }) => {
        options.onRunCreated?.('run-design-system');
        options.handlers.onDone();
      });
      return render(
        <DesignSystemDetailView
          id={system.id}
          selectedId={system.id}
          config={config}
          agents={agents}
          onBack={() => {}}
          onSetDefault={() => {}}
        />,
      );
    }

    it('fixture self-check: a normal send calls the preflight with the candidate agent/model', async () => {
      renderAndSend();
      await screen.findByText('Preflight Design System');
      fireEvent.click(screen.getByTestId('design-system-chat-send'));
      await waitFor(() => expect(mocks.postModelPreflight).toHaveBeenCalledTimes(1));
      const [sessionId, projectId, request] = mocks.postModelPreflight.mock.calls[0]!;
      expect(sessionId).toBe('conv-design-system');
      expect(projectId).toBe(project.id);
      expect(request).toMatchObject({ agentId: 'opencode' });
    });

    it('an ok preflight lets the send proceed to the daemon run as before', async () => {
      renderAndSend();
      await screen.findByText('Preflight Design System');
      fireEvent.click(screen.getByTestId('design-system-chat-send'));
      await waitFor(() => expect(mocks.postModelPreflight).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1));
    });

    // The mismatch banner itself (`SessionModelPreflightBanner`) is a plain
    // read of the result this test proves `sendProjectChatMessage` already
    // computed and stored — covered directly by
    // `SessionModelStatus.test.tsx` and, wired into a full ProjectView
    // render, by `ProjectView.model-preflight.test.tsx`. This file's shared
    // `ChatPane` mock does not render `composerFooterAccessory` (where the
    // real banner lives) for any of its other ~60 cases, so asserting on it
    // here would mean mounting the real `InlineModelSwitcher` into a harness
    // that was never built to support it.
    it('a mismatch stops the send before any run starts', async () => {
      mocks.postModelPreflight.mockResolvedValue({
        agentId: 'opencode', modelId: 'default', ok: false,
        mismatches: [{ code: 'model-unavailable', message: 'Model "default" is not available for OpenCode' }],
      });
      renderAndSend();
      await screen.findByText('Preflight Design System');
      fireEvent.click(screen.getByTestId('design-system-chat-send'));
      await waitFor(() => expect(mocks.postModelPreflight).toHaveBeenCalledTimes(1));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
    });

    it('a failed preflight CALL (network/service error) fails open and still starts the run', async () => {
      mocks.postModelPreflight.mockRejectedValue(new Error('network down'));
      renderAndSend();
      await screen.findByText('Preflight Design System');
      fireEvent.click(screen.getByTestId('design-system-chat-send'));
      await waitFor(() => expect(mocks.postModelPreflight).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1));
    });

    // BLOCK #1 (captain-integration preflight fixer review): `sendProjectChatMessage`
    // used to call `sessionModel.ensureSaved()` — which PUTs the candidate choice —
    // BEFORE this preflight check, so a rejected preflight still left the
    // incompatible model persisted. The fix moves the check ahead of
    // `ensureSaved()`, so a rejection never reaches the PUT at all.
    it('OPEND preflight-before-persist: a mismatch never persists the rejected candidate model', async () => {
      mocks.postModelPreflight.mockResolvedValue({
        agentId: 'opencode', modelId: 'default', ok: false,
        mismatches: [{ code: 'model-unavailable', message: 'Model "default" is not available for OpenCode' }],
      });
      renderAndSend();
      await screen.findByText('Preflight Design System');
      fireEvent.click(screen.getByTestId('design-system-chat-send'));
      await waitFor(() => expect(mocks.postModelPreflight).toHaveBeenCalledTimes(1));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
      expect(mocks.putSessionModel).not.toHaveBeenCalled();
    });

    // BLOCK #2: daemon run admission does not itself reject image attachments
    // for an agent without `supportsImagePaths` — it silently passes an empty
    // attachment list through. Failing open on a failed preflight CALL (as the
    // test above does, correctly, for a text-only send) would therefore
    // silently drop the user's images with no indication anything went wrong.
    it('a failed preflight CALL with image attachments staged fails CLOSED: no send, no persist, a truthful error', async () => {
      mocks.postModelPreflight.mockRejectedValue(new Error('network down'));
      renderAndSend();
      await screen.findByText('Preflight Design System');
      fireEvent.click(screen.getByTestId('design-system-chat-send-with-image'));
      await waitFor(() => expect(mocks.postModelPreflight).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe(
          "Couldn't verify this model can receive images. Retry sending, or remove the attached images and send text only.",
        ),
      );
      expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
      expect(mocks.putSessionModel).not.toHaveBeenCalled();
    });

    // AC-R02.3: this harness's `ChatPane` mock does not render
    // `composerFooterAccessory` (see the comment above `renderAndSend`), so it
    // cannot drive the real `InlineModelSwitcher` to exercise a genuine A→B
    // picker selection — the select-time gate that now rejects an
    // incompatible pick BEFORE it ever persists is covered end-to-end in
    // `ProjectView.model-preflight.test.tsx`, which mounts the real picker.
    // What IS exercisable here: a send-time rejection of the model already
    // in effect (e.g. its availability changed server-side between sends)
    // never touches the session's saved choice or fires a further PUT —
    // there is no restore path any more to even consider firing one.
    it('a rejection of the model already in effect (no switch happened) persists nothing further', async () => {
      renderAndSend();
      await screen.findByText('Preflight Design System');
      fireEvent.click(screen.getByTestId('design-system-chat-send'));
      await waitFor(() => expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1));
      expect(mocks.putSessionModel).toHaveBeenCalledTimes(1);

      mocks.postModelPreflight.mockResolvedValue({
        agentId: 'opencode', modelId: 'default', ok: false,
        mismatches: [{ code: 'model-unavailable', message: 'Model "default" is not available for OpenCode' }],
      });
      fireEvent.click(screen.getByTestId('design-system-chat-send'));
      await waitFor(() => expect(mocks.postModelPreflight).toHaveBeenCalledTimes(2));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      // Still just the one successful send — the second was rejected.
      expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1);
      // No further PUT: a send-time rejection never touches the session's
      // saved choice any more — there is no restore path left to fire one.
      expect(mocks.putSessionModel).toHaveBeenCalledTimes(1);
    });

    // AC-R02.3 parity with `ProjectView.model-preflight.test.tsx` ("a send
    // fired while a picker check is still pending waits, then runs once on
    // the choice the check leaves selected"). A send never runs while a
    // picker check is pending; it waits for the check to settle instead of
    // being refused. The check fails, so the previous choice stays selected
    // and the send goes out once, on that kept choice.
    it('a send fired while a picker check is still pending waits, then runs once on the choice the check leaves selected', async () => {
      chatPaneHarness.renderComposerAccessory = true;
      let releaseAlt: (value: unknown) => void = () => {};
      mocks.postModelPreflight.mockImplementation(async (_sessionId: string, _projectId: string, input: { agentId: string; modelId: string }) =>
        input.modelId === 'alt-model'
          ? new Promise((resolve) => { releaseAlt = resolve; })
          : { agentId: input.agentId, modelId: input.modelId, ok: true, mismatches: [] });
      renderAndSend([{
        id: 'opencode',
        name: 'OpenCode',
        bin: 'opencode',
        available: true,
        models: [
          { id: 'default', label: 'Default', default: true },
          { id: 'alt-model', label: 'Alt Model' },
        ],
      }] as unknown as AgentInfo[]);
      await screen.findByText('Preflight Design System');
      await waitFor(() => expect(screen.getByTestId('design-system-chat-state').getAttribute('data-send-disabled')).toBe('false'));

      fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
      fireEvent.click(screen.getByTestId('inline-model-switcher-agent-model'));
      const popover = screen.getByTestId('inline-model-switcher-agent-model-popover');
      fireEvent.click(within(popover).getByRole('option', { name: 'Alt Model' }));
      await waitFor(() => expect(mocks.postModelPreflight.mock.calls.some(([, , request]) => (request as { modelId: string }).modelId === 'alt-model')).toBe(true));

      fireEvent.click(screen.getByTestId('design-system-chat-send'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mocks.streamViaDaemon).not.toHaveBeenCalled();

      releaseAlt({
        agentId: 'opencode', modelId: 'alt-model', ok: false,
        mismatches: [{ code: 'model-unavailable', message: 'Model "alt-model" is not available for OpenCode' }],
      });
      await waitFor(() => expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1);
      expect(mocks.streamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'opencode', model: 'default' });
      expect(mocks.putSessionModel).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ modelId: 'alt-model' }), expect.anything());
    });

    // AC-R02.3 parity with ProjectView's `restartOnSettledChoice`: a send whose
    // model choice moves under it at any later await waits for the picker to
    // settle and starts over on the live choice, instead of being refused.
    describe('a choice that moves during the send starts the send over on the live choice', () => {
      const threeModels = [{
        id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true,
        models: [
          { id: 'default', label: 'Default', default: true },
          { id: 'alt-model', label: 'Alt Model' },
          { id: 'third-model', label: 'Third Model' },
        ],
      }] as unknown as AgentInfo[];
      type Gate = { modelId: string; release: () => void };
      const okPreflight = (input: { agentId: string; modelId: string }) => ({ agentId: input.agentId, modelId: input.modelId, ok: true, mismatches: [] });
      const sendTime = (request: unknown) => Array.isArray((request as { attachments?: unknown }).attachments);
      const preflightModels = (filter: (request: unknown) => boolean) =>
        mocks.postModelPreflight.mock.calls.filter(([, , request]) => filter(request)).map(([, , request]) => (request as { modelId: string }).modelId);
      function savedSession(modelId: string | null) {
        mocks.getSessionModel.mockImplementation(async (sessionId: string, projectId: string) => ({
          sessionId, projectId, revision: modelId ? 1 : 0, choice: modelId ? { agentId: 'opencode', modelId } : null, updatedAt: 0,
        }));
      }
      /** Holds the next PUT of `modelId` until released. */
      function holdPut(modelId: string): Gate {
        const gate: Gate = { modelId, release: () => {} };
        let held = false;
        mocks.putSessionModel.mockImplementation(async (sessionId: string, projectId: string, input: import('@open-design/contracts').PutSessionModel) => {
          const snapshot = { sessionId, projectId, revision: input.expectedRevision + 1, choice: { agentId: input.agentId, modelId: input.modelId }, updatedAt: 0 };
          if (input.modelId !== modelId || held) return snapshot;
          held = true;
          return new Promise((resolve) => { gate.release = () => resolve(snapshot); });
        });
        return gate;
      }
      async function ready() {
        chatPaneHarness.renderComposerAccessory = true;
        renderAndSend(threeModels);
        await screen.findByText('Preflight Design System');
        await waitFor(() => expect(screen.getByTestId('design-system-chat-state').getAttribute('data-send-disabled')).toBe('false'));
        // The session model controller for the active conversation has loaded,
        // so a send takes the active-conversation path the picker drives.
        await waitFor(() => expect(mocks.getSessionModel).toHaveBeenCalledWith('conv-design-system', expect.anything(), null));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      }
      function pickModel(label: string) {
        if (!screen.queryByTestId('inline-model-switcher-agent-model')) fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
        fireEvent.click(screen.getByTestId('inline-model-switcher-agent-model'));
        fireEvent.click(within(screen.getByTestId('inline-model-switcher-agent-model-popover')).getByRole('option', { name: label }));
      }
      async function expectOneRunOn(modelId: string) {
        await waitFor(() => expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1);
        expect(mocks.streamViaDaemon.mock.calls[0]?.[0]).toMatchObject({ agentId: 'opencode', model: modelId });
        // The run's attachments were checked against the model it runs on.
        expect(preflightModels(sendTime)).toContain(modelId);
      }

      it('after the candidate preflight: a stale result for the old model never clears the send', async () => {
        savedSession('default');
        let releaseDefault: () => void = () => {};
        mocks.postModelPreflight.mockImplementation(async (_sessionId: string, _projectId: string, input: { agentId: string; modelId: string; attachments?: unknown[] }) =>
          input.modelId === 'default' && Array.isArray(input.attachments)
            ? new Promise((resolve) => { releaseDefault = () => resolve(okPreflight(input)); })
            : okPreflight(input));
        await ready();
        fireEvent.click(screen.getByTestId('design-system-chat-send'));
        await waitFor(() => expect(preflightModels(sendTime)).toEqual(['default']));
        pickModel('Alt Model');
        await waitFor(() => expect(mocks.putSessionModel).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ modelId: 'alt-model' }), null));
        releaseDefault();
        await expectOneRunOn('alt-model');
      });

      it('after ensureSaved: a picker check that starts while the send saves its model holds the send', async () => {
        savedSession(null);
        const putDefault = holdPut('default');
        let releaseAlt: () => void = () => {};
        mocks.postModelPreflight.mockImplementation(async (_sessionId: string, _projectId: string, input: { agentId: string; modelId: string; attachments?: unknown[] }) =>
          input.modelId === 'alt-model' && !Array.isArray(input.attachments)
            ? new Promise((resolve) => { releaseAlt = () => resolve(okPreflight(input)); })
            : okPreflight(input));
        await ready();
        fireEvent.click(screen.getByTestId('design-system-chat-send'));
        await waitFor(() => expect(mocks.putSessionModel).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ modelId: 'default' }), null));
        pickModel('Alt Model');
        await waitFor(() => expect(preflightModels(request => !sendTime(request))).toContain('alt-model'));
        putDefault.release();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
        releaseAlt();
        await expectOneRunOn('alt-model');
      });

      // The composer's half of the contract: a send that gives up resolves as
      // 'restore-draft' (keep the draft); one that went out resolves as sent.
      async function lastOutcome() {
        return await (chatPaneHarness.sendOutcomes.at(-1) as Promise<unknown>);
      }
      async function holdPicker(whenPickerSettled: typeof sessionModelOverride.whenPickerSettled) {
        sessionModelOverride.pickerPending = true;
        sessionModelOverride.whenPickerSettled = whenPickerSettled;
        await act(async () => { sessionModelOverride.rerender(); });
      }
      async function releasePicker() {
        sessionModelOverride.pickerPending = false;
        sessionModelOverride.whenPickerSettled = null;
        await act(async () => { sessionModelOverride.rerender(); });
      }
      const keptChanging = 'The model kept changing while this message was sending, so it was not sent. Your message is kept. Send it again once the model choice is settled.';

      it('gives up with the draft kept when the picker wait times out', async () => {
        savedSession('default');
        await ready();
        const waits = vi.fn(async () => 'timed-out' as const);
        await holdPicker(waits);
        await act(async () => { fireEvent.click(screen.getByTestId('design-system-chat-send')); });
        expect(await lastOutcome()).toBe('restore-draft');
        // A timed-out wait ends the send at once; it does not try again.
        expect(waits).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(keptChanging));
        expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
        expect(preflightModels(sendTime)).toEqual([]);
      });

      it('gives up with the draft kept after the bounded number of restarts', async () => {
        savedSession('default');
        await ready();
        const waits = vi.fn(async () => 'settled' as const);
        await holdPicker(waits);
        await act(async () => { fireEvent.click(screen.getByTestId('design-system-chat-send')); });
        expect(await lastOutcome()).toBe('restore-draft');
        // The first wait plus MAX_SEND_CHOICE_RESTARTS (3) restarts.
        expect(waits).toHaveBeenCalledTimes(4);
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(keptChanging));
        expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
      });

      it('sends nothing and shows no error when the wait is cancelled', async () => {
        savedSession('default');
        await ready();
        await holdPicker(vi.fn(async () => 'cancelled' as const));
        await act(async () => { fireEvent.click(screen.getByTestId('design-system-chat-send')); });
        expect(await lastOutcome()).toBe('restore-draft');
        expect(screen.queryByRole('alert')).toBeNull();
        expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
      });

      it('never runs a waiting send in a conversation the user switched to', async () => {
        savedSession('default');
        await ready();
        let settle!: (outcome: 'settled') => void;
        await holdPicker(() => new Promise((resolve) => { settle = resolve; }));
        await act(async () => { fireEvent.click(screen.getByTestId('design-system-chat-send')); });
        fireEvent.click(screen.getByTestId('select-other-conversation'));
        // The other conversation is fully ready to send, so only the send's own
        // target check can stop it from running there.
        await waitFor(() => expect(screen.getByTestId('design-system-chat-state').getAttribute('data-send-disabled')).toBe('false'));
        await releasePicker();
        await act(async () => { settle('settled'); });
        expect(await lastOutcome()).toBe('restore-draft');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
        expect(mocks.postModelPreflight.mock.calls.filter(([, , request]) => sendTime(request))).toEqual([]);
      });

      it('a send that waited and then went out resolves as sent, so the composer clears only what it carried', async () => {
        savedSession('default');
        await ready();
        let settle!: (outcome: 'settled') => void;
        await holdPicker(() => new Promise((resolve) => { settle = resolve; }));
        await act(async () => { fireEvent.click(screen.getByTestId('design-system-chat-send')); });
        await releasePicker();
        await act(async () => { settle('settled'); });
        expect(await lastOutcome()).toBeUndefined();
        expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1);
      });

      it('attachment-checked mismatch: a selection queued behind the send\'s save makes it re-check the new model', async () => {
        savedSession('default');
        const putAlt = holdPut('alt-model');
        mocks.postModelPreflight.mockImplementation(async (_sessionId: string, _projectId: string, input: { agentId: string; modelId: string }) => okPreflight(input));
        await ready();
        pickModel('Alt Model');
        await waitFor(() => expect(mocks.putSessionModel).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ modelId: 'alt-model' }), null));
        fireEvent.click(screen.getByTestId('design-system-chat-send'));
        await waitFor(() => expect(preflightModels(sendTime)).toEqual(['alt-model']));
        pickModel('Third Model');
        await waitFor(() => expect(preflightModels(request => !sendTime(request))).toContain('third-model'));
        putAlt.release();
        await expectOneRunOn('third-model');
      });
    });
  });

  it('opens the Design Files workspace when the detail payload omits the optional source field', async () => {
    const system = {
      id: 'user:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-acme-design-system',
    } satisfies Omit<DesignSystemDetail, 'source'>;
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const config: AppConfig = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: '',
      model: '',
      agentId: 'opencode',
      agentModels: {},
      skillId: null,
      designSystemId: null,
    };

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.listConversations.mockResolvedValue([
      { id: 'conv-design-system', projectId: project.id, title: 'Design system', createdAt: 1, updatedAt: 1 },
    ]);

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={config}
        agents={[{ id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Design Files' }));

    await waitFor(() =>
      expect(mocks.ensureDesignSystemWorkspace).toHaveBeenCalledWith(system.id, null),
    );
    await waitFor(() => expect(screen.getByTestId('design-system-files')).toBeTruthy());
    expect(screen.queryByText('Opening the design system workspace...')).toBeNull();
  });

  it('opens the existing project fallback when workspace creation returns null', async () => {
    const workspaceContext = teamContext();
    workspaceContextState.context = workspaceContext;
    const system: DesignSystemDetail = {
      id: 'user:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-acme-design-system',
    };
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const files: ProjectFile[] = [
      { name: 'DESIGN.md', size: 42, mtime: 1, kind: 'text', mime: 'text/markdown' },
    ];
    const config: AppConfig = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: '',
      model: '',
      agentId: 'opencode',
      agentModels: {},
      skillId: null,
      designSystemId: null,
    };
    const onOpenProject = vi.fn();
    const onProjectsRefresh = vi.fn();

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue(null);
    mocks.getProject.mockResolvedValue(project);
    mocks.fetchProjectFiles.mockResolvedValue(files);
    mocks.listConversations.mockResolvedValue([
      { id: 'conv-design-system', projectId: project.id, title: 'Design system', createdAt: 1, updatedAt: 1 },
    ]);

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={config}
        agents={[{ id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]}
        onBack={() => {}}
        onSetDefault={() => {}}
        onOpenProject={onOpenProject}
        onProjectsRefresh={onProjectsRefresh}
      />,
    );

    await waitFor(() =>
      expect(mocks.ensureDesignSystemWorkspace).toHaveBeenCalledWith(system.id, workspaceContext),
    );
    await waitFor(() => expect(mocks.getProject).toHaveBeenCalledWith(project.id, workspaceContext));
    expect(mocks.fetchProjectFiles).toHaveBeenCalledWith(project.id, {
      workspaceContext,
      requireAuthoritative: true,
    });
    expect(onProjectsRefresh).toHaveBeenCalledTimes(1);
    expect(onOpenProject).toHaveBeenCalledWith(project.id);
    expect(screen.queryByText('Could not open the design system workspace.')).toBeNull();
  });

  it('shows a terminal error when workspace creation and project fallback both fail', async () => {
    const system: DesignSystemDetail = {
      id: 'user:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-acme-design-system',
    };
    const config: AppConfig = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: '',
      model: '',
      agentId: 'opencode',
      agentModels: {},
      skillId: null,
      designSystemId: null,
    };
    const onOpenProject = vi.fn();

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue(null);
    mocks.getProject.mockResolvedValue(null);

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={config}
        agents={[{ id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]}
        onBack={() => {}}
        onSetDefault={() => {}}
        onOpenProject={onOpenProject}
      />,
    );

    await waitFor(() =>
      expect(mocks.ensureDesignSystemWorkspace).toHaveBeenCalledWith(system.id, null),
    );
    await waitFor(() => expect(mocks.getProject).toHaveBeenCalledWith(system.projectId, null));
    expect(mocks.fetchProjectFiles).not.toHaveBeenCalled();
    expect(onOpenProject).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Design Files' }));
    await waitFor(() => expect(screen.getByText('Could not open the design system workspace.')).toBeTruthy());
    expect(screen.queryByText('Opening the design system workspace...')).toBeNull();
    expect(screen.queryByTestId('design-system-files')).toBeNull();
  });

  it('shows a terminal error when the fallback project file snapshot is not authoritative', async () => {
    const system: DesignSystemDetail = {
      id: 'user:fallback-read-failure',
      title: 'Fallback Read Failure',
      category: 'Custom',
      summary: 'Fallback file read failure.',
      swatches: [],
      surface: 'web',
      body: '# Fallback Read Failure\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-fallback-read-failure',
    };
    const project: Project = {
      id: system.projectId!,
      name: system.title,
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
    };
    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue(null);
    mocks.getProject.mockResolvedValue(project);
    mocks.fetchProjectFiles.mockRejectedValue(new Error('files unavailable'));

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={{ mode: 'daemon', agentId: 'opencode' } as AppConfig}
        agents={[]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    await waitFor(() => expect(mocks.fetchProjectFiles).toHaveBeenCalledWith(project.id, {
      requireAuthoritative: true,
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Design Files' }));
    await waitFor(() => expect(screen.getByText('Could not open the design system workspace.')).toBeTruthy());
    expect(screen.queryByTestId('design-system-files')).toBeNull();
  });

  it.each([false, true])('sends chat through an existing project fallback when workspace creation returns null (model PUT fails: %s)', async modelPutFails => {
    const system: DesignSystemDetail = {
      id: 'user:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-acme-design-system',
    };
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const files: ProjectFile[] = [
      { name: 'DESIGN.md', size: 42, mtime: 1, kind: 'text', mime: 'text/markdown' },
    ];
    const config: AppConfig = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: '',
      model: '',
      agentId: 'codex',
      agentModels: {},
      skillId: null,
      designSystemId: null,
    };
    const conversation = {
      id: 'conv-design-system',
      projectId: project.id,
      title: 'Design system',
      createdAt: 1,
      updatedAt: 1,
    };

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(null);
    mocks.getProject.mockResolvedValue(project);
    mocks.fetchProjectFiles.mockResolvedValue(files);
    mocks.listConversations.mockResolvedValue([conversation]);
    mocks.createConversation.mockResolvedValue(conversation);

    if (modelPutFails) mocks.putSessionModel.mockRejectedValue(new Error('offline'));
    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={config}
        agents={[{ id: 'codex', name: 'Codex', bin: 'codex', available: true, models: [] }]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    await waitFor(() => expect(mocks.ensureDesignSystemWorkspace).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('design-system-chat-send'));

    await waitFor(() => expect(mocks.ensureDesignSystemWorkspace).toHaveBeenCalledTimes(2));
    if (modelPutFails) {
      await waitFor(() => expect(mocks.putSessionModel).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
      expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
      expect(mocks.createConversation).not.toHaveBeenCalled();
      return;
    }
    await waitFor(() => expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1));
    expect(mocks.getProject).toHaveBeenCalledWith(project.id, null);
    expect(mocks.fetchProjectFiles).toHaveBeenCalledWith(project.id, {
      requireAuthoritative: true,
    });
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.streamViaDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        conversationId: conversation.id,
        designSystemId: system.id,
        agentId: 'codex', model: 'default', expectedModelRevision: 1,
      }),
    );
    expect(mocks.putSessionModel).toHaveBeenCalledWith(conversation.id, project.id, { agentId: 'codex', modelId: 'default', expectedRevision: 0 }, null);
    expect(mocks.putSessionModel.mock.invocationCallOrder[0]).toBeLessThan(mocks.streamViaDaemon.mock.invocationCallOrder[0]!);
    expect(screen.queryByText('Could not open the design system workspace.')).toBeNull();
  });

  it('starts a new design-system conversation by opening the workspace first', async () => {
    const system: DesignSystemDetail = {
      id: 'installed:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'installed',
      status: 'published',
      isEditable: true,
    };
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const fresh: Conversation = {
      id: 'conv-new',
      projectId: project.id,
      title: 'Design system',
      createdAt: 1,
      updatedAt: 1,
    };
    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ project, files: [] });
    mocks.createConversation.mockResolvedValue(fresh);

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={null}
        config={{ mode: 'daemon', agentId: 'codex' } as AppConfig}
        agents={[]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    const button = await screen.findByTestId('new-conversation');
    fireEvent.click(button);

    await waitFor(() =>
      expect(mocks.ensureDesignSystemWorkspace).toHaveBeenCalledWith(system.id, null),
    );
    await waitFor(() =>
      expect(mocks.createConversation).toHaveBeenCalledWith(project.id, 'Design system', {
        workspaceContext: null,
      }),
    );
    expect(mocks.createConversation).toHaveBeenCalledTimes(1);
    expect(mocks.listConversations).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.listMessages).toHaveBeenCalledWith(project.id, fresh.id, null),
    );
  });

  it('does not expose or submit the previous transcript when the selected conversation read fails', async () => {
    const system: DesignSystemDetail = {
      id: 'user:conversation-read-failure',
      title: 'Conversation Read Failure',
      category: 'Custom',
      summary: 'Conversation switching regression fixture.',
      swatches: [],
      surface: 'web',
      body: '# Conversation Read Failure\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-conversation-read-failure',
    };
    const project: Project = {
      id: system.projectId!,
      name: system.title,
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
    };
    const previousConversation: Conversation = {
      id: 'conv-previous',
      projectId: project.id,
      title: 'Previous',
      createdAt: 1,
      updatedAt: 1,
    };
    const otherConversation: Conversation = {
      id: 'conv-other',
      projectId: project.id,
      title: 'Other',
      createdAt: 2,
      updatedAt: 2,
    };
    const previousMessage: ChatMessage = {
      id: 'previous-message',
      role: 'assistant',
      content: 'Previous conversation transcript',
      createdAt: 1,
    };

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.listConversations.mockResolvedValue([previousConversation, otherConversation]);
    mocks.listMessages
      .mockResolvedValueOnce([previousMessage])
      .mockRejectedValueOnce(new Error('workspace directory unavailable'));

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={{ mode: 'daemon', agentId: 'codex' } as AppConfig}
        agents={[]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    await screen.findByText(previousMessage.content);

    fireEvent.click(screen.getByTestId('select-other-conversation'));

    await waitFor(() => expect(mocks.listMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.queryByText(previousMessage.content)).toBeNull();
      expect(screen.getByTestId('design-system-chat-state').dataset.sendDisabled).toBe('true');
    });
    fireEvent.click(screen.getByTestId('design-system-chat-send'));
    expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
  });

  it('clears a stale creation error after a successful new conversation retry', async () => {
    const system: DesignSystemDetail = {
      id: 'installed:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'installed',
      status: 'published',
      isEditable: true,
    };
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const fresh: Conversation = {
      id: 'conv-new',
      projectId: project.id,
      title: 'Design system',
      createdAt: 1,
      updatedAt: 1,
    };
    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ project, files: [] });
    mocks.createConversation
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fresh);

    render(
      <DesignSystemDetailView
        id={system.id}
        selectedId={null}
        config={{ mode: 'daemon', agentId: 'codex' } as AppConfig}
        agents={[]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />,
    );

    const button = await screen.findByTestId('new-conversation');
    fireEvent.click(button);

    await screen.findByText('Could not create a design system conversation.');

    fireEvent.click(button);

    await waitFor(() => expect(mocks.createConversation).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.queryByText('Could not create a design system conversation.')).toBeNull();
    });
    await waitFor(() =>
      expect(mocks.listMessages).toHaveBeenCalledWith(project.id, fresh.id, null),
    );
  });

  it('passes the current UI locale to daemon workspace chat runs', async () => {
    const system: DesignSystemDetail = {
      id: 'user:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-acme-design-system',
    };
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    const config: AppConfig = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: '',
      model: '',
      agentId: 'opencode',
      agentModels: {},
      skillId: null,
      designSystemId: null,
    };

    mocks.fetchDesignSystem.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.listConversations.mockResolvedValue([
      { id: 'conv-design-system', projectId: project.id, title: 'Design system', createdAt: 1, updatedAt: 1 },
    ]);

    render(
      <I18nProvider initial="en">
        <DesignSystemDetailView
          id={system.id}
          selectedId={system.id}
          config={config}
          agents={[{ id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]}
          onBack={() => {}}
          onSetDefault={() => {}}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('design-system-chat-send')).toBeTruthy());
    fireEvent.click(screen.getByTestId('design-system-chat-send'));

    await waitFor(() => expect(mocks.streamViaDaemon).toHaveBeenCalledTimes(1));
    expect(mocks.streamViaDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        conversationId: 'conv-design-system',
        designSystemId: system.id,
        locale: "en",
      }),
    );
  });
  it('stages DS chat intake into its backing project and active conversation instead of Library pending', async () => {
    const system: DesignSystemDetail = { id: 'user:intake', title: 'Intake Design System', category: 'Custom', summary: 'Workspace', swatches: [], surface: 'web', body: '# System', source: 'user', status: 'draft', isEditable: true, projectId: 'ds-intake' };
    const project: Project = { id: 'ds-intake', name: 'DS', skillId: null, designSystemId: system.id, createdAt: 1, updatedAt: 1 };
    mocks.fetchDesignSystem.mockResolvedValue(system); mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] }); mocks.listConversations.mockResolvedValue([{ id: 'ds-intake-conversation', projectId: project.id, title: 'DS', createdAt: 1, updatedAt: 1 }]);
    let receipt: IntakeBatchSnapshot | undefined;
    const store = new IntakeStore({
      create: async request => (receipt = { ...request, revision: 1, createdAt: 1, updatedAt: 1, files: request.files.map(descriptor => ({ clientFileId: descriptor.clientFileId, order: descriptor.order, descriptor, state: 'queued', retryable: true, hasSuccessfulAttachment: false })) }),
      get: async () => receipt!, list: async () => ({ batches: [] }), clear: vi.fn(),
      put: async (id, fileId) => { const file = receipt!.files.find(file => file.clientFileId === fileId)!; const stored = { ...file, state: 'stored' as const, retryable: false, stored: { assetId: fileId, contentHash: 'a'.repeat(64), size: file.descriptor.size, filename: file.descriptor.filename, detectedMime: 'application/zip', kind: 'file' as const, downloadUrl: '/download' } }; receipt = { ...receipt!, revision: 2, files: [stored] }; return { intakeBatchId: id, revision: 2, file: stored }; },
      attach: async (id, target) => ({ intakeBatchId: id, revision: 3, files: receipt!.files, attachments: receipt!.files.map(file => ({ clientFileId: file.clientFileId, assetId: file.stored!.assetId, contentHash: file.stored!.contentHash, projectId: target.projectId, conversationId: target.conversationId, relPath: file.descriptor.filename, filename: file.descriptor.filename, size: file.descriptor.size })) }),
    });
    const config: AppConfig = { mode: 'daemon', apiKey: '', baseUrl: '', model: '', agentId: 'opencode', skillId: null, designSystemId: null };
    render(<WorkbenchIntake store={store} target={{ destination: { kind: 'pending' }, context: null }}><DesignSystemDetailView id={system.id} selectedId={system.id} config={config} agents={[{ id: 'opencode', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]} onBack={() => {}} onSetDefault={() => {}} /></WorkbenchIntake>);
    await screen.findByTestId('attach-design-system-file'); await waitFor(() => expect(screen.getByTestId('design-system-chat-state').getAttribute('data-send-disabled')).toBe('false')); fireEvent.click(screen.getByTestId('attach-design-system-file'));
    await waitFor(() => expect(store.getSnapshot()[0]?.target.destination).toEqual({ kind: 'project', projectId: project.id, conversationId: 'ds-intake-conversation' }));
    await waitFor(() => expect(store.getSnapshot()[0]?.attached?.attachments[0]).toMatchObject({ projectId: project.id, conversationId: 'ds-intake-conversation', filename: 'ds-notes.zip' })); expect(mocks.streamViaDaemon).not.toHaveBeenCalled();
  });

});
