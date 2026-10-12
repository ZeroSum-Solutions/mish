// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@mish/contracts';
vi.mock('../../src/providers/registry', () => ({ setDesignSystemApproval: vi.fn() }));
vi.mock('../../src/components/DesignSystemPreviewModal', () => ({ DesignSystemPreviewModal: ({ system }: { system: DesignSystemSummary }) => <div role="dialog">Inspect {system.title}</div> }));
vi.mock('../../src/collab/useWorkspaceContext', () => ({ useWorkspaceContext: () => ({ context: null }) }));
import { setDesignSystemApproval } from '../../src/providers/registry';
import { DesignSystemApprovalBrowser } from '../../src/components/DesignSystemApprovalBrowser';
const kit: DesignSystemSummary = { id: 'user:kit', title: 'Kit', category: '', summary: '', status: 'published', approval: { status: 'unreviewed', revision: 'a'.repeat(64) } };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('keeps unreviewed kits behind Show all for inspection and sends the inspected revision on approval', async () => {
  const onApprovalChange = vi.fn();
  const approved = { ...kit, approval: { status: 'approved' as const, revision: kit.approval!.revision, approvedRevision: kit.approval!.revision } };
  vi.mocked(setDesignSystemApproval).mockResolvedValue(approved);
  render(<DesignSystemApprovalBrowser systems={[kit]} onApprovalChange={onApprovalChange} />);
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  fireEvent.click(screen.getByLabelText('Show all kits'));
  fireEvent.click(screen.getByRole('button', { name: 'Kit · Unreviewed' }));
  expect(screen.getByRole('dialog').textContent).toBe('Inspect Kit');
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(onApprovalChange).toHaveBeenCalledExactlyOnceWith(approved));
  expect(setDesignSystemApproval).toHaveBeenCalledWith(kit.id, { approved: true, expectedRevision: kit.approval!.revision }, null);
});
it('shows a selected unreviewed kit and Approve recovery without Show all', async () => {
  vi.mocked(setDesignSystemApproval).mockResolvedValue(null);
  const onApprovalChange = vi.fn();
  render(<DesignSystemApprovalBrowser systems={[kit]} selectedIds={[kit.id]} onApprovalChange={onApprovalChange} />);
  expect(screen.getByRole('alert').textContent).toContain('Approve');
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
  expect(onApprovalChange).not.toHaveBeenCalled();
});
