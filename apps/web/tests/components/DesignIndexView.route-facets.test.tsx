// @vitest-environment jsdom
//
// The Search panel's route facets. Spine, archetype and family come from the
// fast lane's static data module rather than from the taxonomy endpoint, so
// they are populated before any request answers — and an archetype belongs to
// exactly one spine, so the list narrows with the picked spine.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { familyRegistry, shapeAtlas } from '@mish/agency-fast-lane/data';

import { DesignIndexView } from '../../src/components/DesignIndexView';
import { DESIGN_INDEX_CHANGED_EVENT } from '../../src/state/design-index';
import { designProfileFixture } from '../fixtures/design-profile';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TAXONOMY = {
  version: 'design-taxonomy/1',
  sections: [{ id: 'hero', definition: 'hero' }],
  components: [{ id: 'primary-cta', definition: 'cta' }],
  mechanics: [{ id: 'scroll-reveal', definition: 'reveal' }],
  depth: [{ id: 'flat', definition: 'flat' }],
  style: {
    ground: [{ id: 'dark', definition: 'dark' }],
    accent: [{ id: 'warm', definition: 'warm' }],
    typography: [{ id: 'geometric-sans', definition: 'sans' }],
    imagery: [{ id: 'photography', definition: 'photo' }],
    topology: [{ id: 'single-column', definition: 'column' }],
    density: [{ id: 'airy', definition: 'airy' }],
  },
  quality: [{ id: 'craft', rubric: 'craft', levels: ['low', 'high'] }],
  truthRisk: { id: 'risk', instructions: '', criteriaTrue: '', criteriaFalse: '' },
  action: [{ id: 'book', definition: 'book' }],
};

function stubFetch() {
  const calls: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('/api/design-index/taxonomy')) {
      return new Response(JSON.stringify({ taxonomy: TAXONOMY }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('/api/design-index')) {
      return new Response(
        JSON.stringify({ profiles: [designProfileFixture({ digest: 'a' })], matched: 1, total: 1 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function optionValues(testId: string): string[] {
  return Array.from(screen.getByTestId(testId).querySelectorAll('option'))
    .map((option) => option.getAttribute('value') ?? '');
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('DesignIndexView route facets', () => {
  it('offers the atlas spines, its archetypes and the registry families', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await settle();

    expect(optionValues('design-index-facet-spine'))
      .toEqual(['', ...shapeAtlas.spines.map((spine) => spine.code)]);
    expect(optionValues('design-index-facet-archetype'))
      .toEqual(['', ...shapeAtlas.archetypes.map((archetype) => archetype.id)]);
    expect(optionValues('design-index-facet-family'))
      .toEqual(['', ...familyRegistry.families.map((entry) => entry.family)]);
  });

  it('narrows the archetype list to the picked spine and drops a stale pick', async () => {
    stubFetch();
    render(<DesignIndexView />);
    await settle();

    fireEvent.change(screen.getByTestId('design-index-facet-archetype'), { target: { value: 'CO.01' } });
    expect((screen.getByTestId('design-index-facet-archetype') as HTMLSelectElement).value).toBe('CO.01');

    fireEvent.change(screen.getByTestId('design-index-facet-spine'), { target: { value: 'TL' } });
    const narrowed = optionValues('design-index-facet-archetype');
    expect(narrowed.slice(1).every((id) => id.startsWith('TL.'))).toBe(true);
    // CO.01 cannot match a TL profile, so the stale pair is dropped rather than
    // silently matching nothing.
    expect((screen.getByTestId('design-index-facet-archetype') as HTMLSelectElement).value).toBe('');
  });

  it('builds spine=TL into the search query', async () => {
    const calls = stubFetch();
    render(<DesignIndexView />);
    await settle();

    fireEvent.change(screen.getByTestId('design-index-facet-spine'), { target: { value: 'TL' } });
    fireEvent.change(screen.getByTestId('design-index-facet-family'), { target: { value: 'practice' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('design-index-search'));
      await Promise.resolve();
    });
    await settle();

    const query = calls.at(-1) ?? '';
    expect(query).toContain('spine=TL');
    expect(query).toContain('family=practice');
  });

  it('tells Home when a stored profile is removed', async () => {
    stubFetch();
    const changed = vi.fn();
    window.addEventListener(DESIGN_INDEX_CHANGED_EVENT, changed);
    render(<DesignIndexView />);
    await settle();

    await waitFor(() => expect(screen.getByTestId('design-index-count')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('design-index-remove'));
      await Promise.resolve();
    });
    await settle();

    expect(changed).toHaveBeenCalled();
    window.removeEventListener(DESIGN_INDEX_CHANGED_EVENT, changed);
  });
});
