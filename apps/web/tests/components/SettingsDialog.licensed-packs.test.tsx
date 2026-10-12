// @vitest-environment jsdom

// P1-2 spec 5: Settings → Licensed packs is reachable from the sidebar and by
// deep link (`openSettings('licensedPacks')`, used by P1-6's first-run hint).
//

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsDialog } from '../../src/components/SettingsDialog';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { AgentInfo } from '../../src/types';

const AGENTS: AgentInfo[] = [{ id: 'codex', name: 'Codex', bin: 'codex', available: true }];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/packs') return json({ packs: [] });
      if (url === '/api/packs/github-access') return json({ configured: false, source: 'none' });
      return new Response('{}', { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsDialog → Licensed packs (P1-2 spec 5)', () => {
  it("the sidebar shows a Licensed packs item and initialSection='licensedPacks' renders the section", async () => {
    stubFetch();
    const { container } = render(
      <SettingsDialog
        initial={DEFAULT_CONFIG}
        agents={AGENTS}
        daemonLive
        appVersionInfo={null}
        initialSection="licensedPacks"
        onPersist={vi.fn()}
        onPersistComposioKey={vi.fn()}
        onClose={vi.fn()}
        onRefreshAgents={vi.fn()}
      />,
    );
    const navItems = [...container.querySelectorAll<HTMLElement>('.settings-nav-item')];
    const item = navItems.find((element) => within(element).queryByText('Licensed packs'));
    expect(item, 'a settings-nav-item labelled Licensed packs').toBeTruthy();
    expect(item!.className).toContain('active');
    expect(await screen.findByTestId('licensed-packs-section')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Component ledger' })).toBeInTheDocument();
  });
});
