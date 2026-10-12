import { homeBriefPreview } from '../helpers/home-brief-preview';
// @vitest-environment jsdom
//
// "Jev chooses" end to end through the real HomeView: Jev is called exactly
// once, at Send, and only in that mode. A routed family that is installed
// creates the project a manual family-card send would have created; anything
// else is a visible result that creates nothing and keeps the brief.

import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteDecision } from '@open-design/contracts';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

vi.mock('../../src/collab/useWorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/collab/useWorkspaceContext')>();
  return {
    ...actual,
    useWorkspaceContext: () => ({ context: null, loading: false, failure: 'unsupported' as const }),
  };
});

vi.mock('../../src/components/workbench/WorkbenchImprovePrompt', () => ({
  WorkbenchImprovePrompt: ({ onUsePreview }: { onUsePreview: (preview: unknown) => void }) => (
    <button onClick={() => onUsePreview(homeBriefPreview)}>Use reviewed Home prompt</button>
  ),
}));

vi.mock('../../src/analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/events')>();
  return { ...actual, trackHomeChatComposerClick: vi.fn() };
});

import { HomeView, seedHomeComposerPrompt } from '../../src/components/HomeView';
import { I18nProvider } from '../../src/i18n';
import { trackHomeChatComposerClick } from '../../src/analytics/events';
import { writeHomeGuideStage } from '../../src/components/home-hero/firstRunGuide';
import { requestHomeChip } from '../../src/runtime/home-intent';
import { designProfileFixture } from '../fixtures/design-profile';
import { setHomeHeroPrompt, homeHeroPromptText } from '../helpers/home-hero-lexical';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});

const BRIEF = 'A boutique consultancy that wants enterprise clients to trust it';
// Planted in the daemon's error bodies: if any of it reaches the page, the
// notice is echoing upstream text instead of saying what happened.
const SENTINEL = 'UPSTREAM-DETAIL-9f3b';

function pluginRecord(id: string, title: string, skills: Array<{ ref?: string; path?: string }>) {
  return {
    id,
    title,
    version: '0.1.0',
    trust: 'bundled' as const,
    sourceKind: 'bundled' as const,
    source: `/tmp/${id}`,
    capabilitiesGranted: ['prompt:inject'],
    fsPath: `/tmp/${id}`,
    installedAt: 0,
    updatedAt: 0,
    marketplaceTrust: 'official' as const,
    manifest: {
      name: id,
      title,
      version: '0.1.0',
      description: `${title} description.`,
      tags: ['example', 'prototype', 'web'],
      od: {
        kind: 'scenario',
        taskKind: 'new-generation',
        mode: 'prototype',
        useCase: { query: `Seeded brief for ${title}.` },
        context: { skills },
      },
    },
  };
}

const AGENCY_SKILLS = [{ ref: 'agency-site' }, { path: './SKILL.md' }];

const CATALOG = [
  pluginRecord('example-web-prototype', 'Web Prototype', [{ path: './SKILL.md' }]),
  pluginRecord('od-new-generation', 'New generation', [{ path: './SKILL.md' }]),
  pluginRecord('example-agency-watson', 'Watson Trust to Lead', AGENCY_SKILLS),
  pluginRecord('example-agency-maren', 'Maren Maker Studio', AGENCY_SKILLS),
];

/** The catalog minus the family Jev routes to, for the not-installed case. */
const CATALOG_WITHOUT_WATSON = CATALOG.filter((p) => p.id !== 'example-agency-watson');

const APPLY_RESULT = {
  query: 'applied',
  contextItems: [],
  inputs: [],
  assets: [],
  mcpServers: [],
  trust: 'trusted',
  capabilitiesGranted: [],
  capabilitiesRequired: [],
  appliedPlugin: {
    snapshotId: 'snap-watson',
    pluginId: 'example-agency-watson',
    pluginVersion: '0.1.0',
    manifestSourceDigest: 'a'.repeat(64),
    inputs: {},
    resolvedContext: { items: [] },
    capabilitiesGranted: [],
    capabilitiesRequired: [],
    assetsStaged: [],
    taskKind: 'new-generation',
    appliedAt: 0,
    connectorsRequired: [],
    connectorsResolved: [],
    mcpServers: [],
    status: 'fresh',
  },
  projectMetadata: {},
};

function routedDecision(family = 'watson'): RouteDecision {
  return {
    decision: 'routed',
    spine: { code: 'TL', name: 'Trust to lead', confidence: 0.91, probabilities: { TL: 0.91 } },
    spines: [{ code: 'TL', probability: 0.91 }],
    archetype: { id: 'TL.05', name: 'Agency, consultancy, or studio', confidence: 0.77 },
    skin: { choice: 'Editorial', confidence: 0.6 },
    family: { id: family, probability: 0.82, basis: 'exact', transfer: 6 },
    candidates: [
      { family, probability: 0.82, basis: 'exact', transfer: 6, archetype: 'TL.05', skin: 'Editorial', viaSpine: 'TL' },
    ],
    warnings: [],
    ms: 430,
    calls: 1,
    model: 'test-model',
  };
}

function unroutedDecision(): RouteDecision {
  return {
    decision: 'unrouted',
    reason: 'family maren at p=0.31 below 0.5',
    spine: { code: 'CO', name: 'Commerce', confidence: 0.55, probabilities: { CO: 0.55 } },
    spines: [{ code: 'CO', probability: 0.55 }],
    archetype: { id: 'CO.01', name: 'Direct-to-consumer storefront', confidence: 0.5 },
    skin: { choice: 'Editorial', confidence: 0.4 },
    candidates: [
      { family: 'maren', probability: 0.31, basis: 'same-spine', transfer: 4, archetype: 'CO.01', skin: 'Editorial', viaSpine: 'CO' },
      { family: 'watson', probability: 0.18, basis: 'compatible', transfer: 2, archetype: 'TL.05', skin: 'Editorial', viaSpine: 'TL' },
    ],
    warnings: [],
    ms: 410,
    calls: 1,
    model: 'test-model',
  };
}

// One stored reference so the strip has a reference card to click, and its
// routed family is the OTHER installed family — a mid-flight click on it would
// contradict Jev's choice loudly if it were allowed through.
const REFERENCE = designProfileFixture({
  digest: 'digest-maren',
  title: 'Maren reference',
  spine: 'TL',
  familyId: 'maren',
});

/** The router could not even name a spine — nothing structured to report. */
function spinelessDecision(): RouteDecision {
  return {
    decision: 'unrouted',
    reason: 'no spine',
    spine: { code: 'none', name: 'none', confidence: 0, probabilities: {} },
    spines: [],
    skin: { choice: 'unspecified', confidence: 0 },
    candidates: [],
    warnings: [],
    ms: 120,
    calls: 1,
    model: 'test-model',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface StubOptions {
  applyResult?: typeof APPLY_RESULT;
  plugins?: unknown[];
  route?: (brief: string) => Promise<Response> | Response;
}

function stubFetch(options: StubOptions = {}) {
  const routeCalls: string[] = [];
  const routeSignals: Array<AbortSignal | null> = [];
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const href = String(url);
    if (href === '/api/plugins') return json({ plugins: options.plugins ?? CATALOG });
    if (href.startsWith('/api/design-index')) {
      return json({ profiles: [REFERENCE], matched: 1, total: 1 });
    }
    if (href === '/api/agency/route') {
      const brief = JSON.parse(String(init?.body ?? '{}')).brief as string;
      routeCalls.push(brief);
      routeSignals.push(init?.signal ?? null);
      return options.route ? options.route(brief) : json({ decision: routedDecision() });
    }
    if (href.includes('/apply-local') || href.includes('/apply')) return json(options.applyResult ?? APPLY_RESULT);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(window.performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  return { fetchMock, routeCalls, routeSignals };
}

function renderHome(onSubmit: (payload: import('../../src/components/PluginLoopHome').PluginLoopSubmit) => Promise<boolean> | void) {
  writeHomeGuideStage('done');
  return render(
    <I18nProvider initial="en">
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />
    </I18nProvider>,
  );
}

async function pickJevChooses() {
  fireEvent.click(await screen.findByTestId('home-hero-jev-chooses'));
  await act(async () => { await Promise.resolve(); });
}

async function send() {
  fireEvent.click(await screen.findByTestId('home-hero-submit'));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A route call the test holds open, so the in-flight window is observable. */
function heldRoute() {
  let release: (() => void) | null = null;
  const route = () => new Promise<Response>((resolve) => {
    release = () => resolve(json({ decision: routedDecision() }));
  });
  return {
    route,
    async inFlight() {
      await waitFor(() => expect(release).not.toBeNull());
    },
    release() {
      release!();
    },
  };
}

function familyCard(id: string): HTMLElement {
  return screen.getAllByTestId('home-hero-plugin-preset')
    .find((card) => card.getAttribute('data-plugin-id') === id)!;
}

function sendButton(): HTMLButtonElement {
  return screen.getByTestId('home-hero-submit') as HTMLButtonElement;
}

/**
 * Every trigger the composer lock closes is open again. Asserted on each way a
 * route can end — created, refused, failed, discarded — because a lock that
 * only lifts on the happy path strands the user on every other one.
 */
const LOCKED_TRIGGERS = [
  'home-hero-design-system-trigger',
  'home-hero-template-trigger',
  'working-dir-trigger',
  'home-hero-file-input',
  'home-hero-plus-trigger',
] as const;

function expectComposerRestored(label: string) {
  expect(sendButton().getAttribute('aria-label'), label).not.toBe('Jev is choosing…');
  for (const testId of LOCKED_TRIGGERS) {
    const control = screen.queryByTestId(testId) as
      | HTMLButtonElement
      | HTMLInputElement
      | null;
    if (control) expect(control.disabled, `${label}: ${testId}`).toBe(false);
  }
}

describe('HomeView — Jev chooses', () => {
  it('routes once for Home Improve, then reuses the route and accepted binding on Send', async () => {
    const onSubmit = vi.fn(async (_payload: import('../../src/components/PluginLoopHome').PluginLoopSubmit) => true);
    const { routeCalls } = stubFetch();
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');
    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    fireEvent.click(screen.getByTestId('home-improve-prompt-button'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use reviewed Home prompt' }));
    expect(routeCalls).toEqual([BRIEF]);
    expect(onSubmit).toHaveBeenCalledTimes(0);
    await send();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(routeCalls).toEqual([BRIEF]);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      acceptedBrief: homeBriefPreview,
      projectMetadata: { agencyRoute: { familyId: 'watson', spine: 'TL', probability: 0.82 } },
    });
    const sendClicks = vi.mocked(trackHomeChatComposerClick).mock.calls.filter(call => call[1].element === 'send_button');
    expect(sendClicks).toHaveLength(1);
  });

  it('does not reuse a prepared Jev decision after the user leaves Jev mode', async () => {
    const onSubmit = vi.fn(async (_payload: import('../../src/components/PluginLoopHome').PluginLoopSubmit) => true);
    stubFetch();
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');
    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    fireEvent.click(screen.getByTestId('home-improve-prompt-button'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use reviewed Home prompt' }));
    await pickJevChooses();
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent('The Home setup changed');
    expect(onSubmit).toHaveBeenCalledTimes(0);
    await send();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].projectMetadata?.agencyRoute).toBeUndefined();
    expect(onSubmit.mock.calls[0]![0].acceptedBrief).toBeUndefined();
  });

  it('cancels an accepted send if Home unmounts during plugin preparation', async () => {
    const onSubmit = vi.fn(async (_payload: import('../../src/components/PluginLoopHome').PluginLoopSubmit) => true);
    const staleApply = { ...APPLY_RESULT, appliedPlugin: { ...APPLY_RESULT.appliedPlugin, inputs: { old: 'value' } } };
    const { fetchMock } = stubFetch({ applyResult: staleApply });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');
    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    fireEvent.click(screen.getByTestId('home-improve-prompt-button'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use reviewed Home prompt' }));
    const original = fetchMock.getMockImplementation()!;
    let finishApply: (() => void) | undefined;
    fetchMock.mockImplementation((url, init) => String(url).includes('/apply')
      ? new Promise(resolve => { finishApply = () => resolve(json(staleApply)); })
      : original(url, init));
    fireEvent.click(sendButton());
    await waitFor(() => expect(finishApply).toBeDefined());
    cleanup();
    await act(async () => { finishApply!(); await settle(); });
    expect(onSubmit).toHaveBeenCalledTimes(0);
  });

  it('never calls Jev before Send', async () => {
    const { routeCalls } = stubFetch();
    renderHome(vi.fn().mockResolvedValue(true));
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await settle();

    expect(routeCalls).toEqual([]);
    expect(screen.getByTestId('home-hero-jev-chooses').getAttribute('aria-pressed')).toBe('true');
  });

  it('lets an unrouted brief leave Jev mode and submit unchanged through normal creation', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { routeCalls } = stubFetch({ route: () => json({ decision: unroutedDecision() }) });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();
    await screen.findByTestId('home-hero-jev-notice');
    expect(onSubmit).not.toHaveBeenCalled();

    await pickJevChooses();
    expect(screen.getByTestId('home-hero-jev-chooses').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('home-hero-jev-notice')).toBeNull();
    expect(homeHeroPromptText()).toBe(BRIEF);
    expect(window.localStorage.getItem('open-design:home-composer:jev-chooses')).toBeNull();
    await send();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.prompt).toBe(BRIEF);
    expect(payload.projectMetadata?.agencyRoute).toBeUndefined();
    expect(routeCalls).toEqual([BRIEF]);
  });

  it('routes once and creates the project with the routed family and the agency skill', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { routeCalls } = stubFetch();
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // One call, with the user's visible brief and nothing else.
    expect(routeCalls).toEqual([BRIEF]);

    const payload = onSubmit.mock.calls[0]![0] as Record<string, any>;
    expect(payload.prompt).toBe(BRIEF);
    expect(payload.pluginId).toBe('example-agency-watson');
    expect(payload.skillId).toBe('agency-site');
    // The pinned family owns the route — never the automatic OD Next profile.
    expect(payload.automaticStrategyTaskProfile).toBeUndefined();
    expect(payload.appliedPluginSnapshotId).toBe('snap-watson');
    // Jev's decision travels with the project it produced.
    expect(payload.projectMetadata.agencyRoute).toEqual({
      familyId: 'watson',
      spine: 'TL',
      archetype: 'TL.05',
      probability: 0.82,
    });

    const emissions = vi.mocked(trackHomeChatComposerClick).mock.calls
      .map((call) => call[1] as unknown as Record<string, unknown>)
      .filter((props) => props.element === 'jev_chooses');
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      chip_id: 'prototype',
      routed_family_id: 'watson',
      plugin_id: 'example-agency-watson',
    });
    expectComposerRestored('created');
  });

  it('shows the decision and its candidates and creates nothing when Jev routes nothing', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    stubFetch({ route: () => json({ decision: unroutedDecision() }) });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();

    const notice = await screen.findByTestId('home-hero-jev-notice');
    // What Jev leaned to, in the product's own localized vocabulary…
    expect(notice.textContent).toContain('Commerce');
    expect(notice.textContent).toContain('Ecommerce retailer');
    // …and the ranked candidates it got closest to.
    expect(notice.textContent).toContain('maren 31%');
    expect(notice.textContent).toContain('watson 18%');
    // The router's own English machine fragment is never rendered: it would
    // read as untranslated debug output in eighteen of the nineteen locales.
    expect(notice.textContent).not.toContain('p=0.31');
    expect(notice.textContent).not.toContain('below 0.5');
    // A result, not an error: no project, and the brief is still there.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(homeHeroPromptText()).toContain(BRIEF);
  });

  it('names the family and creates nothing when its generator is not installed', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    stubFetch({ plugins: CATALOG_WITHOUT_WATSON });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();

    const notice = await screen.findByTestId('home-hero-jev-notice');
    expect(notice.textContent).toContain('watson');
    expect(notice.textContent).toContain('not installed');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(homeHeroPromptText()).toContain(BRIEF);

    // The route is still reported: which family Jev picked, and that we did
    // not have it, is exactly what the funnel needs.
    const emissions = vi.mocked(trackHomeChatComposerClick).mock.calls
      .map((call) => call[1] as unknown as Record<string, unknown>)
      .filter((props) => props.element === 'jev_chooses');
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({ routed_family_id: 'watson' });
    expect(emissions[0]).not.toHaveProperty('plugin_id');
  });

  it('says Jev is unavailable when the daemon has no key for it', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    stubFetch({
      route: () => json({ error: { code: 'JEV_UNAVAILABLE', message: 'no key' } }, 503),
    });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();

    const notice = await screen.findByTestId('home-hero-jev-notice');
    expect(notice.textContent).toContain('TypeSafe key');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('says Jev failed on an upstream failure', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    stubFetch({ route: () => json({ error: { code: 'JEV_FAILED', message: 'upstream' } }, 502) });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();

    const notice = await screen.findByTestId('home-hero-jev-notice');
    expect(notice.textContent).toContain('Jev could not choose a family.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('discards a decision for a brief the user has since rewritten', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    let release: (() => void) | null = null;
    stubFetch({
      route: () => new Promise<Response>((resolve) => {
        release = () => resolve(json({ decision: routedDecision() }));
      }),
    });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();
    await waitFor(() => expect(release).not.toBeNull());

    // The answer that comes back belongs to a brief that no longer exists.
    // Released with no settle in between: the response must lose to the edit
    // even when it lands before React has committed anything.
    setHomeHeroPrompt('Actually, a subscription box for climbing gear');
    release!();
    await settle();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('home-hero-jev-notice')).toBeNull();
    expect(screen.queryByTestId('home-hero-active-plugin')?.textContent ?? '')
      .not.toContain('Watson');
  });

  it('leaves the mode when the user picks a family card themselves', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { routeCalls } = stubFetch();
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    const maren = (await screen.findAllByTestId('home-hero-plugin-preset'))
      .find((card) => card.getAttribute('data-plugin-id') === 'example-agency-maren')!;
    fireEvent.click(maren);
    await settle();

    expect(screen.getByTestId('home-hero-jev-chooses').getAttribute('aria-pressed')).toBe('false');

    setHomeHeroPrompt(BRIEF);
    await send();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    // The human override stands: no Jev call, and the family the user picked.
    expect(routeCalls).toEqual([]);
    expect((onSubmit.mock.calls[0]![0] as Record<string, unknown>).pluginId)
      .toBe('example-agency-maren');
  });
});

// The mode has to be airtight against the paths that were NOT designed for it:
// a marker another card left behind, a selection the user changes while the one
// Jev call is still out, and a second Send on top of the first.
describe('HomeView — Jev chooses holds its ground', () => {
  it('drops the example-prompt marker a family card left behind', async () => {
    // A family card seeds its own brief AND stamps the one-shot example-prompt
    // marker. Switching to Jev drops the family; the marker has to go with it,
    // or the created project claims to be a curated example send — the legacy
    // prompt-example path this mode must never take.
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { routeCalls } = stubFetch();
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    fireEvent.click(familyCard('example-agency-watson'));
    await settle();
    // Deliberately no prompt edit: the card's own seed IS the brief, so
    // nothing incidentally clears the marker on the way to Send.
    await pickJevChooses();
    await send();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(routeCalls).toHaveLength(1);
    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.examplePromptContext).toBeUndefined();
    expect(payload.pluginId).toBe('example-agency-watson');
    expect(window.localStorage.getItem('od:example-prompt-used')).toBeNull();
  });

  it('freezes every composer control while Jev is choosing', async () => {
    const held = heldRoute();
    stubFetch({ route: held.route });
    renderHome(vi.fn().mockResolvedValue(true));
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();
    await held.inFlight();
    await settle();

    // The editor, the type row, both card kinds and Send are all inert: a
    // choice made now would contradict the question already asked.
    expect(screen.getByTestId('home-hero-input').closest('[aria-disabled]')).not.toBeNull();
    expect((screen.getByTestId('home-hero-type-pill-document') as HTMLButtonElement).disabled)
      .toBe(true);
    expect((familyCard('example-agency-maren') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('home-hero-design-reference') as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByTestId('home-hero-jev-chooses') as HTMLButtonElement).disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().getAttribute('aria-label')).toBe('Jev is choosing…');
    expect(screen.getByTestId('home-hero-jev-notice').textContent).toContain('Jev is choosing…');

    held.release();
    await settle();
  });

  it('ignores a family card click made while Jev is choosing', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const held = heldRoute();
    stubFetch({ route: held.route });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();
    await held.inFlight();

    fireEvent.click(familyCard('example-agency-maren'));
    await settle();
    held.release();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Jev's family, not the one the dead click aimed at.
    expect((onSubmit.mock.calls[0]![0] as Record<string, unknown>).pluginId)
      .toBe('example-agency-watson');
  });

  it('ignores a reference card click made while Jev is choosing', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const held = heldRoute();
    stubFetch({ route: held.route });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();
    await held.inFlight();

    fireEvent.click(screen.getByTestId('home-hero-design-reference'));
    await settle();
    held.release();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.pluginId).toBe('example-agency-watson');
    // The reference never got to replace the brief Jev was asked about.
    expect(payload.prompt).toBe(BRIEF);
  });

  it('discards the route when the creation type changes while Jev is choosing', async () => {
    // A cross-surface hand-off can switch the type without touching the
    // composer's own controls, so the freeze alone cannot cover this: the
    // answer belongs to a question the user has since replaced.
    const onSubmit = vi.fn().mockResolvedValue(true);
    const held = heldRoute();
    stubFetch({ route: held.route });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();
    await held.inFlight();

    act(() => { requestHomeChip('document'); });
    await settle();
    held.release();
    await settle();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('home-hero-jev-notice')).toBeNull();
  });

  it('suppresses a second Send while the first is still choosing', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const held = heldRoute();
    const { routeCalls } = stubFetch({ route: held.route });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();
    await held.inFlight();

    fireEvent.click(sendButton());
    fireEvent.keyDown(screen.getByTestId('home-hero-input'), { key: 'Enter' });
    await settle();
    held.release();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(routeCalls).toHaveLength(1);
  });

  it('discards a decision whose brief changed before React committed anything', async () => {
    // The staleness guard cannot live in a passive effect: a host-driven brief
    // change (Community's "use this prompt") mutates the composer synchronously
    // and the response can land before React has flushed a single effect. With
    // the check one commit behind, the answer is accepted for the old brief.
    const onSubmit = vi.fn().mockResolvedValue(true);
    const held = heldRoute();
    stubFetch({ route: held.route });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();
    await held.inFlight();

    // Deliberately outside act(): no effect flush stands between the edit and
    // the answer.
    seedHomeComposerPrompt('Actually, a subscription box for climbing gear');
    held.release();
    await settle();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('home-hero-jev-notice')).toBeNull();
  });

  it('emits exactly one send_button and one jev_chooses per Send', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    stubFetch();
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    const elements = vi.mocked(trackHomeChatComposerClick).mock.calls
      .map((call) => (call[1] as unknown as Record<string, unknown>).element);
    // The deferred second pass through submit() is the same user press, not a
    // second one.
    expect(elements.filter((element) => element === 'send_button')).toHaveLength(1);
    expect(elements.filter((element) => element === 'jev_chooses')).toHaveLength(1);
  });
});

// The contract the mode owes the rest of Home: nothing of Jev's leaks into the
// UI verbatim, the brief always survives, and the mode itself behaves like the
// persistent, overridable choice it claims to be.
describe('HomeView — Jev chooses keeps its promises', () => {
  it('falls back to a localized line when the decision names nothing structured', async () => {
    stubFetch({ route: () => json({ decision: spinelessDecision() }) });
    renderHome(vi.fn().mockResolvedValue(true));
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();

    const notice = await screen.findByTestId('home-hero-jev-notice');
    expect(notice.textContent).toContain('Jev found no family for this brief.');
    expect(notice.textContent).not.toContain('no spine');
    expect(notice.textContent).not.toContain('none');
  });

  it('keeps the brief and says nothing of the upstream failure on 502', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    stubFetch({
      route: () => json({ error: { code: 'JEV_FAILED', message: `boom ${SENTINEL}` } }, 502),
    });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();

    await screen.findByTestId('home-hero-jev-notice');
    expect(homeHeroPromptText()).toContain(BRIEF);
    // Upstream bodies can carry provider detail; none of it reaches the page.
    expect(document.body.textContent ?? '').not.toContain(SENTINEL);
    expect(onSubmit).not.toHaveBeenCalled();
    expectComposerRestored('502');
  });

  it('keeps the brief and says nothing of the upstream failure on 503', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    stubFetch({
      route: () => json({ error: { code: 'JEV_UNAVAILABLE', message: `no key ${SENTINEL}` } }, 503),
    });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();

    await screen.findByTestId('home-hero-jev-notice');
    expect(homeHeroPromptText()).toContain(BRIEF);
    expect(document.body.textContent ?? '').not.toContain(SENTINEL);
    expect(onSubmit).not.toHaveBeenCalled();
    expectComposerRestored('503');
  });

  it('is still chosen after the view is torn down and mounted again', async () => {
    // Home unmounts on every project-tab switch and on a trip through
    // Settings. The mode is a deliberate choice, so it comes back with the
    // draft rather than quietly handing the family pick back to the user.
    stubFetch();
    const first = renderHome(vi.fn().mockResolvedValue(true));
    await screen.findByTestId('home-hero-input');
    await pickJevChooses();
    expect(screen.getByTestId('home-hero-jev-chooses').getAttribute('aria-pressed')).toBe('true');

    first.unmount();
    renderHome(vi.fn().mockResolvedValue(true));

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-jev-chooses').getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('leaves the mode when the user picks a reference card themselves', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { routeCalls } = stubFetch();
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    fireEvent.click(await screen.findByTestId('home-hero-design-reference'));
    await settle();

    expect(screen.getByTestId('home-hero-jev-chooses').getAttribute('aria-pressed')).toBe('false');

    await send();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // The reference bound its own routed family; Jev was never asked.
    expect(routeCalls).toEqual([]);
    expect((onSubmit.mock.calls[0]![0] as Record<string, unknown>).pluginId)
      .toBe('example-agency-maren');
  });
});

// Three windows the last round left open: the stretch between accepting a
// decision and binding it, a request nobody ever answers, and a brief that is
// only a file.
describe('HomeView — Jev chooses closes its last windows', () => {
  function stageFile(name: string) {
    const file = new File(['x'], name, { type: 'text/plain' });
    fireEvent.paste(screen.getByTestId('home-hero-input'), {
      clipboardData: { files: [file], items: [{ kind: 'file', getAsFile: () => file }] },
    });
  }

  it('never creates a project for a brief Jev was not asked about', async () => {
    // The brief can move at any point between the Send press and the create.
    // This sweeps the whole interleaving rather than one chosen moment: at
    // every depth either the route is discarded, or the project that had
    // already committed belongs to the brief Jev actually read. It is never
    // created for the brief that replaced it.
    //
    // The narrowest window — after the decision is accepted, before the send
    // effect commits — is shorter than one microtask in jsdom and cannot be
    // parked in from a test. Its guard is the brief carried on the pending
    // entry and re-read immediately before `submit`.
    const REPLACEMENT = 'Actually, a subscription box for climbing gear';
    for (const depth of [0, 2, 4, 6, 8, 12]) {
      const onSubmit = vi.fn().mockResolvedValue(true);
      const held = heldRoute();
      stubFetch({ route: held.route });
      renderHome(onSubmit);
      await screen.findByTestId('home-hero-input');

      await pickJevChooses();
      setHomeHeroPrompt(BRIEF);
      await send();
      await held.inFlight();

      held.release();
      for (let i = 0; i < depth; i += 1) await Promise.resolve();
      seedHomeComposerPrompt(REPLACEMENT);
      await settle();

      for (const call of onSubmit.mock.calls) {
        expect((call[0] as Record<string, unknown>).prompt, `depth ${depth}`).toBe(BRIEF);
      }
      // However it resolved, the composer is the user's again.
      expectComposerRestored(`depth ${depth}`);

      cleanup();
      vi.clearAllMocks();
      window.localStorage.clear();
    }
  });

  it('aborts and unlocks when an override arrives and the request never answers', async () => {
    // Invalidating a route is not the same as cancelling it. A request that
    // never settles used to hold the composer frozen for the rest of the
    // session.
    const onSubmit = vi.fn().mockResolvedValue(true);
    const never = () => new Promise<Response>(() => {});
    const { routeSignals } = stubFetch({ route: never });
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    setHomeHeroPrompt(BRIEF);
    await send();
    await waitFor(() => expect(routeSignals).toHaveLength(1));

    act(() => { requestHomeChip('document'); });
    await settle();

    expect(routeSignals[0]?.aborted).toBe(true);
    expect(sendButton().getAttribute('aria-label')).not.toBe('Jev is choosing…');
    expect((screen.getByTestId('home-hero-type-pill-document') as HTMLButtonElement).disabled)
      .toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('leaves the ordinary attachment-only send alone where Jev is dormant', async () => {
    // Jev stays selected across a type switch but only routes under Prototype.
    // Under Document it must not quietly take away Home's existing
    // attachment-only send.
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { routeCalls } = stubFetch();
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    fireEvent.click(screen.getByTestId('home-hero-type-pill-document'));
    await settle();

    stageFile('reference.txt');
    await waitFor(() => expect(screen.getByTestId('home-hero-staged-files')).toBeTruthy());
    await waitFor(() => expect(sendButton().disabled).toBe(false));

    await send();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(routeCalls).toEqual([]);
  });

  it('never asks Jev about an empty brief, even with a file attached', async () => {
    // `POST /api/agency/route` requires a non-empty brief. Send is enabled by
    // an attachment alone, so Jev mode has to require the text itself.
    const onSubmit = vi.fn().mockResolvedValue(true);
    const { routeCalls } = stubFetch();
    renderHome(onSubmit);
    await screen.findByTestId('home-hero-input');

    await pickJevChooses();
    stageFile('reference.txt');
    await waitFor(() => expect(screen.getByTestId('home-hero-staged-files')).toBeTruthy());

    expect(sendButton().disabled).toBe(true);
    fireEvent.click(sendButton());
    await settle();

    expect(routeCalls).toEqual([]);
    expect(onSubmit).not.toHaveBeenCalled();

    // The same attachment with a brief beside it routes normally.
    setHomeHeroPrompt(BRIEF);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await send();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(routeCalls).toEqual([BRIEF]);
  });
});
