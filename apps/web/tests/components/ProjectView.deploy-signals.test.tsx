// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectView } from '../../src/components/ProjectView';
import { useIframeKeepAlivePool } from '../../src/components/IframeKeepAlivePool';
import { useProjectCollab, type ProjectCollab } from '../../src/collab/useProjectCollab';
import type {
  AgentInfo,
  AppConfig,
  Conversation,
  DesignSystemSummary,
  Project,
  SkillSummary,
} from '../../src/types';
import {
  createConversation,
  listConversations,
  listMessages,
  loadTabs,
} from '../../src/state/projects';
import { fetchPreviewComments } from '../../src/providers/registry';

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: () => {},
  }),
}));

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
}));

vi.mock('../../src/components/IframeKeepAlivePool', async () => {
  const actual = await vi.importActual<typeof import('../../src/components/IframeKeepAlivePool')>(
    '../../src/components/IframeKeepAlivePool',
  );
  return {
    ...actual,
    useIframeKeepAlivePool: vi.fn(),
  };
});

vi.mock('../../src/providers/anthropic', () => ({
  streamMessage: vi.fn(),
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(),
  listActiveChatRuns: vi.fn().mockResolvedValue([]),
  publishDaemonRunFinishedEvent: vi.fn(),
  reattachDaemonRun: vi.fn(),
  streamViaDaemon: vi.fn(),
}));

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
}));

vi.mock('../../src/collab/useProjectCollab', async () => {
  const actual = await vi.importActual<typeof import('../../src/collab/useProjectCollab')>(
    '../../src/collab/useProjectCollab',
  );
  return {
    ...actual,
    useProjectCollab: vi.fn(),
  };
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
    fetchPreviewComments: vi.fn(),
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
    loadTabs: vi.fn(),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});

vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

vi.mock('../../src/components/AvatarMenu', () => ({
  AvatarMenu: () => null,
}));

const workspaceProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock('../../src/components/FileWorkspace', () => ({
  DESIGN_SYSTEM_TAB: '__design_system__',
  FileWorkspace: (props: Record<string, unknown>) => {
    workspaceProps.last = props;
    return <div data-testid="file-workspace" />;
  },
}));

vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
}));

const mockedUseIframeKeepAlivePool = vi.mocked(useIframeKeepAlivePool);
const mockedUseProjectCollab = vi.mocked(useProjectCollab);
const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedLoadTabs = vi.mocked(loadTabs);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);

const config: AppConfig = {
  mode: 'api',
  apiKey: '',
  baseUrl: '',
  model: '',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

const conversation: Conversation = {
  id: 'conv-1',
  projectId: 'project-1',
  title: null,
  createdAt: 1,
  updatedAt: 1,
};

const designSystem: DesignSystemSummary = {
  id: 'ds-1',
  title: 'Design System',
  category: 'product',
  summary: 'System',
};

function collabStub(): ProjectCollab {
  return {
    enabled: false,
    member: null,
    present: [],
    publishedVersion: 0,
    syncState: 'synced',
    viewerOnly: false,
    writerAuthority: 'allowed',
    isOwner: true,
    isEffectiveOwner: true,
    isSharedNonOwner: false,
    ownerDisplayName: null,
    ownerRole: 'owner',
    downloadPending: false,
    reportChange: vi.fn(),
    requestPublish: vi.fn(),
    refreshPresence: vi.fn(),
    checkStatusNow: vi.fn(),
    applyContentTransferState: vi.fn(),
  };
}

function renderWith(project: Project) {
  return render(
    <ProjectView
      project={project}
      routeFileName={null}
      config={config}
      agents={[] as AgentInfo[]}
      skills={[] as SkillSummary[]}
      designTemplates={[] as SkillSummary[]}
      designSystems={[designSystem]}
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
}

function baseProject(overrides: Partial<Project>): Project {
  return {
    id: 'project-1',
    name: 'Project 1',
    skillId: null,
    designSystemId: 'ds-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

// The deploy modal's "Make preview public" default is decided from project
// data that only ProjectView holds. A test that starts at FileWorkspace with
// hand-derived signals would still pass if these two props were deleted here,
// so this one asserts the wiring at its origin.
describe('ProjectView — agency deploy signals handed to FileWorkspace', () => {
  beforeEach(() => {
    workspaceProps.last = null;
    mockedUseIframeKeepAlivePool.mockReturnValue({
      attach: vi.fn(),
      release: vi.fn(),
      evict: vi.fn(),
      evictProject: vi.fn(),
      evictMatching: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      revision: vi.fn(() => 0),
    });
    mockedUseProjectCollab.mockReturnValue(collabStub());
    mockedListConversations.mockResolvedValue([conversation]);
    mockedCreateConversation.mockResolvedValue(conversation);
    mockedListMessages.mockResolvedValue([]);
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
    mockedFetchPreviewComments.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('passes the persisted Skill id through as the deploy signal', async () => {
    renderWith(baseProject({ skillId: 'agency-site' }));
    await waitFor(() => {
      expect(workspaceProps.last).not.toBeNull();
    });
    expect(workspaceProps.last).toMatchObject({
      projectSkillId: 'agency-site',
      projectPluginId: null,
    });
  });

  it('passes the bound example plugin id from project metadata', async () => {
    renderWith(baseProject({
      skillId: null,
      metadata: {
        kind: 'prototype',
        exampleBinding: {
          schemaVersion: 1,
          provenance: 'example_card',
          pluginId: 'example-agency-emmpo',
          pluginSource: 'local',
          manifestSourceDigest: 'a'.repeat(64),
          boundAt: 1,
        },
      },
    }));
    await waitFor(() => {
      expect(workspaceProps.last).not.toBeNull();
    });
    expect(workspaceProps.last).toMatchObject({
      projectSkillId: null,
      projectPluginId: 'example-agency-emmpo',
    });
  });

  it('passes nulls for a project that is neither', async () => {
    renderWith(baseProject({ skillId: null }));
    await waitFor(() => {
      expect(workspaceProps.last).not.toBeNull();
    });
    expect(workspaceProps.last).toMatchObject({
      projectSkillId: null,
      projectPluginId: null,
    });
  });
});
