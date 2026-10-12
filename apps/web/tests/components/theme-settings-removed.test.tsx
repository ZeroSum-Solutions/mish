// @vitest-environment jsdom
//
// General settings own the shared theme picker. Onboarding stays focused on
// setup and does not duplicate appearance controls.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { AgentInfo, AppConfig } from '../../src/types';

const analyticsMocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      newRequestId: vi.fn(() => 'request-1'),
      setConfigureGlobals: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      track: analyticsMocks.track,
    }),
    useAppVersion: () => null,
  };
});

const AGENTS: AgentInfo[] = [
  { id: 'codex', name: 'Codex', bin: 'codex', available: true },
];

const THEME_CONTROL_LABELS = ['System', 'Light', 'Dark'];

const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  globalThis.ResizeObserver = originalResizeObserver;
  analyticsMocks.track.mockReset();
});

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  analyticsMocks.track.mockReset();
});

describe('Settings → General (theme preferences)', () => {
  function renderGeneralSettings() {
    return render(
      <I18nProvider initial="en">
        <SettingsDialog
          presentation="page"
          initial={{ ...DEFAULT_CONFIG }}
          agents={AGENTS}
          daemonLive
          appVersionInfo={null}
          initialSection="general"
          onPersist={vi.fn()}
          onPersistComposioKey={vi.fn()}
          onClose={vi.fn()}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );
  }

  it('offers System / Light / Dark through an accessible shared selection control', () => {
    renderGeneralSettings();
    for (const label of THEME_CONTROL_LABELS) {
      expect(screen.getByRole('radio', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
  });

  it('applies a selected theme immediately without dropping neighbouring settings', () => {
    renderGeneralSettings();
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('keeps the neighbouring General settings intact', () => {
    renderGeneralSettings();

    // The appearance control stays on General; the language select is gone
    // because the app ships English only (D23).
    expect(screen.getByRole('radio', { name: 'System' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Language' })).toBeNull();
  });
});

describe('Onboarding welcome (theme toggle removed)', () => {
  function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      mode: 'daemon',
      agentId: null,
      agentModels: {},
      apiProtocol: 'anthropic',
      apiProtocolConfigs: {},
      apiKey: '',
      baseUrl: '',
      model: '',
      ...overrides,
    } as AppConfig;
  }

  function renderOnboarding() {
    window.history.replaceState(null, '', '/onboarding');
    return render(
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
          config={baseConfig()}
          agents={AGENTS}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiProtocolChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onConfigPersist={vi.fn()}
          onRefreshAgents={vi.fn(() => AGENTS)}
          onCreateProject={vi.fn()}
          onImportClaudeDesign={vi.fn()}
          onOpenProject={vi.fn()}
          onOpenLiveArtifact={vi.fn()}
          onDeleteProject={vi.fn()}
          onRenameProject={vi.fn()}
          onChangeDefaultDesignSystem={vi.fn()}
          onPersistComposioKey={vi.fn()}
          onOpenSettings={vi.fn()}
          onCompleteOnboarding={vi.fn()}
        />
      </I18nProvider>,
    );
  }

  it('renders no sun/moon theme toggle on the welcome pane', () => {
    const { container } = renderOnboarding();

    expect(container.querySelector('.onboarding-cloud__pane')).not.toBeNull();
    expect(container.querySelector('.onboarding-cloud__theme')).toBeNull();
  });

  it('exposes no theme control by accessible name', () => {
    renderOnboarding();

    for (const label of THEME_CONTROL_LABELS) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });
});
