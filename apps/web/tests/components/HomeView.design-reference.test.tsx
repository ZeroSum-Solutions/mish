// @vitest-environment jsdom
//
// What a reference card click does to the composer, through the real HomeView:
// the brief always lands in the editor, and the family generator is bound only
// when the router resolved a family that is actually installed.

import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { homeHeroPromptText } from '../helpers/home-hero-lexical';
import { designProfileFixture } from '../fixtures/design-profile';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function pluginRecord(id: string, title: string, skills: Array<Record<string, string>>) {
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

const CATALOG = [
  pluginRecord('example-web-prototype', 'Web Prototype', [{ path: './SKILL.md' }]),
  pluginRecord('od-new-generation', 'New generation', [{ path: './SKILL.md' }]),
  pluginRecord('example-agency-watson', 'Watson Trust to Lead', [
    { ref: 'agency-site' },
    { path: './SKILL.md' },
  ]),
];

const PROFILES = [
  designProfileFixture({
    digest: 'digest-routed',
    title: 'Routed reference',
    spine: 'TL',
    familyId: 'watson',
  }),
  designProfileFixture({
    digest: 'digest-unrouted',
    title: 'Unrouted reference',
    spine: 'CO',
    archetype: 'CO.01',
    familyId: null,
  }),
];

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
    snapshotId: 'snap',
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

function stubFetch() {
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    const href = String(url);
    if (href === '/api/plugins') {
      return new Response(JSON.stringify({ plugins: CATALOG }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.startsWith('/api/design-index')) {
      return new Response(
        JSON.stringify({ profiles: PROFILES, matched: PROFILES.length, total: PROFILES.length }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (href.includes('/apply-local')) {
      return new Response(JSON.stringify(APPLY_RESULT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(window.performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  return fetchMock;
}

function renderHome() {
  return render(
    <HomeView
      projects={[]}
      onSubmit={() => undefined}
      onOpenProject={() => undefined}
      onViewAllProjects={() => undefined}
    />,
  );
}

async function clickReference(digest: string) {
  let card: HTMLElement | undefined;
  await waitFor(() => {
    card = screen.queryAllByTestId('home-hero-design-reference')
      .find((item) => item.getAttribute('data-reference-id') === digest);
    expect(card).toBeTruthy();
  });
  fireEvent.click(card!);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('HomeView — picking a stored design reference', () => {
  it('binds the routed family generator and seeds the brief', async () => {
    stubFetch();
    renderHome();
    await screen.findByTestId('home-hero-input');

    await clickReference('digest-routed');

    await waitFor(() => expect(homeHeroPromptText()).toContain('Routed reference'));
    expect(homeHeroPromptText()).toContain('Trust to lead');
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-plugin').textContent)
        .toContain('Watson Trust to Lead');
    });
  });

  it('seeds only the brief for an unrouted reference and leaves the binding alone', async () => {
    stubFetch();
    renderHome();
    await screen.findByTestId('home-hero-input');

    // Bind a family first, so "leaves the binding alone" has something to hold.
    await clickReference('digest-routed');
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-plugin').textContent)
        .toContain('Watson Trust to Lead');
    });

    await clickReference('digest-unrouted');
    await waitFor(() => expect(homeHeroPromptText()).toContain('Unrouted reference'));
    // The composer text moved; the bound generator did not.
    expect(screen.getByTestId('home-hero-active-plugin').textContent)
      .toContain('Watson Trust to Lead');
  });
});
