// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RecentProjectsStrip } from '../../src/components/RecentProjectsStrip';
import { trackProjectCollectionClick, trackWorkspaceProjectActionResult } from '../../src/analytics/events';
import { deleteProject } from '../../src/state/projects';
import type { Project } from '../../src/types';
vi.mock('../../src/analytics/events', async original => ({ ...await original<typeof import('../../src/analytics/events')>(), trackProjectCollectionClick: vi.fn(), trackWorkspaceProjectActionResult: vi.fn() }));
vi.mock('../../src/providers/registry', () => ({ fetchProjectFileText: vi.fn(async () => null), fetchProjectFiles: vi.fn(async () => []), projectFileUrl: () => '' }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const projects: Project[] = [1, 2, 3].map(n => ({ id: `p${n}`, name: `Project ${n}`, skillId: null, designSystemId: null, createdAt: n, updatedAt: n }));
it('enters Select without a team permission, selects visible cards, and exits on Escape', () => {
  const onOpen = vi.fn();
  const { container } = render(<RecentProjectsStrip projects={projects} limit={2} onOpen={onOpen} onDelete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  expect([...container.querySelectorAll('.recent-projects__card-main')].every(card => (card as HTMLButtonElement).tabIndex === -1)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Select all (visible)' }));
  expect(screen.getAllByRole('checkbox').every(input => (input as HTMLInputElement).checked)).toBe(true);
  expect(screen.getByText('2 selected')).toBeTruthy();
  fireEvent.click(container.querySelector('.recent-projects__card-main')!);
  expect(screen.getByText('1 selected')).toBeTruthy();
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('checkbox')).toBeNull();
});
it('Select all uses the archived filter rather than every project', () => {
  const archived = { ...projects[0]!, metadata: { kind: 'prototype' as const, archived: true } };
  render(<RecentProjectsStrip projects={[archived, projects[1]!]} heading="Projects" onOpen={vi.fn()} onDelete={vi.fn()} onArchiveToggle={vi.fn()} />);
  fireEvent.click(screen.getByTestId('recent-projects-archived-toggle'));
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all (visible)' }));
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Unarchive' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(within(screen.getByRole('alertdialog')).getByText('Project 1')).toBeTruthy();
});

it('shows the daemon 409 queued-or-running reason once in the strip', async () => {
  const message = 'Project has queued or running runs (or other active work). Wait for them to finish before deleting it.';
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'PROJECT_BUSY', message } }), { status: 409 }));
  vi.stubGlobal('fetch', fetchMock);
  render(<RecentProjectsStrip projects={projects.slice(0, 1)} onOpen={vi.fn()} onDelete={(id, options) => deleteProject(id, null, options)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.getByText(`Project 1: ${message}`)).toBeTruthy());
  expect(screen.getAllByText(`Project 1: ${message}`)).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toContain('0 succeeded · 1 failed');
  expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1?ifIdle=1', { method: 'DELETE' });
});

it('retains collection click and bulk-delete outcome analytics shapes', async () => {
  render(<RecentProjectsStrip projects={projects.slice(0, 2)} onOpen={vi.fn()} onDelete={async id => { if (id === 'p2') throw new Error('busy'); return true; }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(trackProjectCollectionClick).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ page_name: 'home', area: 'project_collection', element: 'multi_select_toggle', selection_count_bucket: '0' }), undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Select all (visible)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(trackProjectCollectionClick).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ element: 'bulk_delete' }), undefined);
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(trackWorkspaceProjectActionResult).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ page_name: 'home', area: 'project_collection', action: 'bulk_delete', result: 'partial_success', requested_count: 2, succeeded_count: 1, failed_count: 1, duration_ms: expect.any(Number), error_code: 'one_or_more_failed' })));
});
