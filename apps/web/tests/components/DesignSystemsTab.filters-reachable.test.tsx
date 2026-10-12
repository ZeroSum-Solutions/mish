// @vitest-environment jsdom

// Wave-2 review (#190): a category / theme filter that empties the Mine or
// Team scope must not unmount the filter column. Before the fix only the
// official scope kept its filters, so in Mine/Team the designed empty state
// replaced the column and the user had no way to clear the filter that caused
// it.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@open-design/contracts';

import { DesignSystemsTab } from '../../src/components/DesignSystemsTab';
import { I18nProvider } from '../../src/i18n';
import { resetCoalescedGet } from '../../src/lib/coalesced-get';
import { workspaceContextFixture } from '../helpers/workspace-context';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return {
    ...actual,
    fetchDesignSystem: vi.fn(async (id: string) => ({
      id,
      title: id,
      summary: 'Theme: light',
      category: 'Custom',
      body: `# ${id}\n\n## Colors\n- Primary #111111`,
    })),
  };
});

const TEAM_CONTEXT = workspaceContextFixture({
  workspaceId: 'ws-team',
  teamId: 'ws-team',
  workspaceType: 'team',
  workspaceMemberId: 'mem-owner',
  billingState: 'free',
  planId: null,
  permissions: {
    canManageMembers: false,
    canManageBilling: false,
    canInviteMembers: false,
    canManageAutoRecharge: false,
    canShareProjects: true,
    canWriteSyncedFiles: true,
    canViewWorkspaceSettings: false,
    canManageSharedResources: true,
  },
});

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({ context: TEAM_CONTEXT, loading: false, refresh: vi.fn() }),
  useWorkspaceBilling: () => ({ membershipTier: '' }),
}));

function userSystem(id: string, title: string): DesignSystemSummary {
  return {
    id,
    title,
    category: 'Custom',
    summary: 'Theme: light. Internal product system.',
    surface: 'web',
    source: 'user',
    status: 'draft',
    isEditable: true,
    updatedAt: '2026-05-13T03:19:00.000Z',
  };
}

const MINE = userSystem('user:mine', 'Mine System');
const SHARED = userSystem('user:shared', 'Shared System');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  resetCoalescedGet();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/workspace/design-systems/team')) {
      return jsonResponse({ ids: [SHARED.id], resources: [{ id: SHARED.id, canUnshare: true }] });
    }
    return jsonResponse({});
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderTab() {
  return render(
    <I18nProvider initial="en">
      <DesignSystemsTab
        loading={false}
        systems={[MINE, SHARED]}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />
    </I18nProvider>,
  );
}

function themeGroup() {
  return screen.getByRole('group', { name: 'Theme' });
}

async function expectFilterEmptiesThenClears(cardId: string) {
  await screen.findByTestId(`design-system-card-${cardId}`);

  fireEvent.click(within(themeGroup()).getByRole('button', { name: 'Dark' }));

  // The filter emptied the scope, but the filter column stays so the user
  // can undo it.
  expect(screen.queryByTestId(`design-system-card-${cardId}`)).toBeNull();
  const group = themeGroup();
  expect(screen.getByTestId('design-systems-category-select')).toBeTruthy();

  fireEvent.click(within(group).getByRole('button', { name: 'All themes' }));
  expect(await screen.findByTestId(`design-system-card-${cardId}`)).toBeTruthy();
}

describe('DesignSystemsTab keeps filters reachable when they empty a scope', () => {
  it('Mine: a theme filter that empties the scope keeps the filter column', async () => {
    renderTab();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Team' })).toBeTruthy();
    });
    await expectFilterEmptiesThenClears(MINE.id);
  });

  it('Team: a theme filter that empties the scope keeps the filter column', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: 'Team' }));
    await expectFilterEmptiesThenClears(SHARED.id);
  });
});
