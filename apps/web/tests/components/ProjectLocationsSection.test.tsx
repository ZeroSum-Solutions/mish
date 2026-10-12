// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectLocationsSection } from '../../src/components/ProjectLocationsSection';
import { I18nProvider } from '../../src/i18n';
import type { AppConfig } from '../../src/types';

const LOCATIONS = [
  { id: 'default', name: 'Default', path: '/data/projects', builtIn: true },
  { id: 'loc-work', name: 'work', path: '/Users/me/Clients/work' },
];

vi.mock('../../src/state/project-locations', () => ({
  fetchProjectLocations: vi.fn(async () => LOCATIONS),
  updateProjectLocations: vi.fn(async (drafts: Array<{ id?: string; path: string }>) =>
    LOCATIONS.filter((location) => location.builtIn || drafts.some((draft) => draft.path === location.path))),
  scanProjectLocations: vi.fn(async () => ({ imported: [], existing: [] })),
  openProjectLocationFolderDialog: vi.fn(async () => null),
}));

let latest: AppConfig | null = null;
function Harness() {
  const [cfg, setCfg] = useState({ defaultProjectLocationId: 'default' } as AppConfig);
  latest = cfg;
  return <ProjectLocationsSection cfg={cfg} setCfg={setCfg} />;
}

afterEach(() => { cleanup(); latest = null; });

describe('ProjectLocationsSection', () => {
  it('lists each work base on one row with its full path on hover and one default badge', async () => {
    render(<I18nProvider initial="en"><Harness /></I18nProvider>);
    const path = await screen.findByText('/Users/me/Clients/work');
    expect(path.getAttribute('title')).toBe('/Users/me/Clients/work');
    expect(screen.getAllByText('Default location')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Project locations' })).toBeNull();
    expect(screen.getByRole('button', { name: /Add folder/ })).toBeTruthy();
  });

  it('moves the default with "Make default" and removes a folder from its icon button', async () => {
    render(<I18nProvider initial="en"><Harness /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Make default' }));
    expect(latest?.defaultProjectLocationId).toBe('loc-work');
    expect(screen.getAllByRole('button', { name: 'Make default' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remove work' }));
    await waitFor(() => expect(screen.queryByText('/Users/me/Clients/work')).toBeNull());
  });

  it('describes custom folders as work bases under their path', async () => {
    render(<I18nProvider initial="en"><Harness /></I18nProvider>);
    const path = await screen.findByText('/Users/me/Clients/work');
    const customRow = path.closest('li')!;
    expect(customRow.textContent).toContain('Work base · projects are created as subfolders here');
    const builtInRow = screen.getByText('/data/projects').closest('li')!;
    expect(builtInRow.textContent).not.toContain('Work base');
  });
});
