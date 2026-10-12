// @vitest-environment jsdom

// Settings -> Packs against a stubbed /api/mish-packs*.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MishPackSummary } from '@mish/contracts';

import { MishPacksSection } from '../../src/components/MishPacksSection';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';

const PACK: MishPackSummary = {
  id: 'team-kit',
  name: 'Team kit',
  version: '1.2.0',
  description: 'Everything for the team',
  origin: 'installed',
  provides: [
    { resource: 'cultCatalog', items: null },
    { resource: 'skills', items: 4 },
  ],
  envKeys: ['MISH_AMR_CONSOLE_URL'],
  mcpServerIds: ['refero', 'shadcn'],
  requiredEnv: [{ name: 'CULT_PRO_TOKEN', set: false }],
  installedAt: '2026-10-12T00:00:00.000Z',
  warnings: ['skills/pack-skill-a already exists and was left as it is'],
};

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function stubFetch(options: { packs?: MishPackSummary[]; installError?: string; keptProjects?: string[] } = {}) {
  let packs = options.packs ?? [];
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null;
    calls.push({ method, url, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/mish-packs' && method === 'GET') return json({ packs, installDir: '/x', externalDir: null });
    if (url === '/api/mish-packs/runtime') return json({ styleCatalogPath: null, styleCatalogOrigin: null });
    if (url === '/api/mish-packs/install' && method === 'POST') {
      if (options.installError) return json({ error: { code: options.installError, message: 'server text with /private/path' } }, 400);
      packs = [PACK];
      return json({ pack: PACK, replaced: false });
    }
    if (url.startsWith('/api/mish-packs/') && method === 'DELETE') {
      packs = [];
      return json({ removed: 'team-kit', ...(options.keptProjects ? { keptProjects: options.keptProjects } : {}) });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
  return { calls };
}

function renderSection() {
  return render(
    <I18nProvider initial="en">
      <MishPacksSection />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MishPacksSection', () => {
  it('shows the empty state', async () => {
    stubFetch();
    renderSection();
    expect(await screen.findByTestId('mish-packs-empty')).toHaveTextContent(en['packs.empty']);
  });

  it('installs from a path, lists what the pack provides, and warns about unset variables', async () => {
    const { calls } = stubFetch();
    renderSection();
    await screen.findByTestId('mish-packs-empty');
    fireEvent.change(screen.getByLabelText(en['packs.pathLabel']), { target: { value: '/tmp/team-packet.zip' } });
    fireEvent.click(screen.getByRole('button', { name: en['packs.install'] }));

    const row = await screen.findByTestId('mish-pack-team-kit');
    expect(row).toHaveTextContent('Version 1.2.0');
    expect(row).toHaveTextContent('Provides: Cult catalogue · Skills (4)');
    expect(row).toHaveTextContent('MCP servers: refero, shadcn');
    expect(row).toHaveTextContent('Set CULT_PRO_TOKEN in your environment');
    expect(row).toHaveTextContent('skills/pack-skill-a already exists');
    expect(screen.getByTestId('mish-packs-install-status')).toHaveTextContent('Team kit 1.2.0 is installed.');
    expect(calls.find((call) => call.url === '/api/mish-packs/install')?.body).toEqual({ source: '/tmp/team-packet.zip' });
  });

  it('uploads a picked .zip with the custom header', async () => {
    const { calls } = stubFetch();
    renderSection();
    await screen.findByTestId('mish-packs-empty');
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'packet.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByTestId('mish-packs-file'), { target: { files: [file] } });
    await screen.findByTestId('mish-pack-team-kit');
    const upload = calls.find((call) => call.url === '/api/mish-packs/install');
    expect(upload?.headers['x-od-pack-upload']).toBe('1');
    expect(upload?.body).toBeInstanceOf(FormData);
  });

  it('renders its own message for an error code, never the daemon text', async () => {
    stubFetch({ installError: 'INVALID_MANIFEST' });
    renderSection();
    await screen.findByTestId('mish-packs-empty');
    fireEvent.change(screen.getByLabelText(en['packs.pathLabel']), { target: { value: '/tmp/x' } });
    fireEvent.click(screen.getByRole('button', { name: en['packs.install'] }));
    await waitFor(() => expect(screen.getByTestId('mish-packs-install-status')).toHaveTextContent(en['packs.error.INVALID_MANIFEST']));
    expect(document.body.textContent).not.toContain('/private/path');
  });

  it('asks before removing, then removes', async () => {
    const { calls } = stubFetch({ packs: [PACK] });
    renderSection();
    const row = await screen.findByTestId('mish-pack-team-kit');
    fireEvent.click(row.querySelector('button')!);
    const dialog = await screen.findByTestId('mish-packs-remove-dialog');
    expect(dialog).toHaveTextContent('Remove Team kit?');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: en['packs.removeConfirmAction'] }));
    await screen.findByTestId('mish-packs-empty');
    expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/mish-packs/team-kit')).toBe(true);
  });

  it('says the saved projects a removed pack added stay', async () => {
    stubFetch({ packs: [PACK], keptProjects: ['ds-one', 'proj-two', 'proj-three'] });
    renderSection();
    const row = await screen.findByTestId('mish-pack-team-kit');
    fireEvent.click(row.querySelector('button')!);
    await screen.findByTestId('mish-packs-remove-dialog');
    fireEvent.click(screen.getByRole('button', { name: en['packs.removeConfirmAction'] }));
    await waitFor(() => expect(document.body.textContent).toContain('Team kit is removed. The 3 saved projects it added stay in your project list.'));
  });

  it('does not offer Remove for a pack that comes from MISH_PACKS_DIR', async () => {
    stubFetch({ packs: [{ ...PACK, origin: 'external' }] });
    renderSection();
    const row = await screen.findByTestId('mish-pack-team-kit');
    expect(row).toHaveTextContent(en['packs.originExternal']);
    expect(row.querySelector('button')).toBeNull();
  });
});
