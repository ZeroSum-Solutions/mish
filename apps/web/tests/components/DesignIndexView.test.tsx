// @vitest-environment jsdom

// Design index view (design contract 2026-09-19, §7).
//
// The load path and the two Jev paths are what these cases pin. Opening the
// view may read the taxonomy and the unfiltered list and nothing else — a Jev
// call costs about half a second and real money, so it must wait for a button.
// An unrouted decision is a result with the spine, the archetype and the
// reason, never an error card.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgencyBuildListItem,
  DesignProfile,
  DesignTaxonomy,
  RouteDecision,
} from '@mish/contracts';

import { DesignIndexView } from '../../src/components/DesignIndexView';
import { designProfileFixture } from '../fixtures/design-profile';

const TAXONOMY: DesignTaxonomy = {
  version: '1.0',
  sections: [
    { id: 'hero', definition: 'The first screen.' },
    { id: 'footer', definition: 'The last band.' },
  ],
  components: [{ id: 'video-loop', definition: 'A looping video.' }],
  mechanics: [{ id: 'scroll-reveal', definition: 'Reveal on scroll.' }],
  depth: [{ id: 'flat', definition: 'No layering.' }],
  style: {
    ground: [
      { id: 'near-black', definition: 'Almost black.' },
      { id: 'paper', definition: 'Warm white.' },
    ],
    accent: [{ id: 'amber', definition: 'Warm accent.' }],
    typography: [{ id: 'grotesk', definition: 'Neo-grotesque.' }],
    imagery: [{ id: 'photographic', definition: 'Photography.' }],
    topology: [{ id: 'single-column', definition: 'One column.' }],
    density: [{ id: 'airy', definition: 'Generous spacing.' }],
  },
  quality: [{ id: 'craft', rubric: 'How crafted.', levels: ['low', 'high'] }],
  truthRisk: {
    id: 'truth-risk',
    instructions: 'Does the page claim something it cannot back?',
    criteriaTrue: 'It does.',
    criteriaFalse: 'It does not.',
  },
  action: [{ id: 'book', definition: 'Book a call.' }],
};

const PROFILE: DesignProfile = {
  schema: 'design-profile/1',
  taxonomy: '1.0',
  model: 'jev-test',
  at: '2026-09-19T10:00:00.000Z',
  ms: 612,
  calls: 105,
  source: {
    kind: 'html',
    title: 'Wrenfield',
    ref: 'https://wrenfield.example/',
    chars: 12_000,
    digest: 'digest-one',
  },
  route: {
    spine: { choice: 'S3', confidence: 0.82, probabilities: { S3: 0.82 } },
    archetype: { choice: 'a-editorial', confidence: 0.7, probabilities: { 'a-editorial': 0.7 } },
    skin: { choice: 'quiet', confidence: 0.61, probabilities: { quiet: 0.61 } },
    format: { choice: 'page', confidence: 0.9, probabilities: { page: 0.9 } },
    action: { choice: 'book', confidence: 0.55, probabilities: { book: 0.55 } },
    family: { choice: 'f-atelier', confidence: 0.66, probabilities: { 'f-atelier': 0.66 } },
    resolved: { archetypeId: 'a-editorial', familyId: 'f-atelier', basis: 'exact', transfer: 4 },
  },
  sections: { hero: 0.95, footer: 0.81, nav: 0.62, pricing: 0.2 },
  components: { 'video-loop': 0.9 },
  mechanics: { 'scroll-reveal': 0.72 },
  depth: { flat: 0.83 },
  style: {
    ground: { choice: 'near-black', confidence: 0.91, probabilities: { 'near-black': 0.91 } },
    accent: { choice: 'amber', confidence: 0.7, probabilities: { amber: 0.7 } },
    typography: { choice: 'grotesk', confidence: 0.8, probabilities: { grotesk: 0.8 } },
    imagery: { choice: 'photographic', confidence: 0.75, probabilities: { photographic: 0.75 } },
    topology: { choice: 'single-column', confidence: 0.85, probabilities: { 'single-column': 0.85 } },
    density: { choice: 'airy', confidence: 0.6, probabilities: { airy: 0.6 } },
  },
  quality: { craft: { score: 0.8, legend: 'high', confidence: 0.7 } },
  truthRisk: 0.12,
};

const ROUTED: RouteDecision = {
  decision: 'routed',
  spine: { code: 'S3', name: 'Editorial spine', confidence: 0.82, probabilities: { S3: 0.82 } },
  spines: [{ code: 'S3', probability: 0.82 }],
  archetype: { id: 'a-editorial', name: 'Editorial archetype', confidence: 0.7 },
  skin: { choice: 'quiet', confidence: 0.61 },
  family: { id: 'f-atelier', probability: 0.66, basis: 'exact', transfer: 4 },
  candidates: [
    {
      family: 'f-atelier',
      probability: 0.66,
      basis: 'exact',
      transfer: 4,
      archetype: 'a-editorial',
      skin: 'quiet',
      viaSpine: 'S3',
    },
  ],
  warnings: ['The brief names no budget.'],
  ms: 590,
  calls: 1,
  model: 'jev-test',
};

const UNROUTED: RouteDecision = {
  decision: 'unrouted',
  reason: 'No family exists for this spine yet.',
  spine: { code: 'S7', name: 'Utility spine', confidence: 0.74, probabilities: { S7: 0.74 } },
  spines: [{ code: 'S7', probability: 0.74 }],
  archetype: { id: 'a-console', name: 'Console archetype', confidence: 0.66 },
  skin: { choice: 'plain', confidence: 0.5 },
  candidates: [],
  warnings: [],
  ms: 540,
  calls: 1,
  model: 'jev-test',
};

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

interface StubOptions {
  profiles?: DesignProfile[];
  /** Status for `POST /api/design-index/profile`; 200 returns `profileResult`. */
  profileStatus?: number;
  /** Per-call statuses for the profile endpoint; falls back to `profileStatus`. */
  profileStatuses?: number[];
  /** Status for `POST /api/agency/route`; 200 returns `decision`. */
  routeStatus?: number;
  decision?: RouteDecision;
  added?: boolean;
  /** `GET /api/agency/builds`'s `builds`, read once when the view opens. */
  recentBuilds?: AgencyBuildListItem[];
  /** Holds the profile response until this resolves, so a request can be in flight. */
  holdProfile?: Promise<void>;
  /** Holds the route response the same way. */
  holdRoute?: Promise<void>;
}

/** A promise the test resolves by hand, to keep a request in flight. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function isDisabled(testId: string): boolean {
  return (screen.getByTestId(testId) as HTMLButtonElement | HTMLTextAreaElement).disabled;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(options: StubOptions = {}) {
  const calls: FetchCall[] = [];
  const removed = new Set<string>();
  const stored = options.profiles ?? [];

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    if (url === '/api/design-index/taxonomy') return json({ taxonomy: TAXONOMY });

    if (url.startsWith('/api/design-index?') || url === '/api/design-index') {
      if (method === 'POST') {
        return json({ profile: PROFILE, added: options.added ?? true, total: 1 });
      }
      const profiles = stored.filter((profile) => !removed.has(profile.source.digest));
      return json({ profiles, matched: profiles.length, total: profiles.length });
    }

    if (url === '/api/design-index/profile') {
      const status = options.profileStatuses?.shift() ?? options.profileStatus ?? 200;
      if (options.holdProfile) await options.holdProfile;
      if (status !== 200) return json({ error: { code: 'JEV_FAILED' } }, status);
      return json({ profile: PROFILE, added: false });
    }

    if (url === '/api/agency/route') {
      const status = options.routeStatus ?? 200;
      if (options.holdRoute) await options.holdRoute;
      if (status !== 200) return json({ error: { code: 'JEV_FAILED' } }, status);
      return json({ decision: options.decision ?? ROUTED });
    }

    if (url === '/api/agency/builds') {
      return json({ builds: options.recentBuilds ?? [] });
    }

    if (method === 'DELETE' && url.startsWith('/api/design-index/')) {
      removed.add(decodeURIComponent(url.slice('/api/design-index/'.length)));
      return json({ removed: true, total: 0 });
    }

    throw new Error(`unexpected fetch ${method} ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function lastGet(calls: FetchCall[]): string {
  const gets = calls.filter((call) => call.method === 'GET' && call.url.startsWith('/api/design-index?'));
  return gets[gets.length - 1]?.url ?? '';
}

describe('DesignIndexView', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('reads only the taxonomy, the unfiltered list and the build history when the view opens', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);

    await waitFor(() => expect(calls.length).toBe(3));
    expect(calls.map((call) => call.url).sort()).toEqual([
      '/api/design-index/taxonomy',
      '/api/design-index?min=0.5&limit=50',
      '/api/agency/builds',
    ].sort());
    // Neither Jev endpoint, nor a build, may be touched before a button is pressed.
    expect(calls.some((call) => call.url === '/api/design-index/profile')).toBe(false);
    expect(calls.some((call) => call.url === '/api/agency/route')).toBe(false);
    expect(calls.some((call) => call.url === '/api/agency/build')).toBe(false);
  });

  it('builds the facet selects from the taxonomy response', async () => {
    stubFetch();
    render(<DesignIndexView />);

    const sections = await screen.findByTestId('design-index-facet-section');
    await waitFor(() => {
      expect(within(sections).getAllByRole('option').map((option) => option.textContent))
        .toEqual(['Any', 'hero', 'footer']);
    });

    const ground = screen.getByTestId('design-index-facet-ground');
    expect(within(ground).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['Any', 'near-black', 'paper']);

    const components = screen.getByTestId('design-index-facet-component');
    expect(within(components).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['Any', 'video-loop']);
  });

  it('builds a search query from the chosen facets and repeats list keys', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.change(screen.getByTestId('design-index-facet-section'), { target: { value: 'hero' } });
    fireEvent.change(screen.getByTestId('design-index-facet-ground'), { target: { value: 'near-black' } });
    fireEvent.click(screen.getByTestId('design-index-search'));

    await waitFor(() => {
      expect(lastGet(calls)).toBe('/api/design-index?section=hero&ground=near-black&min=0.5&limit=50');
    });

    fireEvent.change(screen.getByTestId('design-index-facet-section'), { target: { value: 'footer' } });
    fireEvent.click(screen.getByTestId('design-index-search'));

    await waitFor(() => {
      expect(lastGet(calls)).toBe(
        '/api/design-index?section=hero&section=footer&ground=near-black&min=0.5&limit=50',
      );
    });
  });

  it('renders stored profiles and removes one with a DELETE on its digest', async () => {
    const { calls } = stubFetch({ profiles: [PROFILE] });
    render(<DesignIndexView />);

    const card = await screen.findByTestId('design-index-result');
    expect(within(card).getByText('Wrenfield')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'https://wrenfield.example/' })).toBeTruthy();
    expect(card.textContent).toContain('S3');
    expect(card.textContent).toContain('f-atelier');
    expect(card.textContent).toContain('hero 95%');
    expect(card.textContent).toContain('near-black');
    expect(screen.getByTestId('design-index-count').textContent).toBe('1 of 1');

    fireEvent.click(within(card).getByTestId('design-index-remove'));

    await waitFor(() => {
      expect(calls.some((call) => (
        call.method === 'DELETE' && call.url === '/api/design-index/digest-one'
      ))).toBe(true);
    });
    await waitFor(() => expect(screen.queryByTestId('design-index-result')).toBeNull());
    expect(screen.getByText('Nothing stored yet')).toBeTruthy();
    expect(screen.getByText('Profile a page and it appears here, searchable by every facet.')).toBeTruthy();
  });

  it('shows "No family yet" for a stored profile the router could not place', async () => {
    const unplaced: DesignProfile = {
      ...PROFILE,
      source: { ...PROFILE.source, digest: 'digest-two', title: 'Coastline' },
      route: { ...PROFILE.route, resolved: { archetypeId: 'a-editorial' } },
    };
    stubFetch({ profiles: [unplaced] });
    render(<DesignIndexView />);

    const card = await screen.findByTestId('design-index-result');
    expect(card.textContent).toContain('No family yet');
  });

  it('profiles an input on the button press and adds the returned profile to the index', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.click(screen.getByTestId('design-index-panel-profile'));
    fireEvent.change(screen.getByTestId('design-index-profile-title'), { target: { value: 'Wrenfield' } });
    fireEvent.change(screen.getByTestId('design-index-profile-ref'), {
      target: { value: 'https://wrenfield.example/' },
    });
    fireEvent.change(screen.getByTestId('design-index-profile-input'), {
      target: { value: '<html>hero</html>' },
    });

    // Typing does not call Jev; only the button does.
    expect(calls.some((call) => call.url === '/api/design-index/profile')).toBe(false);

    fireEvent.click(screen.getByTestId('design-index-profile-run'));

    await waitFor(() => {
      const call = calls.find((entry) => entry.url === '/api/design-index/profile');
      expect(call?.method).toBe('POST');
      expect(call?.body).toEqual({
        kind: 'html',
        input: '<html>hero</html>',
        title: 'Wrenfield',
        ref: 'https://wrenfield.example/',
        add: false,
      });
    });

    // The full label tables come with the card.
    const card = await screen.findByTestId('design-index-result');
    expect(card.textContent).toContain('Wrenfield');
    expect(screen.getByText('Mechanics')).toBeTruthy();
    expect(screen.getByText('scroll-reveal')).toBeTruthy();

    fireEvent.click(screen.getByTestId('design-index-profile-add'));

    await waitFor(() => {
      const call = calls.find((entry) => entry.url === '/api/design-index' && entry.method === 'POST');
      expect(call?.body).toEqual({ profile: PROFILE });
    });
    expect(screen.getByTestId('design-index-add-notice').textContent).toBe('Stored in the index.');
  });

  it('reports an already-stored digest instead of claiming a new entry', async () => {
    stubFetch({ added: false });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.click(screen.getByTestId('design-index-panel-profile'));
    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: 'brief text' } });
    fireEvent.click(screen.getByTestId('design-index-profile-run'));
    await screen.findByTestId('design-index-result');

    fireEvent.click(screen.getByTestId('design-index-profile-add'));
    await waitFor(() => {
      expect(screen.getByTestId('design-index-add-notice').textContent).toBe('Already in the index.');
    });
  });

  // A profile is a twenty-second call. These four cases pin that a result is
  // only ever shown, and only ever stored, for the inputs that are on screen.
  it('drops a settled profile as soon as any of its inputs changes', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');
    fireEvent.click(screen.getByTestId('design-index-panel-profile'));

    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: 'page A' } });
    fireEvent.click(screen.getByTestId('design-index-profile-run'));
    await screen.findByTestId('design-index-result');
    expect(isDisabled('design-index-profile-add')).toBe(false);

    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: 'page B' } });

    expect(screen.queryByTestId('design-index-result')).toBeNull();
    expect(isDisabled('design-index-profile-add')).toBe(true);

    // Each of the other four inputs invalidates a result the same way.
    for (const [testId, value] of [
      ['design-index-profile-title', 'Another title'],
      ['design-index-profile-ref', 'https://other.example/'],
      ['design-index-profile-id', 'other-id'],
      ['design-index-profile-kind', 'prompt'],
    ] as const) {
      fireEvent.click(screen.getByTestId('design-index-profile-run'));
      await screen.findByTestId('design-index-result');
      fireEvent.change(screen.getByTestId(testId), { target: { value } });
      expect(screen.queryByTestId('design-index-result'), testId).toBeNull();
      expect(isDisabled('design-index-profile-add')).toBe(true);
    }
  });

  it('ignores a profile response whose inputs are no longer on screen', async () => {
    const held = gate();
    stubFetch({ holdProfile: held.promise });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');
    fireEvent.click(screen.getByTestId('design-index-panel-profile'));

    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: 'page A' } });
    fireEvent.click(screen.getByTestId('design-index-profile-run'));

    // The request for A is in flight; the panel moves on to B anyway.
    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: 'page B' } });

    held.open();
    await waitFor(() => expect(isDisabled('design-index-profile-run')).toBe(false));

    expect(screen.queryByTestId('design-index-result')).toBeNull();
    expect(isDisabled('design-index-profile-add')).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByTestId('design-index-profile-input') as HTMLTextAreaElement).value)
      .toBe('page B');
  });

  it('leaves no stale result under a failed second profile', async () => {
    stubFetch({ profileStatuses: [200, 502] });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');
    fireEvent.click(screen.getByTestId('design-index-panel-profile'));

    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: 'page A' } });
    fireEvent.click(screen.getByTestId('design-index-profile-run'));
    await screen.findByTestId('design-index-result');

    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: 'page B' } });
    fireEvent.click(screen.getByTestId('design-index-profile-run'));

    expect((await screen.findByRole('alert')).textContent)
      .toBe('Jev could not profile this input');
    expect(screen.queryByTestId('design-index-result')).toBeNull();
    expect(isDisabled('design-index-profile-add')).toBe(true);
  });

  it('locks the profile inputs and both buttons while a request is in flight', async () => {
    const held = gate();
    stubFetch({ holdProfile: held.promise });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');
    fireEvent.click(screen.getByTestId('design-index-panel-profile'));

    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: 'page A' } });
    for (const testId of [
      'design-index-profile-kind',
      'design-index-profile-title',
      'design-index-profile-ref',
      'design-index-profile-id',
      'design-index-profile-input',
    ]) {
      expect(isDisabled(testId), testId).toBe(false);
    }

    fireEvent.click(screen.getByTestId('design-index-profile-run'));

    for (const testId of [
      'design-index-profile-kind',
      'design-index-profile-title',
      'design-index-profile-ref',
      'design-index-profile-id',
      'design-index-profile-input',
      'design-index-profile-run',
      'design-index-profile-add',
    ]) {
      expect(isDisabled(testId), testId).toBe(true);
    }

    held.open();
    await screen.findByTestId('design-index-result');
    expect(isDisabled('design-index-profile-input')).toBe(false);
    expect(isDisabled('design-index-profile-add')).toBe(false);
  });

  it('drops a decision when the brief changes, in flight or after it lands', async () => {
    const held = gate();
    stubFetch({ holdRoute: held.promise });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');
    fireEvent.click(screen.getByTestId('design-index-panel-route'));

    fireEvent.change(screen.getByTestId('design-index-route-brief'), { target: { value: 'brief A' } });
    fireEvent.click(screen.getByTestId('design-index-route-run'));
    expect(isDisabled('design-index-route-brief')).toBe(true);
    fireEvent.change(screen.getByTestId('design-index-route-brief'), { target: { value: 'brief B' } });

    held.open();
    await waitFor(() => expect(isDisabled('design-index-route-run')).toBe(false));
    expect(screen.queryByTestId('design-index-decision')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // A decision that does land is dropped as soon as the brief moves on.
    vi.unstubAllGlobals();
    stubFetch();
    fireEvent.click(screen.getByTestId('design-index-route-run'));
    await screen.findByTestId('design-index-decision');
    fireEvent.change(screen.getByTestId('design-index-route-brief'), { target: { value: 'brief C' } });
    expect(screen.queryByTestId('design-index-decision')).toBeNull();
  });

  it('renders a routed decision with its family and candidates', async () => {
    const { calls } = stubFetch();
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.click(screen.getByTestId('design-index-panel-route'));
    fireEvent.change(screen.getByTestId('design-index-route-brief'), {
      target: { value: 'A quiet atelier site.' },
    });
    expect(calls.some((call) => call.url === '/api/agency/route')).toBe(false);

    fireEvent.click(screen.getByTestId('design-index-route-run'));

    const card = await screen.findByTestId('design-index-decision');
    expect(calls.find((call) => call.url === '/api/agency/route')?.body)
      .toEqual({ brief: 'A quiet atelier site.' });
    expect(card.textContent).toContain('Editorial spine');
    expect(card.textContent).toContain('Editorial archetype');
    expect(card.textContent).toContain('f-atelier');
    expect(card.textContent).toContain('Basis exact');
    expect(card.textContent).toContain('The brief names no budget.');
    expect(within(card).getByText('Routed')).toBeTruthy();
  });

  it('renders an unrouted decision as a result, not an error', async () => {
    stubFetch({ decision: UNROUTED });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.click(screen.getByTestId('design-index-panel-route'));
    fireEvent.change(screen.getByTestId('design-index-route-brief'), {
      target: { value: 'An internal console.' },
    });
    fireEvent.click(screen.getByTestId('design-index-route-run'));

    const card = await screen.findByTestId('design-index-decision');
    expect(within(card).getByText('Unrouted')).toBeTruthy();
    expect(card.textContent).toContain('Utility spine');
    expect(card.textContent).toContain('Console archetype');
    expect(card.textContent).toContain('No family exists for this spine yet.');
    expect(card.textContent).toContain('No family yet for this spine');
    // Nothing on the panel is announced as an error.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports an unavailable Jev key as 503 and a failed Jev call as 502', async () => {
    stubFetch({ profileStatus: 503 });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.click(screen.getByTestId('design-index-panel-profile'));
    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: '<html/>' } });
    fireEvent.click(screen.getByTestId('design-index-profile-run'));

    expect((await screen.findByRole('alert')).textContent)
      .toBe('Jev is not available on this daemon');
    // No `onOpenSettings` prop was passed: even though this is the 503 case,
    // the button must not render, never an inert one.
    expect(screen.queryByTestId('design-index-profile-open-settings')).toBeNull();

    cleanup();
    vi.unstubAllGlobals();

    stubFetch({ profileStatus: 502 });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.click(screen.getByTestId('design-index-panel-profile'));
    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: '<html/>' } });
    fireEvent.click(screen.getByTestId('design-index-profile-run'));

    expect((await screen.findByRole('alert')).textContent)
      .toBe('Jev could not profile this input');
  });

  it('reports a failed route call without echoing the upstream body', async () => {
    stubFetch({ routeStatus: 502 });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.click(screen.getByTestId('design-index-panel-route'));
    fireEvent.change(screen.getByTestId('design-index-route-brief'), { target: { value: 'A brief.' } });
    fireEvent.click(screen.getByTestId('design-index-route-run'));

    expect((await screen.findByRole('alert')).textContent)
      .toBe('Jev could not route this brief');
    expect(screen.queryByTestId('design-index-decision')).toBeNull();
  });

  // F4: a 503 means the daemon cannot resolve a Jev key at all, so the error
  // gets a way out — a button straight to the Settings section that holds the
  // key (`media`, where `JevKeyCard` renders). A 502 is a call that failed
  // with a key in hand; Settings would not fix that, so no button.
  it('shows an Open Settings button on a Profile 503 and calls onOpenSettings with "media"', async () => {
    stubFetch({ profileStatus: 503 });
    const onOpenSettings = vi.fn();
    render(<DesignIndexView onOpenSettings={onOpenSettings} />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.click(screen.getByTestId('design-index-panel-profile'));
    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: '<html/>' } });
    fireEvent.click(screen.getByTestId('design-index-profile-run'));

    await screen.findByRole('alert');
    const button = screen.getByTestId('design-index-profile-open-settings');
    expect(button.textContent).toBe('Open Settings');

    fireEvent.click(button);
    expect(onOpenSettings).toHaveBeenCalledWith('media');
  });

  it('shows an Open Settings button on a Route 503 and calls onOpenSettings with "media"', async () => {
    stubFetch({ routeStatus: 503 });
    const onOpenSettings = vi.fn();
    render(<DesignIndexView onOpenSettings={onOpenSettings} />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.click(screen.getByTestId('design-index-panel-route'));
    fireEvent.change(screen.getByTestId('design-index-route-brief'), { target: { value: 'A brief.' } });
    fireEvent.click(screen.getByTestId('design-index-route-run'));

    await screen.findByRole('alert');
    const button = screen.getByTestId('design-index-route-open-settings');
    expect(button.textContent).toBe('Open Settings');

    fireEvent.click(button);
    expect(onOpenSettings).toHaveBeenCalledWith('media');
  });

  it('does not show an Open Settings button on a 502, even when onOpenSettings is provided', async () => {
    stubFetch({ profileStatus: 502 });
    const onOpenSettings = vi.fn();
    render(<DesignIndexView onOpenSettings={onOpenSettings} />);
    await screen.findByTestId('design-index-facet-section');

    fireEvent.click(screen.getByTestId('design-index-panel-profile'));
    fireEvent.change(screen.getByTestId('design-index-profile-input'), { target: { value: '<html/>' } });
    fireEvent.click(screen.getByTestId('design-index-profile-run'));

    await screen.findByRole('alert');
    expect(screen.queryByTestId('design-index-profile-open-settings')).toBeNull();
  });

  // Facet discrimination (design contract §7, move 6): a facet whose largest bucket holds more
  // than 60% of the loaded profiles hides behind "More filters" by default — it is not narrowing
  // anything for most of what is on screen. `section` (every profile tagged `hero`) is the
  // dominated case below; `ground` sits exactly on the 60% line and `spine` is wide open, so both
  // stay inline.
  function dominatedFixture(): DesignProfile[] {
    return ['a', 'b', 'c', 'd', 'e'].map((digest, index) => designProfileFixture({
      digest,
      spine: `S${index + 1}`,
      sections: { hero: 0.9 },
      style: { ground: index < 3 ? 'near-black' : 'paper' },
    }));
  }

  it('hides a dominated facet behind "More filters" by default, keeping a discriminating one inline', async () => {
    stubFetch({ profiles: dominatedFixture() });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-spine');

    const visible = screen.getByTestId('design-index-facets');
    expect(within(visible).queryByTestId('design-index-facet-section')).toBeNull();
    expect(within(visible).getByTestId('design-index-facet-ground')).toBeTruthy();
    expect(within(visible).getByTestId('design-index-facet-spine')).toBeTruthy();

    const more = screen.getByTestId('design-index-more-filters');
    expect(within(more).getByTestId('design-index-facet-section')).toBeTruthy();
    expect((more as HTMLDetailsElement).open).toBe(false);
  });

  it('reveals the collapsed facets through the "More filters" disclosure', async () => {
    stubFetch({ profiles: dominatedFixture() });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-spine');

    const more = screen.getByTestId('design-index-more-filters') as HTMLDetailsElement;
    expect(more.open).toBe(false);
    fireEvent.click(within(more).getByText('More filters'));
    expect(more.open).toBe(true);
  });

  it('keeps a facet the user has already set visible even though it dominates the loaded set', async () => {
    stubFetch({ profiles: dominatedFixture() });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-spine');

    const more = screen.getByTestId('design-index-more-filters') as HTMLDetailsElement;
    fireEvent.click(within(more).getByText('More filters'));
    fireEvent.change(within(more).getByTestId('design-index-facet-section'), { target: { value: 'hero' } });

    const visible = screen.getByTestId('design-index-facets');
    expect(within(visible).getByTestId('design-index-facet-section')).toBeTruthy();
    expect(within(visible).getByRole('button', { name: 'Remove hero' })).toBeTruthy();
  });

  it('shows every facet when fewer than 5 profiles are loaded, even a dominated one', async () => {
    const profiles = dominatedFixture().slice(0, 4);
    stubFetch({ profiles });
    render(<DesignIndexView />);
    await screen.findByTestId('design-index-facet-spine');

    expect(screen.queryByTestId('design-index-more-filters')).toBeNull();
    expect(within(screen.getByTestId('design-index-facets')).getByTestId('design-index-facet-section')).toBeTruthy();
  });
});
