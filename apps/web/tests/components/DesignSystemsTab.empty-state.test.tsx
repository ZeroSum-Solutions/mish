// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@mish/contracts';

import { DesignSystemsTab } from '../../src/components/DesignSystemsTab';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchDesignSystem: vi.fn(async (id: string) => ({
      id,
      title: 'Neutral Product',
      summary: 'Calm, neutral product system.',
      category: 'Productivity & SaaS',
      body: '# Neutral\n\n## Colors\n- Primary #111111',
    })),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const preset: DesignSystemSummary = {
  id: 'neutral-product',
  title: 'Neutral Product',
  category: 'Productivity & SaaS',
  summary: 'Calm, neutral product system.',
  surface: 'web',
  source: 'built-in',
  status: 'published',
  isEditable: false,
  swatches: ['#f8f8f7', '#16171a', '#1e5a78'],
};

describe('DesignSystemsTab empty state', () => {
  it('shows one designed empty state instead of a list column plus a preview placeholder', () => {
    render(<DesignSystemsTab systems={[preset]} selectedId={null} onSelect={() => {}} onCreate={() => {}} />);

    const empty = screen.getByTestId('design-systems-empty');
    expect(empty.textContent).toContain('No design systems yet');
    // The explanation appears once, not in two panes.
    expect(screen.getAllByText(/Create one from real product context/)).toHaveLength(1);
    // The body explains; it does not repeat the title line.
    expect(empty.textContent?.match(/No design systems yet/g)).toHaveLength(1);
    expect(screen.queryByTestId('design-systems-list')).toBeNull();
    expect(screen.queryByTestId('design-systems-preview')).toBeNull();
    // The page keeps exactly one Create action, in the header.
    expect(screen.getAllByRole('button', { name: /^Create$/ })).toHaveLength(1);
  });

  it('offers the official presets from an empty collection', async () => {
    render(<DesignSystemsTab systems={[preset]} selectedId={null} onSelect={() => {}} onCreate={() => {}} />);

    fireEvent.click(screen.getByTestId('design-systems-empty-browse'));
    expect(screen.getByRole('tab', { name: 'Official presets' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('design-system-card-neutral-product')).toBeTruthy();
    expect(await screen.findByTestId('design-kit-view-neutral-product')).toBeTruthy();
  });

  it('says the official catalog is empty, not "no match", when nothing is filtered', () => {
    render(<DesignSystemsTab systems={[]} selectedId={null} onSelect={() => {}} onCreate={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Official presets' }));

    const empty = screen.getByTestId('design-systems-empty');
    expect(empty.textContent).toContain('No official presets available');
    expect(empty.textContent).not.toContain('match your search');
  });

  it('turns a search with no match into a clear-search action', () => {
    render(<DesignSystemsTab systems={[preset]} selectedId={null} onSelect={() => {}} onCreate={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Official presets' }));
    fireEvent.change(screen.getByTestId('design-systems-search'), { target: { value: 'zzz no match' } });

    expect(screen.getByTestId('design-systems-empty').textContent).toContain('No design systems match your search.');
    fireEvent.click(screen.getByTestId('design-systems-empty-clear'));
    expect((screen.getByTestId('design-systems-search') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('design-system-card-neutral-product')).toBeTruthy();
  });

  it('moves between scopes with the arrow keys like a segmented control', () => {
    render(<DesignSystemsTab systems={[preset]} selectedId={null} onSelect={() => {}} onCreate={() => {}} />);
    const mine = screen.getByRole('tab', { name: 'Your systems' });
    expect(mine.tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Official presets' }).tabIndex).toBe(-1);

    fireEvent.keyDown(mine, { key: 'ArrowRight' });
    const official = screen.getByRole('tab', { name: 'Official presets' });
    expect(official.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(official);
  });

  it('shows the palette strip and a status badge on each card', () => {
    render(<DesignSystemsTab systems={[{ ...preset, id: 'user:mine', source: 'user', isEditable: true, status: 'draft' }]} selectedId="user:mine" onSelect={() => {}} onCreate={() => {}} />);
    const card = screen.getByTestId('design-system-card-user:mine');
    expect(card.textContent).toContain('Draft');
    expect(card.textContent).toContain('Chat default');
    expect(card.querySelectorAll('[style*="background"]').length).toBeGreaterThanOrEqual(3);
  });
});
