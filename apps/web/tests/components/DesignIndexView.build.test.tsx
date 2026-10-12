// @vitest-environment jsdom

// Building from the Route panel (design 2026-09-20 §6.6).
//
// The condition that matters is the same one the panel already holds for routing: a build spends
// real money, so nothing starts until the button is pressed — and the button only exists once a
// decision has actually routed. The rest is what a person sees while it runs: the events as a
// list, a way to stop it, a link to the project when it worked, and one fixed sentence when it
// did not.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgencyBuildEvent, AgencyBuildListItem, AgencyBuildSnapshot, DesignTaxonomy, RouteDecision } from '@open-design/contracts';

import { DesignIndexView } from '../../src/components/DesignIndexView';
import { aguiStateOf, emitBuildEnd, emitBuildEvent } from '../helpers/agency-build-agui-frames';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { referenceFanout } from '../helpers/reference-fanout';

import buttonStyles from '../../../../packages/components/src/button.module.css';

const TAXONOMY: DesignTaxonomy = {
  version: '1.0',
  sections: [{ id: 'hero', definition: 'The first screen.' }],
  components: [],
  mechanics: [],
  depth: [],
  style: {
    ground: [{ id: 'near-black', definition: 'Almost black.' }],
    accent: [],
    typography: [],
    imagery: [],
    topology: [],
    density: [],
  },
  quality: [],
  truthRisk: { id: 'truth-risk', instructions: 'i', criteriaTrue: 't', criteriaFalse: 'f' },
  action: [],
};

const ROUTED: RouteDecision = {
  decision: 'routed',
  spine: { code: 'S3', name: 'Editorial spine', confidence: 0.82, probabilities: { S3: 0.82 } },
  spines: [{ code: 'S3', probability: 0.82 }],
  archetype: { id: 'a-editorial', name: 'Editorial archetype', confidence: 0.7 },
  skin: { choice: 'quiet', confidence: 0.61 },
  family: { id: 'f-atelier', probability: 0.66, basis: 'exact', transfer: 4 },
  candidates: [],
  warnings: [],
  ms: 590,
  calls: 1,
  model: 'jev-test',
};

const UNROUTED: RouteDecision = {
  ...ROUTED,
  decision: 'unrouted',
  reason: 'No family exists for this spine yet.',
  family: undefined,
} as RouteDecision;

const QUEUED: AgencyBuildSnapshot = {
  id: 'build-1',
  status: 'queued',
  events: [],
  startedAt: '2026-09-20T10:00:00.000Z',
};

function done(extra: Partial<AgencyBuildSnapshot> = {}): AgencyBuildSnapshot {
  return { ...QUEUED, status: 'done', projectId: 'project-1', finishedAt: '2026-09-20T10:01:00.000Z', ...extra };
}

interface FetchCall { url: string; method: string; body: any }

/** The one EventSource the view opens, driven by hand. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  static CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  /** Drives the `onerror` path the registry installs. */
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;

  constructor(public url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(name: string, handler: (event: MessageEvent) => void) {
    const existing = this.listeners.get(name) ?? [];
    existing.push(handler);
    this.listeners.set(name, existing);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(name: string, data: unknown) {
    for (const handler of this.listeners.get(name) ?? []) {
      handler({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  /** Sends `data` as it is — for frames that are not valid JSON. */
  emitRaw(name: string, data: string) {
    for (const handler of this.listeners.get(name) ?? []) {
      handler({ data } as MessageEvent);
    }
  }
}

interface StubOptions {
  decision?: RouteDecision;
  /** Status for `POST /api/agency/build`. */
  buildStatus?: number;
  buildError?: { code: string; message: string };
  /** Holds the build POST until this resolves, so it can be in flight across an unmount. */
  holdBuild?: Promise<void>;
  /** What `GET /api/agency/builds/:id` answers, for the stream-died path. */
  snapshot?: AgencyBuildSnapshot;
  /** The routed family's optional sections (`GET /api/agency/families/:family/sections`). */
  sections?: Array<{ id: string; type: string; label: string }>;
  /** How the sections request fails before it answers, once per entry, in order: an HTTP status
   * or `network` (a rejected fetch). Later requests answer normally. */
  sectionsFailures?: Array<number | 'network'>;
  /** The routed family's output scope, on its sections response (C16). */
  outputScope?: 'site' | 'static-prototype';
  /** What `GET /api/agency/builds` answers: the recent-builds rows. */
  recentBuilds?: AgencyBuildListItem[];
  /** `GET /api/sections`' entries (the selectable-section picker). Defaults to none. */
  sectionCatalogEntries?: unknown[];
  /** `GET /api/sections`' five design directions. Defaults to none. */
  sectionCatalogDirections?: Array<{ id: string; label: string }>;
  /** `GET /api/motionsites/connection`'s status. Defaults to `not_connected`. */
  motionsitesConnection?: 'not_connected' | 'connected' | 'expired';
}

/** A promise the test resolves by hand, to keep a request in flight. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function stubFetch(options: StubOptions = {}) {
  const calls: FetchCall[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });

    if (url === '/api/design-index/taxonomy') return json({ taxonomy: TAXONOMY });
    if (url.startsWith('/api/design-index')) return json({ profiles: [], matched: 0, total: 0 });
    if (url === '/api/workbench/references/fanout') return json(referenceFanout());
    if (url === '/api/agency/route') return json({ decision: options.decision ?? ROUTED });
    const sectionsUrl = /^\/api\/agency\/families\/([^/]+)\/sections$/.exec(url);
    if (sectionsUrl) {
      const failure = options.sectionsFailures?.shift();
      if (failure === 'network') throw new TypeError('Failed to fetch');
      if (typeof failure === 'number') return json({ error: { code: 'INTERNAL_ERROR', message: 'no' } }, failure);
      return json({ family: sectionsUrl[1], sections: options.sections ?? [], ...(options.outputScope ? { outputScope: options.outputScope } : {}) });
    }
    if (url === '/api/agency/build') {
      if (options.holdBuild) await options.holdBuild;
      const status = options.buildStatus ?? 202;
      if (status !== 202) return json({ error: options.buildError ?? { code: 'REQUEST_FAILED', message: 'no' } }, status);
      return json({ build: QUEUED }, 202);
    }
    if (url === '/api/agency/builds') return json({ builds: options.recentBuilds ?? [] });
    if (url.startsWith('/api/sections')) {
      return json({
        catalog: { schema: 'section-catalog/1', entries: options.sectionCatalogEntries ?? [] },
        directions: options.sectionCatalogDirections ?? [],
      });
    }
    if (url === '/api/motionsites/connection') return json({ status: options.motionsitesConnection ?? 'not_connected' });
    if (url.endsWith('/cancel')) return json({ build: { ...QUEUED, status: 'cancelled' } }, 202);
    if (url.startsWith('/api/agency/builds/')) return json({ build: options.snapshot ?? QUEUED });
    throw new Error(`unexpected fetch ${method} ${url}`);
  }));
  vi.stubGlobal('EventSource', FakeEventSource);
  return { calls };
}

/** Opens the Route panel and routes a brief, which is what makes the Build button exist. */
async function route(brief = 'A quiet atelier site.') {
  fireEvent.click(await screen.findByTestId('design-index-panel-route'));
  fireEvent.change(screen.getByTestId('design-index-route-brief'), { target: { value: brief } });
  fireEvent.click(screen.getByTestId('design-index-route-run'));
  await screen.findByTestId('design-index-decision');
}

const event = (seq: number, patch: Partial<AgencyBuildEvent>): AgencyBuildEvent =>
  ({ seq, at: '2026-09-20T10:00:01.000Z', type: 'unit', ...patch } as AgencyBuildEvent);

describe('DesignIndexView — building from the Route panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.last = undefined;
    cleanup();
  });

  it('finds suggested references for default/auto choices and preserves named keeps and drops', async () => {
    const { calls } = stubFetch({
      decision: { ...ROUTED, spine: { ...ROUTED.spine, code: 'TL' } },
      sections: [{ id: 'reviews', type: 'testimonials', label: 'customer reviews' }, { id: 'support', type: 'support', label: 'donor support' }, { id: 'press', type: 'press', label: 'press mentions' }],
    });
    render(<I18nProvider initial="en"><DesignIndexView /></I18nProvider>);
    await route();
    const reviews = await screen.findByTestId('design-index-build-section-reviews');
    const button = screen.getByRole('button', { name: 'Find references' });
    expect(button).not.toBeDisabled();
    expect(calls.filter(call => call.url.includes('/references/'))).toHaveLength(0);
    fireEvent.click(button);
    await screen.findByRole('link', { name: 'Dental practice' });
    expect(calls.find(call => call.url.includes('/references/'))?.body).toEqual({ brief: 'A quiet atelier site.', spineCode: 'TL', limit: 10 });
    fireEvent.change(reviews, { target: { value: 'drop' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-support'), { target: { value: 'keep' } });
    expect(screen.queryByRole('link', { name: 'Dental practice' })).toBeNull();
    fireEvent.click(button);
    await screen.findByRole('link', { name: 'Dental practice' });
    expect(calls.filter(call => call.url.includes('/references/'))[1]?.body).toMatchObject({
      sectionAdditions: [{ id: 'support', name: 'donor support', purpose: 'support' }], excludedSections: ['customer reviews', 'testimonials'],
    });
    expect(calls.filter(call => call.url.includes('/references/'))[1]?.body).not.toHaveProperty('sections');
    expect((screen.getByTestId('design-index-build-section-press') as HTMLSelectElement).value).toBe('auto');
    fireEvent.change(reviews, { target: { value: 'auto' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-support'), { target: { value: 'auto' } });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await screen.findByRole('link', { name: 'Dental practice' });
    expect(calls.filter(call => call.url.includes('/references/'))[2]?.body).toEqual({ brief: 'A quiet atelier site.', spineCode: 'TL', limit: 10 });
  });

  it('C16: labels a static-prototype family before the build starts', async () => {
    stubFetch({ outputScope: 'static-prototype' });
    render(<DesignIndexView />);
    await route();
    const badge = await screen.findByTestId('design-index-build-output-scope');
    expect(badge.getAttribute('role')).toBe('note');
    expect(badge.textContent).toContain(en['designIndex.build.outputScope.staticPrototype']);
    expect(badge.textContent).toContain(en['designIndex.build.outputScope.staticPrototypeHint']);
  });

  it('C16: shows no label for a site family', async () => {
    const { calls } = stubFetch({ outputScope: 'site' });
    render(<DesignIndexView />);
    await route();
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/families/f-atelier/sections')).toBe(true));
    expect(screen.queryByTestId('design-index-build-output-scope')).toBeNull();
  });

  it("C16: labels a finished build from its own state, and in English", async () => {
    stubFetch();
    render(<I18nProvider initial="en"><DesignIndexView onOpenProject={() => {}} /></I18nProvider>);
    await route();
    expect(screen.queryByTestId('design-index-build-output-scope')).toBeNull();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEnd(FakeEventSource.last!, done({ family: 'crm-dashboard', outputScope: 'static-prototype' }));
    const badge = await screen.findByTestId('design-index-build-output-scope');
    expect(badge.textContent).toContain(en['designIndex.build.outputScope.staticPrototype']);
  });

  it('C16: labels a running build from the live AG-UI state, before the build ends', async () => {
    stubFetch({ outputScope: 'site' });
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    expect(screen.queryByTestId('design-index-build-output-scope')).toBeNull();
    // An auto build learns its family at routing; the stream's state carries the scope mid-run.
    FakeEventSource.last!.emit('message', {
      type: 'STATE_SNAPSHOT',
      snapshot: aguiStateOf({ ...QUEUED, status: 'building', family: 'crm-dashboard', outputScope: 'static-prototype' }),
    });
    const badge = await screen.findByTestId('design-index-build-output-scope');
    expect(badge.textContent).toContain(en['designIndex.build.outputScope.staticPrototype']);
    expect(FakeEventSource.last!.closed).toBe(false);
  });

  it('C16: labels a static-prototype row in recent builds, and only that row', async () => {
    stubFetch({
      recentBuilds: [
        { id: 'build-app', status: 'done', family: 'app-shell', outputScope: 'static-prototype', projectId: 'p-1', startedAt: '2026-09-20T09:00:00.000Z', finishedAt: '2026-09-20T09:01:00.000Z' },
        { id: 'build-site', status: 'done', family: 'marketing-site', outputScope: 'site', projectId: 'p-2', startedAt: '2026-09-20T08:00:00.000Z', finishedAt: '2026-09-20T08:01:00.000Z' },
      ] as AgencyBuildListItem[],
    });
    render(<DesignIndexView />);
    fireEvent.click(await screen.findByTestId('design-index-panel-route'));
    await waitFor(() => expect(screen.getAllByTestId('design-index-recent-build')).toHaveLength(2));
    const [appRow, siteRow] = screen.getAllByTestId('design-index-recent-build');
    expect(within(appRow!).getByTestId('design-index-recent-build-output-scope').textContent).toBe(en['designIndex.build.outputScope.staticPrototype']);
    expect(within(siteRow!).queryByTestId('design-index-recent-build-output-scope')).toBeNull();
  });

  it('offers no build button until a decision has routed', async () => {
    stubFetch({ decision: UNROUTED });
    render(<DesignIndexView />);
    fireEvent.click(await screen.findByTestId('design-index-panel-route'));
    expect(screen.queryByTestId('design-index-build-run')).toBeNull();

    await route();
    // The brief routed, but to no family, so there is nothing to build with.
    expect(screen.queryByTestId('design-index-build-run')).toBeNull();
  });

  it('builds with the routed family and posts a strict build by default', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await route();

    const button = screen.getByTestId('design-index-build-run');
    expect(button.textContent).toContain('f-atelier');
    expect(calls.some((call) => call.url === '/api/agency/build')).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    expect(calls.find((call) => call.url === '/api/agency/build')?.body).toEqual({
      brief: 'A quiet atelier site.',
      family: 'f-atelier',
      verify: 'strict',
    });
    expect(FakeEventSource.last?.url).toBe('/api/agency/builds/build-1/agui');
  });

  it('offers the routed family\'s optional sections and sends only explicit keep/drop choices as hints', async () => {
    const { calls } = stubFetch({
      sections: [
        { id: 'reviews', type: 'reviews', label: 'customer reviews' },
        { id: 'support', type: 'support', label: 'donor support' },
        { id: 'press', type: 'press', label: 'press mentions' },
      ],
    });
    render(<DesignIndexView />);
    await route();

    const reviews = await screen.findByTestId('design-index-build-section-reviews') as HTMLSelectElement;
    expect(reviews.value).toBe('auto');
    expect([...reviews.options].map((option) => option.textContent)).toEqual([
      en['designIndex.build.sections.auto'],
      en['designIndex.build.sections.keep'],
      en['designIndex.build.sections.drop'],
    ]);
    expect(screen.getByTestId('design-index-build-sections').textContent).toContain('customer reviews');

    fireEvent.change(reviews, { target: { value: 'drop' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-support'), { target: { value: 'keep' } });
    // Set, then back to "Let Jev decide": no hint for press.
    fireEvent.change(screen.getByTestId('design-index-build-section-press'), { target: { value: 'drop' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-press'), { target: { value: 'auto' } });

    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    expect(calls.find((call) => call.url === '/api/agency/build')?.body).toEqual({
      brief: 'A quiet atelier site.',
      family: 'f-atelier',
      verify: 'strict',
      sections: { reviews: 'drop', support: 'keep' },
    });
  });

  it('shows no section controls for a family without optional sections, and sends no hints', async () => {
    const { calls } = stubFetch({ sections: [] });
    render(<DesignIndexView />);
    await route();
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/families/f-atelier/sections')).toBe(true));
    expect(screen.queryByTestId('design-index-build-sections')).toBeNull();

    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    expect(calls.find((call) => call.url === '/api/agency/build')?.body.sections).toBeUndefined();
  });

  for (const failure of [500, 'network'] as const) {
    it(`says the sections could not load (${failure}) and retries, instead of hiding the controls`, async () => {
      const { calls } = stubFetch({
        sections: [{ id: 'reviews', type: 'reviews', label: 'customer reviews' }],
        sectionsFailures: [failure],
      });
      render(<DesignIndexView />);
      await route();

      const failed = await screen.findByTestId('design-index-build-sections-error');
      expect(failed.textContent).toContain(en['designIndex.build.sections.loadFailed']);
      expect(screen.queryByTestId('design-index-build-section-reviews')).toBeNull();

      fireEvent.click(screen.getByTestId('design-index-build-sections-retry'));
      const reviews = await screen.findByTestId('design-index-build-section-reviews');
      expect((reviews as HTMLSelectElement).value).toBe('auto');
      expect(screen.queryByTestId('design-index-build-sections-error')).toBeNull();
      expect(calls.filter((call) => call.url === '/api/agency/families/f-atelier/sections')).toHaveLength(2);
    });
  }

  it("shows localised section labels in en, and the schema label for a section without one", async () => {
    stubFetch({
      decision: { ...ROUTED, family: { id: 'wrenfield', probability: 0.7, basis: 'exact', transfer: 4 } } as RouteDecision,
      sections: [
        { id: 'reviews', type: 'reviews', label: 'customer reviews' },
        { id: 'press', type: 'press', label: 'press mentions' },
      ],
    });
    render(<I18nProvider initial="en"><DesignIndexView /></I18nProvider>);
    await route();

    await screen.findByTestId('design-index-build-section-reviews');
    const controls = screen.getByTestId('design-index-build-sections');
    expect(controls.textContent).toContain(en['designIndex.build.sectionLabel.wrenfield.reviews']);
    expect(controls.textContent).not.toContain('customer reviews');
    expect(controls.textContent).toContain('press mentions');
    expect(controls.textContent).toContain(en['designIndex.build.sections.label']);
  });

  it('sends advisory when the verify mode select is set to advisory', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await route();

    fireEvent.change(screen.getByTestId('design-index-build-verify-mode'), { target: { value: 'advisory' } });
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    expect(calls.find((call) => call.url === '/api/agency/build')?.body.verify).toBe('advisory');
  });

  it('defaults the verify mode select to strict and sends verify: "strict" unchanged', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await route();

    expect((screen.getByTestId('design-index-build-verify-mode') as HTMLSelectElement).value).toBe('strict');

    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    expect(calls.find((call) => call.url === '/api/agency/build')?.body.verify).toBe('strict');
  });

  it('renders the events as a progress list as they arrive', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEvent(FakeEventSource.last!, event(1, { type: 'route', decision: 'routed', family: 'f-atelier' }));
    emitBuildEvent(FakeEventSource.last!, event(2, { type: 'unit', label: 'hero' }));
    emitBuildEvent(FakeEventSource.last!, event(3, { type: 'verify', counts: { checked: 12, illustrative: 0, flagged: 1, repaired: 1, remaining: 0 } }));

    const progress = await screen.findByTestId('design-index-build-progress');
    await waitFor(() => expect(progress.textContent).toContain('Routed to f-atelier'));
    expect(progress.textContent).toContain('Section hero');
    expect(progress.textContent).toContain('Checked 12, 0 unresolved');
  });

  it('shows the dropped sections from the stream\'s state, not as a progress line', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last?.url).toBe('/api/agency/builds/build-1/agui'));
    const source = FakeEventSource.last!;

    source.emit('message', { type: 'RUN_STARTED', threadId: 'agency-build:build-1', runId: 'build-1' });
    source.emit('message', { type: 'STATE_SNAPSHOT', snapshot: aguiStateOf({ ...QUEUED, status: 'building' }) });
    emitBuildEvent(source, event(1, { type: 'route', decision: 'routed', family: 'f-atelier' }));
    await screen.findByTestId('design-index-build-progress');
    expect(screen.queryByTestId('design-index-build-sections-outcome')).toBeNull();

    // The state carries the decision; the CUSTOM event alone does not add a progress line.
    source.emit('message', {
      type: 'STATE_DELTA',
      delta: [{ op: 'replace', path: '/sections', value: { kept: ['final-cta'], dropped: ['reviews', 'support'], source: 'jev', reason: null } }],
    });
    emitBuildEvent(source, event(2, { type: 'sections', keptSections: ['final-cta'], droppedSections: ['reviews', 'support'], sectionSource: 'jev' }));
    const outcome = await screen.findByTestId('design-index-build-sections-outcome');
    expect(outcome.textContent).toBe(en['designIndex.build.event.sectionsDropped'].replace('{sections}', 'reviews, support'));
    expect(screen.getByTestId('design-index-build-progress').textContent).not.toContain('reviews');

    // Still shown once the build has finished: the terminal snapshot keeps the decision.
    const sectionsEvent = event(2, { type: 'sections', keptSections: ['final-cta'], droppedSections: ['reviews', 'support'], sectionSource: 'jev' });
    emitBuildEnd(source, { ...QUEUED, status: 'done', projectId: 'project-1', events: [sectionsEvent], finishedAt: '2026-09-20T10:01:00.000Z' });
    await screen.findByTestId('design-index-build-outcome');
    expect(screen.getByTestId('design-index-build-sections-outcome').textContent).toContain('reviews, support');
  });

  it('shows a step timeline driven by the stream\'s STEP events, and the live status', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last?.url).toBe('/api/agency/builds/build-1/agui'));
    const source = FakeEventSource.last!;

    const steps = await screen.findByTestId('design-index-build-steps');
    const statusOf = (name: string) => steps.querySelector(`[data-step="${name}"]`)?.getAttribute('data-status');
    expect(['route', 'fill', 'verify', 'publish'].map(statusOf)).toEqual(['pending', 'pending', 'pending', 'pending']);

    source.emit('message', { type: 'RUN_STARTED', threadId: 'agency-build:build-1', runId: 'build-1' });
    source.emit('message', { type: 'STATE_SNAPSHOT', snapshot: aguiStateOf({ ...QUEUED, status: 'routing' }) });
    source.emit('message', { type: 'STEP_STARTED', stepName: 'route' });
    await waitFor(() => expect(statusOf('route')).toBe('active'));
    expect(screen.getByTestId('design-index-build-status').textContent).toBe(en['designIndex.build.status.routing']);

    source.emit('message', { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/build/status', value: 'building' }] });
    source.emit('message', { type: 'STEP_FINISHED', stepName: 'route' });
    emitBuildEvent(source, event(1, { type: 'route', decision: 'routed', family: 'f-atelier' }));
    source.emit('message', { type: 'STEP_STARTED', stepName: 'fill' });
    // The running line follows the stream's state; it used to stay on "Queued" for the whole build.
    await waitFor(() => expect(screen.getByTestId('design-index-build-status').textContent).toBe(en['designIndex.build.status.building']));
    expect(['route', 'fill', 'verify', 'publish'].map(statusOf)).toEqual(['done', 'active', 'pending', 'pending']);
    expect(screen.getByTestId('design-index-build-progress').textContent).toContain('Routed to f-atelier');
    expect(steps.querySelector('[data-step="fill"]')?.textContent).toContain(en['designIndex.build.step.fill']);

    source.emit('message', { type: 'STEP_FINISHED', stepName: 'fill' });
    emitBuildEnd(source, { ...QUEUED, status: 'failed', error: { code: 'MODEL_UNAVAILABLE', message: 'x' }, finishedAt: '2026-09-20T10:01:00.000Z' });
    await screen.findByTestId('design-index-build-outcome');
    expect(statusOf('fill')).toBe('failed');
    expect(source.closed).toBe(true);
    expect(screen.queryByTestId('design-index-build-status')).toBeNull();
  });

  it('reads the finished build from the daemon when a delta did not apply before the terminal frame', async () => {
    const { calls } = stubFetch({ snapshot: done({ projectId: 'project-9' }) });
    render(<DesignIndexView onOpenProject={() => {}} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last?.url).toBe('/api/agency/builds/build-1/agui'));
    const source = FakeEventSource.last!;

    source.emit('message', { type: 'RUN_STARTED', threadId: 'agency-build:build-1', runId: 'build-1' });
    source.emit('message', { type: 'STATE_SNAPSHOT', snapshot: aguiStateOf({ ...QUEUED, status: 'building' }) });
    // Rejected: `/nope` is not in the state. The stream's state is now stale.
    source.emit('message', { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/nope/deeper', value: 1 }] });
    source.emit('message', { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/build/status', value: 'publishing' }] });
    source.emit('message', { type: 'RUN_FINISHED', threadId: 'agency-build:build-1', runId: 'build-1', result: { status: 'done' } });

    // The terminal frame is accepted only once the snapshot is read, and the snapshot is what shows.
    await screen.findByTestId('design-index-build-open-project');
    expect(calls.some((call) => call.method === 'GET' && call.url === '/api/agency/builds/build-1')).toBe(true);
    expect(source.closed).toBe(true);
    expect(screen.queryByTestId('design-index-build-status')).toBeNull();
  });

  it('orders the timeline as the stream starts steps: publish before verify for verify:"after"', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last?.url).toBe('/api/agency/builds/build-1/agui'));
    const source = FakeEventSource.last!;
    const steps = await screen.findByTestId('design-index-build-steps');
    const order = () => [...steps.querySelectorAll('[data-step]')].map((node) => node.getAttribute('data-step'));
    expect(order()).toEqual(['route', 'fill', 'verify', 'publish']);

    source.emit('message', { type: 'RUN_STARTED', threadId: 'agency-build:build-1', runId: 'build-1' });
    for (const name of ['route', 'fill']) {
      source.emit('message', { type: 'STEP_STARTED', stepName: name });
      source.emit('message', { type: 'STEP_FINISHED', stepName: name });
    }
    source.emit('message', { type: 'STEP_STARTED', stepName: 'publish' });
    await waitFor(() => expect(order()).toEqual(['route', 'fill', 'publish', 'verify']));
    source.emit('message', { type: 'STEP_FINISHED', stepName: 'publish' });
    source.emit('message', { type: 'STEP_STARTED', stepName: 'verify' });
    await waitFor(() => expect(steps.querySelector('[data-step="verify"]')?.getAttribute('data-status')).toBe('active'));
    expect(order()).toEqual(['route', 'fill', 'publish', 'verify']);
  });

  it.each([
    ['a frame that is not JSON', (source: FakeEventSource) => source.emitRaw('message', '{"type":"STATE_DELTA","delta":[')],
    ['a STATE_SNAPSHOT that fails validation', (source: FakeEventSource) => source.emit('message', { type: 'STATE_SNAPSHOT', snapshot: { build: 'done' } })],
    ['a STATE_DELTA that fails validation', (source: FakeEventSource) => source.emit('message', { type: 'STATE_DELTA', delta: [{ nope: true }] })],
  ])('reads the finished build from the daemon after %s', async (_label, lose) => {
    const { calls } = stubFetch({ snapshot: done({ projectId: 'project-9' }) });
    render(<DesignIndexView onOpenProject={() => {}} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last?.url).toBe('/api/agency/builds/build-1/agui'));
    const source = FakeEventSource.last!;

    source.emit('message', { type: 'RUN_STARTED', threadId: 'agency-build:build-1', runId: 'build-1' });
    source.emit('message', { type: 'STATE_SNAPSHOT', snapshot: aguiStateOf({ ...QUEUED, status: 'building' }) });
    // The lost frame may have been the terminal state delta; the stream's state still says building.
    lose(source);
    source.emit('message', { type: 'RUN_FINISHED', threadId: 'agency-build:build-1', runId: 'build-1', result: { status: 'done' } });

    await screen.findByTestId('design-index-build-open-project');
    expect(calls.some((call) => call.method === 'GET' && call.url === '/api/agency/builds/build-1')).toBe(true);
    expect(source.closed).toBe(true);
    expect(screen.queryByTestId('design-index-build-status')).toBeNull();
  });

  it('takes the terminal frame from the stream without a second request when every delta applied', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView onOpenProject={() => {}} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEnd(FakeEventSource.last!, done());
    await screen.findByTestId('design-index-build-open-project');
    expect(calls.some((call) => call.url === '/api/agency/builds/build-1')).toBe(false);
  });

  it('cancels a running build, and the cancel button only exists while it runs', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await route();
    expect(screen.queryByTestId('design-index-build-cancel')).toBeNull();

    fireEvent.click(screen.getByTestId('design-index-build-run'));
    const cancel = await screen.findByTestId('design-index-build-cancel');
    fireEvent.click(cancel);
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/builds/build-1/cancel')).toBe(true));

    emitBuildEnd(FakeEventSource.last!, { ...QUEUED, status: 'cancelled', finishedAt: '2026-09-20T10:01:00.000Z' });
    await waitFor(() => expect(screen.queryByTestId('design-index-build-cancel')).toBeNull());
    expect(screen.getByTestId('design-index-build-outcome').textContent)
      .toContain(en['designIndex.build.status.cancelled']);
  });

  it('offers the project when the build is done', async () => {
    stubFetch();
    const opened: string[] = [];
    render(<DesignIndexView onOpenProject={(id) => { opened.push(id); }} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEnd(FakeEventSource.last!, done());
    const open = await screen.findByTestId('design-index-build-open-project');
    fireEvent.click(open);
    expect(opened).toEqual(['project-1']);
    expect(FakeEventSource.last!.closed).toBe(true);
  });

  it('names every provider that filled a mixed build, and nothing extra for a single one', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEvent(FakeEventSource.last!, event(1, { type: 'failover', label: 'cerebras', reason: 'server-error' }));
    // The snapshot the panel attached with has no `providers`: the line can only come from the
    // stream's terminal state.
    emitBuildEnd(FakeEventSource.last!, done({
      provider: 'cerebras',
      model: 'gpt-oss-120b',
      providers: [
        { provider: 'deepseek', model: 'deepseek-v4-flash', sections: ['hero', 'about', 'services', 'team', 'faq'] },
        { provider: 'cerebras', model: 'gpt-oss-120b', sections: ['contact', 'footer'] },
      ],
    }));
    const line = await screen.findByTestId('design-index-build-providers');
    expect(line.textContent).toBe('Filled by deepseek (5 sections) and cerebras (2 sections)');
    expect(screen.getByTestId('design-index-build-progress').textContent).toContain('Switched to cerebras');
  });

  it('says nothing about providers when one provider filled the whole build', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEnd(FakeEventSource.last!, done({ providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash', sections: ['hero'] }] }));
    await screen.findByTestId('design-index-build-outcome');
    expect(screen.queryByTestId('design-index-build-providers')).toBeNull();
  });

  it('never renders an inert Open project button', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEnd(FakeEventSource.last!, done());

    await screen.findByTestId('design-index-build-outcome');
    expect(screen.queryByTestId('design-index-build-open-project')).toBeNull();
  });

  it('starts one build however fast the button is clicked twice', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await route();

    const button = screen.getByTestId('design-index-build-run');
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    expect(calls.filter((call) => call.url === '/api/agency/build')).toHaveLength(1);
  });

  it('opens no stream when the view is gone before the build POST lands', async () => {
    const held = gate();
    stubFetch({ holdBuild: held.promise });
    const { unmount } = render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));

    unmount();
    held.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeEventSource.last).toBeUndefined();
  });

  it('closes the stream when the view goes away mid-build', async () => {
    stubFetch();
    const { unmount } = render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    unmount();
    expect(FakeEventSource.last!.closed).toBe(true);
  });

  it('drops a finished build when the brief is routed again', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEnd(FakeEventSource.last!, done());
    await screen.findByTestId('design-index-build-outcome');

    // Re-routing the same brief produces a new decision, which the old build no longer belongs to.
    fireEvent.click(screen.getByTestId('design-index-route-run'));
    await waitFor(() => expect(screen.queryByTestId('design-index-build-outcome')).toBeNull());
    expect(screen.queryByTestId('design-index-build-progress')).toBeNull();
  });

  it('offers no project for a cancelled build whose rollback succeeded', async () => {
    // The daemon drops `projectId` when it removed the project again, so there is nothing to
    // open — and the panel must not invent a link to a project that is already gone.
    stubFetch();
    render(<DesignIndexView onOpenProject={() => {}} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEvent(FakeEventSource.last!, event(1, { type: 'project', projectId: 'project-9', created: true }));
    emitBuildEnd(FakeEventSource.last!, { ...QUEUED, status: 'cancelled', finishedAt: '2026-09-20T10:01:00.000Z' });

    const outcome = await screen.findByTestId('design-index-build-outcome');
    expect(outcome.textContent).toContain(en['designIndex.build.status.cancelled']);
    expect(outcome.textContent).not.toContain('project-9');
    expect(screen.queryByTestId('design-index-build-open-project')).toBeNull();
  });

  it('offers the project a failed rollback left behind', async () => {
    stubFetch();
    const opened: string[] = [];
    render(<DesignIndexView onOpenProject={(id) => { opened.push(id); }} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'failed',
      projectId: 'project-7',
      error: { code: 'ROLLBACK_FAILED', message: 'the build failed and the project it created could not be removed' },
      finishedAt: '2026-09-20T10:01:00.000Z',
    });
    const outcome = await screen.findByTestId('design-index-build-outcome');
    expect(outcome.textContent).toContain('project-7');
    fireEvent.click(screen.getByTestId('design-index-build-open-project'));
    expect(opened).toEqual(['project-7']);
  });

  it('shows a failed build\'s route and failure detail, read-only', async () => {
    stubFetch();
    render(<DesignIndexView onOpenProject={() => {}} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'failed',
      route: { decision: 'routed', spine: 'SM', family: 'listings', probability: 0.97 },
      error: { code: 'VERIFY_FAILED', message: 'the build did not pass the faithfulness check and nothing was published' },
      failure: { step: 'verifying', flaggedSlots: ['sections[4].items[0].date'] },
      finishedAt: '2026-09-20T10:01:00.000Z',
    });
    const detail = await screen.findByTestId('design-index-build-failure');
    expect(detail.textContent).toContain('spine SM, family listings, confidence 0.97');
    expect(screen.getByTestId('design-index-build-failure-step').textContent).toContain(en['designIndex.build.status.verifying']);
    expect(screen.getByTestId('design-index-build-failure-flagged').textContent).toContain('sections[4].items[0].date');
    expect(screen.queryByTestId('design-index-build-failure-last-error')).toBeNull();
  });

  it('translates a BUILD_FAILED detail\'s step and reason, shows the unit and slot verbatim, and never the daemon\'s English sentence', async () => {
    stubFetch();
    render(<DesignIndexView onOpenProject={() => {}} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'failed',
      route: { decision: 'routed', spine: 'TL', family: 'wrenfield', probability: 0.71 },
      error: { code: 'BUILD_FAILED', message: 'the build failed' },
      failure: {
        step: 'building',
        unit: 'hero',
        reason: 'invalid',
        slot: 'hero.claim',
        // The daemon's own fixed English sentence: the panel must never show it, in any locale.
        lastError: 'hero: the family compiler refused the filled unit at hero.claim',
      },
      finishedAt: '2026-09-20T10:01:00.000Z',
    });
    const detail = await screen.findByTestId('design-index-build-failure');
    expect(screen.getByTestId('design-index-build-failure-step').textContent).toContain(en['designIndex.build.status.building']);
    expect(screen.getByTestId('design-index-build-failure-reason').textContent).toContain(en['designIndex.build.failure.reason.invalid']);
    expect(screen.getByTestId('design-index-build-failure-unit').textContent).toContain('hero');
    expect(screen.getByTestId('design-index-build-failure-slot').textContent).toContain('hero.claim');
    expect(screen.queryByTestId('design-index-build-failure-last-error')).toBeNull();
    expect(detail.textContent).not.toContain('the family compiler refused the filled unit');
  });

  it("shows the same BUILD_FAILED detail in en: in English, no English sentence", async () => {
    stubFetch();
    render(<I18nProvider initial="en"><DesignIndexView onOpenProject={() => {}} /></I18nProvider>);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'failed',
      route: { decision: 'routed', spine: 'TL', family: 'wrenfield', probability: 0.71 },
      error: { code: 'BUILD_FAILED', message: 'the build failed' },
      failure: {
        step: 'building',
        unit: 'hero',
        reason: 'invalid',
        slot: 'hero.claim',
        lastError: 'hero: the family compiler refused the filled unit at hero.claim',
      },
      finishedAt: '2026-09-20T10:01:00.000Z',
    });
    const detail = await screen.findByTestId('design-index-build-failure');
    expect(screen.getByTestId('design-index-build-failure-step').textContent).toContain(en['designIndex.build.status.building']);
    expect(screen.getByTestId('design-index-build-failure-reason').textContent).toContain(en['designIndex.build.failure.reason.invalid']);
    expect(screen.getByTestId('design-index-build-failure-unit').textContent).toContain('hero');
    expect(screen.getByTestId('design-index-build-failure-slot').textContent).toContain('hero.claim');
    // Neither the English step/reason words nor the daemon's own English sentence ever surface.
    expect(screen.queryByTestId('design-index-build-failure-last-error')).toBeNull();
    expect(detail.textContent).not.toContain('the family compiler refused the filled unit');
  });

  it('names the spine a failed build\'s family was admitted from beside the top spine', async () => {
    stubFetch();
    render(<DesignIndexView onOpenProject={() => {}} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'failed',
      route: { decision: 'routed', spine: 'TL', viaSpine: 'SM', family: 'listings', probability: 0.97 },
      error: { code: 'VERIFY_FAILED', message: 'the build did not pass the faithfulness check and nothing was published' },
      failure: { step: 'verifying' },
      finishedAt: '2026-09-20T10:01:00.000Z',
    });
    const row = await screen.findByTestId('design-index-build-failure-route');
    expect(row.textContent).toContain('spine TL, family listings via spine SM, confidence 0.97');
  });

  it('asks for the snapshot rather than crying failure when the stream dies', async () => {
    stubFetch({ snapshot: done() });
    render(<DesignIndexView onOpenProject={() => {}} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    FakeEventSource.last!.fail();
    const outcome = await screen.findByTestId('design-index-build-outcome');
    expect(outcome.textContent).toContain(en['designIndex.build.status.done']);
    expect(screen.queryByTestId('design-index-build-error')).toBeNull();
  });

  it('gets the stream back when it dies on a build that is still running', async () => {
    stubFetch();
    render(<DesignIndexView onOpenProject={() => {}} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    const first = FakeEventSource.last!;

    first.fail();
    await waitFor(() => expect(FakeEventSource.last).not.toBe(first));
    expect(FakeEventSource.last!.url).toBe('/api/agency/builds/build-1/agui');
    expect(screen.queryByTestId('design-index-build-error')).toBeNull();

    emitBuildEnd(FakeEventSource.last!, done());
    const outcome = await screen.findByTestId('design-index-build-outcome');
    expect(outcome.textContent).toContain(en['designIndex.build.status.done']);
    expect(screen.queryByTestId('design-index-build-error')).toBeNull();
  });

  it.each([
    ['VERIFY_FAILED', 'designIndex.build.error.verifyFailed'],
    ['MODEL_UNAVAILABLE', 'designIndex.build.error.modelUnavailable'],
    ['ROLLBACK_FAILED', 'designIndex.build.error.rollbackFailed'],
    ['JEV_UNAVAILABLE', 'designIndex.error.jevUnavailable'],
    ['BUILD_FAILED', 'designIndex.build.status.failed'],
  ] as const)('says what went wrong for %s, not just that something did', async (code, key) => {
    // A strict build that finds a fabrication is the expected outcome of a strict build, and it
    // must not read like a model outage or a leftover project.
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'failed',
      error: { code, message: 'the daemon\'s own English, which is never what a person reads' },
      finishedAt: '2026-09-20T10:01:00.000Z',
    });
    const outcome = await screen.findByTestId('design-index-build-outcome');
    expect(outcome.textContent).toContain(en[key]);
    expect(outcome.textContent).not.toContain('never what a person reads');
    // Only the generic code may fall back to the bare status sentence.
    if (code !== 'BUILD_FAILED') {
      expect(outcome.textContent).not.toBe(en['designIndex.build.status.failed']);
    }
  });

  it('falls back to the generic sentence for a code it does not know', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'failed',
      // A code the daemon may add later; the stream carries it as-is.
      error: { code: 'SOMETHING_NEW' as never, message: 'x' },
      finishedAt: '2026-09-20T10:01:00.000Z',
    });
    const outcome = await screen.findByTestId('design-index-build-outcome');
    expect(outcome.textContent).toContain(en['designIndex.build.status.failed']);
  });

  it('shows the fixed sentence when the build fails', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'failed',
      error: { code: 'BUILD_FAILED', message: 'the build failed' },
      finishedAt: '2026-09-20T10:01:00.000Z',
    });
    const outcome = await screen.findByTestId('design-index-build-outcome');
    expect(outcome.textContent).toContain(en['designIndex.build.status.failed']);
    // The daemon's own English message has no locale, so it is never what a person reads.
    expect(outcome.textContent).not.toContain('the build failed');
  });

  it('routes a 503 to the Settings button the Route panel already owns', async () => {
    // A 500 carrying the daemon's own JEV_UNAVAILABLE code: the code decides, not the status.
    stubFetch({ buildStatus: 500, buildError: { code: 'JEV_UNAVAILABLE', message: 'Jev is not available on this daemon' } });
    const sections: string[] = [];
    render(<DesignIndexView onOpenSettings={(section) => { sections.push(section); }} />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));

    const settings = await screen.findByTestId('design-index-build-open-settings');
    fireEvent.click(settings);
    expect(sections).toEqual(['media']);
    expect(FakeEventSource.last).toBeUndefined();
  });

  it('says so when a build is already running on the daemon', async () => {
    stubFetch({ buildStatus: 500, buildError: { code: 'BUILD_BUSY', message: 'busy' } });
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));

    const alert = await screen.findByTestId('design-index-build-error');
    expect(alert.textContent).toContain(en['designIndex.build.busy']);
    expect(FakeEventSource.last).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The selectable-section picker (sol-design.md §1/§2/§3): one extra section, from
// GET /api/sections, on top of the routed family's fixed recipe.
// ---------------------------------------------------------------------------

const INSERTABLE_ENTRY = {
  id: 'hyperui:marketing/ctas/1',
  title: 'Centered CTA',
  sourceKind: 'hyperui',
  sectionKind: 'cta-band',
  spineAffinities: 'any',
  rights: { license: 'MIT', decision: 'bundle', evidence: 'plugins/_official/shared/ui-kits/hyperui/LICENSE' },
  access: 'local',
  availability: 'insertable',
  preview: { kind: 'none' },
  content: { kind: 'vendored-block', blockId: 'marketing/ctas/1', adapterId: 'hyperui:marketing/ctas/1', sha256: 'a'.repeat(64) },
};

const STARTING_POINT_ENTRY = {
  id: 'motionsites-prompt:remote-1',
  title: 'Studio launch landing page',
  sourceKind: 'motionsites-prompt',
  sectionKind: 'page-composition',
  spineAffinities: ['TL'],
  rights: { license: 'proprietary', decision: 'metadata-only', evidence: 'motionsites.ai/mcp' },
  access: 'free-account',
  availability: 'reference-only',
  preview: { kind: 'external-link', url: 'https://motionsites.ai/templates#remote-1' },
  content: { kind: 'motion-prompt', remoteId: 'remote-1', url: 'https://motionsites.ai/templates#remote-1' },
};

// As `GET /api/sections` serves a Cult entry: public id, scrubbed summary, display title as the
// source title (apps/daemon/src/routes/sections.ts `publicCultEntry`).
const CULT_SECTION_ENTRY = {
  id: 'cult:pricing-series-v',
  title: 'Pricing (series V)',
  sourceKind: 'cult-pro',
  sectionKind: 'pricing',
  sourceType: 'marketing-pricing',
  spineAffinities: ['PA'],
  rights: { license: 'licensed', decision: 'bundle', evidence: 'docs/legal/cult-ui-pro-rights.md' },
  access: 'local',
  availability: 'adapter-needed',
  preview: { kind: 'none' },
  content: {
    kind: 'cult-item',
    summary: 'Pricing section with a billing toggle.',
    sourceTitle: 'Pricing (series V)',
    provenance: { cultId: 'cult:pricing-series-v', snapshotId: 'cult-ui-pro@6b9560102fcd5ae5' },
  },
};

const CULT_PAGE_ENTRY = {
  ...CULT_SECTION_ENTRY,
  id: 'cult:landing-saas-colorful',
  title: 'SaaS Colorful',
  sectionKind: 'page-composition',
  sourceType: 'landing-page',
  content: { ...CULT_SECTION_ENTRY.content, sourceTitle: 'SaaS Colorful', provenance: { cultId: 'cult:landing-saas-colorful', snapshotId: 'cult-ui-pro@6b9560102fcd5ae5' } },
};

const DIRECTIONS = [{ id: 'modern-minimal', label: 'Modern minimal' }, { id: 'editorial-monocle', label: "Mobile" }];

describe('DesignIndexView — the selectable section picker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.last = undefined;
    cleanup();
  });

  it('lists insertable entries and starting points, and shows placement/direction once one is picked', async () => {
    stubFetch({ sectionCatalogEntries: [INSERTABLE_ENTRY, STARTING_POINT_ENTRY], sectionCatalogDirections: DIRECTIONS });
    render(<DesignIndexView />);
    await route();

    const entryRadio = await screen.findByTestId(`design-index-build-section-entry-${INSERTABLE_ENTRY.id}`);
    expect(screen.queryByTestId('design-index-build-section-placement')).toBeNull();
    const reference = within(screen.getByTestId('design-index-build-section-starting-points')).getByRole('button', { name: 'Use as reference' });
    expect(reference.classList.contains(buttonStyles.ghost!)).toBe(true);
    expect(reference.classList.contains(buttonStyles.sm!)).toBe(true);
    fireEvent.click(entryRadio);
    await screen.findByTestId('design-index-build-section-placement');
    expect(screen.getByTestId('design-index-build-section-direction')).toBeTruthy();
    fireEvent.click(reference);
    expect((screen.getByTestId('design-index-build-section-reference') as HTMLInputElement).value).toBe(STARTING_POINT_ENTRY.id);
  });

  it('lists Cult entries as "Adapter needed", never as a selectable section or a design-reference starting point', async () => {
    stubFetch({ sectionCatalogEntries: [INSERTABLE_ENTRY, CULT_SECTION_ENTRY, CULT_PAGE_ENTRY], sectionCatalogDirections: DIRECTIONS });
    render(<DesignIndexView />);
    await route();

    await screen.findByTestId(`design-index-build-section-entry-${INSERTABLE_ENTRY.id}`);
    for (const entry of [CULT_SECTION_ENTRY, CULT_PAGE_ENTRY]) {
      expect(screen.queryByTestId(`design-index-build-section-entry-${entry.id}`)).toBeNull();
      expect(screen.queryByTestId(`design-index-build-section-starting-point-${entry.id}`)).toBeNull();
    }
    expect(screen.queryByTestId('design-index-build-section-starting-points')).toBeNull();
    const other = screen.getByTestId('design-index-build-section-other');
    expect(other.textContent).toContain('Pricing (series V)');
    expect(other.textContent).toContain('SaaS Colorful');
    expect(other.textContent).toContain(en['designIndex.build.section.availability.adapterNeeded']);
    expect(other.textContent).not.toContain('Vercel');
  });

  it('sends sectionSelection and designReferenceId on the build request once placed and directed', async () => {
    const { calls } = stubFetch({ sectionCatalogEntries: [INSERTABLE_ENTRY], sectionCatalogDirections: DIRECTIONS });
    render(<DesignIndexView />);
    await route();

    fireEvent.click(await screen.findByTestId(`design-index-build-section-entry-${INSERTABLE_ENTRY.id}`));
    fireEvent.change(await screen.findByTestId('design-index-build-section-placement-id'), { target: { value: 'hero' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-direction'), { target: { value: 'modern-minimal' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-reference'), { target: { value: 'zerosum-kit:launch-1' } });
    fireEvent.click(screen.getByTestId('design-index-build-run'));

    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    const buildCall = calls.find((call) => call.url === '/api/agency/build')!;
    expect(buildCall.body.sectionSelection).toEqual({
      entryId: INSERTABLE_ENTRY.id,
      placement: { mode: 'append', afterSectionId: 'hero' },
      directionId: 'modern-minimal',
    });
    expect(buildCall.body.designReferenceId).toBe('zerosum-kit:launch-1');
  });

  it('never sends a half-made selection (no placement id yet)', async () => {
    const { calls } = stubFetch({ sectionCatalogEntries: [INSERTABLE_ENTRY], sectionCatalogDirections: DIRECTIONS });
    render(<DesignIndexView />);
    await route();

    fireEvent.click(await screen.findByTestId(`design-index-build-section-entry-${INSERTABLE_ENTRY.id}`));
    fireEvent.click(screen.getByTestId('design-index-build-run'));

    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    const buildCall = calls.find((call) => call.url === '/api/agency/build')!;
    expect(buildCall.body.sectionSelection).toBeUndefined();
  });

  it('shows a localized message for MOTIONSITES_LOGIN_REQUIRED', async () => {
    stubFetch({
      sectionCatalogEntries: [INSERTABLE_ENTRY],
      sectionCatalogDirections: DIRECTIONS,
      buildStatus: 401,
      buildError: { code: 'MOTIONSITES_LOGIN_REQUIRED', message: 'No MotionSites connection.' },
    });
    render(<DesignIndexView />);
    await route();
    fireEvent.click(await screen.findByTestId(`design-index-build-section-entry-${INSERTABLE_ENTRY.id}`));
    fireEvent.change(await screen.findByTestId('design-index-build-section-placement-id'), { target: { value: 'hero' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-direction'), { target: { value: 'modern-minimal' } });
    fireEvent.click(screen.getByTestId('design-index-build-run'));

    const alert = await screen.findByTestId('design-index-build-error');
    expect(alert.textContent).toContain(en['designIndex.build.section.reference.loginRequired']);
    // The daemon's own English sentence never reaches the screen — same rule as every other code.
    expect(alert.textContent).not.toContain('No MotionSites connection.');
  });

  it('shows a localized message for MOTIONSITES_PAID_ACCESS_REQUIRED', async () => {
    stubFetch({
      sectionCatalogEntries: [INSERTABLE_ENTRY],
      sectionCatalogDirections: DIRECTIONS,
      buildStatus: 403,
      buildError: { code: 'MOTIONSITES_PAID_ACCESS_REQUIRED', message: 'needs a paid plan' },
    });
    render(<DesignIndexView />);
    await route();
    fireEvent.click(await screen.findByTestId(`design-index-build-section-entry-${INSERTABLE_ENTRY.id}`));
    fireEvent.change(await screen.findByTestId('design-index-build-section-placement-id'), { target: { value: 'hero' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-direction'), { target: { value: 'modern-minimal' } });
    fireEvent.click(screen.getByTestId('design-index-build-run'));

    const alert = await screen.findByTestId('design-index-build-error');
    expect(alert.textContent).toContain(en['designIndex.build.section.reference.paidAccessRequired']);
  });

  it('does not mislabel a bare 401/403 (no envelope code) as a MotionSites failure (delta audit finding 4)', async () => {
    stubFetch({
      sectionCatalogEntries: [INSERTABLE_ENTRY],
      sectionCatalogDirections: DIRECTIONS,
      buildStatus: 401,
      buildError: { code: 'UNAUTHORIZED', message: 'some other 401 cause' },
    });
    render(<DesignIndexView />);
    await route();
    fireEvent.click(await screen.findByTestId(`design-index-build-section-entry-${INSERTABLE_ENTRY.id}`));
    fireEvent.change(await screen.findByTestId('design-index-build-section-placement-id'), { target: { value: 'hero' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-direction'), { target: { value: 'modern-minimal' } });
    fireEvent.click(screen.getByTestId('design-index-build-run'));

    const alert = await screen.findByTestId('design-index-build-error');
    expect(alert.textContent).not.toContain(en['designIndex.build.section.reference.loginRequired']);
    expect(alert.textContent).toContain(en['designIndex.build.startFailed']);
  });

  it('shows the access label from the entry and the MotionSites connection status', async () => {
    stubFetch({
      sectionCatalogEntries: [{ ...INSERTABLE_ENTRY, id: 'motionsites-prompt:gated-1', access: 'paid-account' }],
      sectionCatalogDirections: DIRECTIONS,
      motionsitesConnection: 'connected',
    });
    render(<DesignIndexView />);
    await route();
    const row = await screen.findByTestId('design-index-build-section-entry-motionsites-prompt:gated-1');
    expect(row.closest('label')?.textContent).toContain(en['designIndex.build.section.access.paid']);
  });
});

describe('DesignIndexView — composition (family / blocks / auto)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.last = undefined;
    cleanup();
  });

  async function runWithComposition(value: 'family' | 'blocks' | 'auto', verify?: 'advisory' | 'after') {
    const stub = stubFetch({ sectionCatalogEntries: [INSERTABLE_ENTRY], sectionCatalogDirections: DIRECTIONS });
    render(<DesignIndexView />);
    await route();
    // A verify choice made first must not leak into a composed build.
    if (verify) fireEvent.change(screen.getByTestId('design-index-build-verify-mode'), { target: { value: verify } });
    fireEvent.change(screen.getByTestId('design-index-build-composition'), { target: { value } });
    return stub;
  }

  it('defaults to Family and sends no composition field', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await route();
    expect((screen.getByTestId('design-index-build-composition') as HTMLSelectElement).value).toBe('family');
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    expect(calls.find((call) => call.url === '/api/agency/build')?.body).not.toHaveProperty('composition');
  });

  it('keeps the chosen verify mode for Family', async () => {
    const { calls } = await runWithComposition('family', 'after');
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    const body = calls.find((call) => call.url === '/api/agency/build')!.body;
    expect(body).not.toHaveProperty('composition');
    expect(body.verify).toBe('after');
  });

  it('sends composition "blocks" with verify strict, even after advisory was chosen, and pins the verify select', async () => {
    const { calls } = await runWithComposition('blocks', 'advisory');
    const verify = screen.getByTestId('design-index-build-verify-mode') as HTMLSelectElement;
    expect(verify.value).toBe('strict');
    expect(verify.disabled).toBe(true);
    expect(Array.from(verify.options).map((option) => option.value)).toEqual(['strict']);
    expect(screen.getByTestId('design-index-build-composition-hint').textContent)
      .toBe(en['designIndex.build.composition.strictHint']);

    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    const body = calls.find((call) => call.url === '/api/agency/build')!.body;
    expect(body.composition).toBe('blocks');
    expect(body.verify).toBe('strict');
  });

  it('sends composition "auto" with verify strict after "after" was chosen', async () => {
    const { calls } = await runWithComposition('auto', 'after');
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    const body = calls.find((call) => call.url === '/api/agency/build')!.body;
    expect(body.composition).toBe('auto');
    expect(body.verify).toBe('strict');
    // The routed family the panel shows is never sent: a named family would make auto fall back
    // with `family-named` before it could compose.
    expect(body.family).toBe('auto');
  });

  it('names the composition, not the routed family, on the Run button for Blocks and Auto', async () => {
    await runWithComposition('family');
    const run = screen.getByTestId('design-index-build-run');
    const familyLabel = run.textContent ?? '';
    expect(familyLabel).not.toBe(en['designIndex.build.runBlocks']);
    fireEvent.change(screen.getByTestId('design-index-build-composition'), { target: { value: 'blocks' } });
    expect(run.textContent).toBe(en['designIndex.build.runBlocks']);
    fireEvent.change(screen.getByTestId('design-index-build-composition'), { target: { value: 'auto' } });
    expect(run.textContent).toBe(en['designIndex.build.runAuto']);
    fireEvent.change(screen.getByTestId('design-index-build-composition'), { target: { value: 'family' } });
    expect(run.textContent).toBe(familyLabel);
  });

  it('sends family "auto" for Blocks too, and the routed family for Family', async () => {
    const blocks = await runWithComposition('blocks');
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(blocks.calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    expect(blocks.calls.find((call) => call.url === '/api/agency/build')!.body.family).toBe('auto');
    cleanup();
    vi.unstubAllGlobals();
    const family = await runWithComposition('family');
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(family.calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    const sent = family.calls.find((call) => call.url === '/api/agency/build')!.body.family;
    expect(typeof sent === 'string' && sent !== 'auto').toBe(true);
  });

  it('turns the section picker off and never sends a sectionSelection with a composed build', async () => {
    const { calls } = stubFetch({ sectionCatalogEntries: [INSERTABLE_ENTRY], sectionCatalogDirections: DIRECTIONS });
    render(<DesignIndexView />);
    await route();
    // A complete selection made under Family...
    fireEvent.click(await screen.findByTestId(`design-index-build-section-entry-${INSERTABLE_ENTRY.id}`));
    fireEvent.change(await screen.findByTestId('design-index-build-section-placement-id'), { target: { value: 'hero' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-direction'), { target: { value: 'modern-minimal' } });
    fireEvent.change(screen.getByTestId('design-index-build-section-reference'), { target: { value: 'zerosum-kit:launch-1' } });
    // ...is dropped once Blocks is chosen.
    fireEvent.change(screen.getByTestId('design-index-build-composition'), { target: { value: 'blocks' } });
    expect((screen.getByTestId(`design-index-build-section-entry-${INSERTABLE_ENTRY.id}`) as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/build')).toBe(true));
    const body = calls.find((call) => call.url === '/api/agency/build')!.body;
    expect(body.composition).toBe('blocks');
    expect(body).not.toHaveProperty('sectionSelection');
    expect(body).not.toHaveProperty('designReferenceId');
  });

  it('shows a finished composed build\'s blocks in order, its direction and spine', async () => {
    stubFetch();
    render(<DesignIndexView onOpenProject={() => {}} />);
    await route();
    fireEvent.change(screen.getByTestId('design-index-build-composition'), { target: { value: 'blocks' } });
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEnd(FakeEventSource.last!, done({
      composition: {
        requested: 'blocks',
        used: 'blocks',
        spine: 'S3',
        directionId: 'editorial-monocle',
        blocks: ['cult:hero/split', 'hyperui:marketing/ctas/1', 'cult:footer/simple'],
        budgetDropped: ['hyperui:marketing/testimonials/3'],
      },
    }));

    const summary = await screen.findByTestId('agency-composition');
    const ids = Array.from(summary.querySelectorAll('ol li')).map((li) => li.getAttribute('data-block-id'));
    expect(ids).toEqual(['cult:hero/split', 'hyperui:marketing/ctas/1', 'cult:footer/simple']);
    expect(screen.getByTestId('agency-composition-direction').textContent).toContain('editorial-monocle');
    expect(screen.getByTestId('agency-composition-spine').textContent).toContain('S3');
    expect(screen.getByTestId('agency-composition-budget-dropped').textContent).toContain('hyperui:marketing/testimonials/3');
    expect(screen.getByTestId('design-index-build-open-project')).toBeTruthy();
  });
});
