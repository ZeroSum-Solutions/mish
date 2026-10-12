// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeProjectBulkActions } from '../../src/components/HomeProjectBulkActions';
import type { Project } from '../../src/types';

const projects = Array.from({ length: 7 }, (_, i): Project => ({
  id: `p${i}`, name: `Project ${i}`, skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1,
}));
afterEach(cleanup);
function setup(overrides = {}) {
  const props = {
    active: true, selected: projects, visible: projects, disabled: false,
    onSelectAll: vi.fn(), onClear: vi.fn(), onCancel: vi.fn(), onCompleted: vi.fn(),
    onDelete: vi.fn(async () => true), onArchive: vi.fn(async () => true), ...overrides,
  };
  render(<HomeProjectBulkActions {...props} />);
  return props;
}
it('selects only visible cards and clears the selection', () => {
  const props = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Select all (visible)' }));
  expect(props.onSelectAll).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(props.onClear).toHaveBeenCalledOnce();
});
it('confirms once with count, five names and the remaining count', async () => {
  const props = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = screen.getByRole('alertdialog');
  expect(within(dialog).getByText('Delete 7 projects?')).toBeTruthy();
  expect(within(dialog).getByText('Project 4')).toBeTruthy();
  expect(within(dialog).queryByText('Project 5')).toBeNull();
  expect(within(dialog).getByText('+2 more')).toBeTruthy();
  expect(props.onDelete).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(props.onCompleted).toHaveBeenCalledWith(projects.map(p => p.id)));
});
it('shows progress and retains per-project partial-failure reasons', async () => {
  let resolve!: (value: boolean) => void;
  const onDelete = vi.fn((id: string) => id === 'p0'
    ? new Promise<boolean>(r => { resolve = r; })
    : Promise.reject(new Error('Project has a queued run.')));
  const props = setup({ selected: projects.slice(0, 2), onDelete });
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  expect(screen.getByRole('status').textContent).toContain('0 of 2');
  resolve(true);
  await waitFor(() => expect(screen.getByText(/Project 1: Project has a queued run/)).toBeTruthy());
  expect(props.onCompleted).toHaveBeenCalledWith(['p0']);
  expect(screen.getByRole('status').textContent).toContain('1 succeeded');
});
it('archives and unarchives via the same callback', async () => {
  const props = setup({ selected: [projects[0]!, { ...projects[1]!, metadata: { archived: true } }] });
  fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
  await waitFor(() => expect(props.onArchive).toHaveBeenCalledWith('p1', false, { bulk: true }));
  expect(props.onArchive).not.toHaveBeenCalledWith('p0', false);
});
it('hides mutation controls after exiting mode while retaining outcomes', async () => {
  const props = { active: true, selected: projects.slice(0, 1), visible: projects, disabled: false,
    onSelectAll: vi.fn(), onClear: vi.fn(), onCancel: vi.fn(), onCompleted: vi.fn(), onDelete: vi.fn(async () => true) };
  const { rerender } = render(<HomeProjectBulkActions {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(props.onCompleted).toHaveBeenCalled());
  rerender(<HomeProjectBulkActions {...props} active={false} />);
  expect(screen.queryByRole('button', { name: 'Select all (visible)' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('1 succeeded');
});
it('portals confirmation, traps keyboard focus, and restores focus on cancel', () => {
  setup();
  const trigger = screen.getByRole('button', { name: 'Delete' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('alertdialog');
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
  const confirm = within(dialog).getByRole('button', { name: 'Delete' });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(confirm);
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  expect(document.activeElement).toBe(trigger);
});

it('exits selection on Escape during a batch and keeps its progress and result visible', async () => {
  let finish!: (value: boolean) => void;
  const props = { active: true, selected: projects.slice(0, 1), visible: projects, disabled: false,
    onSelectAll: vi.fn(), onClear: vi.fn(), onCancel: vi.fn(), onCompleted: vi.fn(),
    onArchive: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })) };
  const { rerender } = render(<HomeProjectBulkActions {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(props.onCancel).toHaveBeenCalledOnce();
  rerender(<HomeProjectBulkActions {...props} active={false} />);
  expect(screen.getByRole('status').textContent).toContain('0 of 1');
  expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  finish(true);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1 succeeded'));
});

it('closes only the confirmation on Escape, leaving selection active', () => {
  const props = setup({ selected: projects.slice(0, 1) });
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.getByRole('alertdialog').textContent).toContain('Delete 1 project?');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(props.onCancel).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(props.onCancel).toHaveBeenCalledOnce();
});
it('ignores an already consumed Escape', () => {
  const props = setup();
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  event.preventDefault();
  fireEvent(document, event);
  expect(props.onCancel).not.toHaveBeenCalled();
});
it.each(['dialog', 'alertdialog', 'menu'])('ignores Escape with focus in another %s', role => {
  const props = setup();
  const overlay = document.createElement('div');
  overlay.setAttribute('role', role);
  const button = document.createElement('button');
  overlay.append(button); document.body.append(overlay); button.focus();
  try { fireEvent.keyDown(button, { key: 'Escape' }); expect(props.onCancel).not.toHaveBeenCalled(); }
  finally { overlay.remove(); }
});
it('passes idle-only deletion and reports exact bulk counts', async () => {
  const onDeleteResult = vi.fn();
  const props = setup({ selected: projects.slice(0, 2), onDeleteResult, onDelete: vi.fn(async (id: string) => { if (id === 'p1') throw new Error('busy'); return true; }) });
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(onDeleteResult).toHaveBeenCalledWith({ requested: 2, succeeded: 1, failed: 1, duration: expect.any(Number) }));
  expect(props.onDelete).toHaveBeenCalledWith('p0', { ifIdle: true });
});
