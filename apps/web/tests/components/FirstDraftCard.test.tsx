// @vitest-environment jsdom

// Flagship "client brief → working first draft" (docs/plans/2026-10-09-flagship/plan.md): the
// Design Index Route panel's "First draft" card. It offers published kits only, sends the routed
// brief, family, section choices and picked catalogue section in ONE POST /api/build-on-brand,
// follows the run to the site check, and deploys through the existing Vercel route. Every failure
// renders a card with a next action instead of failing silently.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { approvedDesignSystemFixtures } from '../helpers/approved-design-systems';
import type { DesignSystemSummary, RouteDecision } from '@mish/contracts';

import { FirstDraftCard } from '../../src/components/design-index/FirstDraftCard';
import { I18nProvider } from '../../src/i18n';
import buttonStyles from '../../../../packages/components/src/button.module.css';

const ROUTED: RouteDecision = {
  decision: 'routed',
  spine: { code: 'PA', name: 'Professional appointments', confidence: 0.8, probabilities: { PA: 0.8 } },
  spines: [{ code: 'PA', probability: 0.8 }],
  skin: { choice: 'calm', confidence: 0.6 },
  family: { id: 'wrenfield', probability: 0.7, basis: 'exact', transfer: 4 },
  candidates: [],
  warnings: [],
  ms: 400,
  calls: 1,
  model: 'jev-test',
};

let fixtures: Awaited<ReturnType<typeof approvedDesignSystemFixtures>>;
let KITS: DesignSystemSummary[];
beforeAll(async () => {
  fixtures = await approvedDesignSystemFixtures([]);
  KITS = [...fixtures.kits.values()];
  KITS.push({ id: 'user:clinic-draft', title: 'Clinic draft', status: 'draft', source: 'user', isEditable: true, approval: { status: 'unreviewed', revision: 'a'.repeat(64) } } as DesignSystemSummary);
}, 120_000);
afterAll(async () => { await fixtures?.stop(); });

const PLAN = {
  pageCount: 4,
  useLibrary: true,
  target: 'static-html',
  designSystem: { id: 'neutral-product', binding: { tokensStylesheet: 'tokens.css' } },
  pages: [
    { role: 'home', file: 'index.html', sections: [{ role: 'hero', source: 'kit' }, { role: 'footer', source: 'kit' }] },
    { role: 'services', file: 'services.html', sections: [{ role: 'hero', source: 'kit' }, { role: 'footer', source: 'kit' }] },
    { role: 'about', file: 'about.html', sections: [{ role: 'hero', source: 'kit' }, { role: 'footer', source: 'kit' }] },
    { role: 'contact', file: 'contact.html', sections: [{ role: 'hero', source: 'kit' }, { role: 'footer', source: 'kit' }] },
  ],
  libraryInserts: [],
};

const CHECK = {
  pages: ['index.html', 'about.html', 'contact.html', 'services.html'],
  rules: [
    { id: 'pages-present', ok: true, detail: '4 pages' },
    { id: 'kit-tokens-linked', ok: true, detail: 'Every page links the kit tokens.css' },
  ],
  ok: true,
};

interface Call { url: string; method: string; body: any }

function mockFetch(overrides: Record<string, (call: Call) => { status: number; body: unknown }> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = `${call.method} ${url.split('?')[0]}`;
    const handler = overrides[key];
    const answer = handler
      ? handler(call)
      : key === 'GET /api/design-systems' ? { status: 200, body: { designSystems: KITS } }
      : key === 'POST /api/build-on-brand' ? { status: 202, body: { projectId: 'p-1', conversationId: 'c-1', runId: 'r-1', plan: PLAN } }
      : key === 'GET /api/runs/r-1' ? { status: 200, body: { id: 'r-1', status: 'succeeded' } }
      : key === 'GET /api/projects/p-1/site-check' ? { status: 200, body: CHECK }
      : key === 'GET /api/deploy/config' ? { status: 200, body: { providerId: 'vercel-self', configured: false, tokenMask: '', teamId: '', teamSlug: '', target: 'preview' } }
      : { status: 404, body: { error: { code: 'NOT_FOUND', message: key } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderCard(props: Partial<Parameters<typeof FirstDraftCard>[0]> = {}) {
  const onOpenProject = vi.fn();
  render(
    <I18nProvider initial="en">
      <FirstDraftCard
        brief="Bright Smile Family Dentistry in Portland. Book online."
        decision={ROUTED}
        sectionHints={{ reviews: 'drop' }}
        catalogEntryId="cult:faq-series-a"
        onOpenProject={onOpenProject}
        pollMs={5}
        {...props}
      />
    </I18nProvider>,
  );
  return { onOpenProject };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FirstDraftCard', () => {
  it('distinguishes same-title installed kits in the first-draft select', async () => {
    mockFetch({ 'GET /api/design-systems': () => ({ status: 200, body: { designSystems: [
      { ...KITS[0], id: 'user:atlas-lang', title: 'Atlas kit', source: 'user' },
      { ...KITS[0], id: 'user:atlas-lang-2', title: 'Atlas kit', source: 'user' },
    ] } }) });
    render(<I18nProvider initial="en"><FirstDraftCard brief="Clinic" decision={ROUTED} sectionHints={{}} /></I18nProvider>);
    expect(await screen.findByRole('option', { name: 'Atlas kit · user:atlas-lang' })).toBeTruthy();
    expect(await screen.findByRole('option', { name: 'Atlas kit · user:atlas-lang-2' })).toBeTruthy();
  });

  it('keeps unique-title first-draft options free of source details', async () => {
    mockFetch();
    renderCard();
    expect(await screen.findByRole('option', { name: KITS[0]!.title })).toBeTruthy();
  });

  it('formats duplicate first-draft option dates in the UI locale', async () => {
    const revision = '2026-10-09T12:00:00.000Z';
    mockFetch({ 'GET /api/design-systems': () => ({ status: 200, body: { designSystems: [
      { ...KITS[0], id: 'user:one', title: 'Atlas kit', updatedAt: revision },
      { ...KITS[0], id: 'user:two', title: 'Atlas kit', updatedAt: revision },
    ] } }) });
    render(<I18nProvider initial="en"><FirstDraftCard brief="Clinic" decision={ROUTED} sectionHints={{}} /></I18nProvider>);
    const date = new Intl.DateTimeFormat('en', { dateStyle: 'short' }).format(new Date(revision));
    expect(await screen.findByRole('option', { name: `Atlas kit · user:one · ${date}` })).toBeTruthy();
  });

  it('keeps Build primary and Improve secondary, announcing startup without changing the button name', async () => {
    mockFetch();
    const fetchReady = fetch;
    let finishStart!: () => void;
    const pending = new Promise<void>((resolve) => { finishStart = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/build-on-brand') await pending;
      return fetchReady(input, init);
    }));
    renderCard();
    const kit = await screen.findByTestId('first-draft-kit');
    await waitFor(() => expect(kit.querySelector('option[value="neutral-product"]')).not.toBeNull());
    fireEvent.change(kit, { target: { value: 'neutral-product' } });
    const build = screen.getByRole('button', { name: 'Build first draft' });
    const improve = screen.getByRole('button', { name: 'Improve prompt' });
    expect(build.classList.contains(buttonStyles.primary!)).toBe(true);
    expect(improve.classList.contains(buttonStyles.secondary!)).toBe(true);
    fireEvent.click(build);
    try {
      expect(build.getAttribute('aria-busy')).toBe('true');
      expect(screen.getByRole('button', { name: 'Build first draft' })).toBe(build);
      expect(build.getAttribute('aria-disabled')).toBe('true');
      expect((build as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(build);
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/build-on-brand')).toHaveLength(1);
    } finally {
      await act(async () => { finishStart(); await pending; });
    }
    await screen.findByTestId('first-draft-site-check');
    expect(build.hasAttribute('aria-busy')).toBe(false);
  });

  it.each(['running', 'succeeded'])('groups %s status, plan and preview actions in one named result', async (status) => {
    mockFetch({ 'GET /api/runs/r-1': () => ({ status: 200, body: { id: 'r-1', status } }) });
    renderCard();
    const kit = await screen.findByTestId('first-draft-kit');
    await waitFor(() => expect(kit.querySelector('option[value="neutral-product"]')).not.toBeNull());
    fireEvent.change(kit, { target: { value: 'neutral-product' } });
    fireEvent.click(screen.getByRole('button', { name: 'Build first draft' }));
    const result = await screen.findByRole('group', { name: 'First draft on a kit' });
    await waitFor(() => expect(within(result).getByRole('status').textContent).toBe(status === 'running' ? 'Building the pages…' : 'Draft ready'));
    expect(within(result).getByText(/Planned pages:/)).toBeTruthy();
    const open = within(result).getByRole('button', { name: 'Open project and preview' });
    const deploy = within(result).getByRole('button', { name: 'Deploy to Vercel' });
    expect(open.classList.contains(buttonStyles.secondary!)).toBe(true);
    expect(deploy.classList.contains(buttonStyles.ghost!)).toBe(true);
    expect(screen.getByRole('button', { name: 'Build first draft' }).getAttribute('aria-busy')).toBe(status === 'running' ? 'true' : null);
    if (status === 'succeeded') expect(await within(result).findByRole('region', { name: 'Site check' })).toBeTruthy();
  });

  it('offers published kits only', async () => {
    mockFetch();
    renderCard();
    const select = await screen.findByTestId('first-draft-kit');
    await waitFor(() => expect(select.querySelectorAll('option[value="neutral-product"]')).toHaveLength(1));
    expect(select.querySelector('option[value="user:clinic-draft"]')).toBeNull();
  });

  it('sends one POST with the brief, kit, pages and the Design Index route, then follows the run to the site check', async () => {
    const calls = mockFetch();
    const { onOpenProject } = renderCard();
    const select = await screen.findByTestId('first-draft-kit');
    await waitFor(() => expect(select.querySelector('option[value="neutral-product"]')).not.toBeNull());
    fireEvent.change(select, { target: { value: 'neutral-product' } });
    fireEvent.click(screen.getByTestId('first-draft-build'));
    fireEvent.click(screen.getByTestId('first-draft-build'));

    await screen.findByTestId('first-draft-site-check');
    const posts = calls.filter((call) => call.method === 'POST' && call.url === '/api/build-on-brand');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      brief: 'Bright Smile Family Dentistry in Portland. Book online.',
      designSystemId: 'neutral-product',
      pageCount: 4,
      useLibrary: true,
      route: { spine: 'PA', family: 'wrenfield', sections: { reviews: 'drop' }, catalogEntryIds: ['cult:faq-series-a'] },
    });
    expect(screen.getByTestId('first-draft-site-check').textContent).toContain('kit-tokens-linked');
    fireEvent.click(screen.getByTestId('first-draft-open-project'));
    expect(onOpenProject).toHaveBeenCalledWith('p-1');
  });

  it('shows the one-line fix when no agent runtime is available', async () => {
    const fix = 'No agent runtime is available. Install Claude Code.';
    mockFetch({
      'POST /api/build-on-brand': () => ({ status: 503, body: { error: { code: 'AGENT_UNAVAILABLE', message: fix, details: { fix } } } }),
    });
    renderCard();
    const select = await screen.findByTestId('first-draft-kit');
    await waitFor(() => expect(select.querySelector('option[value="neutral-product"]')).not.toBeNull());
    fireEvent.change(select, { target: { value: 'neutral-product' } });
    fireEvent.click(screen.getByTestId('first-draft-build'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(fix);
    expect(screen.queryByTestId('first-draft-site-check')).toBeNull();
  });

  it('records that no Vercel token is configured instead of deploying', async () => {
    const calls = mockFetch();
    renderCard();
    const select = await screen.findByTestId('first-draft-kit');
    await waitFor(() => expect(select.querySelector('option[value="neutral-product"]')).not.toBeNull());
    fireEvent.change(select, { target: { value: 'neutral-product' } });
    fireEvent.click(screen.getByTestId('first-draft-build'));
    await screen.findByTestId('first-draft-site-check');
    fireEvent.click(screen.getByTestId('first-draft-deploy'));
    expect(await screen.findByTestId('first-draft-deploy-unconfigured')).toBeTruthy();
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/deploy'))).toBe(false);
  });

  it('deploys index.html as a Vercel preview through the existing deploy route', async () => {
    const calls = mockFetch({
      'GET /api/deploy/config': () => ({ status: 200, body: { providerId: 'vercel-self', configured: true, tokenMask: 'saved', teamId: 'team_1', teamSlug: 'zerosum', target: 'preview' } }),
      'POST /api/projects/p-1/deploy': () => ({ status: 200, body: { id: 'd-1', projectId: 'p-1', fileName: 'index.html', providerId: 'vercel-self', url: 'https://bright-smile.vercel.app', deploymentCount: 1, target: 'preview', status: 'ready', access: 'public', publicAccessOutcome: 'ready', createdAt: 1, updatedAt: 1 } }),
    });
    renderCard();
    const select = await screen.findByTestId('first-draft-kit');
    await waitFor(() => expect(select.querySelector('option[value="neutral-product"]')).not.toBeNull());
    fireEvent.change(select, { target: { value: 'neutral-product' } });
    fireEvent.click(screen.getByTestId('first-draft-build'));
    await screen.findByTestId('first-draft-site-check');
    fireEvent.click(screen.getByTestId('first-draft-deploy'));
    const link = await screen.findByTestId('first-draft-deploy-url');
    expect(link.getAttribute('href')).toBe('https://bright-smile.vercel.app');
    // The link a person shares must open logged out: the card asks for a public preview by
    // default, like the file viewer's deploy modal, and says what access the link has.
    const deploy = calls.find((call) => call.method === 'POST' && call.url === '/api/projects/p-1/deploy');
    expect(deploy?.body).toEqual({ fileName: 'index.html', providerId: 'vercel-self', target: 'preview', publicAccess: true });
    expect(screen.getByTestId('first-draft-deploy-access').getAttribute('data-access')).toBe('public');
  });

  it('keeps Vercel deployment protection when "Make preview public" is unticked, and says the link is protected', async () => {
    const calls = mockFetch({
      'GET /api/deploy/config': () => ({ status: 200, body: { providerId: 'vercel-self', configured: true, tokenMask: 'saved', teamId: 'team_1', teamSlug: 'zerosum', target: 'preview' } }),
      'POST /api/projects/p-1/deploy': () => ({ status: 200, body: { id: 'd-1', projectId: 'p-1', fileName: 'index.html', providerId: 'vercel-self', url: 'https://bright-smile.vercel.app', deploymentCount: 1, target: 'preview', status: 'ready', access: 'protected', createdAt: 1, updatedAt: 1 } }),
    });
    renderCard();
    const select = await screen.findByTestId('first-draft-kit');
    await waitFor(() => expect(select.querySelector('option[value="neutral-product"]')).not.toBeNull());
    fireEvent.change(select, { target: { value: 'neutral-product' } });
    fireEvent.click(screen.getByTestId('first-draft-build'));
    await screen.findByTestId('first-draft-site-check');
    const toggle = screen.getByTestId('deploy-public-access') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('first-draft-deploy'));
    await screen.findByTestId('first-draft-deploy-url');
    const deploy = calls.find((call) => call.method === 'POST' && call.url === '/api/projects/p-1/deploy');
    expect(deploy?.body).toMatchObject({ publicAccess: false });
    expect(screen.getByTestId('first-draft-deploy-access').getAttribute('data-access')).toBe('protected');
  });

  it('says the access is unknown when an older daemon reports none', async () => {
    mockFetch({
      'GET /api/deploy/config': () => ({ status: 200, body: { providerId: 'vercel-self', configured: true, tokenMask: 'saved', teamId: 'team_1', teamSlug: 'zerosum', target: 'preview' } }),
      'POST /api/projects/p-1/deploy': () => ({ status: 200, body: { id: 'd-1', projectId: 'p-1', fileName: 'index.html', providerId: 'vercel-self', url: 'https://bright-smile.vercel.app', deploymentCount: 1, target: 'preview', status: 'ready', createdAt: 1, updatedAt: 1 } }),
    });
    renderCard();
    const select = await screen.findByTestId('first-draft-kit');
    await waitFor(() => expect(select.querySelector('option[value="neutral-product"]')).not.toBeNull());
    fireEvent.change(select, { target: { value: 'neutral-product' } });
    fireEvent.click(screen.getByTestId('first-draft-build'));
    await screen.findByTestId('first-draft-site-check');
    fireEvent.click(screen.getByTestId('first-draft-deploy'));
    await screen.findByTestId('first-draft-deploy-url');
    expect(screen.getByTestId('first-draft-deploy-access').getAttribute('data-access')).toBe('unknown');
  });
});
