// @vitest-environment jsdom
//
// Track B P0: a run whose requested design kit was not injected must say so
// in the chat, never drop the kit silently.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../../src/providers/registry')>(
    '../../../src/providers/registry',
  );
  return { ...actual, updateDesignSystemDraft: vi.fn(), fetchDesignSystem: vi.fn(), setDesignSystemApproval: vi.fn() };
});

import {
  DesignSystemNotice,
  latestDesignSystemNotice,
} from '../../../src/components/chat/DesignSystemNotice';
import { updateDesignSystemDraft, fetchDesignSystem, setDesignSystemApproval } from '../../../src/providers/registry';
import type { AgentEvent } from '../../../src/types';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const DRAFT_NOTICE = {
  reason: 'draft' as const,
  designSystemId: 'user:acme',
  title: 'Acme Kit',
  message: 'Design kit "Acme Kit" is a draft, so this run did not use it.',
  resolveCommand: 'od design-systems publish user:acme',
};

describe('DesignSystemNotice', () => {
  it('finds the notice among a turn\'s events', () => {
    const events: AgentEvent[] = [
      { kind: 'done_key', key: 'k' },
      { kind: 'design_system_notice', notice: DRAFT_NOTICE },
      { kind: 'text', text: 'hello' },
    ];
    expect(latestDesignSystemNotice(events)).toEqual(DRAFT_NOTICE);
    expect(latestDesignSystemNotice([{ kind: 'text', text: 'x' }])).toBeNull();
  });

  it('warns that a draft kit was not used and publishes it from the chat', async () => {
    vi.mocked(updateDesignSystemDraft).mockResolvedValue({
      id: 'user:acme', title: 'Acme Kit', category: '', summary: '', body: '', status: 'published',
    } as never);
    render(<DesignSystemNotice notice={DRAFT_NOTICE} />);
    const note = screen.getByTestId('design-system-notice');
    expect(note.getAttribute('data-reason')).toBe('draft');
    expect(note.textContent).toContain('"Acme Kit" is a draft');
    fireEvent.click(screen.getByRole('button', { name: 'Publish kit' }));
    await waitFor(() => expect(screen.getByText(/Kit published/)).toBeTruthy());
    expect(vi.mocked(updateDesignSystemDraft).mock.calls[0]?.slice(0, 2)).toEqual([
      'user:acme',
      { status: 'published' },
    ]);
  });

  it('offers revision-bound approval and a retry message for a blocked generation', async () => {
    const approval = { status: 'unreviewed' as const, revision: 'a'.repeat(64) };
    vi.mocked(fetchDesignSystem).mockResolvedValue({ id: 'user:acme', title: 'Acme Kit', category: '', summary: '', body: '# Changed kit', approval: { ...approval, revision: 'b'.repeat(64) } });
    vi.mocked(setDesignSystemApproval).mockResolvedValue({ id: 'user:acme', title: 'Acme Kit', category: '', summary: '', approval: { ...approval, status: 'approved', approvedRevision: approval.revision } });
    render(<DesignSystemNotice notice={{ ...DRAFT_NOTICE, reason: 'unreviewed', revision: approval.revision, resolveCommand: 'od design-system approve user:acme' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Kit approved. Retry generation.'));
    expect(setDesignSystemApproval).toHaveBeenCalledWith('user:acme', { approved: true, expectedRevision: approval.revision }, null);
    expect(updateDesignSystemDraft).not.toHaveBeenCalled();
    expect(fetchDesignSystem).not.toHaveBeenCalled();
  });

  it('keeps a stale revision refused and does not offer approval for legacy notices', async () => {
    vi.mocked(setDesignSystemApproval).mockResolvedValue(null);
    const notice = { ...DRAFT_NOTICE, reason: 'unreviewed' as const, revision: 'a'.repeat(64) };
    const view = render(<DesignSystemNotice notice={notice} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<DesignSystemNotice notice={{ ...DRAFT_NOTICE, reason: 'unreviewed' }} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('explains a missing kit without offering to publish it', () => {
    render(
      <DesignSystemNotice
        notice={{ ...DRAFT_NOTICE, reason: 'not_found', title: null, resolveCommand: null }}
      />,
    );
    expect(screen.getByTestId('design-system-notice').textContent).toContain('was not found');
    expect(screen.queryByRole('button', { name: 'Publish kit' })).toBeNull();
  });
});
