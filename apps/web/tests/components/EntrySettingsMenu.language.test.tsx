// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntrySettingsMenu } from '../../src/components/EntrySettingsMenu';
import { I18nProvider } from '../../src/i18n';
import type { AppConfig } from '../../src/types';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
    theme: 'system',
    ...overrides,
  } as AppConfig;
}

function renderMenu() {
  return render(
    <I18nProvider initial="en">
      <EntrySettingsMenu
        config={baseConfig()}
        onOpenSettings={vi.fn()}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('EntrySettingsMenu language picker a11y', () => {
  it('renders no language picker while the app ships a single locale (D23)', () => {
    const { container } = renderMenu();
    fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));

    // English only: the picker only renders when more than one locale exists.
    expect(screen.getByTestId('entry-settings-menu')).toBeTruthy();
    expect(container.querySelector('.entry-settings-menu__select-trigger')).toBeNull();
    expect(container.querySelector('[role="menuitemradio"]')).toBeNull();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('keeps upstream community destinations out of the rendered menu', () => {
    const { container } = renderMenu();
    fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));

    const hrefs = Array.from(container.querySelectorAll('a')).map((link) => link.href);
    expect(hrefs).not.toContain('https://github.com/nexu-io/open-design');
    expect(hrefs).not.toContain('https://x.com/OpenDesignHQ');
    expect(container.textContent).not.toContain('OpenDesign');
    expect(container.textContent).not.toContain('Open Design');
    // Upstream sales/pricing surfaces (the Go-plan pricing page, the
    // "Workspace for Teams" enterprise landing page) must never appear as a
    // rendered link — only AMR-bound destinations stay reachable from here.
    expect(hrefs.some((href) => href.includes('/pricing'))).toBe(false);
    expect(hrefs.some((href) => href.includes('/enterprise'))).toBe(false);
  });

  it('still dismisses the menu on an outside press when upstream links are disabled', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('entry-settings-menu-trigger'));
    expect(screen.getByTestId('entry-settings-menu')).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId('entry-settings-menu')).toBeNull();
  });
});
