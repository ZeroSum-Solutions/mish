// @vitest-environment jsdom

// The Build panel's Effects block and result card (Sol ruling 2026-09-25).
//
// What these cases hold: Auto is the default and sends no field; Off sends `off`; once the routed
// family's placements load, each placement offers Auto / None / its allowed components labelled
// "name · kind", and only explicit picks travel; a family with no placements says so; the finished
// build lists applied (placement → component) and skipped (placement → reason) in this locale; and
// the `effects` progress event reads as this locale's words.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgencyBuildSnapshot, AgencyFamilyEffectsResponse, DesignTaxonomy, RouteDecision } from '@open-design/contracts';

import { DesignIndexView } from '../../src/components/DesignIndexView';
import { emitBuildEnd, emitBuildEvent } from '../helpers/agency-build-agui-frames';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';


const TAXONOMY: DesignTaxonomy = {
  version: '1.0',
  sections: [{ id: 'hero', definition: 'The first screen.' }],
  components: [],
  mechanics: [],
  depth: [],
  style: { ground: [], accent: [], typography: [], imagery: [], topology: [], density: [] },
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
  family: { id: 'marketing-site', probability: 0.66, basis: 'exact', transfer: 4 },
  candidates: [],
  warnings: [],
  ms: 590,
  calls: 1,
  model: 'jev-test',
};

const OFFER: AgencyFamilyEffectsResponse = {
  family: 'marketing-site',
  scriptPolicy: 'hash',
  maxEffects: 2,
  placements: [
    { placement: 'hero-title', host: 'marketing-site-hero-heading', allow: [{ id: 'shiny-text', name: 'Shiny Text', kind: 'css-only', bytes: { js: 2341, css: 1677 } }, { id: 'split-text', name: 'Split Text', kind: 'js', bytes: { js: 4714, css: 696 } }] },
    { placement: 'card-surface', host: 'marketing-site-features', allow: [{ id: 'glass-surface', name: 'Glass Surface', kind: 'css-only', bytes: { js: 3444, css: 2022 } }] },
  ],
};

const QUEUED: AgencyBuildSnapshot = { id: 'build-1', status: 'queued', events: [], startedAt: '2026-09-25T10:00:00.000Z' };

class FakeEventSource {
  static last: FakeEventSource | undefined;
  static CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, handler: (event: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(name: string, data: unknown) {
    for (const handler of this.listeners.get(name) ?? []) handler({ data: JSON.stringify(data) } as MessageEvent);
  }
}

interface FetchCall { url: string; method: string; body: any }

function stubFetch(options: { offer?: AgencyFamilyEffectsResponse | 'fail' } = {}) {
  const calls: FetchCall[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url === '/api/design-index/taxonomy') return json({ taxonomy: TAXONOMY });
    if (url.startsWith('/api/design-index')) return json({ profiles: [], matched: 0, total: 0 });
    if (url === '/api/agency/route') return json({ decision: ROUTED });
    if (/^\/api\/agency\/families\/[^/]+\/sections$/.test(url)) return json({ family: 'marketing-site', sections: [], outputScope: 'site' });
    if (/^\/api\/agency\/families\/[^/]+\/effects$/.test(url)) {
      if (options.offer === 'fail') return json({ error: { code: 'INTERNAL_ERROR', message: 'no' } }, 500);
      return json(options.offer ?? OFFER);
    }
    if (url === '/api/agency/build') return json({ build: QUEUED }, 202);
    if (url === '/api/agency/builds') return json({ builds: [] });
    if (url.startsWith('/api/sections')) return json({ catalog: { schema: 'section-catalog/1', entries: [] }, directions: [] });
    if (url === '/api/motionsites/connection') return json({ status: 'not_connected' });
    if (url.startsWith('/api/agency/builds/')) return json({ build: QUEUED });
    throw new Error(`unexpected fetch ${method} ${url}`);
  }));
  vi.stubGlobal('EventSource', FakeEventSource);
  return { calls };
}

async function route() {
  fireEvent.click(await screen.findByTestId('design-index-panel-route'));
  fireEvent.change(screen.getByTestId('design-index-route-brief'), { target: { value: 'A quiet atelier site.' } });
  fireEvent.click(screen.getByTestId('design-index-route-run'));
  await screen.findByTestId('design-index-decision');
}

const buildBody = (calls: FetchCall[]) => calls.find((call) => call.url === '/api/agency/build')?.body;

describe('DesignIndexView — the Effects block', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.last = undefined;
    cleanup();
  });

  it('defaults to Auto and sends no effects field', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await route();
    const mode = await screen.findByTestId('design-index-build-effects-mode') as HTMLSelectElement;
    expect(mode.value).toBe('auto');
    expect([...mode.options].map((option) => option.textContent)).toEqual([
      en['designIndex.build.effects.mode.auto'],
      en['designIndex.build.effects.mode.off'],
    ]);
    await screen.findByTestId('design-index-build-effect-hero-title');
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(buildBody(calls)).toBeDefined());
    expect(buildBody(calls)).not.toHaveProperty('effects');
  });

  it('lists each placement\'s allowed components as "name · kind" and sends only explicit picks', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await route();
    const hero = await screen.findByTestId('design-index-build-effect-hero-title') as HTMLSelectElement;
    expect([...hero.options].map((option) => option.textContent)).toEqual([
      en['designIndex.build.effects.placementAuto'],
      en['designIndex.build.effects.placementNone'],
      `Shiny Text · ${en['designIndex.build.effects.kind.cssOnly']}`,
      `Split Text · ${en['designIndex.build.effects.kind.js']}`,
    ]);
    fireEvent.change(hero, { target: { value: 'split-text' } });
    fireEvent.change(screen.getByTestId('design-index-build-effect-card-surface'), { target: { value: 'none' } });
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(buildBody(calls)).toBeDefined());
    expect(buildBody(calls).effects).toEqual({ 'hero-title': 'split-text', 'card-surface': 'none' });
  });

  it('Blocks and Auto disable the effect controls, say why, and send no effect picks', async () => {
    for (const composition of ['blocks', 'auto'] as const) {
      const { calls } = stubFetch();
      render(<DesignIndexView />);
      await route();
      const hero = await screen.findByTestId('design-index-build-effect-hero-title') as HTMLSelectElement;
      fireEvent.change(hero, { target: { value: 'split-text' } });
      fireEvent.change(screen.getByTestId('design-index-build-composition'), { target: { value: composition } });
      expect((screen.getByTestId('design-index-build-effects-mode') as HTMLSelectElement).disabled).toBe(true);
      expect((screen.getByTestId('design-index-build-effect-hero-title') as HTMLSelectElement).disabled).toBe(true);
      expect(screen.getByTestId('design-index-build-composition-effects-hint').textContent).toBe(en['designIndex.build.composition.effectsOffHint']);
      fireEvent.click(screen.getByTestId('design-index-build-run'));
      await waitFor(() => expect(buildBody(calls)).toBeDefined());
      expect(buildBody(calls)).not.toHaveProperty('effects');
      expect(buildBody(calls).composition).toBe(composition);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('sends off and hides the per-placement pickers when Off is chosen', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await route();
    await screen.findByTestId('design-index-build-effect-hero-title');
    fireEvent.change(screen.getByTestId('design-index-build-effects-mode'), { target: { value: 'off' } });
    expect(screen.queryByTestId('design-index-build-effect-hero-title')).toBeNull();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(buildBody(calls)).toBeDefined());
    expect(buildBody(calls).effects).toBe('off');
  });

  it('says so when the family offers no placements, and offers a retry when the read fails', async () => {
    stubFetch({ offer: { family: 'marketing-site', scriptPolicy: 'none', maxEffects: 0, placements: [] } });
    render(<DesignIndexView />);
    await route();
    expect((await screen.findByTestId('design-index-build-effects-none')).textContent).toBe(en['designIndex.build.effects.none']);
    cleanup();
    vi.unstubAllGlobals();

    stubFetch({ offer: 'fail' });
    render(<DesignIndexView />);
    await route();
    expect(await screen.findByTestId('design-index-build-effects-retry')).toBeTruthy();
  });

  it("shows the finished build's applied and skipped placements, in English", async () => {
    stubFetch();
    render(<I18nProvider initial="en"><DesignIndexView /></I18nProvider>);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEvent(FakeEventSource.last!, { seq: 1, at: '2026-09-25T10:00:01.000Z', type: 'effects', ms: 12, label: '1 applied, 1 skipped' });
    await waitFor(() => expect(screen.getByTestId('design-index-build-progress').textContent)
      .toContain(en['designIndex.build.event.effects'].replace('{applied}', '1').replace('{skipped}', '1')));
    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'done',
      projectId: 'project-1',
      finishedAt: '2026-09-25T10:01:00.000Z',
      effects: {
        mode: 'mixed',
        applied: [
          { placement: 'hero-title', componentId: 'shiny-text', kind: 'css-only', source: 'hint' },
          { placement: 'cta', componentId: 'glare-hover', kind: 'css-only', source: 'repair' },
        ],
        skipped: [
          { placement: 'card-surface', componentId: 'glass-surface', reason: 'max-effects' },
          // A reason code this web build predates: its own "other" sentence, never the raw code.
          { placement: 'section-title', componentId: 'split-text', reason: 'held-for-review' as never },
        ],
        bytesAdded: 1200,
      },
    });
    const applied = await screen.findByTestId('design-index-build-effects-applied');
    expect(applied.textContent).toContain('hero-title');
    expect(applied.textContent).toContain('shiny-text');
    expect(applied.textContent).toContain(en['designIndex.build.effects.kind.cssOnly']);
    expect(applied.textContent).toContain(en['designIndex.build.effects.source.hint']);
    expect(applied.textContent).toContain(en['designIndex.build.effects.source.repair']);
    const skipped = screen.getByTestId('design-index-build-effects-skipped');
    expect(skipped.textContent).toContain('card-surface');
    expect(skipped.textContent).toContain(en['designIndex.build.effects.reason.maxEffects']);
    expect(skipped.textContent).toContain(en['designIndex.build.effects.reason.unknown']);
    expect(skipped.textContent).not.toContain('held-for-review');
  });

  it('labels an applied effect with a source this client predates as its own fixed string, never a skip reason', async () => {
    stubFetch();
    render(<I18nProvider initial="en"><DesignIndexView /></I18nProvider>);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'done',
      projectId: 'project-1',
      finishedAt: '2026-09-25T10:01:00.000Z',
      effects: {
        mode: 'explicit',
        applied: [{ placement: 'hero-title', componentId: 'shiny-text', kind: 'css-only', source: 'from-the-future' as never }],
        skipped: [],
        bytesAdded: 600,
      },
    });
    const applied = await screen.findByTestId('design-index-build-effects-applied');
    expect(applied.textContent).toContain(en['designIndex.build.effects.source.unknown']);
    expect(applied.textContent).not.toContain(en['designIndex.build.effects.reason.unknown']);
    expect(applied.textContent).not.toContain('from-the-future');
  });

  it('says when Jev did not answer and nothing was applied', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await route();
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'done',
      projectId: 'project-1',
      finishedAt: '2026-09-25T10:01:00.000Z',
      effects: { mode: 'auto', applied: [], skipped: [], jevSkipped: 'jev-timeout', bytesAdded: 0 },
    });
    const card = await screen.findByTestId('design-index-build-effects-result');
    expect(card.textContent).toContain(en['designIndex.build.effects.result.nothing']);
    expect(screen.getByTestId('design-index-build-effects-jev-skipped').textContent).toBe(en['designIndex.build.effects.result.jevSkipped']);
  });
});
