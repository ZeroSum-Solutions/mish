// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesignSystemSummary } from '../../src/types';

vi.mock('../../src/providers/registry', () => ({
  designSystemStaticUrl: (id: string, filePath: string) => `/design-systems/${id}/${filePath}`,
  fetchDesignSystem: vi.fn(),
  setDesignSystemApproval: vi.fn(),
  fetchDesignSystemShowcase: vi.fn(async () => '<!doctype html><p>Showcase</p>'),
  fetchProjectFileText: vi.fn(),
  openExternalUrl: vi.fn(),
  projectRawUrl: (projectId: string, filePath: string) => `/raw/${projectId}/${filePath}`,
}));

import { DesignSystemPicker } from '../../src/components/DesignSystemPicker';
import { I18nProvider, type Locale } from '../../src/i18n';
import {
  fetchDesignSystem,
  setDesignSystemApproval,
  fetchProjectFileText,
} from '../../src/providers/registry';

const fetchDesignSystemMock = vi.mocked(fetchDesignSystem);
const fetchProjectFileTextMock = vi.mocked(fetchProjectFileText);

const designSystems: DesignSystemSummary[] = [
  {
    approval: { status: 'approved', revision: 'r1', approvedRevision: 'r1' },
    id: 'clay',
    title: 'Clay',
    summary: 'Friendly tactile product UI.',
    category: 'Product',
    swatches: ['#f4efe7', '#25211d'],
  },
  {
    approval: { status: 'approved', revision: 'r2', approvedRevision: 'r2' },
    id: 'noir',
    title: 'Editorial Noir',
    summary: 'High-contrast editorial system.',
    category: "Mobile",
    swatches: ['#111111', '#f7f0e8'],
  },
];

beforeEach(() => {
  fetchDesignSystemMock.mockImplementation(async (id) => ({
    id,
    title: id === 'clay' ? 'Clay' : 'Editorial Noir',
    summary: id === 'clay' ? 'Friendly tactile product UI.' : 'High-contrast editorial system.',
    category: id === 'clay' ? 'Product' : "Mobile",
    body: [
      `# ${id === 'clay' ? 'Clay' : 'Editorial Noir'}`,
      '',
      id === 'clay' ? 'Friendly tactile product UI.' : 'High-contrast editorial system.',
      '',
      '## Typography',
      id === 'clay' ? '- Display: Fraunces' : '- Display: Playfair Display',
      '- Body: Inter',
      '',
      '## Color Palette',
      id === 'clay' ? '- Warm Paper #f4efe7' : '- Ink #111111',
      id === 'clay' ? '- Charcoal #25211d' : '- Bone #f7f0e8',
    ].join('\n'),
    swatches: id === 'clay' ? ['#f4efe7', '#25211d'] : ['#111111', '#f7f0e8'],
  }));
  fetchProjectFileTextMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DesignSystemPicker', () => {
  it('applies the picked system when the option is activated with a click', () => {
    const onChange = vi.fn();
    renderPicker({ onChange }, 'en');
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    fireEvent.click(screen.getByTestId('project-ds-picker-option-clay'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('clay');
    expect(screen.queryByTestId('project-ds-picker-popover')).toBeNull();
  });

  it.each(['project', 'home'] as const)('searches words across metadata and colors in the %s picker', async (variant) => {
    renderPicker({ variant }, 'en');
    fireEvent.click(screen.getByTestId(variant === 'home' ? 'home-hero-design-system-trigger' : 'project-ds-picker-trigger'));
    const search = screen.getByPlaceholderText('Search design systems');
    fireEvent.change(search, { target: { value: 'noir editorial 111111' } });
    expect(screen.getByTestId('project-ds-picker-option-noir')).toBeTruthy();
    expect(screen.queryByTestId('project-ds-picker-option-clay')).toBeNull();
  });

  it('distinguishes published kits with identical titles by their source identity', () => {
    renderPicker({ designSystems: [
      { ...designSystems[0]!, id: 'user:atlas-lang', title: 'Atlas kit', source: 'user', status: 'published' },
      { ...designSystems[0]!, id: 'user:atlas-lang-2', title: 'Atlas kit', source: 'user', status: 'published' },
    ] }, 'en');
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    for (const id of ['user:atlas-lang', 'user:atlas-lang-2']) {
      const option = screen.getByTestId(`project-ds-picker-option-${id}`);
      expect(option.textContent).toContain(id);
      expect(option.getAttribute('aria-label')).toBe('Atlas kit, Product');
    }
  });

  it('keeps unique-title rows and labels free of source identities', () => {
    renderPicker({ designSystems: [{ ...designSystems[0]!, id: 'user:only', updatedAt: '2026-10-09T12:00:00.000Z' }] }, 'en');
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    const option = screen.getByTestId('project-ds-picker-option-user:only');
    expect(option.textContent).not.toContain('user:only');
    expect(option.textContent).not.toContain('2026');
    expect(option.getAttribute('aria-label')).toBe('Clay, Product');
  });

  it.each(['en'] as const)('shows a short %s date only for colliding titles, even after search', (locale) => {
    const revision = '2026-10-09T12:00:00.000Z';
    renderPicker({ designSystems: [
      { ...designSystems[0]!, id: 'user:one', title: 'Atlas kit', summary: 'First copy', updatedAt: revision },
      { ...designSystems[0]!, id: 'user:two', title: 'Atlas kit', summary: 'Second copy', updatedAt: revision },
    ] }, locale);
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First copy' } });
    const option = screen.getByTestId('project-ds-picker-option-user:one');
    expect(option.textContent).toContain(new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(new Date(revision)));
    expect(option.textContent).not.toContain(revision);
    expect(option.getAttribute('aria-label')).toBe('Atlas kit, Product');
  });

  it('shows unreviewed kits only for inspection and preserves a blocked selection until approval', async () => {
    const onChange = vi.fn();
    renderPicker({ designSystems: [{ ...designSystems[0]!, id: 'user:kit', title: 'Kit', status: 'published', approval: { status: 'unreviewed', revision: 'r3' } }], selectedId: 'user:kit', onChange }, 'en');
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    expect(screen.queryByTestId('project-ds-picker-option-user:kit')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Approve');
    fireEvent.click(screen.getByLabelText('Show all kits'));
    const option = screen.getByTestId('project-ds-picker-option-user:kit');
    expect(option.textContent).toContain('Unreviewed');
    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('uses a refreshed Unreviewed receipt after approval even when content did not change', async () => {
    const kit = { ...designSystems[0]!, status: 'published' as const, approval: { status: 'unreviewed' as const, revision: 'r1' } };
    vi.mocked(setDesignSystemApproval).mockResolvedValue({ ...kit, approval: { status: 'approved', revision: 'r1', approvedRevision: 'r1' } });
    const { rerender } = render(<I18nProvider initial="en"><DesignSystemPicker designSystems={[kit]} selectedId="clay" onChange={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    rerender(<I18nProvider initial="en"><DesignSystemPicker designSystems={[{ ...kit }]} selectedId="clay" onChange={vi.fn()} /></I18nProvider>);
    expect(screen.getByRole('alert').textContent).toContain('Approve');
  });

  it('revokes a selected approved kit from the UI while preserving the selection', async () => {
    const kit = designSystems[0]!;
    vi.mocked(setDesignSystemApproval).mockResolvedValue({ ...kit, approval: { status: 'unreviewed', revision: kit.approval!.revision } });
    const onChange = vi.fn();
    renderPicker({ selectedId: kit.id, onChange }, 'en');
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    fireEvent.click(screen.getByRole('button', { name: 'Unapprove' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Approve'));
    expect(setDesignSystemApproval).toHaveBeenCalledWith(kit.id, { approved: false, expectedRevision: kit.approval!.revision }, undefined);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('can approve and then revoke in one inspection without replacing the selected id', async () => {
    const kit = { ...designSystems[0]!, approval: { status: 'unreviewed' as const, revision: 'r1' } };
    vi.mocked(setDesignSystemApproval).mockResolvedValueOnce({ ...kit, approval: { status: 'approved', revision: 'r1', approvedRevision: 'r1' } }).mockResolvedValueOnce(kit);
    renderPicker({ designSystems: [kit], selectedId: kit.id }, 'en');
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unapprove' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Unapprove' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Approve'));
  });

  it('hides unfinished drafts from the canvas menu just as the creation menu does', () => {
    renderPicker({ designSystems: [...designSystems, {
      id: 'unfinished', title: 'Unfinished', summary: '', category: 'Product', source: 'user',
    }] });
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    expect(screen.queryByTestId('project-ds-picker-option-unfinished')).toBeNull();
    expect(screen.getByTestId('project-ds-picker-option-clay')).toBeTruthy();
  });

  it('clears a hovered preview when search removes that system from the results', async () => {
    renderPicker({}, 'en');
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    fireEvent.mouseEnter(screen.getByTestId('project-ds-picker-option-clay'));
    expect(await screen.findAllByText('Friendly tactile product UI.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search design systems'), { target: { value: 'noir' } });
    await waitFor(() => {
      expect(screen.queryByText('Friendly tactile product UI.')).toBeNull();
      expect(screen.getAllByText('High-contrast editorial system.')[0]).toBeTruthy();
    });
  });

  it('allows copying an unpublished reference without making it project-selectable', () => {
    renderPicker({ includeUnpublished: true, designSystems: [{
      id: 'user:reference', title: 'Work in progress', summary: '', category: 'Product', source: 'user', status: 'draft',
    }], selectedId: null });
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    expect(screen.getByTestId('project-ds-picker-option-user:reference')).toBeTruthy();
  });

  function renderPicker(
    props: Partial<ComponentProps<typeof DesignSystemPicker>> = {},
    locale: Locale = "en",
  ) {
    return render(
      <I18nProvider initial={locale}>
        <DesignSystemPicker
          designSystems={designSystems}
          selectedId="noir"
          onChange={vi.fn()}
          {...props}
        />
      </I18nProvider>,
    );
  }

  it('checks the active project design system and previews it by default', async () => {
    renderPicker();

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));

    const activeOption = await screen.findByTestId('project-ds-picker-option-noir');
    expect(activeOption.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('project-ds-picker-option-noir-check')).toBeTruthy();

    await waitFor(() => {
      expect(fetchDesignSystemMock).toHaveBeenCalledWith('noir', null);
    });
    expect(await screen.findByTestId('project-ds-picker-preview-kit-view')).toBeTruthy();
    expect(screen.getAllByText('High-contrast editorial system.')[0]).toBeTruthy();
    expect(screen.queryByTestId('project-ds-picker-preview-frame')).toBeNull();
  });

  it('updates the preview target on hover and opens the expanded kit preview', async () => {
    renderPicker();

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    await screen.findByTestId('project-ds-picker-preview-kit-view');

    fireEvent.mouseEnter(screen.getByTestId('project-ds-picker-option-clay'));
    await waitFor(() => {
      expect(fetchDesignSystemMock).toHaveBeenCalledWith('clay', null);
    });
    expect(screen.getAllByText('Friendly tactile product UI.')[0]).toBeTruthy();

    fireEvent.click(await screen.findByTestId('project-ds-picker-preview-expand'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByText('Clay').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: "Close" }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('makes the neutral preview state explicit and still reveals presets on hover', async () => {
    renderPicker({ selectedId: null }, 'en');

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));

    expect(screen.getByTestId('project-ds-picker-preview-none')).toBeTruthy();
    expect(screen.getByText('Hover a design system to preview it')).toBeTruthy();

    fireEvent.mouseEnter(screen.getByTestId('project-ds-picker-option-clay'));
    await waitFor(() => {
      expect(fetchDesignSystemMock).toHaveBeenCalledWith('clay', null);
    });
    expect(await screen.findByTestId('project-ds-picker-preview-kit-view')).toBeTruthy();
  });

  it('selects a design system option with keyboard activation', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    const option = await screen.findByTestId('project-ds-picker-option-clay');
    option.focus();
    fireEvent.keyDown(option, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('clay');
  });

  it('selects the no-design-system option with keyboard activation', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    const option = (await screen.findAllByRole('option'))[0];
    if (!option) throw new Error('Expected the no-design-system option to render');
    option.focus();
    fireEvent.keyDown(option, { key: ' ' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('uses localized picker copy', async () => {
    renderPicker({}, "en");

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));

    // Category chips were removed from the list/preview per design; only the
    // surrounding picker copy needs to localize.
    expect(screen.getByPlaceholderText("Search design systems")).toBeTruthy();
    expect(screen.getByText("No design system")).toBeTruthy();
  });

  it('places team systems between personal systems and official presets', async () => {
    const personalSystem: DesignSystemSummary = {
      id: 'user:personal-brand',
      title: 'Personal Brand',
      summary: 'Owned by the current member.',
      category: 'Custom',
      swatches: [],
      source: 'user',
      isEditable: true,
      approval: { status: 'approved', revision: 'test', approvedRevision: 'test' },
      status: 'published',
    };
    const teamSystem: DesignSystemSummary = {
      id: 'user:team-brand',
      title: 'Team Brand',
      summary: 'Shared by the current member.',
      category: 'Custom',
      swatches: [],
      source: 'user',
      isEditable: true,
      approval: { status: 'approved', revision: 'test', approvedRevision: 'test' },
      status: 'published',
      teamShared: true,
    };
    const teammateSystem: DesignSystemSummary = {
      id: 'user:teammate-brand',
      title: 'Teammate Brand',
      summary: 'Pulled from a teammate.',
      category: 'Custom',
      swatches: [],
      source: 'user',
      isEditable: false,
      approval: { status: 'approved', revision: 'test', approvedRevision: 'test' },
      status: 'published',
      teamSynced: true,
    };
    const officialSystem: DesignSystemSummary = {
      id: 'official-brand',
      title: 'Official Brand',
      summary: 'Bundled preset.',
      category: 'Product',
      swatches: [],
      approval: { status: 'approved', revision: 'test', approvedRevision: 'test' },
      source: 'built-in',
      isEditable: false,
    };
    renderPicker({
      designSystems: [officialSystem, teamSystem, teammateSystem, personalSystem],
      selectedId: null,
    });

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));

    const listText = [...screen.getByRole('listbox').children]
      .map((element) => element.querySelector('.project-ds-picker-option-title')?.textContent?.trim() ?? element.textContent?.trim())
      .filter(Boolean);
    expect(listText).toEqual([
      "No design system",
      "Your systems",
      'Personal Brand',
      "Team",
      'Team Brand',
      'Teammate Brand',
      "Official presets",
      'Official Brand',
    ]);
  });

  it('omits empty personal and team group headings', async () => {
    renderPicker({
      designSystems: [{
        id: 'official-only',
        title: 'Official Only',
        summary: 'Bundled preset.',
        category: 'Product',
        swatches: [],
        approval: { status: 'approved', revision: 'test', approvedRevision: 'test' },
      source: 'built-in',
        isEditable: false,
      }],
      selectedId: null,
    });

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));

    expect(screen.queryByTestId('project-ds-picker-group-mine')).toBeNull();
    expect(screen.queryByTestId('project-ds-picker-group-team')).toBeNull();
    expect(screen.getByTestId('project-ds-picker-group-official')).toBeTruthy();
  });
});
