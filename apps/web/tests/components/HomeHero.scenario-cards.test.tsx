// @vitest-environment jsdom
//
// Scenario-card rail coverage.
//   - The default create rail renders illustrated scenario cards carrying a
//     title AND a one-line description.
//   - The rail leads with Website clone, then the slide deck ("Slides"), per the
//     curated create order.
//   - The finer-grained scenarios (wireframe / mobile / document) exist and
//     route to a working scenario plugin.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomeHero } from '../../src/components/HomeHero';
import { findChip, orderedCreateChips } from '../../src/components/home-hero/chips';
import {
  prototypeSceneProjectMetadata,
  prototypeSubChipForSlug,
} from '../../src/components/home-hero/sub-chips';

afterEach(() => {
  cleanup();
});

function renderHero(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}) {
  const props = {
    prompt: '',
    onPromptChange: () => undefined,
    onSubmit: () => undefined,
    activePluginTitle: null,
    activeChipId: null,
    onClearActivePlugin: () => undefined,
    pluginOptions: [],
    pluginsLoading: false,
    pendingPluginId: null,
    pendingChipId: null,
    onPickPlugin: () => undefined,
    onPickChip: () => undefined,
    contextItemCount: 0,
    error: null,
    ...overrides,
  } as React.ComponentProps<typeof HomeHero>;
  render(<HomeHero {...props} />);
}

// #5517 removed the illustrated scenario-card rail from Home; scenarios are
// picked from the composer footer's radial template picker instead.
function openTemplatePicker() {
  fireEvent.click(screen.getByTestId('home-hero-template-trigger'));
}

describe('HomeHero scenario cards', () => {
  it('labels each create scenario in the composer template picker', () => {
    renderHero();
    openTemplatePicker();
    expect(
      screen.getByTestId('home-hero-template-wedge-prototype').getAttribute('aria-label'),
    ).toContain('Prototype');
    expect(
      screen.getByTestId('home-hero-template-wedge-deck').getAttribute('aria-label'),
    ).toContain('Slide deck');
  });

  it('uses the streamlined Home creation hierarchy in product order', () => {
    const ordered = orderedCreateChips();
    const ids = ordered.map((chip) => chip.id);
    expect(ids).toEqual([
      'prototype',
      'deck',
      'image',
      'document',
      'web-clone',
      'video',
      'audio',
      'live-artifact',
    ]);
    expect(ids).not.toContain('wireframe');
    expect(ids).not.toContain('mobile');
    expect(ids).not.toContain('webgl');
  });

  it('keeps nested prototype scenarios executable without giving them a chip of their own', () => {
    renderHero();
    openTemplatePicker();
    expect(screen.queryByTestId('home-hero-template-wedge-wireframe')).toBeNull();
    expect(screen.queryByTestId('home-hero-template-wedge-mobile')).toBeNull();
    expect(screen.getByTestId('home-hero-template-wedge-document')).toBeTruthy();
    // They are scenes, so they have no catalog entry at all — what makes them
    // executable is the Prototype chip's action plus their own refinement.
    expect(findChip('wireframe')).toBeUndefined();
    expect(findChip('mobile')).toBeUndefined();
    const prototypeChip = findChip('prototype')!;
    expect(prototypeChip.action).toMatchObject({
      kind: 'apply-scenario',
      pluginId: 'example-web-prototype',
      projectKind: 'prototype',
    });
    // Wireframe reuses the web-prototype seed at lo-fi fidelity.
    expect(
      prototypeSceneProjectMetadata(prototypeChip, prototypeSubChipForSlug('wireframe')),
    ).toEqual({ kind: 'prototype', fidelity: 'wireframe' });
    expect(findChip('document')?.action).toMatchObject({
      pluginId: 'od-new-generation',
      projectKind: 'other',
    });
  });

  it('keeps an empty composer disabled while plugins are loading', () => {
    const onSubmit = vi.fn();
    renderHero({ pluginsLoading: true, onSubmit });
    const submit = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the composer empty after picking a nested Prototype scene', () => {
    renderHero({ activeChipId: 'prototype', activePrototypeSubtypeId: 'mobile' });
    expect(document.querySelector('.home-hero-placeholder-carousel')).toBeNull();
    expect(screen.getByTestId('home-hero-submit').hasAttribute('disabled')).toBe(true);
  });
});
