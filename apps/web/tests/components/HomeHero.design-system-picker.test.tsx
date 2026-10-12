// @vitest-environment jsdom
//
// Team release P0s on the Home composer's design-system picker:
//  - while the catalogue is still loading the picker must say so, not open on
//    "No matching design systems" (QA J3 P0-1: a slow catalogue read looked
//    like an empty, broken picker);
//  - an installed kit lands as a draft; Home must show it with a Publish
//    action instead of hiding it (Track B P0).

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomeHero } from '../../src/components/HomeHero';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const APPROVAL = { status: 'approved', revision: 'r1', approvedRevision: 'r1' };
const PUBLISHED = { approval: APPROVAL, id: 'user:brand', title: 'Brand', summary: '', category: 'Product', source: 'user', status: 'published' };
const DRAFT = { approval: APPROVAL, id: 'user:acme', title: 'Acme Kit', summary: '', category: 'Product', source: 'user', status: 'draft' };

function renderHero(overrides: Record<string, unknown> = {}) {
  const Hero = HomeHero as unknown as (props: Record<string, unknown>) => JSX.Element;
  return render(
    <Hero
      {...{
        prompt: '',
        onPromptChange: () => undefined,
        onSubmit: () => undefined,
        activePluginTitle: null,
        activeChipId: 'prototype',
        onClearActivePlugin: () => undefined,
        pluginOptions: [],
        pluginsLoading: false,
        pendingPluginId: null,
        pendingChipId: null,
        onPickPlugin: () => undefined,
        onPickChip: () => undefined,
        contextItemCount: 0,
        error: null,
        designIndexProfiles: [],
        onDesignSystemChange: vi.fn(),
        selectedDesignSystemId: null,
        designSystems: [PUBLISHED],
        ...overrides,
      }}
    />,
  );
}

describe('Home composer design-system picker', () => {
  it('reads as loading while the catalogue has not arrived, instead of an empty picker', () => {
    renderHero({ designSystems: [], designSystemsLoading: true });
    const trigger = screen.getByTestId('home-hero-design-system-trigger');
    expect(trigger.textContent).toContain('Loading design systems');
  });

  it('shows an installed draft kit with a Publish action, and selects it once published', async () => {
    const onDesignSystemChange = vi.fn();
    const onPublishDesignSystemDraft = vi.fn(async () => true);
    renderHero({
      designSystems: [PUBLISHED, DRAFT],
      onDesignSystemChange,
      onPublishDesignSystemDraft,
    });
    fireEvent.click(screen.getByTestId('home-hero-design-system-trigger'));
    expect(screen.getByTestId('project-ds-picker-draft-user:acme')).toBeTruthy();
    // A draft is not directly selectable: generation would skip it.
    expect(screen.queryByTestId('project-ds-picker-option-user:acme')).toBeNull();
    fireEvent.click(screen.getByTestId('project-ds-picker-publish-user:acme'));
    await waitFor(() => expect(onDesignSystemChange).toHaveBeenCalledWith('user:acme'));
    expect(onPublishDesignSystemDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'user:acme' }));
  });
});
