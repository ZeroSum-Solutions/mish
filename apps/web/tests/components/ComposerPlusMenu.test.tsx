// @vitest-environment jsdom

// Regression coverage for the shared composer "+" menu (replaces the deleted
// ChatComposer.tools-menu-caret.test.tsx, #3195): the connector / plugin / MCP
// pick rows must cancel `mousedown` so the editor keeps focus and the caller's
// insertMention lands at the caret instead of the draft end.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { ComposerPlusMenu } from '../../src/components/ComposerPlusMenu';
import { I18nProvider } from '../../src/i18n';
import type { Locale } from '../../src/i18n/types';
import type { ReusableUnitManifest, UnitInsertReceipt, ResourceSearchResponse, WorkbenchPreferencesSnapshot } from '@open-design/contracts';
import { getWorkbenchPreferences, getProjectDesignContext, putWorkbenchPreferences, searchWorkbenchResources } from '../../src/providers/workbench';
import { captureApi, unitApi, CaptureRequestError } from '../../src/providers/workbench-capture';
import * as registry from '../../src/providers/registry';

vi.mock('../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../src/providers/workbench')>(),
  getWorkbenchPreferences: vi.fn(), getProjectDesignContext: vi.fn(),
  putWorkbenchPreferences: vi.fn(), searchWorkbenchResources: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(getWorkbenchPreferences).mockReset();
  vi.mocked(getProjectDesignContext).mockReset();
  vi.mocked(putWorkbenchPreferences).mockReset();
  vi.mocked(searchWorkbenchResources).mockReset();
});

const CONNECTOR = { id: 'c1', name: 'Notion', status: 'connected' } as never;
const PLUGIN = { id: 'p1', title: 'Deck Maker', manifest: {} } as never;
const MCP_SERVER = { id: 'm1', label: 'Linear', enabled: true } as never;

function pluginOption(
  id: string,
  title: string,
  options: { kind?: string; mode?: string; hidden?: boolean; sourceKind?: string } = {},
) {
  return {
    id,
    title,
    sourceKind: options.sourceKind ?? 'bundled',
    manifest: {
      name: id,
      version: '1.0.0',
      od: {
        kind: options.kind ?? 'scenario',
        mode: options.mode ?? 'prototype',
        hidden: options.hidden,
      },
    },
  } as never;
}

function renderMenu(
  overrides: Partial<ComponentProps<typeof ComposerPlusMenu>> = {},
  options: { chatBoundary?: Pick<DOMRect, 'left' | 'right'>; boundaryClass?: string } = {},
) {
  const props: ComponentProps<typeof ComposerPlusMenu> = {
    connectors: [CONNECTOR],
    onPickConnector: vi.fn(),
    plugins: [PLUGIN],
    onPickPlugin: vi.fn(),
    mcpServers: [MCP_SERVER],
    onPickMcp: vi.fn(),
    onAttachFiles: vi.fn(),
    triggerTestId: 'plus-trigger',
    ...overrides,
  };
  const view = render(
    <I18nProvider initial={'en' as Locale}>
      <div className={options.chatBoundary ? (options.boundaryClass ?? 'split-chat-slot') : undefined} data-testid="menu-host">
        <ComposerPlusMenu {...props} />
      </div>
    </I18nProvider>,
  );
  if (options.chatBoundary) {
    const host = screen.getByTestId('menu-host');
    host.getBoundingClientRect = () =>
      ({
        x: options.chatBoundary?.left ?? 0,
        y: 0,
        top: 0,
        left: options.chatBoundary?.left ?? 0,
        right: options.chatBoundary?.right ?? 0,
        bottom: 420,
        width: (options.chatBoundary?.right ?? 0) - (options.chatBoundary?.left ?? 0),
        height: 420,
        toJSON: () => ({}),
      }) as DOMRect;
  }
  return { props, ...view };
}

// A pick row cancels mousedown so focus stays on the editor; assert the
// dispatched mousedown event is defaultPrevented.
function expectPickRowPreventsMousedown(name: RegExp) {
  const row = screen.getByRole('menuitem', { name });
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  row.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

describe('ComposerPlusMenu pick-row caret protection', () => {
  it.each(['outside click', 'Escape', 'another submenu'] as const)('retains Resources during preference save and allows %s', async dismissal => {
    vi.useFakeTimers();
    try {
      vi.mocked(getWorkbenchPreferences).mockResolvedValue({ projectId: 'p', revision: 0, preferences: null, effective: { useProjectContext: true } });
      vi.mocked(getProjectDesignContext).mockResolvedValue({ projectId: 'p', revision: 0, context: null });
      let finishSave!: (value: WorkbenchPreferencesSnapshot) => void;
      vi.mocked(putWorkbenchPreferences).mockImplementation(() => new Promise(resolve => { finishSave = resolve; }));
      const savedOff: WorkbenchPreferencesSnapshot = { projectId: 'p', revision: 1,
        preferences: { schema: 'workbench-preferences/1', projectId: 'p', revision: 1, updatedAt: '2026-10-03T16:00:00.000Z', useProjectContext: false },
        effective: { useProjectContext: false } };
      const response: ResourceSearchResponse = { results: [], excluded: [], sourceStatuses: [], context: {
        requested: false, applied: false, reason: 'context-disabled', projectId: 'p', selection: 'saved',
        preferenceRevision: 1, observedContextRevision: 0, rankingVersion: 'local-context/1', resultMode: 'lexical',
      }, contextRevision: null, nextCursor: null, indexDigest: 'digest', degradedReason: null };
      vi.mocked(searchWorkbenchResources).mockResolvedValue(response);
      renderMenu({ projectId: 'p' });
      fireEvent.click(screen.getByTestId('plus-trigger'));
      fireEvent.click(screen.getByTestId('composer-plus-resources'));
      await act(async () => {});
      const panel = screen.getByTestId('workbench-resource-search');
      const query = within(panel).getByRole('textbox', { name: 'Search resources' });
      const toggle = within(panel).getByRole('checkbox', { name: 'Use project context' });
      expect(toggle).toBeEnabled();
      fireEvent.change(query, { target: { value: 'keep this discovery prompt' } });
      toggle.focus();
      expect(document.activeElement).toBe(toggle);
      fireEvent.click(toggle);
      expect(toggle).toBeDisabled();
      expect(putWorkbenchPreferences).toHaveBeenCalledWith('p', { expectedRevision: 0, useProjectContext: false }, null);
      // Native Chromium drops focus when a focused control becomes disabled;
      // jsdom retains it, so reproduce the native focus loss explicitly.
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
      expect(document.activeElement).toBe(document.body);
      fireEvent.mouseLeave(panel.closest('.plus-menu__flyout')!);
      act(() => vi.advanceTimersByTime(201));
      expect(screen.queryByTestId('workbench-resource-search')).toBe(panel);
      expect(query).toHaveValue('keep this discovery prompt');
      await act(async () => { finishSave(savedOff); });
      await act(async () => { vi.advanceTimersByTime(201); });
      expect(screen.getByTestId('workbench-resource-search')).toBe(panel);
      expect(query).toHaveValue('keep this discovery prompt');
      expect(toggle).toBeEnabled(); expect(toggle).not.toBeChecked();
      expect(panel.querySelector('[data-context-reason]')).toHaveAttribute('data-context-reason', 'context-disabled');
      if (dismissal === 'outside click') fireEvent.mouseDown(document.body);
      else if (dismissal === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.click(screen.getByTestId('composer-plus-plugins'));
      expect(screen.queryByTestId('workbench-resource-search')).toBeNull();
      expect(screen.getByTestId('plus-trigger')).toHaveAttribute('aria-expanded', dismissal === 'outside click' ? 'false' : 'true');
      if (dismissal === 'another submenu') expect(screen.getByPlaceholderText('Plugins')).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('keeps Plugins open when a pointer enters the parent and then clicks it', () => {
    vi.useFakeTimers();
    try {
      renderMenu();
      fireEvent.click(screen.getByTestId('plus-trigger'));
      const parent = screen.getByTestId('composer-plus-plugins');
      fireEvent.mouseEnter(parent.closest('.plus-menu__submenu-row')!);
      fireEvent.click(parent);
      act(() => vi.advanceTimersByTime(400));
      expect(screen.queryByPlaceholderText('Plugins')).not.toBeNull();
      expect(parent.getAttribute('aria-expanded')).toBe('true');
    } finally { vi.useRealTimers(); }
  });

  it('gives every selectable plugin a thumbnail alongside its complete title', () => {
    const plugins = Array.from({ length: 52 }, (_, index) =>
      pluginOption(`visible-${index}`, `Plugin ${index} with a complete descriptive title`),
    );
    renderMenu({ plugins });
    fireEvent.click(screen.getByTestId('plus-trigger'));
    fireEvent.click(screen.getByTestId('composer-plus-plugins'));
    expect(screen.queryAllByTestId('composer-plugin-thumbnail')).toHaveLength(52);
    for (let index = 0; index < 52; index++) {
      const row = screen.getByRole('menuitem', { name: `Plugin ${index} with a complete descriptive title` });
      expect(row.querySelector('[data-testid="composer-plugin-thumbnail"]')?.getAttribute('data-plugin-id')).toBe(`visible-${index}`);
    }
  });

  it('shows user-facing plugins without exposing bundled workflow internals', () => {
    renderMenu({
      plugins: [
        pluginOption('example-web-clone', 'Website Clone'),
        pluginOption('od-web-effect-extractor', 'Web effect extractor'),
        pluginOption('od-plugin-authoring', 'Plugin authoring'),
        pluginOption('od-figma-migration', 'Figma migration'),
        pluginOption('team-brand-audit', 'Team Brand Audit', { sourceKind: 'github' }),
        pluginOption('od-media-generation', 'Media generation'),
        pluginOption('od-new-generation', 'New generation'),
        pluginOption('od-code-migration', 'Code migration'),
        pluginOption('od-tune-collab', 'Tune collaboration'),
        pluginOption('neutral-product', 'Neutral Product', { mode: 'design-system' }),
        pluginOption('code-import', 'Code import', { kind: 'atom' }),
        pluginOption('hidden-strategy', 'Hidden Strategy', { hidden: true }),
      ],
    });

    fireEvent.click(screen.getByTestId('plus-trigger'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Plugins/i }));

    expect(screen.getByRole('menuitem', { name: 'Website Clone' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Web effect extractor' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Plugin authoring' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Figma migration' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Team Brand Audit' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Media generation' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'New generation' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Code migration' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Tune collaboration' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Neutral Product' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Code import' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Hidden Strategy' })).toBeNull();
  });

  it('cancels mousedown on the connector / plugin / MCP pick rows', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('plus-trigger'));

    fireEvent.click(screen.getByRole('menuitem', { name: /Connectors/i }));
    expectPickRowPreventsMousedown(/Notion/i);

    fireEvent.click(screen.getByRole('menuitem', { name: /Plugins/i }));
    expectPickRowPreventsMousedown(/Deck Maker/i);

    fireEvent.click(screen.getByRole('menuitem', { name: /^MCP/i }));
    expectPickRowPreventsMousedown(/Linear/i);
  });

  it('keeps the plugin flyout open when filtering reflows fire a mouseleave mid-search', () => {
    vi.useFakeTimers();
    try {
      renderMenu({
        plugins: [
          PLUGIN,
          { id: 'p2', title: 'Slide Builder', manifest: {} } as never,
        ],
      });
      fireEvent.click(screen.getByTestId('plus-trigger'));
      fireEvent.click(screen.getByRole('menuitem', { name: /Plugins/i }));

      // The user clicks into the search box (focus enters the flyout) and types,
      // pruning the list. In a real browser the shrinking list reflows rows out
      // from under the stationary cursor, so Chromium synthesizes a `mouseleave`
      // on the flyout even though the pointer never moved.
      const search = screen.getByPlaceholderText('Plugins') as HTMLInputElement;
      search.focus();
      fireEvent.change(search, { target: { value: 'deck' } });
      const flyout = document.querySelector('.plus-menu__flyout') as HTMLElement;
      fireEvent.mouseLeave(flyout);

      // The hover-close grace period elapses; the panel must survive because the
      // search box still owns focus — yanking it away would make the plugin
      // impossible to pick.
      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(screen.queryByPlaceholderText('Plugins')).not.toBeNull();
      expect(screen.getByRole('menuitem', { name: /Deck Maker/i })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the shared search query when switching submenus', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('plus-trigger'));

    fireEvent.click(screen.getByRole('menuitem', { name: /Plugins/i }));
    const pluginSearch = screen.getByPlaceholderText('Plugins') as HTMLInputElement;
    fireEvent.change(pluginSearch, { target: { value: 'deck' } });
    expect(pluginSearch.value).toBe('deck');

    // Moving to the MCP submenu must clear the query so it doesn't cross-filter.
    fireEvent.click(screen.getByRole('menuitem', { name: /^MCP/i }));
    const mcpSearch = screen.getByPlaceholderText('MCP') as HTMLInputElement;
    expect(mcpSearch.value).toBe('');
    expect(screen.getByText('Linear')).toBeTruthy();
  });

  it('portals the menu and constrains it to the available viewport height', async () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 420 });

    try {
      renderMenu();
      const trigger = screen.getByTestId('plus-trigger') as HTMLButtonElement;
      trigger.getBoundingClientRect = () =>
        ({
          x: 8,
          y: 376,
          top: 376,
          left: 8,
          right: 36,
          bottom: 404,
          width: 28,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(trigger);

      const menu = screen.getByRole('menu');
      expect(menu.parentElement).toBe(document.body);
      expect(menu.style.left).toBe('12px');
      expect(menu.style.width).toBe('190px');
      expect(menu.style.maxHeight).toBe('356px');
      expect(menu.style.top).toBe('auto');
      expect(menu.style.bottom).toBe('52px');
      expect(screen.getByRole('menuitem', { name: /Connectors/i })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: /Plugins/i })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: /^MCP/i })).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });

  it('can open downward for the home surface even when there is enough room above', () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });

    try {
      renderMenu({ placementPreference: 'down' });
      const trigger = screen.getByTestId('plus-trigger') as HTMLButtonElement;
      trigger.getBoundingClientRect = () =>
        ({
          x: 280,
          y: 320,
          top: 320,
          left: 280,
          right: 312,
          bottom: 352,
          width: 32,
          height: 32,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(trigger);

      const menu = screen.getByRole('menu');
      expect(menu.style.top).toBe('360px');
      expect(menu.style.bottom).toBe('auto');
      expect(menu.style.width).toBe('190px');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });

  it('opens flyouts to the left when the right edge would overflow', () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 420 });

    try {
      renderMenu();
      const trigger = screen.getByTestId('plus-trigger') as HTMLButtonElement;
      trigger.getBoundingClientRect = () =>
        ({
          x: 620,
          y: 376,
          top: 376,
          left: 620,
          right: 648,
          bottom: 404,
          width: 28,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(trigger);
      const menu = screen.getByRole('menu');
      expect(menu.className).toContain('plus-menu__popup--flyout-left');

      fireEvent.click(screen.getByRole('menuitem', { name: /Plugins/i }));
      expect(screen.getByRole('menuitem', { name: /Deck Maker/i })).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });

  it('contains flyouts inside the menu when neither side has enough room', () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 420 });

    try {
      renderMenu();
      const trigger = screen.getByTestId('plus-trigger') as HTMLButtonElement;
      trigger.getBoundingClientRect = () =>
        ({
          x: 220,
          y: 376,
          top: 376,
          left: 220,
          right: 248,
          bottom: 404,
          width: 28,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(trigger);
      const menu = screen.getByRole('menu');
      expect(menu.className).toContain('plus-menu__popup--flyout-contained');

      fireEvent.click(screen.getByRole('menuitem', { name: /Plugins/i }));
      expect(screen.getByRole('menuitem', { name: /Deck Maker/i })).toBeTruthy();
      expect(menu.style.width).toBe('336px');
      expect(menu.style.left).toBe('12px');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });

  it.each(['split-chat-slot', 'chat-composer-fixed-layer'])('opens flyouts beside the menu beyond the %s boundary', (boundaryClass) => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });

    try {
      renderMenu({}, { chatBoundary: { left: 0, right: 460 }, boundaryClass });
      const trigger = screen.getByTestId('plus-trigger') as HTMLButtonElement;
      trigger.getBoundingClientRect = () =>
        ({
          x: 24,
          y: 576,
          top: 576,
          left: 24,
          right: 52,
          bottom: 604,
          width: 28,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(trigger);
      const menu = screen.getByRole('menu');
      expect(menu.className).toContain('plus-menu__popup--flyout-right');

      fireEvent.click(screen.getByRole('menuitem', { name: /Plugins/i }));
      expect(screen.getByRole('menuitem', { name: /Deck Maker/i })).toBeTruthy();
      expect(menu.style.width).toBe('190px');
      expect(menu.style.left).toBe('24px');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });

  it('limits flyout height to the visible viewport below the hovered row', () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 520 });

    try {
      renderMenu();
      const trigger = screen.getByTestId('plus-trigger') as HTMLButtonElement;
      trigger.getBoundingClientRect = () =>
        ({
          x: 24,
          y: 468,
          top: 468,
          left: 24,
          right: 52,
          bottom: 496,
          width: 28,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(trigger);
      const pluginParent = screen.getByRole('menuitem', { name: /Plugins/i });
      const pluginRow = pluginParent.closest('.plus-menu__submenu-row') as HTMLDivElement;
      pluginRow.getBoundingClientRect = () =>
        ({
          x: 24,
          y: 210,
          top: 210,
          left: 24,
          right: 214,
          bottom: 242,
          width: 190,
          height: 32,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(pluginParent);

      const menu = screen.getAllByRole('menu')[0];
      expect(menu).toBeDefined();
      expect(menu?.className).toContain('plus-menu__popup--flyout-y-down');
      expect(menu?.style.getPropertyValue('--plus-menu-flyout-max-height')).toBe('303px');
      expect(screen.getByRole('menuitem', { name: /Deck Maker/i })).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });

  it('opens low flyouts upward when the hovered row is near the viewport bottom', () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 520 });

    try {
      renderMenu({
        toolboxLabel: 'Design toolbox',
        renderToolbox: () => <div>Toolbox content</div>,
      });
      const trigger = screen.getByTestId('plus-trigger') as HTMLButtonElement;
      trigger.getBoundingClientRect = () =>
        ({
          x: 24,
          y: 468,
          top: 468,
          left: 24,
          right: 52,
          bottom: 496,
          width: 28,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(trigger);
      const toolboxParent = screen.getByRole('menuitem', { name: /Design toolbox/i });
      const toolboxRow = toolboxParent.closest('.plus-menu__submenu-row') as HTMLDivElement;
      toolboxRow.getBoundingClientRect = () =>
        ({
          x: 24,
          y: 330,
          top: 330,
          left: 24,
          right: 214,
          bottom: 362,
          width: 190,
          height: 32,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(toolboxParent);

      const menu = screen.getAllByRole('menu')[0];
      expect(menu).toBeDefined();
      expect(menu?.className).toContain('plus-menu__popup--flyout-y-up');
      expect(menu?.style.getPropertyValue('--plus-menu-flyout-max-height')).toBe('320px');
      expect(screen.getByText('Toolbox content')).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });

  // Acceptance #50, part 2: hovering a submenu row must open its flyout right
  // next to that row. Writing viewport coordinates into the flyout's inline
  // style is the bug — the stylesheet positions it `position: absolute;
  // left: 100%` inside the row, so a viewport-space `left` is re-anchored to
  // the row's own left edge and throws the panel across the screen.
  it('leaves submenu flyout placement to the stylesheet instead of viewport-space inline coords', () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

    try {
      renderMenu({ placementPreference: 'down', onAddMcp: vi.fn() });
      const trigger = screen.getByTestId('plus-trigger') as HTMLButtonElement;
      trigger.getBoundingClientRect = () =>
        ({
          x: 369,
          y: 548,
          top: 548,
          left: 369,
          right: 405,
          bottom: 584,
          width: 36,
          height: 36,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(trigger);

      const mcpParent = screen.getByRole('menuitem', { name: /^MCP/i });
      const mcpRow = mcpParent.closest('.plus-menu__submenu-row') as HTMLDivElement;
      mcpRow.getBoundingClientRect = () =>
        ({
          x: 375,
          y: 800,
          top: 800,
          left: 375,
          right: 571,
          bottom: 828,
          width: 196,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(mcpParent);

      const menu = screen.getAllByRole('menu')[0];
      expect(menu?.className).toContain('plus-menu__popup--flyout-right');

      const flyout = document.querySelector<HTMLElement>('.plus-menu__flyout');
      expect(flyout).not.toBeNull();
      // No inline geometry at all: side, offset and width all come from
      // plus-menu.css, which anchors the flyout to its parent row.
      expect(flyout?.style.left).toBe('');
      expect(flyout?.style.right).toBe('');
      expect(flyout?.style.top).toBe('');
      expect(flyout?.style.bottom).toBe('');
      expect(flyout?.style.width).toBe('');

      const css = readFileSync(join(process.cwd(), 'src/styles/home/plus-menu.css'), 'utf8');
      expect(css).toContain('.plus-menu__submenu-row {\n  position: relative;\n}');
      expect(css).toContain('.plus-menu__flyout {\n  position: absolute;\n  left: 100%;');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });

  // Acceptance #50, part 1: the popup uses `overflow: visible` so its side
  // flyouts can escape, which means a stack taller than the room under the
  // trigger spills off the viewport with no way to scroll it back. The
  // surface's `down` preference must therefore yield to the measured height.
  it('flips a down-preferred menu upward when the measured stack cannot fit below', () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollHeight',
    );
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    // jsdom never lays out, so stand in for a real 9-row stack.
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return (this as Element).classList.contains('plus-menu__popup') ? 418 : 0;
      },
    });

    try {
      renderMenu({ placementPreference: 'down' });
      const trigger = screen.getByTestId('plus-trigger') as HTMLButtonElement;
      // The real 1440x900 home composer: 296px below, 528px above.
      trigger.getBoundingClientRect = () =>
        ({
          x: 369,
          y: 548,
          top: 548,
          left: 369,
          right: 405,
          bottom: 584,
          width: 36,
          height: 36,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(trigger);

      const menu = screen.getAllByRole('menu')[0] as HTMLElement;
      expect(menu.style.top).toBe('auto');
      expect(menu.style.bottom).toBe('360px');
      // 528px of headroom — the whole stack is reachable without scrolling.
      expect(menu.style.maxHeight).toBe('528px');
    } finally {
      if (scrollHeightDescriptor) {
        Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeightDescriptor);
      }
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });

  it('keeps contained design toolbox flyouts within the popup width', () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 420 });

    try {
      renderMenu({
        toolboxLabel: 'Design toolbox',
        renderToolbox: () => (
          <div className="composer-design-toolbox-menu">Contained toolbox</div>
        ),
      });
      const trigger = screen.getByTestId('plus-trigger') as HTMLButtonElement;
      trigger.getBoundingClientRect = () =>
        ({
          x: 220,
          y: 376,
          top: 376,
          left: 220,
          right: 248,
          bottom: 404,
          width: 28,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect;

      fireEvent.click(trigger);
      const menu = screen.getByRole('menu');
      expect(menu.className).toContain('plus-menu__popup--flyout-contained');

      fireEvent.click(screen.getByRole('menuitem', { name: /Design toolbox/i }));
      expect(screen.getByText('Contained toolbox')).toBeTruthy();

      const css = readFileSync(join(process.cwd(), 'src/styles/home/plus-menu.css'), 'utf8');
      expect(css).toContain('.plus-menu__popup--flyout-contained .plus-menu__flyout .composer-design-toolbox-menu');
      expect(css).toContain('width: 100%;');
      expect(css).toContain('max-width: 100%;');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });
});

// Usability guard (user request): every module offered by the "+" menu must be
// wired to a working handler, not just rendered. These tests open the menu and
// click each row — direct items and every submenu's pick + "Add …" row — and
// assert the corresponding callback fires. A row that renders but no longer
// calls its handler (a refactor dropping the onClick, a mis-wired prop) turns
// this red.
describe('ComposerPlusMenu module wiring', () => {
  function openMenu() {
    fireEvent.click(screen.getByTestId('plus-trigger'));
  }

  it('invokes each direct row handler', () => {
    const { props } = renderMenu({
      onReferenceProject: vi.fn(),
      onLinkLocalCode: vi.fn(),
      onImportFigma: vi.fn(),
      onShowFigmaHelp: vi.fn(),
    });

    // Each row closes the menu, so re-open before clicking the next one.
    const clickRow = (testId: string) => {
      openMenu();
      fireEvent.click(screen.getByTestId(testId));
    };

    clickRow('composer-plus-attach');
    expect(props.onAttachFiles).toHaveBeenCalledTimes(1);

    clickRow('composer-plus-reference-project');
    expect(props.onReferenceProject).toHaveBeenCalledTimes(1);

    clickRow('composer-plus-local-code');
    expect(props.onLinkLocalCode).toHaveBeenCalledTimes(1);

    clickRow('composer-plus-figma');
    expect(props.onImportFigma).toHaveBeenCalledTimes(1);
  });

  // The "+" menu lists things to ATTACH to the message. 「查看方法」 (the .fig
  // download guide) was a help article wedged into that list, so it is gone —
  // even when a caller still passes the handler, which both composers do.
  it('does not offer the Figma help article as a row', () => {
    renderMenu({
      onImportFigma: vi.fn(),
      onShowFigmaHelp: vi.fn(),
    });
    openMenu();

    expect(screen.queryByTestId('composer-plus-figma-help')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Learn how/i })).toBeNull();
    // The import row it sat beside is untouched.
    expect(screen.getByTestId('composer-plus-figma')).toBeTruthy();
  });

  // Skills and design systems are deliberately NOT "+" menu rows: skills are
  // picked through the composer's `@` mention popover and the design system
  // through the picker already sitting in the same composer footer. Both used
  // to be duplicated here, which pushed the stack past the viewport (#50).
  it('does not duplicate the skills or design-system surfaces as rows', () => {
    renderMenu({
      skills: [{ id: 's1', name: 'Wireframe Kit', description: 'Skill fixture.' } as never],
      onPickSkill: vi.fn(),
      onOpenDesignSystems: vi.fn(),
    });
    openMenu();
    expect(screen.queryByTestId('composer-plus-skills')).toBeNull();
    expect(screen.queryByTestId('composer-plus-design-system')).toBeNull();
  });

  it('invokes every submenu pick and "Add …" row handler', () => {
    const { props } = renderMenu({
      onAddConnector: vi.fn(),
      onAddPlugin: vi.fn(),
      onAddMcp: vi.fn(),
    });

    // A submenu flyout opens on click and stays open until a pick/add row
    // closes the whole menu, so re-open the menu + submenu for each row.
    const openSubmenu = (rowName: RegExp) => {
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: rowName }));
    };

    openSubmenu(/Connectors/i);
    fireEvent.click(screen.getByRole('menuitem', { name: /Notion/i }));
    expect(props.onPickConnector).toHaveBeenCalledWith(CONNECTOR);
    openSubmenu(/Connectors/i);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add connectors' }));
    expect(props.onAddConnector).toHaveBeenCalledTimes(1);

    openSubmenu(/Plugins/i);
    fireEvent.click(screen.getByRole('menuitem', { name: /Deck Maker/i }));
    expect(props.onPickPlugin).toHaveBeenCalledWith(PLUGIN);
    openSubmenu(/Plugins/i);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add plugin' }));
    expect(props.onAddPlugin).toHaveBeenCalledTimes(1);

    openSubmenu(/^MCP/i);
    fireEvent.click(screen.getByRole('menuitem', { name: /Linear/i }));
    expect(props.onPickMcp).toHaveBeenCalledWith(MCP_SERVER);
    openSubmenu(/^MCP/i);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add MCP server' }));
    expect(props.onAddMcp).toHaveBeenCalledTimes(1);
  });

  it('renders the Design toolbox submenu when a toolbox renderer is provided', () => {
    renderMenu({ renderToolbox: () => <div>Toolbox contents</div> });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Design toolbox/i }));
    expect(screen.getByText('Toolbox contents')).toBeTruthy();
  });
});

it('omits the responsive palette action while the toolbar palette is visible', () => {
  renderMenu({ responsiveToolbar: true, onOpenDesignSystems: vi.fn() });
  fireEvent.click(screen.getByTestId('plus-trigger'));
  expect(screen.queryByTestId('composer-plus-design-system')).toBeNull();
});

it('responsive overflow reaches the existing palette action when the container query collapses it', () => {
  // jsdom cannot evaluate container queries; model their computed signal.
  const getStyle = window.getComputedStyle.bind(window);
  const style = vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const computed = getStyle(element);
    return new Proxy(computed, {
      get(target, property) {
        if (property === 'getPropertyValue') return (name: string) => name === '--composer-palette-collapsed' ? '1' : target.getPropertyValue(name);
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  const onOpenDesignSystems = vi.fn();
  try {
    renderMenu({ responsiveToolbar: true, onOpenDesignSystems });
    fireEvent.click(screen.getByTestId('plus-trigger'));
    fireEvent.click(screen.getByTestId('composer-plus-design-system'));
    expect(onOpenDesignSystems).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  } finally { style.mockRestore(); }
});

it('responsive menu keys leave editable controls alone', () => {
  // jsdom has no layout; give menu items a visible rect so an overly broad
  // arrow-key handler would actually move focus and fail this regression.
  const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 32)] as unknown as DOMRectList);
  renderMenu({ responsiveToolbar: true });
  fireEvent.click(screen.getByTestId('plus-trigger'));
  const input = document.createElement('input');
  input.setAttribute('aria-label', 'Search draft');
  document.body.append(input);
  input.focus();
  try {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(input);
    }
  } finally {
    input.remove();
    rects.mockRestore();
  }
});

// Regression for QA HOLD #273: clicking "Back up edits and undo" in the
// Captures > Units unit-insert confirm dialog closed the whole "+" menu and
// sent no undo request. The confirm dialog is portaled to document.body via
// createPortal (WorkbenchUnitInsert.tsx), so it sits outside both the menu
// root and the popup the document `mousedown` listener (ComposerPlusMenu.tsx,
// `onPointer`) checks; mousedown fires before click and unmounted the dialog
// out from under the pending click.
describe('ComposerPlusMenu captures submenu — unit-insert undo confirmation', () => {
  const unit = {
    unitId: 'unit_AAAAAAAAAAAAAAAAAAAA',
    name: 'Demo unit',
    kind: 'section',
    createdAt: '2026-01-01T00:00:00.000Z',
    provenance: { projectId: 'a' },
    dependencies: [],
    rights: { status: 'redistributable' },
    thumbnail: { source: 'unavailable', reason: 'test fixture' },
  } as unknown as ReusableUnitManifest;
  const receipt = {
    insertId: 'insert_AAAAAAAAAAAAAAAAAAAA',
    status: 'inserted',
    projectId: 'b',
    directory: 'unit-insert-AAAAAAAAAAAAAAAAAAAA',
    entryPath: 'unit-insert-AAAAAAAAAAAAAAAAAAAA/index.html',
    files: [{ path: 'unit-insert-AAAAAAAAAAAAAAAAAAAA/index.html' }],
    dependenciesInstalled: false,
    actionVerification: 'not-run',
  } as unknown as UnitInsertReceipt;

  afterEach(() => { vi.restoreAllMocks(); });

  it('lets the confirm button receive its own click instead of being dismissed as an outside click', async () => {
    vi.spyOn(registry, 'fetchProjectFiles').mockResolvedValue([]);
    vi.spyOn(captureApi, 'list').mockResolvedValue({ captures: [], nextCursor: null } as never);
    vi.spyOn(unitApi, 'list').mockResolvedValue([unit]);
    vi.spyOn(unitApi, 'listInsertions').mockResolvedValue([receipt]);
    const undo = vi.spyOn(unitApi, 'undoInsert')
      .mockRejectedValueOnce(new CaptureRequestError(409, 'insert-conflict', 'Changed files', [receipt.entryPath], null, true))
      .mockResolvedValueOnce({ ...receipt, status: 'undone', recoveryPath: `.od-undo/${receipt.insertId}` });

    renderMenu({ projectId: 'b' });
    fireEvent.click(screen.getByTestId('plus-trigger'));
    fireEvent.click(screen.getByTestId('composer-plus-captures'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Units' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Undo insertion' }));
    const confirmButton = await screen.findByRole('button', { name: 'Back up edits and undo' });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.contains(confirmButton)).toBe(true);

    // Reproduce the real DOM event order a mouse click produces: `mousedown`
    // fires (and reaches the document listener) before `click`.
    fireEvent.mouseDown(confirmButton);
    // The dialog, and the rest of the flyout, must still be mounted — the bug
    // unmounted both on this mousedown, before the click handler ever ran.
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(screen.getByTestId('composer-plus-captures')).toBeTruthy();

    fireEvent.click(confirmButton);
    await waitFor(() => expect(undo).toHaveBeenCalledTimes(2));
    expect(undo).toHaveBeenLastCalledWith(receipt.insertId, null, { discardEdits: true });
    await screen.findByText(`Edited files were backed up to .od-undo/${receipt.insertId}.`);
    // The flyout stays open and consistent afterward — the bug fully closed it.
    expect(screen.getByTestId('composer-plus-captures')).toBeTruthy();
  });

  it('still closes on a real outside mousedown, including inside an unrelated alertdialog', async () => {
    vi.spyOn(registry, 'fetchProjectFiles').mockResolvedValue([]);
    vi.spyOn(captureApi, 'list').mockResolvedValue({ captures: [], nextCursor: null } as never);
    vi.spyOn(unitApi, 'list').mockResolvedValue([unit]);
    vi.spyOn(unitApi, 'listInsertions').mockResolvedValue([receipt]);

    renderMenu({ projectId: 'b' });
    fireEvent.click(screen.getByTestId('plus-trigger'));
    expect(screen.getByTestId('composer-plus-captures')).toBeTruthy();
    // A foreign alertdialog (not this menu's unit-insert confirmation) is outside the menu.
    const foreign = document.createElement('div');
    foreign.setAttribute('role', 'alertdialog');
    document.body.appendChild(foreign);
    try {
      fireEvent.mouseDown(foreign);
      await waitFor(() => expect(screen.queryByTestId('composer-plus-captures')).toBeNull());
    } finally {
      foreign.remove();
    }

    fireEvent.click(screen.getByTestId('plus-trigger'));
    expect(screen.getByTestId('composer-plus-captures')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByTestId('composer-plus-captures')).toBeNull());
  });
});
