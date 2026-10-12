// @vitest-environment jsdom
//
// The Prototype strip end to end: which cards it shows, what a spine tab does
// to them, and what a reference click hands back to the host.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPluginRecord } from '@mish/contracts';

import { HomeHero } from '../../src/components/HomeHero';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';
import { trackHomeChatComposerClick } from '../../src/analytics/events';
import { designProfileFixture } from '../fixtures/design-profile';
import { createDropCoordinator } from '../../src/runtime/intake/drop-coordinator';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

vi.mock('../../src/analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/events')>();
  return { ...actual, trackHomeChatComposerClick: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

// A reference card's clip is retrieved through `fetch` so the request can
// state a referrer policy the <video> element cannot. jsdom has neither a
// network nor `URL.createObjectURL`, so both are stubbed; `settled` is the
// response the clip request gets.
function stubClipTransport(settled: () => Promise<unknown>) {
  let issued = 0;
  const revoked: string[] = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:reference-${++issued}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn((url: string) => {
      revoked.push(url);
    }),
  });
  const fetchMock = vi.fn(settled);
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, revoked };
}

function clipBytes() {
  return { ok: true, status: 200, blob: async () => new Blob(['clip-bytes']) };
}

function agencyPlugin(family: string, title: string): InstalledPluginRecord {
  return {
    id: `example-agency-${family}`,
    title,
    manifest: {
      name: `example-agency-${family}`,
      title,
      tags: ['example', 'prototype', 'web'],
      od: {
        kind: 'scenario',
        mode: 'prototype',
        useCase: { query: `Build a site with ${title}.` },
        context: { skills: [{ ref: 'agency-site' }, { path: './SKILL.md' }] },
      },
    },
  } as unknown as InstalledPluginRecord;
}

function bundledExample(id: string, title: string): InstalledPluginRecord {
  return {
    id,
    title,
    manifest: {
      name: id,
      title,
      tags: ['example', 'prototype', 'web'],
      od: {
        kind: 'scenario',
        mode: 'prototype',
        useCase: { query: `Build ${title}.` },
        context: { skills: [{ path: './SKILL.md' }] },
      },
    },
  } as unknown as InstalledPluginRecord;
}

const PLUGINS = [
  agencyPlugin('watson', 'Watson Trust to Lead'),
  agencyPlugin('maren', 'Maren Maker Studio'),
  bundledExample('example-pricing-page', 'Pricing Page'),
  bundledExample('example-meeting-notes', 'Meeting Notes'),
];

const ROUTED = designProfileFixture({
  digest: 'digest-routed',
  title: 'Routed reference',
  spine: 'TL',
  familyId: 'watson',
  meta: {
    total_likes: 500,
    previewImage: 'https://cdn.example.com/routed.jpg',
  },
});

const UNROUTED = designProfileFixture({
  digest: 'digest-unrouted',
  title: 'Unrouted reference',
  spine: 'CO',
  archetype: 'CO.01',
  familyId: null,
  meta: { total_likes: 200, previewVideo: 'https://cdn.example.com/clip.mp4' },
});

const NO_MEDIA = designProfileFixture({
  digest: 'digest-no-media',
  title: 'Vortex Studio hero',
  spine: 'none',
  archetype: null,
  familyId: null,
});

// A clip with a still behind it: the poster paints while the clip decodes.
const POSTER_AND_VIDEO = designProfileFixture({
  digest: 'digest-poster-video',
  title: 'Poster and video reference',
  spine: 'TL',
  familyId: null,
  meta: {
    total_likes: 400,
    previewImage: 'https://cdn.example.com/still.jpg',
    previewVideo: 'https://cdn.example.com/still.mp4',
  },
});

const PROFILES = [ROUTED, UNROUTED, NO_MEDIA];

function heroProps(overrides: Record<string, unknown> = {}) {
  return {
    prompt: '',
    onPromptChange: () => undefined,
    onSubmit: () => undefined,
    activePluginTitle: null,
    activeChipId: 'prototype',
    onClearActivePlugin: () => undefined,
    pluginOptions: PLUGINS,
    pluginsLoading: false,
    pendingPluginId: null,
    pendingChipId: null,
    onPickPlugin: () => undefined,
    onPickChip: () => undefined,
    contextItemCount: 0,
    error: null,
    designIndexProfiles: PROFILES,
    ...overrides,
  };
}

function renderHero(overrides: Record<string, unknown> = {}) {
  const Hero = HomeHero as unknown as (props: Record<string, unknown>) => JSX.Element;
  const result = render(<Hero {...(heroProps(overrides) as unknown as Record<string, unknown>)} />);
  return {
    ...result,
    // Re-render the SAME hero instance with new props, so a card that keeps
    // its React key keeps its state — which is the point of the replace case.
    rerenderHero(next: Record<string, unknown> = {}) {
      result.rerender(<Hero {...(heroProps(next) as unknown as Record<string, unknown>)} />);
    },
  };
}

// The WEBSITE cards only. The strip also pins the "Jev chooses" card, which is
// not a website and is filtered out here so the cases below keep saying what
// the catalog produced; `railTitles` is the one that reads the whole rail.
function cardTitles(): string[] {
  return railCells()
    .filter((cell) => cell.querySelector('[data-testid="home-hero-jev-chooses"]') === null)
    .map((cell) => cell.querySelector('.home-hero__plugin-preset-title')?.textContent ?? '');
}

function railCells(): HTMLElement[] {
  const strip = screen.getByTestId('home-hero-website-cards');
  return Array.from(strip.querySelectorAll<HTMLElement>('.home-hero__plugin-preset-cell'));
}

/** Every card in the rail, in DOM order — the pinned card included. */
function railTitles(): string[] {
  return railCells()
    .map((cell) => cell.querySelector('.home-hero__plugin-preset-title')?.textContent ?? '');
}

function pickSpine(code: string) {
  fireEvent.click(screen.getByTestId(`home-hero-subtype-${code}`));
}

describe('HomeHero Prototype website strip', () => {
  it('shows the family cards and the stored references, and nothing else', () => {
    renderHero();
    const titles = cardTitles();
    expect(titles).toEqual([
      'Watson',
      'Maren',
      'Routed reference',
      'Unrouted reference',
      'Vortex Studio hero',
    ]);
    // The daemon's other bundled examples are not on Home under Prototype.
    expect(titles).not.toContain('Pricing Page');
    expect(titles).not.toContain('Meeting Notes');
    expect(screen.queryByTestId('home-hero-plugin-presets')).toBeNull();
  });

  it('keeps the excluded examples off every spine tab too', () => {
    renderHero();
    for (const spine of ['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI']) {
      pickSpine(spine);
      const titles = cardTitles();
      expect(titles, spine).not.toContain('Pricing Page');
      expect(titles, spine).not.toContain('Meeting Notes');
      pickSpine(spine); // toggle back to All
    }
  });

  it('filters the cards by the picked spine and keeps an unrouted spine under All only', () => {
    renderHero();
    pickSpine('TL');
    // maren sits on spine TL (registry v7.2), next to watson.
    expect(cardTitles()).toEqual(['Watson', 'Maren', 'Routed reference']);
    expect(cardTitles()).not.toContain('Vortex Studio hero');

    pickSpine('TL');
    pickSpine('CO');
    expect(cardTitles()).toEqual(['Unrouted reference']);

    pickSpine('CO');
    pickSpine('MI');
    expect(cardTitles()).toEqual([]);
    expect(screen.getByTestId('home-hero-website-empty').textContent)
      .toContain('No websites stored for this spine yet');

    pickSpine('MI');
    expect(cardTitles()).toHaveLength(5);
  });

  it('renders a reference badge, its route line, and a title card when there is no media', () => {
    renderHero();
    const cards = screen.getAllByTestId('home-hero-design-reference');
    const routed = cards.find((card) => card.getAttribute('data-reference-id') === 'digest-routed')!;
    expect(within(routed).getByText(/^Reference · /)).toBeTruthy();
    expect(routed.textContent).toContain('Reference · watson');
    expect(routed.getAttribute('aria-label')).toContain('TL · Agency, consultancy, or studio · watson');
    expect(routed.querySelector('.home-hero__plugin-preset-subtitle')?.getAttribute('title'))
      .toContain('TL · Agency, consultancy, or studio · watson');
    expect(routed.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(routed.querySelector('img')?.getAttribute('loading')).toBe('lazy');

    const unrouted = cards.find((card) => card.getAttribute('data-reference-id') === 'digest-unrouted')!;
    expect(unrouted.textContent).toContain('No family yet');

    // Five of the catalog's profiles carry no public preview at all; those
    // cards draw a generated title card from the profile's own style.
    const bare = cards.find((card) => card.getAttribute('data-reference-id') === 'digest-no-media')!;
    expect(bare.querySelector('.home-hero__reference-title-text')!.textContent)
      .toBe('Vortex Studio hero');
    expect(bare.querySelector('img')).toBeNull();
    expect(bare.querySelector('video')).toBeNull();
  });

  it('lets a replaced profile with the same digest recover its media', () => {
    // `od design-index add --replace` overwrites a profile in place: same
    // digest, new preview URLs. The card is keyed by digest, so it is the same
    // React element across the refetch and its recorded failure would
    // otherwise pin it to the title card for the rest of the session.
    const gone = designProfileFixture({
      digest: 'digest-replaced',
      title: 'Replaced reference',
      familyId: null,
      meta: { previewImage: 'https://cdn.example.com/gone.jpg' },
    });
    const { rerenderHero } = renderHero({ designIndexProfiles: [gone] });

    fireEvent.error(screen.getByTestId('home-hero-design-reference').querySelector('img')!);
    expect(screen.getByTestId('home-hero-design-reference')
      .querySelector('.home-hero__reference-title')).toBeTruthy();

    rerenderHero({
      designIndexProfiles: [
        designProfileFixture({
          digest: 'digest-replaced',
          title: 'Replaced reference',
          familyId: null,
          meta: { previewImage: 'https://cdn.example.com/fresh.jpg' },
        }),
      ],
    });

    const settled = screen.getByTestId('home-hero-design-reference');
    expect(settled.querySelector('.home-hero__reference-title')).toBeNull();
    expect(settled.querySelector('img')?.getAttribute('src'))
      .toBe('https://cdn.example.com/fresh.jpg');
  });

  it('marks the strip with its own geometry modifier', () => {
    // The strip's cards carry a two-row caption; the shared preset card height
    // reserves one row. The correction is CSS keyed on this class, so the class
    // is the contract — jsdom cannot measure the layout it buys.
    renderHero();
    expect(screen.getByTestId('home-hero-website-cards').classList
      .contains('home-hero__website-strip')).toBe(true);
  });

  it('sends no referrer for either remote request a reference card makes', async () => {
    // The poster states its policy on the element. The clip cannot — HTML does
    // not define `referrerpolicy` on media elements — so it is retrieved
    // through a request that states one, and played from the buffered copy.
    const { fetchMock } = stubClipTransport(async () => clipBytes());
    renderHero({ designIndexProfiles: [POSTER_AND_VIDEO] });

    const card = screen.getByTestId('home-hero-design-reference');
    expect(card.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-design-reference')
        .querySelector('video')?.getAttribute('src')).toBe('blob:reference-1');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.example.com/still.mp4',
      expect.objectContaining({
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('falls back to the title card when a video-only preview cannot be retrieved', async () => {
    stubClipTransport(async () => {
      throw new TypeError('network down');
    });
    renderHero({ designIndexProfiles: [UNROUTED] });

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-design-reference')
        .querySelector('.home-hero__reference-title')).toBeTruthy();
    });
    const settled = screen.getByTestId('home-hero-design-reference');
    expect(settled.querySelector('video')).toBeNull();
    expect(settled.querySelector('img')).toBeNull();
    expect(settled.textContent).toContain('Unrouted reference');
  });

  it('falls back to the title card when the clip of a poster+video preview is refused', async () => {
    // The poster alone is not the preview the profile stored; a card whose
    // clip is dead reads as the reference's title card, not as a still.
    stubClipTransport(async () => ({ ok: false, status: 403, blob: async () => new Blob([]) }));
    renderHero({ designIndexProfiles: [POSTER_AND_VIDEO] });
    expect(screen.getByTestId('home-hero-design-reference').querySelector('img')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-design-reference')
        .querySelector('.home-hero__reference-title')).toBeTruthy();
    });
    const settled = screen.getByTestId('home-hero-design-reference');
    expect(settled.querySelector('video')).toBeNull();
    expect(settled.querySelector('img')).toBeNull();
  });

  it('releases a reference clip when the strip goes away', async () => {
    const { revoked } = stubClipTransport(async () => clipBytes());
    const { unmount } = renderHero({ designIndexProfiles: [POSTER_AND_VIDEO] });
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-design-reference').querySelector('video')).not.toBeNull();
    });

    unmount();
    expect(revoked).toEqual(['blob:reference-1']);
  });

  it('shows the index notice while the read is in flight and still shows the family cards', () => {
    renderHero({ designIndexProfiles: [], designIndexLoading: true });
    expect(screen.getByTestId('home-hero-website-notice')).toBeTruthy();
    expect(cardTitles()).toEqual(['Watson', 'Maren']);
    // The spine row is static atlas data: it is there before the index is.
    expect(screen.getByTestId('home-hero-subtype-TL')).toBeTruthy();
  });

  it('stays usable with an inline notice when the index read fails', () => {
    renderHero({ designIndexProfiles: [], designIndexFailed: true });
    expect(screen.getByTestId('home-hero-website-notice').textContent)
      .toContain('Could not load the stored websites.');
    expect(cardTitles()).toEqual(['Watson', 'Maren']);
  });

  it('binds the routed family and seeds the brief on a routed reference click', () => {
    const onPickDesignReference = vi.fn();
    renderHero({ onPickDesignReference });

    const routed = screen.getAllByTestId('home-hero-design-reference')
      .find((card) => card.getAttribute('data-reference-id') === 'digest-routed')!;
    fireEvent.click(routed);

    expect(onPickDesignReference).toHaveBeenCalledTimes(1);
    const [profile, prompt, record] = onPickDesignReference.mock.calls[0] as [
      { source: { digest: string } }, string, InstalledPluginRecord | null,
    ];
    expect(profile.source.digest).toBe('digest-routed');
    expect(prompt).toContain('Routed reference');
    expect(prompt).toContain('Trust to lead');
    expect(record?.id).toBe('example-agency-watson');

    const emissions = vi.mocked(trackHomeChatComposerClick).mock.calls;
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.[1]).toMatchObject({
      element: 'design_reference',
      chip_id: 'prototype',
      reference_id: 'digest-routed',
      // The family id is the profile's route; the plugin id is the installed
      // generator. They are different strings and both are reported.
      routed_family_id: 'watson',
      plugin_id: 'example-agency-watson',
    });
  });

  it('reports the routed family even when its generator is not installed', () => {
    // The funnel's whole question is "which family did the router pick, and
    // did we have it?" — dropping the route when the plugin is missing loses
    // exactly the rows that answer it.
    const onPickDesignReference = vi.fn();
    renderHero({
      onPickDesignReference,
      pluginOptions: [agencyPlugin('maren', 'Maren Maker Studio')],
      designIndexProfiles: [ROUTED],
    });

    fireEvent.click(screen.getByTestId('home-hero-design-reference'));

    expect(onPickDesignReference.mock.calls[0]?.[2]).toBeNull();
    const emissions = vi.mocked(trackHomeChatComposerClick).mock.calls;
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.[1]).toMatchObject({
      element: 'design_reference',
      reference_id: 'digest-routed',
      routed_family_id: 'watson',
    });
    expect(emissions[0]?.[1]).not.toHaveProperty('plugin_id');
  });

  it('leaves the plugin binding alone on an unrouted reference click', () => {
    const onPickDesignReference = vi.fn();
    renderHero({ onPickDesignReference });

    const unrouted = screen.getAllByTestId('home-hero-design-reference')
      .find((card) => card.getAttribute('data-reference-id') === 'digest-unrouted')!;
    fireEvent.click(unrouted);

    expect(onPickDesignReference).toHaveBeenCalledTimes(1);
    const [, prompt, record] = onPickDesignReference.mock.calls[0] as [
      unknown, string, InstalledPluginRecord | null,
    ];
    expect(prompt).toContain('Unrouted reference');
    expect(record).toBeNull();

    const emissions = vi.mocked(trackHomeChatComposerClick).mock.calls;
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.[1]).toMatchObject({
      element: 'design_reference',
      reference_id: 'digest-unrouted',
    });
    expect(emissions[0]?.[1]).not.toHaveProperty('plugin_id');
    // Nothing was routed, so there is no family to report either.
    expect(emissions[0]?.[1]).not.toHaveProperty('routed_family_id');
  });

  it('is terminal: a catalog with no website at all shows the empty state, never the legacy rail', () => {
    // The Prototype branch must not fall through to `PluginPromptPresets` when
    // there is nothing to show. Without the guard the daemon's bundled
    // examples come back under Prototype — the exact thing the strip exists to
    // prevent — for any install with no agency family and an empty index.
    renderHero({
      pluginOptions: [bundledExample('example-pricing-page', 'Pricing Page')],
      designIndexProfiles: [],
    });

    expect(screen.getByTestId('home-hero-website-cards')).toBeTruthy();
    expect(screen.queryByTestId('home-hero-plugin-presets')).toBeNull();
    expect(screen.queryAllByTestId('home-hero-plugin-preset')).toHaveLength(0);
    expect(screen.queryAllByTestId('home-hero-design-reference')).toHaveLength(0);
    expect(screen.queryByTestId('home-hero-prompt-examples')).toBeNull();
    expect(screen.getByTestId('home-hero-website-empty').textContent)
      .toContain('No websites stored for this spine yet');
  });

  it('shows the empty state under a failed index read with no family installed', () => {
    renderHero({
      pluginOptions: [bundledExample('example-meeting-notes', 'Meeting Notes')],
      designIndexProfiles: [],
      designIndexFailed: true,
    });

    expect(screen.getByTestId('home-hero-website-notice').textContent)
      .toContain('Could not load the stored websites.');
    expect(screen.queryAllByTestId('home-hero-plugin-preset')).toHaveLength(0);
    expect(screen.getByTestId('home-hero-website-empty')).toBeTruthy();
  });

  it('routes a family card through the ordinary example-preset click', () => {
    const onPickExamplePlugin = vi.fn();
    renderHero({ onPickExamplePlugin });

    const family = screen.getAllByTestId('home-hero-plugin-preset')
      .find((card) => card.getAttribute('data-plugin-id') === 'example-agency-watson')!;
    fireEvent.click(family);

    expect(onPickExamplePlugin).toHaveBeenCalledTimes(1);
    expect(onPickExamplePlugin.mock.calls[0]?.[1]).toBe('prototype');
  });
});

// The strip's pinned first card: Jev picks the family from the brief when the
// user presses Send, instead of the user picking a family here. The card is a
// mode switch, so HomeHero only draws it — the mode itself lives in HomeView
// (see HomeView.agency-route.test.tsx for what Send then does).
describe('HomeHero Prototype website strip — Jev chooses', () => {
  it('shows the Jev image and keeps the card usable if the image cannot load', () => {
    const onPickJevChooses = vi.fn();
    renderHero({ onPickJevChooses });
    const card = screen.getByTestId('home-hero-jev-chooses');
    const image = card.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/images/jev-card.webp');
    fireEvent.error(image);
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.plugins-home__text-surface')).toBeTruthy();
    fireEvent.click(card);
    expect(onPickJevChooses).toHaveBeenCalledTimes(1);
  });

  it('pins the card first under All and under every spine tab', () => {
    renderHero();
    expect(railTitles()[0]).toBe('Jev');
    for (const spine of ['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI']) {
      pickSpine(spine);
      // Jev's decision is spine-agnostic: the tab only filters what the user
      // browses, so the card is there whichever tab is open.
      expect(railTitles()[0], spine).toBe('Jev');
      pickSpine(spine);
    }
  });

  it('stays offered under a spine that stores no website of its own', () => {
    renderHero();
    pickSpine('MI');
    expect(cardTitles()).toEqual([]);
    expect(screen.getByTestId('home-hero-jev-chooses')).toBeTruthy();
    expect(screen.getByTestId('home-hero-website-empty').textContent)
      .toContain('No websites stored for this spine yet');
  });

  it('is never the default, and a pick is reported to the host', () => {
    const onPickJevChooses = vi.fn();
    renderHero({ onPickJevChooses });

    const card = screen.getByTestId('home-hero-jev-chooses');
    expect(card.className).not.toContain('is-active');
    expect(card.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(card);
    expect(onPickJevChooses).toHaveBeenCalledTimes(1);
  });

  it('marks the card active while the mode is on', () => {
    renderHero({ jevChoosesActive: true });
    const card = screen.getByTestId('home-hero-jev-chooses');
    expect(card.className).toContain('is-active');
    expect(card.getAttribute('aria-pressed')).toBe('true');
  });

  it('says Jev is choosing while the route is in flight', () => {
    renderHero({ jevChoosesActive: true, jevChoosing: true });
    expect(screen.getByTestId('home-hero-jev-notice').textContent)
      .toContain('Jev is choosing…');
  });

  it('renders Jev’s result as a notice in the strip, not as an error', () => {
    renderHero({ jevChoosesNotice: 'Jev found no family for this brief.' });
    const notice = screen.getByTestId('home-hero-jev-notice');
    expect(notice.textContent).toContain('Jev found no family for this brief.');
    expect(notice.getAttribute('role')).not.toBe('alert');
    // The brief survives a notice: the website cards stay exactly as they were.
    expect(cardTitles()).toHaveLength(5);
  });

  it('is not the card the first-run guide pulses', () => {
    // Beat 2 of the trail points at the first EXAMPLE card. Jev chooses is a
    // mode, never a starting point, so the sheen stays on the first family.
    renderHero({ firstRunGuide: true });
    const jev = screen.getByTestId('home-hero-jev-chooses');
    expect(jev.className).not.toContain('home-hero__attention-sheen');
  });
});

// Everything the composer can still change about the create payload while the
// one Jev call is out: the staged files, the bound plugin and skill, the
// staged contexts, the design system and the working directory. Disabling the
// six controls the brief named is not the same as freezing the composer, so
// this is asserted surface by surface.
describe('HomeHero composer lock while Jev is choosing', () => {
  it('keeps locked file drops out of the global intake tray and restores local drops after unlock', () => {
    const onAddFiles = vi.fn();
    const onGlobalDrop = vi.fn();
    const coordinator = createDropCoordinator({ getSnapshot: () => ({}), onDrop: onGlobalDrop });
    const dispose = coordinator.mount(document);
    try {
      const { rerenderHero } = renderHero({ jevChoosing: true, onAddFiles });
      const card = document.querySelector('.home-hero__input-card')!;
      const files = [new File(['late'], 'late.txt', { type: 'text/plain' })];

      expect(fireEvent.drop(card, { dataTransfer: { files, types: ['Files'] } })).toBe(false);
      expect(onAddFiles).not.toHaveBeenCalled();
      expect(onGlobalDrop).not.toHaveBeenCalled();

      rerenderHero({ jevChoosing: false, onAddFiles });
      fireEvent.drop(card, { dataTransfer: { files, types: ['Files'] } });
      expect(onAddFiles).toHaveBeenCalledExactlyOnceWith(files);
      expect(onGlobalDrop).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  function spies() {
    return {
      onAddFiles: vi.fn(),
      onRemoveFile: vi.fn(),
      onClearActivePlugin: vi.fn(),
      onClearActiveSkill: vi.fn(),
      onRemovePluginContext: vi.fn(),
      onDesignSystemChange: vi.fn(),
      onPickWorkingDir: vi.fn(),
    };
  }

  function mutableProps(handlers: ReturnType<typeof spies>, locked: boolean) {
    return {
      ...handlers,
      jevChoosing: locked,
      jevChoosesActive: true,
      stagedFiles: [new File(['x'], 'brief.txt', { type: 'text/plain' })],
      activePluginTitle: 'Watson Trust to Lead',
      activePluginRecord: PLUGINS[0],
      activePluginIsExplicit: true,
      activeSkillTitle: 'Agency site',
      selectedPluginContexts: [PLUGINS[1]],
      designSystems: [{ id: 'brand', title: 'Brand', source: 'local' }],
      selectedDesignSystemId: null,
      workingDir: null,
      recentDirs: [],
    };
  }

  function attemptEveryMutation() {
    fireEvent.click(screen.getByLabelText('Remove brief.txt'));
    fireEvent.click(
      screen.getByTestId('home-hero-active-plugin').querySelector('.home-hero__active-clear')!,
    );
    fireEvent.click(
      screen.getByTestId('home-hero-active-skill').querySelector('.home-hero__active-clear')!,
    );
    const card = document.querySelector('.home-hero__input-card')!;
    fireEvent.drop(card, {
      dataTransfer: { files: [new File(['y'], 'late.txt', { type: 'text/plain' })], types: ['Files'] },
    });
    fireEvent.paste(screen.getByTestId('home-hero-input'), {
      clipboardData: {
        files: [new File(['z'], 'pasted.txt', { type: 'text/plain' })],
        items: [{ kind: 'file', getAsFile: () => new File(['z'], 'pasted.txt') }],
      },
    });
    fireEvent.click(screen.getByTestId('working-dir-trigger'));
    const pick = screen.queryByTestId('working-dir-pick');
    if (pick) fireEvent.click(pick);
  }

  it('refuses every composer mutation while the route is out', () => {
    const handlers = spies();
    renderHero(mutableProps(handlers, true));

    attemptEveryMutation();

    // None of it reaches the host: the payload Jev's answer will be applied to
    // is the one the user committed at Send.
    expect(handlers.onRemoveFile).not.toHaveBeenCalled();
    expect(handlers.onClearActivePlugin).not.toHaveBeenCalled();
    expect(handlers.onClearActiveSkill).not.toHaveBeenCalled();
    expect(handlers.onAddFiles).not.toHaveBeenCalled();
    expect(handlers.onPickWorkingDir).not.toHaveBeenCalled();
    // Gating a handler is not the same as freezing a surface: a picker that
    // still opens and then silently does nothing reads as a broken composer.
    // Every trigger that can start a mutation is refused at the surface.
    for (const testId of [
      'home-hero-design-system-trigger',
      'home-hero-template-trigger',
      'working-dir-trigger',
      'home-hero-file-input',
    ]) {
      expect((screen.getByTestId(testId) as HTMLButtonElement | HTMLInputElement).disabled, testId)
        .toBe(true);
    }
  });

  it('hands every one of them back once the route settles', () => {
    const handlers = spies();
    renderHero(mutableProps(handlers, false));

    attemptEveryMutation();

    expect(handlers.onRemoveFile).toHaveBeenCalled();
    expect(handlers.onClearActivePlugin).toHaveBeenCalled();
    expect(handlers.onClearActiveSkill).toHaveBeenCalled();
    expect(handlers.onAddFiles).toHaveBeenCalled();
    expect(handlers.onPickWorkingDir).toHaveBeenCalled();
    for (const testId of [
      'home-hero-design-system-trigger',
      'home-hero-template-trigger',
      'working-dir-trigger',
      'home-hero-file-input',
    ]) {
      expect((screen.getByTestId(testId) as HTMLButtonElement | HTMLInputElement).disabled, testId)
        .toBe(false);
    }
  });
});

// Three ways the lock was still reachable: a menu that was already open when
// the lock arrived, a clear button that rewrote the brief before checking, and
// a host node that only stopped the mouse.
describe('HomeHero composer lock — the paths that got around it', () => {
  const WORKSPACE_ITEM = {
    id: 'ws-1',
    kind: 'project' as const,
    label: 'Reference project',
  };

  it('closes a plus menu that was already open when the lock arrives', () => {
    const { rerenderHero } = renderHero({ jevChoosesActive: true });
    fireEvent.click(screen.getByTestId('home-hero-plus-trigger'));
    expect(screen.getByTestId('composer-plus-attach')).toBeTruthy();

    // The menu's items live in a portal, so disabling the trigger never
    // reached them.
    rerenderHero({ jevChoosesActive: true, jevChoosing: true });

    expect(screen.queryByTestId('composer-plus-attach')).toBeNull();
    expect((screen.getByTestId('home-hero-plus-trigger') as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('leaves the brief alone when a workspace context is cleared while locked', () => {
    // The removal was gated but the mention strip that precedes it was not, so
    // the brief Jev is reading could still change under the lock.
    const onPromptChange = vi.fn();
    const onRemoveWorkspaceContext = vi.fn();
    renderHero({
      jevChoosesActive: true,
      jevChoosing: true,
      prompt: 'Build @Reference project into a site',
      onPromptChange,
      contextWorkspaceItems: [WORKSPACE_ITEM],
      onRemoveWorkspaceContext,
    });

    fireEvent.click(screen.getByTestId('home-hero-context-clear-ws-1'));

    expect(onPromptChange).not.toHaveBeenCalled();
    expect(onRemoveWorkspaceContext).not.toHaveBeenCalled();
  });

  it('still clears a workspace context and its mention once unlocked', () => {
    const onPromptChange = vi.fn();
    const onRemoveWorkspaceContext = vi.fn();
    renderHero({
      jevChoosesActive: true,
      prompt: 'Build @Reference project into a site',
      onPromptChange,
      contextWorkspaceItems: [WORKSPACE_ITEM],
      onRemoveWorkspaceContext,
    });

    fireEvent.click(screen.getByTestId('home-hero-context-clear-ws-1'));

    expect(onPromptChange).toHaveBeenCalled();
    expect(onRemoveWorkspaceContext).toHaveBeenCalledWith('ws-1');
  });

  it('blocks the execution switcher to the keyboard, not only the mouse', () => {
    // `pointer-events: none` says nothing to a focused descendant: Enter and
    // Space still activate it.
    const onSwitch = vi.fn();
    renderHero({
      jevChoosesActive: true,
      jevChoosing: true,
      executionSwitcher: (
        <button type="button" data-testid="exec-switch" onClick={onSwitch}>
          Switch
        </button>
      ),
    });

    const target = screen.getByTestId('exec-switch');
    expect(fireEvent.keyDown(target, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(target, { key: ' ' })).toBe(false);
    fireEvent.click(target);

    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('lets the keyboard leave the locked execution switcher', () => {
    // Swallowing every key would trap a descendant that already had focus when
    // the lock arrived: locked is not the same as captured. Only activation is
    // refused; navigation and dismissal still belong to the user.
    renderHero({
      jevChoosesActive: true,
      jevChoosing: true,
      executionSwitcher: (
        <button type="button" data-testid="exec-switch">
          Switch
        </button>
      ),
    });

    const target = screen.getByTestId('exec-switch');
    for (const key of ['Tab', 'Escape', 'ArrowDown']) {
      // `fireEvent` returns false only when something called preventDefault.
      expect(fireEvent.keyDown(target, { key }), key).toBe(true);
    }
  });

  it('hands the execution switcher back once unlocked', () => {
    const onSwitch = vi.fn();
    renderHero({
      jevChoosesActive: true,
      executionSwitcher: (
        <button type="button" data-testid="exec-switch" onClick={onSwitch}>
          Switch
        </button>
      ),
    });

    fireEvent.click(screen.getByTestId('exec-switch'));

    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it('shows every clear button as disabled while locked, and working after', () => {
    // A focusable button that announces itself as enabled, then silently
    // refuses — and records a removal in analytics on the way — is worse than
    // one that says it cannot act.
    const handlers = {
      onRemoveFile: vi.fn(),
      onClearActivePlugin: vi.fn(),
      onClearActiveSkill: vi.fn(),
      onRemovePluginContext: vi.fn(),
      onRemoveMcpContext: vi.fn(),
      onRemoveConnectorContext: vi.fn(),
      onRemoveWorkspaceContext: vi.fn(),
    };
    const shared = {
      ...handlers,
      jevChoosesActive: true,
      stagedFiles: [new File(['x'], 'brief.txt', { type: 'text/plain' })],
      activePluginTitle: 'Watson Trust to Lead',
      activePluginRecord: PLUGINS[0],
      activePluginIsExplicit: true,
      activeSkillTitle: 'Agency site',
      contextOnlyPlugins: [PLUGINS[1]],
      contextOnlyMcpServers: [{ id: 'mcp-1', label: 'Files' }],
      contextOnlyConnectors: [{ id: 'conn-1', name: 'Gmail', provider: 'google', category: 'email', status: 'connected' }],
      contextWorkspaceItems: [WORKSPACE_ITEM],
    };

    const { rerenderHero } = renderHero({ ...shared, jevChoosing: true });
    const clears = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('.home-hero__active-clear'));

    expect(clears().length).toBeGreaterThanOrEqual(7);
    for (const button of clears()) {
      expect(button.disabled, button.getAttribute('aria-label') ?? '').toBe(true);
    }
    for (const button of clears()) fireEvent.click(button);
    for (const spy of Object.values(handlers)) expect(spy).not.toHaveBeenCalled();
    // The analytics a removal would have recorded never happened either.
    expect(vi.mocked(trackHomeChatComposerClick)).not.toHaveBeenCalled();

    rerenderHero({ ...shared, jevChoosing: false });
    for (const button of clears()) {
      expect(button.disabled, button.getAttribute('aria-label') ?? '').toBe(false);
    }
    for (const button of clears()) fireEvent.click(button);
    for (const [name, spy] of Object.entries(handlers)) {
      expect(spy, name).toHaveBeenCalled();
    }
  });

  it('keeps attachment-only Send available where Jev is dormant', () => {
    // Jev stays selected but dormant off Prototype, and Send there is the
    // ordinary Home send: an attachment alone is a valid brief for it.
    renderHero({
      jevChoosesActive: true,
      activeChipId: 'document',
      prompt: '',
      stagedFiles: [new File(['x'], 'brief.txt', { type: 'text/plain' })],
    });

    expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('still requires the text under Prototype, where Jev actually reads it', () => {
    renderHero({
      jevChoosesActive: true,
      activeChipId: 'prototype',
      prompt: '',
      stagedFiles: [new File(['x'], 'brief.txt', { type: 'text/plain' })],
    });

    expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

// Three surfaces that outlive the moment the lock arrives: a wrapper the host
// can swap underneath it, a mention picker that was already open, and a
// working-directory panel that was already open.
describe('HomeHero composer lock — surfaces that were already open', () => {
  function switcher(testId = 'exec-switch') {
    return (
      <button type="button" data-testid={testId}>
        Switch
      </button>
    );
  }

  function switcherWrapper(): HTMLElement {
    return screen.getByTestId('home-hero-execution-switcher');
  }

  it('marks the execution switcher inert while locked and clears it after', () => {
    const { rerenderHero } = renderHero({
      jevChoosesActive: true,
      jevChoosing: true,
      executionSwitcher: switcher(),
    });
    expect(switcherWrapper().hasAttribute('inert')).toBe(true);

    rerenderHero({ jevChoosesActive: true, executionSwitcher: switcher() });
    expect(switcherWrapper().hasAttribute('inert')).toBe(false);
  });

  it('inerts a switcher the host swaps in while the lock is still on', () => {
    // EntryShell drops and restores the switcher when Home is left and
    // returned to. An effect that snapshotted one node and keyed only on the
    // lock would leave the replacement live.
    const { rerenderHero } = renderHero({
      jevChoosesActive: true,
      jevChoosing: true,
      executionSwitcher: switcher(),
    });
    const first = switcherWrapper();
    expect(first.hasAttribute('inert')).toBe(true);

    rerenderHero({ jevChoosesActive: true, jevChoosing: true });
    expect(screen.queryByTestId('home-hero-execution-switcher')).toBeNull();
    // The node that went away does not keep the attribute either.
    expect(first.hasAttribute('inert')).toBe(false);

    rerenderHero({
      jevChoosesActive: true,
      jevChoosing: true,
      executionSwitcher: switcher('exec-switch-2'),
    });
    const second = switcherWrapper();
    expect(second).not.toBe(first);
    expect(second.hasAttribute('inert')).toBe(true);
  });

  it('leaves no inert node behind when the hero unmounts while locked', () => {
    const { unmount } = renderHero({
      jevChoosesActive: true,
      jevChoosing: true,
      executionSwitcher: switcher(),
    });
    const node = switcherWrapper();
    expect(node.hasAttribute('inert')).toBe(true);

    unmount();
    expect(node.hasAttribute('inert')).toBe(false);
  });

  it('closes a mention picker that was already open when the lock arrives', () => {
    const onPickPlugin = vi.fn();
    const { rerenderHero } = renderHero({ jevChoosesActive: true, onPickPlugin });

    setHomeHeroPrompt('@Watson');
    expect(screen.getByTestId('home-hero-plugin-picker')).toBeTruthy();

    rerenderHero({ jevChoosesActive: true, jevChoosing: true, onPickPlugin, prompt: '@Watson' });

    expect(screen.queryByTestId('home-hero-plugin-picker')).toBeNull();
    expect(onPickPlugin).not.toHaveBeenCalled();
  });

  it('closes a working-directory panel that was already open when the lock arrives', () => {
    const onPickWorkingDir = vi.fn();
    const { rerenderHero } = renderHero({ jevChoosesActive: true, onPickWorkingDir });

    fireEvent.click(screen.getByTestId('working-dir-trigger'));
    expect(screen.getByTestId('working-dir-panel')).toBeTruthy();

    rerenderHero({ jevChoosesActive: true, jevChoosing: true, onPickWorkingDir });

    expect(screen.queryByTestId('working-dir-panel')).toBeNull();
    expect(screen.queryByTestId('working-dir-pick')).toBeNull();
    expect(onPickWorkingDir).not.toHaveBeenCalled();
    // Nothing was staged as a removal or a pick on the way, either.
    expect(vi.mocked(trackHomeChatComposerClick)).not.toHaveBeenCalled();
  });

  it('opens the working-directory panel again once unlocked', () => {
    const onPickWorkingDir = vi.fn();
    const { rerenderHero } = renderHero({
      jevChoosesActive: true,
      jevChoosing: true,
      onPickWorkingDir,
    });
    expect((screen.getByTestId('working-dir-trigger') as HTMLButtonElement).disabled).toBe(true);

    rerenderHero({ jevChoosesActive: true, onPickWorkingDir });
    fireEvent.click(screen.getByTestId('working-dir-trigger'));
    fireEvent.click(screen.getByTestId('working-dir-pick'));

    expect(onPickWorkingDir).toHaveBeenCalledTimes(1);
  });
});

// Dismissing the picker once is not the same as keeping it shut: the editor
// can report a fresh trigger at any time, including from an update that was
// already queued when the lock landed.
describe('HomeHero composer lock — the mention picker stays shut', () => {
  function pickerOptions(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.home-hero__plugin-option'));
  }

  it('refuses a mention trigger that arrives after the lock', () => {
    const onPickPlugin = vi.fn();
    const onPickSkill = vi.fn();
    const { rerenderHero } = renderHero({ jevChoosesActive: true, onPickPlugin, onPickSkill });

    rerenderHero({ jevChoosesActive: true, jevChoosing: true, onPickPlugin, onPickSkill });
    // A queued editor update lands after the locked render and reports a new
    // trigger; the dismiss that ran on the lock cannot help here.
    setHomeHeroPrompt('@Watson');

    expect(screen.queryByTestId('home-hero-plugin-picker')).toBeNull();
    expect(pickerOptions()).toHaveLength(0);
    expect(onPickPlugin).not.toHaveBeenCalled();
    expect(onPickSkill).not.toHaveBeenCalled();
  });

  it('opens on a fresh @ once the lock lifts', () => {
    const onPickPlugin = vi.fn();
    const { rerenderHero } = renderHero({
      jevChoosesActive: true,
      jevChoosing: true,
      onPickPlugin,
    });
    setHomeHeroPrompt('@Watson');
    expect(screen.queryByTestId('home-hero-plugin-picker')).toBeNull();

    rerenderHero({ jevChoosesActive: true, onPickPlugin, prompt: '@Watson' });
    setHomeHeroPrompt('@Wat');

    expect(screen.getByTestId('home-hero-plugin-picker')).toBeTruthy();
    expect(pickerOptions().length).toBeGreaterThan(0);
  });
});
