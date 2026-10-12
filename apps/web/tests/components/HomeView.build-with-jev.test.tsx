// @vitest-environment jsdom
//
// "Build with Jev" from Home, through the real HomeView: the `jev-site` chip selects the mode, the
// composer asks for a client brief, Send posts exactly `{ brief, family: 'auto', mode: 'sections',
// effects: 'auto', composition: 'auto' }` (no `verify`: the daemon's default, strict, applies) to `POST /api/agency/build`, the
// AG-UI stream renders the route → fill → verify → publish steps and the applied effects, and a
// `done` build opens its project the way every other create does. Missing keys point to Settings.

import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgencyBuildSnapshot } from '@open-design/contracts';

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

import { HomeView } from '../../src/components/HomeView';
import { CREATE_RAIL_ORDER, findChip } from '../../src/components/home-hero/chips';
import { writeHomeGuideStage } from '../../src/components/home-hero/firstRunGuide';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';

import { emitBuildEnd, emitBuildEvent } from '../helpers/agency-build-agui-frames';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  FakeEventSource.last = undefined;
});

const BRIEF = 'A two-person physiotherapy clinic that treats running injuries.';
const QUEUED: AgencyBuildSnapshot = { id: 'build-1', status: 'queued', events: [], startedAt: '2026-09-25T10:00:00.000Z' };

class FakeEventSource {
  static last: FakeEventSource | undefined;
  static CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, handler: (event: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  /** The browser gave up on the stream: drives the `onerror` path the registry installs. */
  fail() {
    act(() => {
      this.readyState = FakeEventSource.CLOSED;
      this.onerror?.();
    });
  }
  emit(name: string, data: unknown) {
    act(() => {
      for (const handler of this.listeners.get(name) ?? []) handler({ data: JSON.stringify(data) } as MessageEvent);
    });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PROTOTYPE_PLUGIN = {
  id: 'example-web-prototype',
  title: 'Web Prototype',
  version: '0.1.0',
  trust: 'bundled' as const,
  sourceKind: 'bundled' as const,
  source: '/tmp/example-web-prototype',
  capabilitiesGranted: ['prompt:inject'],
  fsPath: '/tmp/example-web-prototype',
  installedAt: 0,
  updatedAt: 0,
  marketplaceTrust: 'official' as const,
  manifest: {
    name: 'example-web-prototype',
    title: 'Web Prototype',
    version: '0.1.0',
    description: 'Web Prototype description.',
    tags: ['example', 'prototype', 'web'],
    od: { kind: 'scenario', taskKind: 'new-generation', mode: 'prototype', useCase: { query: 'Seeded.' }, context: { skills: [] } },
  },
};

function stubFetch(build: () => Response = () => json({ build: QUEUED }, 202)) {
  const buildBodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const href = String(url);
    if (href === '/api/plugins') return json({ plugins: [PROTOTYPE_PLUGIN] });
    if (href.startsWith('/api/design-index')) return json({ profiles: [], matched: 0, total: 0 });
    if (href === '/api/agency/build') {
      buildBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return build();
    }
    if (href.startsWith('/api/agency/builds/')) return json({ build: QUEUED });
    return json({});
  }));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(window.performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  return { buildBodies };
}

function renderHome(props: Partial<Parameters<typeof HomeView>[0]> = {}, locale: 'en' = 'en') {
  writeHomeGuideStage('done');
  const onSubmit = vi.fn().mockResolvedValue(true);
  const onOpenProject = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <I18nProvider initial={locale}>
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={onOpenProject}
        onViewAllProjects={() => undefined}
        onOpenSettings={onOpenSettings}
        {...props}
      />
    </I18nProvider>,
  );
  return { onSubmit, onOpenProject, onOpenSettings };
}

async function pickBuildWithJev() {
  fireEvent.click(await screen.findByTestId('home-hero-type-pill-jev-site'));
  await act(async () => { await Promise.resolve(); });
}

async function sendBrief(brief = BRIEF) {
  setHomeHeroPrompt(brief);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByTestId('home-hero-submit'));
}

describe('HomeView — Build with Jev', () => {
  it('is its own chip, outside the template set', () => {
    expect(findChip('jev-site')?.action).toEqual({ kind: 'build-with-jev' });
    expect(CREATE_RAIL_ORDER).not.toContain('jev-site' as never);
  });

  it('shows the "Build with Jev" pill first and selects it, with a client-brief placeholder', async () => {
    stubFetch();
    renderHome();
    const pill = await screen.findByTestId('home-hero-type-pill-jev-site');
    expect(pill.textContent).toBe('Build with Jev');
    const pills = screen.getByTestId('home-hero-type-pills').querySelectorAll('[data-testid^="home-hero-type-pill-"]');
    expect(pills[0]?.getAttribute('data-testid')).toBe('home-hero-type-pill-jev-site');

    await pickBuildWithJev();
    expect(screen.getByTestId('home-hero-type-pill-jev-site').getAttribute('aria-selected')).toBe('true');
    expect(document.body.innerHTML).toContain(en['homeHero.jevSite.placeholder']);
  });

  it("labels the pill in English", async () => {
    stubFetch();
    renderHome({}, "en");
    expect((await screen.findByTestId('home-hero-type-pill-jev-site')).textContent).toBe("Build with Jev");
  });

  it('posts the brief to the agency build with family, mode, effects and composition, and never starts an agent run', async () => {
    const { buildBodies } = stubFetch();
    const { onSubmit } = renderHome();
    await screen.findByTestId('home-hero-input');
    await pickBuildWithJev();
    await sendBrief();

    await waitFor(() => expect(buildBodies).toHaveLength(1));
    expect(buildBodies[0]).toEqual({ brief: BRIEF, family: 'auto', mode: 'sections', effects: 'auto', composition: 'auto' });
    // A composed build only runs strict; Home leaves verify to the daemon's (strict) default.
    expect(buildBodies[0]).not.toHaveProperty('verify');
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(FakeEventSource.last?.url).toBe('/api/agency/builds/build-1/agui'));
  });

  it('sends the kit picked in the composer, so a composed page wears it', async () => {
    const kit = {
      id: 'user:atlas-beyond-tl03', title: 'Atlas TL.03', category: 'Atlas reference', summary: '', swatches: ['#edf0ed', '#eb461f'], surface: 'web',
      source: 'user', status: 'published', isEditable: true,
      approval: { status: 'approved', revision: 'a'.repeat(64), approvedRevision: 'a'.repeat(64) },
    } as never;
    const { buildBodies } = stubFetch();
    renderHome({ designSystems: [kit], defaultDesignSystemId: 'user:atlas-beyond-tl03' });
    await screen.findByTestId('home-hero-input');
    await pickBuildWithJev();
    await sendBrief();

    await waitFor(() => expect(buildBodies).toHaveLength(1));
    expect(buildBodies[0]).toEqual({ brief: BRIEF, family: 'auto', mode: 'sections', effects: 'auto', composition: 'auto', designSystemId: 'user:atlas-beyond-tl03' });
  });

  it('says why when the daemon refuses the picked kit', async () => {
    stubFetch(() => json({ error: { code: 'DESIGN_SYSTEM_TOKENS_UNUSABLE', message: 'x', details: { reason: 'missing-token' } } }, 422));
    renderHome();
    await screen.findByTestId('home-hero-input');
    await pickBuildWithJev();
    await sendBrief();
    expect(await screen.findByText(en['designIndex.build.kitTokensUnusable'])).toBeTruthy();
  });

  it('renders the steps and the applied effects, then opens the published project', async () => {
    stubFetch();
    const { onOpenProject } = renderHome();
    await screen.findByTestId('home-hero-input');
    await pickBuildWithJev();
    await sendBrief();
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    const source = FakeEventSource.last!;

    source.emit('message', { type: 'RUN_STARTED', threadId: 'agency-build:build-1', runId: 'build-1' });
    source.emit('message', { type: 'STEP_STARTED', stepName: 'route' });
    source.emit('message', { type: 'STEP_FINISHED', stepName: 'route' });
    source.emit('message', { type: 'STEP_STARTED', stepName: 'fill' });
    emitBuildEvent(source, { seq: 1, at: '2026-09-25T10:00:01.000Z', type: 'route', decision: 'routed', family: 'wrenfield' });
    emitBuildEvent(source, { seq: 2, at: '2026-09-25T10:00:02.000Z', type: 'effects', ms: 9, label: '1 applied, 0 skipped' });

    const steps = await screen.findByTestId('home-jev-build-steps');
    const rows = Array.from(steps.querySelectorAll('li'));
    expect(rows.map((row) => row.getAttribute('data-step'))).toEqual(['route', 'fill', 'verify', 'publish']);
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['done', 'active', 'pending', 'pending']);
    const progress = screen.getByTestId('home-jev-build-progress').textContent ?? '';
    expect(progress).toContain(en['designIndex.build.event.route'].replace('{family}', 'wrenfield'));
    expect(progress).toContain(en['designIndex.build.event.effects'].replace('{applied}', '1').replace('{skipped}', '0'));
    expect(onOpenProject).not.toHaveBeenCalled();

    emitBuildEnd(source, {
      ...QUEUED,
      status: 'done',
      family: 'wrenfield',
      projectId: 'project-7',
      finishedAt: '2026-09-25T10:01:00.000Z',
      effects: {
        mode: 'auto',
        applied: [{ placement: 'hero-title', componentId: 'shiny-text', kind: 'css-only', source: 'jev' }],
        skipped: [],
        bytesAdded: 900,
      },
    });

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledTimes(1));
    expect(onOpenProject).toHaveBeenCalledWith('project-7');
    const applied = screen.getByTestId('home-jev-build-effects-applied');
    expect(applied.textContent).toContain('hero-title');
    expect(applied.textContent).toContain('shiny-text');
    expect(screen.getByTestId('home-jev-build-outcome').textContent).toContain(en['designIndex.build.status.done']);
  });

  it('shows the composed blocks in page order and the direction, with the project link kept', async () => {
    stubFetch();
    const { onOpenProject } = renderHome();
    await screen.findByTestId('home-hero-input');
    await pickBuildWithJev();
    await sendBrief();
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    const source = FakeEventSource.last!;

    emitBuildEnd(source, {
      ...QUEUED,
      status: 'done',
      projectId: 'project-9',
      finishedAt: '2026-09-25T10:01:00.000Z',
      composition: {
        requested: 'auto',
        used: 'blocks',
        spine: 'TL',
        directionId: 'modern-minimal',
        blocks: ['cult:hero/aurora', 'hyperui:marketing/features/2', 'cult:footer/simple'],
        source: 'jev',
      },
    });

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledWith('project-9'));
    const panel = screen.getByTestId('home-jev-build');
    const summary = panel.querySelector('[data-testid="agency-composition"]')!;
    expect(summary).not.toBeNull();
    expect(summary.getAttribute('data-used')).toBe('blocks');
    const blocks = Array.from(summary.querySelectorAll('li[data-block-id]')).map((li) => li.getAttribute('data-block-id'));
    expect(blocks).toEqual(['cult:hero/aurora', 'hyperui:marketing/features/2', 'cult:footer/simple']);
    expect(screen.getByTestId('agency-composition-direction').getAttribute('data-direction-id')).toBe('modern-minimal');
    expect(screen.queryByTestId('agency-composition-fallback')).toBeNull();
    expect(screen.getByTestId('home-jev-build-open-project')).toBeTruthy();
  });

  it('shows why an auto build ran the family route instead', async () => {
    stubFetch();
    renderHome();
    await screen.findByTestId('home-hero-input');
    await pickBuildWithJev();
    await sendBrief();
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());

    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'done',
      family: 'wrenfield',
      projectId: 'project-10',
      finishedAt: '2026-09-25T10:01:00.000Z',
      composition: { requested: 'auto', used: 'family', fallback: 'spine-below-threshold' },
    });

    const fallback = await screen.findByTestId('agency-composition-fallback');
    expect(fallback.getAttribute('data-fallback')).toBe('spine-below-threshold');
    expect(fallback.textContent).toContain(en['designIndex.build.composition.summary.fallback']);
    expect(fallback.textContent).toContain('spine-below-threshold');
    expect(screen.queryByTestId('agency-composition-blocks')).toBeNull();
  });

  it('re-attaches when the stream drops on a build that is still running, instead of reporting an error', async () => {
    // The snapshot endpoint answers `queued`: the build is alive, only the stream went away.
    stubFetch();
    const { onOpenProject } = renderHome();
    await screen.findByTestId('home-hero-input');
    await pickBuildWithJev();
    await sendBrief();
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    const first = FakeEventSource.last!;

    first.fail();
    await waitFor(() => expect(FakeEventSource.last).not.toBe(first));
    const second = FakeEventSource.last!;
    expect(second.url).toBe('/api/agency/builds/build-1/agui');
    expect(screen.queryByTestId('home-jev-build-error')).toBeNull();

    emitBuildEnd(second, { ...QUEUED, status: 'done', projectId: 'project-8', finishedAt: '2026-09-25T10:01:00.000Z' });
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledWith('project-8'));
    expect(screen.queryByTestId('home-jev-build-error')).toBeNull();
  });

  it('sends a missing Jev key to Settings', async () => {
    stubFetch(() => json({ error: { code: 'JEV_UNAVAILABLE', message: 'UPSTREAM-DETAIL' } }, 503));
    const { onOpenSettings } = renderHome();
    await screen.findByTestId('home-hero-input');
    await pickBuildWithJev();
    await sendBrief();

    const error = await screen.findByTestId('home-jev-build-error');
    expect(error.textContent).toContain(en['designIndex.error.jevUnavailable']);
    expect(error.textContent).not.toContain('UPSTREAM-DETAIL');
    fireEvent.click(screen.getByTestId('home-jev-build-open-settings'));
    expect(onOpenSettings).toHaveBeenCalledWith('media');
  });

  it('sends a missing fill key to Settings, and says when Jev found fabrication', async () => {
    stubFetch();
    const { onOpenSettings, onOpenProject } = renderHome();
    await screen.findByTestId('home-hero-input');
    await pickBuildWithJev();
    await sendBrief();
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'failed',
      finishedAt: '2026-09-25T10:01:00.000Z',
      error: { code: 'MODEL_UNAVAILABLE', message: 'the model key is not available on this daemon' },
    });
    const outcome = await screen.findByTestId('home-jev-build-outcome');
    expect(outcome.textContent).toContain(en['designIndex.build.error.modelUnavailable']);
    fireEvent.click(screen.getByTestId('home-jev-build-outcome-open-settings'));
    expect(onOpenSettings).toHaveBeenCalledWith('media');

    // Dismiss, then a strict build that Jev refused: its own sentence, no Settings, no project.
    fireEvent.click(screen.getByTestId('home-jev-build-dismiss'));
    expect(screen.queryByTestId('home-jev-build')).toBeNull();
    FakeEventSource.last = undefined;
    await sendBrief();
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    emitBuildEnd(FakeEventSource.last!, {
      ...QUEUED,
      status: 'failed',
      finishedAt: '2026-09-25T10:02:00.000Z',
      error: { code: 'VERIFY_FAILED', message: 'fabrication' },
    });
    const refused = await screen.findByTestId('home-jev-build-outcome');
    expect(refused.textContent).toContain(en['designIndex.build.error.verifyFailed']);
    expect(screen.queryByTestId('home-jev-build-outcome-open-settings')).toBeNull();
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it('follows a host-owned mode (the model picker) and hands a chip pick back to it', async () => {
    stubFetch();
    const onJevBuildActiveChange = vi.fn();
    renderHome({ jevBuildActive: true, onJevBuildActiveChange });
    const pill = await screen.findByTestId('home-hero-type-pill-jev-site');
    expect(pill.getAttribute('aria-selected')).toBe('true');


    await waitFor(() => expect((screen.getByTestId('home-hero-type-pill-deck') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('home-hero-type-pill-deck'));
    expect(onJevBuildActiveChange).toHaveBeenCalledWith(false);
  });
});
