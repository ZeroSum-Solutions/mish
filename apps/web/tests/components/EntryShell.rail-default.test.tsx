// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import {
  ENTRY_RAIL_STATE_EVENT,
  ENTRY_RAIL_TOGGLE_EVENT,
  RAIL_OPEN_STORAGE_KEY,
} from '../../src/components/entryRailBridge';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig } from '../../src/types';
import { installViewport } from '../helpers/viewport-media';

// Decision D13 (2026-10-09, Sol-audited): the Home nav rail docks by default
// at >= 1280 px when the user has never chosen and stays collapsed below that.
// Only an explicit toggle is remembered, and it always wins. A docked rail is
// navigation, not a drawer: it survives navigation, outside presses and
// Escape. At <= 1080 px CSS cannot show a docked rail, so the rail presents
// collapsed there (opening it shows a dismissible overlay) while the stored
// preference is kept.

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      newRequestId: vi.fn(() => 'request-1'),
      setConfigureGlobals: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      track: vi.fn(),
    }),
    useAppVersion: () => null,
  };
});

const originalFetch = globalThis.fetch;
const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function cliAgent(): AgentInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '1.0.0',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
  };
}

function renderHome() {
  window.history.replaceState(null, '', '/');
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    promptTemplates: [],
    defaultDesignSystemId: null,
    connectors: [],
    connectorsLoading: false,
    config: {
      mode: 'daemon',
      agentId: 'claude-code',
      agentModels: { 'claude-code': { model: 'sonnet' } },
      apiProtocol: 'anthropic',
      apiProtocolConfigs: {},
      apiKey: '',
      baseUrl: '',
      model: '',
    } as unknown as AppConfig,
    agents: [cliAgent()],
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [cliAgent()]),
    onCreateProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onPersistComposioKey: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
  };
  render(
    <I18nProvider initial="en">
      <EntryShell {...props} />
    </I18nProvider>,
  );
}

function entry(): HTMLElement {
  const node = document.querySelector<HTMLElement>('.entry');
  if (!node) throw new Error('entry not rendered');
  return node;
}

function rail(): HTMLElement {
  const node = document.querySelector<HTMLElement>('nav.entry-nav-rail');
  if (!node) throw new Error('rail not rendered');
  return node;
}

function expectDocked() {
  expect(entry().classList.contains('entry--rail-open')).toBe(true);
  expect(rail().getAttribute('aria-hidden')).toBeNull();
  expect(rail().hasAttribute('inert')).toBe(false);
}

function expectCollapsed() {
  expect(entry().classList.contains('entry--rail-open')).toBe(false);
  expect(rail().getAttribute('aria-hidden')).toBe('true');
  expect(rail().hasAttribute('inert')).toBe(true);
}

let railWrites: string[];

beforeEach(() => {
  window.localStorage.clear();
  globalThis.fetch = vi.fn(async () => new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  railWrites = [];
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === RAIL_OPEN_STORAGE_KEY) railWrites.push(value);
    return setItem.call(this, key, value);
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = originalResizeObserver;
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('never-chosen default', () => {
  it('docks the rail open at 1440 px, focusable and exposed to assistive tech', () => {
    installViewport(1440);
    renderHome();
    expectDocked();
  });

  it('keeps the rail collapsed at 1024 px', () => {
    installViewport(1024);
    renderHome();
    expectCollapsed();
  });

  it('keeps the rail collapsed between the narrow breakpoint and 1280 px', () => {
    installViewport(1200);
    renderHome();
    expectCollapsed();
  });

  it('follows the viewport while the user has not chosen', () => {
    const viewport = installViewport(1440);
    renderHome();
    expectDocked();
    act(() => viewport.resize(1200));
    expectCollapsed();
    act(() => viewport.resize(1366));
    expectDocked();
    expect(railWrites).toEqual([]);
  });

  it('does not write a preference on mount', () => {
    installViewport(1440);
    renderHome();
    cleanup();
    installViewport(1024);
    renderHome();
    expect(railWrites).toEqual([]);
    expect(window.localStorage.getItem(RAIL_OPEN_STORAGE_KEY)).toBeNull();
  });
});

describe('explicit choice', () => {
  it('persists an explicit close at 1440 px, and the close wins on reload', () => {
    installViewport(1440);
    renderHome();
    expectDocked();
    fireEvent.click(screen.getByTestId('entry-rail-collapse'));
    expectCollapsed();
    expect(window.localStorage.getItem(RAIL_OPEN_STORAGE_KEY)).toBe('false');

    cleanup();
    renderHome();
    expectCollapsed();
  });

  it('lets a stored open choice dock the rail above the narrow breakpoint', () => {
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, 'true');
    railWrites = [];
    installViewport(1200);
    renderHome();
    expectDocked();
    expect(railWrites).toEqual([]);
  });
});

describe('docked rail is not a drawer', () => {
  it('stays open across navigation, outside presses and Escape', async () => {
    installViewport(1440);
    renderHome();
    expectDocked();

    fireEvent.click(screen.getByTestId('entry-nav-design-systems'));
    await waitFor(() => {
      expect(screen.getByTestId('entry-view-design-systems').getAttribute('data-active')).toBe('true');
    });
    expectDocked();

    fireEvent.pointerDown(document.querySelector('main') ?? document.body);
    expectDocked();

    fireEvent.keyDown(document, { key: 'Escape' });
    expectDocked();

    expect(railWrites).toEqual([]);
  });
});

describe('narrow presentation (<= 1080 px)', () => {
  it('presents a stored open preference as collapsed and reports it closed to the opener', () => {
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, 'true');
    railWrites = [];
    installViewport(1024);
    const states: boolean[] = [];
    const onState = (event: Event) => {
      states.push((event as CustomEvent<{ open: boolean }>).detail.open);
    };
    window.addEventListener(ENTRY_RAIL_STATE_EVENT, onState);
    try {
      renderHome();
      expectCollapsed();
      expect(states.at(-1)).toBe(false);
    } finally {
      window.removeEventListener(ENTRY_RAIL_STATE_EVENT, onState);
    }
  });

  it('opens a dismissible overlay from the opener without changing the preference', () => {
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, 'true');
    railWrites = [];
    const viewport = installViewport(1024);
    const states: boolean[] = [];
    const onState = (event: Event) => {
      states.push((event as CustomEvent<{ open: boolean }>).detail.open);
    };
    window.addEventListener(ENTRY_RAIL_STATE_EVENT, onState);
    try {
      renderHome();
      act(() => {
        window.dispatchEvent(new CustomEvent(ENTRY_RAIL_TOGGLE_EVENT));
      });
      // The overlay is reachable and the opener mirrors it as open.
      expect(rail().getAttribute('aria-hidden')).toBeNull();
      expect(rail().hasAttribute('inert')).toBe(false);
      expect(rail().classList.contains('is-peek')).toBe(true);
      expect(entry().classList.contains('entry--rail-open')).toBe(false);
      expect(states.at(-1)).toBe(true);

      // Escape dismisses the overlay.
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(rail().getAttribute('aria-hidden')).toBe('true');
      expect(states.at(-1)).toBe(false);

      // Selection dismisses it too.
      act(() => {
        window.dispatchEvent(new CustomEvent(ENTRY_RAIL_TOGGLE_EVENT));
      });
      fireEvent.click(screen.getByTestId('entry-nav-design-systems'));
      expect(rail().getAttribute('aria-hidden')).toBe('true');

      // None of that touched the stored preference, so widening restores
      // the docked rail.
      expect(railWrites).toEqual([]);
      expect(window.localStorage.getItem(RAIL_OPEN_STORAGE_KEY)).toBe('true');
      act(() => viewport.resize(1440));
      expectDocked();
      expect(states.at(-1)).toBe(true);
    } finally {
      window.removeEventListener(ENTRY_RAIL_STATE_EVENT, onState);
    }
  });
});
