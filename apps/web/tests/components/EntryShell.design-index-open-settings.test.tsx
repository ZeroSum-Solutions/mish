// @vitest-environment jsdom
//
// F4: the Design index 503 alert's "Open Settings" button only works if
// `EntryShell` actually hands its own `onOpenSettings` down to the mounted
// `DesignIndexView` (`EntryShell.tsx:1828-1830`, contract amendment §8 F4).
// `DesignIndexView`'s own render/click behavior for that button is pinned in
// `DesignIndexView.test.tsx`; this test only pins the hand-off, so it mocks
// `DesignIndexView` out rather than re-driving its Jev fetches through a
// fully wired EntryShell.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig } from '../../src/types';

type CapturedOnOpenSettings = ((section?: string) => void) | undefined;

let capturedOnOpenSettings: CapturedOnOpenSettings;

vi.mock('../../src/components/DesignIndexView', () => ({
  DesignIndexView: (props: { onOpenSettings?: (section?: string) => void }) => {
    capturedOnOpenSettings = props.onOpenSettings;
    return null;
  },
}));

const originalFetch = globalThis.fetch;
const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function agent(): AgentInfo {
  return {
    id: 'amr',
    name: 'AMR',
    bin: 'amr',
    available: true,
    models: [{ id: 'glm-5', label: 'GLM 5' }],
  };
}

function config(): AppConfig {
  return {
    mode: 'daemon',
    agentId: 'amr',
    agentModels: { amr: { model: 'glm-5' } },
    apiProtocol: 'anthropic',
    apiProtocolConfigs: {},
    apiKey: '',
    baseUrl: '',
    model: '',
    skillId: null,
    designSystemId: null,
    theme: 'system',
  };
}

describe('EntryShell hands its onOpenSettings down to DesignIndexView', () => {
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.ResizeObserver = originalResizeObserver;
    capturedOnOpenSettings = undefined;
    vi.restoreAllMocks();
  });

  it('passes the real onOpenSettings through to the mounted DesignIndexView', async () => {
    globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
    // Signed-out shape (`context: null`) so no billing/team-project reads are
    // needed — this test is only about the DesignIndexView hand-off.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/workspace/context')) return jsonResponse({ context: null });
      if (url.endsWith('/api/workspace/directory')) {
        return jsonResponse({ items: [], activeWorkspaceId: null });
      }
      if (url.endsWith('/api/plugins')) return jsonResponse({ plugins: [] });
      if (url.endsWith('/api/mcp/servers')) return jsonResponse({ servers: [] });
      return jsonResponse({});
    }) as typeof fetch;

    const onOpenSettings = vi.fn();

    render(
      <I18nProvider initial="en">
        <EntryShell
          skills={[]}
          designTemplates={[]}
          designSystems={[]}
          projects={[]}
          templates={[]}
          promptTemplates={[]}
          defaultDesignSystemId={null}
          connectors={[]}
          connectorsLoading={false}
          config={config()}
          agents={[agent()]}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiProtocolChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onConfigPersist={vi.fn()}
          onRefreshAgents={vi.fn(() => [agent()])}
          onCreateProject={vi.fn(async () => true)}
          onImportClaudeDesign={vi.fn()}
          onOpenProject={vi.fn()}
          onOpenLiveArtifact={vi.fn()}
          onDeleteProject={vi.fn()}
          onRenameProject={vi.fn()}
          onChangeDefaultDesignSystem={vi.fn()}
          onPersistComposioKey={vi.fn()}
          onOpenSettings={onOpenSettings}
          onCompleteOnboarding={vi.fn()}
        />
      </I18nProvider>,
    );

    await screen.findByTestId('entry-view-design-index');

    expect(capturedOnOpenSettings).toBeTruthy();
    capturedOnOpenSettings?.('media');
    expect(onOpenSettings).toHaveBeenCalledWith('media');
  });
});
