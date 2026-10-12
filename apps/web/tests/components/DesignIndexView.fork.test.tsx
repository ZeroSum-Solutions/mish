// @vitest-environment jsdom

// "Start from this build" — the Route panel's recent-builds list (design 2026-09-20 §6.6 fork).
//
// The behavior that matters here is not covered by DesignIndexView.build.test.tsx (which never
// renders RecentBuildsPanel) or DesignIndexView.test.tsx (which only asserts the mount-time GET).
// This file exercises: which saved builds offer the action, what pressing it actually posts, the
// hand-off to the new build's own stream on success, the disabled-while-forking state, and the
// four-way error mapping `startFromBuild` performs on `forkAgencyBuild`'s result.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgencyBuildListItem, AgencyBuildSnapshot, DesignTaxonomy } from '@open-design/contracts';

import { DesignIndexView } from '../../src/components/DesignIndexView';
import { emitBuildEnd, emitBuildEvent } from '../helpers/agency-build-agui-frames';
import { en } from '../../src/i18n/locales/en';

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

const DONE_FORKABLE: AgencyBuildListItem = {
  id: 'build-old-1',
  status: 'done',
  family: 'f-atelier',
  projectId: 'project-old-1',
  startedAt: '2026-09-20T10:00:00.000Z',
  finishedAt: '2026-09-20T10:01:00.000Z',
};

const DONE_FORKABLE_2: AgencyBuildListItem = {
  id: 'build-old-4',
  status: 'done',
  family: 'f-console',
  projectId: 'project-old-4',
  startedAt: '2026-09-20T08:00:00.000Z',
  finishedAt: '2026-09-20T08:01:00.000Z',
};

const DONE_ROLLED_BACK: AgencyBuildListItem = {
  id: 'build-old-2',
  status: 'done',
  family: 'f-atelier',
  // No `projectId`: the daemon rolled it back, so there is nothing to fork from.
  startedAt: '2026-09-20T09:00:00.000Z',
  finishedAt: '2026-09-20T09:01:00.000Z',
};

const STILL_BUILDING: AgencyBuildListItem = {
  id: 'build-old-3',
  status: 'building',
  family: 'f-atelier',
  startedAt: '2026-09-20T11:00:00.000Z',
};

const NEW_QUEUED: AgencyBuildSnapshot = {
  id: 'build-new-1',
  status: 'queued',
  events: [],
  startedAt: '2026-09-20T12:00:00.000Z',
};

/** The one EventSource the view opens, driven by hand — same shape as the build test's fake. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  static CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
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
}

interface FetchCall { url: string; method: string; body: any }

interface StubOptions {
  recentBuilds?: AgencyBuildListItem[];
  /** Status for `POST /api/agency/builds/:id/fork`. */
  forkStatus?: number;
  forkError?: { code: string; message: string };
  /** Holds the fork POST until this resolves, so it can be observed in flight. */
  holdFork?: Promise<void>;
  /** `GET /api/agency/families/:family/sections`. */
  sections?: Array<{ id: string; type: string; label: string }>;
}

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
    if (url === '/api/agency/builds') return json({ builds: options.recentBuilds ?? [] });
    const sectionsUrl = /^\/api\/agency\/families\/([^/]+)\/sections$/.exec(url);
    if (sectionsUrl) return json({ family: sectionsUrl[1], sections: options.sections ?? [] });
    if (url.endsWith('/fork')) {
      if (options.holdFork) await options.holdFork;
      const status = options.forkStatus ?? 202;
      if (status !== 202) {
        return json({ error: options.forkError ?? { code: 'REQUEST_FAILED', message: 'no' } }, status);
      }
      return json({ build: NEW_QUEUED }, 202);
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  }));
  vi.stubGlobal('EventSource', FakeEventSource);
  return { calls };
}

/** Opens the Route panel, where RecentBuildsPanel lives — no brief or routing required. */
async function openRoutePanel() {
  fireEvent.click(await screen.findByTestId('design-index-panel-route'));
  await screen.findByTestId('design-index-recent-builds');
}

describe('DesignIndexView — starting from a saved build', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.last = undefined;
    cleanup();
  });

  it('shows the empty sentence when the daemon remembers no builds', async () => {
    stubFetch({ recentBuilds: [] });
    render(<DesignIndexView />);
    await openRoutePanel();

    expect(screen.getByTestId('design-index-recent-builds').textContent)
      .toContain(en['designIndex.build.recent.empty']);
    expect(screen.queryByTestId('design-index-recent-build')).toBeNull();
  });

  it('offers "Start from this build" only on a done build that still has a project', async () => {
    stubFetch({ recentBuilds: [DONE_FORKABLE, DONE_ROLLED_BACK, STILL_BUILDING] });
    render(<DesignIndexView />);
    await openRoutePanel();

    const rows = screen.getAllByTestId('design-index-recent-build');
    expect(rows).toHaveLength(3);

    const startButtons = screen.getAllByTestId('design-index-recent-build-start-from');
    // Only the forkable row (done + projectId) renders the action.
    expect(startButtons).toHaveLength(1);
    expect(within(rows[0]!).queryByTestId('design-index-recent-build-start-from')).not.toBeNull();
    expect(within(rows[1]!).queryByTestId('design-index-recent-build-start-from')).toBeNull();
    expect(within(rows[2]!).queryByTestId('design-index-recent-build-start-from')).toBeNull();
  });

  it('posts the fork to the saved build\'s own id and attaches the returned build to a visible panel', async () => {
    const { calls } = stubFetch({ recentBuilds: [DONE_FORKABLE] });
    const opened: string[] = [];
    render(<DesignIndexView onOpenProject={(id) => { opened.push(id); }} />);
    await openRoutePanel();

    // No routed decision exists in this test at all — this is the ordinary shape of pressing
    // "Start from this build" straight from the recent-builds list, never having typed a brief.
    expect(screen.queryByTestId('design-index-build')).toBeNull();

    fireEvent.click(screen.getByTestId('design-index-recent-build-start-from'));

    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/builds/build-old-1/fork')).toBe(true));
    const forkCall = calls.find((call) => call.url === '/api/agency/builds/build-old-1/fork');
    expect(forkCall?.method).toBe('POST');
    // No brief override was given, so the request carries none.
    expect(forkCall?.body).toEqual({});

    // The same hand-off a routed Build press makes: the panel now watches the NEW build's stream,
    // proving `attachBuild(result.build)` ran against the build the fork actually returned rather
    // than the id that was forked FROM.
    await waitFor(() => expect(FakeEventSource.last?.url).toBe('/api/agency/builds/build-new-1/agui'));

    // And it is not just plumbing: the build panel itself is now on screen, with no decision
    // behind it, and its Run button offers nothing to run since there is no routed family here.
    expect(screen.getByTestId('design-index-build')).toBeTruthy();
    expect((screen.getByTestId('design-index-build-run') as HTMLButtonElement).disabled).toBe(true);

    // Driving the attached stream to a finished status proves the outcome is genuinely visible,
    // not merely that a stream object exists somewhere off screen — the exact regression class
    // the review finding named ("fails to call attachBuild(result.build) on a successful fork").
    emitBuildEnd(FakeEventSource.last!, {
      ...NEW_QUEUED,
      status: 'done',
      projectId: 'project-new-1',
      finishedAt: '2026-09-20T12:01:00.000Z',
    });
    const outcome = await screen.findByTestId('design-index-build-outcome');
    expect(outcome.textContent).toContain(en['designIndex.build.status.done']);
    fireEvent.click(screen.getByTestId('design-index-build-open-project'));
    expect(opened).toEqual(['project-new-1']);
  });

  it('prefills the fork\'s section controls from the saved hints and sends only what changed', async () => {
    const saved: AgencyBuildListItem = { ...DONE_FORKABLE, family: 'wrenfield', sections: { reviews: 'drop', 'final-cta': 'keep' } };
    const { calls } = stubFetch({
      recentBuilds: [saved],
      sections: [
        { id: 'reviews', type: 'reviews', label: 'customer reviews' },
        { id: 'support', type: 'support', label: 'support' },
        { id: 'final-cta', type: 'cta', label: 'closing call to action' },
      ],
    });
    render(<DesignIndexView />);
    await openRoutePanel();

    // Closed by default: nothing is fetched until the person asks for the controls.
    expect(calls.some((call) => call.url.startsWith('/api/agency/families/'))).toBe(false);
    fireEvent.click(screen.getByTestId('design-index-recent-build-sections-toggle'));

    const reviews = await screen.findByTestId('design-index-recent-build-section-reviews') as HTMLSelectElement;
    expect(reviews.value).toBe('drop');
    expect((screen.getByTestId('design-index-recent-build-section-support') as HTMLSelectElement).value).toBe('auto');
    expect((screen.getByTestId('design-index-recent-build-section-final-cta') as HTMLSelectElement).value).toBe('keep');
    expect(screen.getByTestId('design-index-recent-build-sections').textContent).toContain(en['designIndex.build.sectionLabel.wrenfield.reviews']);

    // Reset a saved hint to Jev, add a new one, and leave final-cta as saved.
    fireEvent.change(reviews, { target: { value: 'auto' } });
    fireEvent.change(screen.getByTestId('design-index-recent-build-section-support'), { target: { value: 'keep' } });
    fireEvent.click(screen.getByTestId('design-index-recent-build-start-from'));

    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/builds/build-old-1/fork')).toBe(true));
    expect(calls.find((call) => call.url === '/api/agency/builds/build-old-1/fork')?.body).toEqual({
      sections: { reviews: 'auto', support: 'keep' },
    });
  });

  it('sends no section override when the open controls still match the saved hints', async () => {
    const saved: AgencyBuildListItem = { ...DONE_FORKABLE, family: 'wrenfield', sections: { reviews: 'drop' } };
    const { calls } = stubFetch({ recentBuilds: [saved], sections: [{ id: 'reviews', type: 'reviews', label: 'customer reviews' }] });
    render(<DesignIndexView />);
    await openRoutePanel();

    fireEvent.click(screen.getByTestId('design-index-recent-build-sections-toggle'));
    const reviews = await screen.findByTestId('design-index-recent-build-section-reviews');
    fireEvent.change(reviews, { target: { value: 'keep' } });
    fireEvent.change(reviews, { target: { value: 'drop' } });
    fireEvent.click(screen.getByTestId('design-index-recent-build-start-from'));

    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/builds/build-old-1/fork')).toBe(true));
    expect(calls.find((call) => call.url === '/api/agency/builds/build-old-1/fork')?.body).toEqual({});
  });

  it('disables the pressed row while the fork is in flight, leaving a second forkable row alone', async () => {
    const held = gate();
    stubFetch({ recentBuilds: [DONE_FORKABLE, DONE_FORKABLE_2], holdFork: held.promise });
    render(<DesignIndexView />);
    await openRoutePanel();

    const buttons = screen.getAllByTestId('design-index-recent-build-start-from') as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    const [pressed, other] = buttons;
    expect(pressed!.disabled).toBe(false);
    expect(other!.disabled).toBe(false);
    fireEvent.click(pressed!);

    await waitFor(() => expect(pressed!.disabled).toBe(true));
    // Only the row that was actually pressed goes disabled — `forkingId` names one build, not
    // "a fork is happening somewhere".
    expect(other!.disabled).toBe(false);

    held.open();
    await waitFor(() => expect(pressed!.disabled).toBe(false));
  });

  it('starts one fork however fast the button is clicked twice', async () => {
    const held = gate();
    const { calls } = stubFetch({ recentBuilds: [DONE_FORKABLE], holdFork: held.promise });
    render(<DesignIndexView />);
    await openRoutePanel();

    const button = screen.getByTestId('design-index-recent-build-start-from');
    // Both clicks land while the first fork POST is still pending, which is the only way this
    // test can actually exercise the `buildStartingRef` guard rather than pass by coincidence.
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agency/builds/build-old-1/fork')).toBe(true));
    expect(calls.filter((call) => call.url === '/api/agency/builds/build-old-1/fork')).toHaveLength(1);

    held.open();
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    expect(calls.filter((call) => call.url === '/api/agency/builds/build-old-1/fork')).toHaveLength(1);
  });

  it('routes JEV_UNAVAILABLE to the Settings button the panel owns', async () => {
    // 503 is what the daemon actually sends for this code (apps/daemon/src/routes/agency-build.ts,
    // startBuild's Jev preflight); the registry's forkFailureCode reads the envelope code first,
    // but the status still has to be the real one or a code-dropped regression could hide behind
    // a status this endpoint never sends.
    stubFetch({
      recentBuilds: [DONE_FORKABLE],
      forkStatus: 503,
      forkError: { code: 'JEV_UNAVAILABLE', message: 'Jev is not available on this daemon' },
    });
    const sections: string[] = [];
    render(<DesignIndexView onOpenSettings={(section) => { sections.push(section); }} />);
    await openRoutePanel();

    fireEvent.click(screen.getByTestId('design-index-recent-build-start-from'));
    const alert = await screen.findByTestId('design-index-recent-builds-error');
    expect(alert.textContent).toContain(en['designIndex.error.jevUnavailable']);

    fireEvent.click(screen.getByTestId('design-index-recent-builds-open-settings'));
    expect(sections).toEqual(['media']);
    expect(FakeEventSource.last).toBeUndefined();
  });

  it('says so when a build is already running on the daemon', async () => {
    // 409 is the real status for BUILD_BUSY (startBuild's one-at-a-time lock check).
    stubFetch({
      recentBuilds: [DONE_FORKABLE],
      forkStatus: 409,
      forkError: { code: 'BUILD_BUSY', message: 'busy' },
    });
    render(<DesignIndexView />);
    await openRoutePanel();

    fireEvent.click(screen.getByTestId('design-index-recent-build-start-from'));
    const alert = await screen.findByRole('alert');
    // No Settings button on this code, so the alert's whole text is the fixed sentence — an exact
    // match, not a substring check that would also pass on an empty or partial render.
    expect(alert.textContent).toBe(en['designIndex.build.busy']);
    expect(FakeEventSource.last).toBeUndefined();
  });

  it('says the build cannot start a new project for BUILD_NOT_FORKABLE', async () => {
    stubFetch({
      recentBuilds: [DONE_FORKABLE],
      forkStatus: 409,
      forkError: { code: 'BUILD_NOT_FORKABLE', message: 'this build never published a project' },
    });
    render(<DesignIndexView />);
    await openRoutePanel();

    fireEvent.click(screen.getByTestId('design-index-recent-build-start-from'));
    const alert = await screen.findByRole('alert');
    // Exact match: this code renders no Settings button, so the whole alert is the fixed
    // sentence — proving the daemon's own English ("this build never published a project") was
    // actually replaced, not merely absent from a check that would also pass on a blank render.
    expect(alert.textContent).toBe(en['designIndex.build.recent.notForkable']);
    expect(FakeEventSource.last).toBeUndefined();
  });

  it('falls back to the generic start-failed sentence for a code it does not know', async () => {
    stubFetch({
      recentBuilds: [DONE_FORKABLE],
      forkStatus: 500,
      forkError: { code: 'SOMETHING_NEW', message: 'x' },
    });
    render(<DesignIndexView />);
    await openRoutePanel();

    fireEvent.click(screen.getByTestId('design-index-recent-build-start-from'));
    const alert = await screen.findByTestId('design-index-recent-builds-error');
    expect(alert.textContent).toContain(en['designIndex.build.startFailed']);
    expect(FakeEventSource.last).toBeUndefined();
  });

  it('falls back to the generic start-failed sentence when the request itself fails', async () => {
    // No envelope at all (a dropped body, a network error) resolves to REQUEST_FAILED in the
    // registry, which the panel renders identically to an unrecognised code.
    stubFetch({ recentBuilds: [DONE_FORKABLE], forkStatus: 502 });
    render(<DesignIndexView />);
    await openRoutePanel();

    fireEvent.click(screen.getByTestId('design-index-recent-build-start-from'));
    const alert = await screen.findByTestId('design-index-recent-builds-error');
    expect(alert.textContent).toContain(en['designIndex.build.startFailed']);
    expect(FakeEventSource.last).toBeUndefined();
  });
});
