// @vitest-environment jsdom
//
// The rail is the ONLY click path to the Design index view: `/automations`
// and `/library` are URL-only today, so a Design index entry that renders in
// just one of the rail's two branches leaves the view unreachable for half the
// product's states. These cases pin that it renders in both, and that the
// click lands on the view rather than on some near-miss route.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';
import { navigate, parseRoute, type EntryHomeView } from '../../src/router';

const WORKSPACE_CONTEXT = {
  workspaceId: 'ws-1',
  workspaceType: 'personal',
  workspaceMemberId: 'wm-1',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
  permissions: { canInviteMembers: true, canViewWorkspaceSettings: false },
} as unknown as WorkspaceCollabContext;

/**
 * `context: null` is the signed-out rail, a context object the workspace rail.
 * `onViewChange` mirrors what EntryShell's `changeView` does with it so the
 * click is followed all the way to the route.
 */
function renderRail(context: WorkspaceCollabContext | null, view: EntryHomeView = 'home') {
  return render(
    <I18nProvider initial="en">
      <EntryNavRail
        view={view}
        onViewChange={(next) => navigate({ kind: 'home', view: next })}
        onNewProject={() => {}}
        open
        context={context}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

describe('EntryNavRail design index entry', () => {
  it('renders the Design index entry on the workspace rail', () => {
    renderRail(WORKSPACE_CONTEXT);
    const entry = screen.getByTestId('entry-nav-design-index');
    expect(entry.textContent).toContain('Design index');
  });

  it('renders the Design index entry on the signed-out rail', () => {
    renderRail(null);
    expect(screen.queryByTestId('entry-nav-design-index')).toBeTruthy();
  });

  it('navigates to the design-index view when the entry is clicked', () => {
    renderRail(WORKSPACE_CONTEXT);
    fireEvent.click(screen.getByTestId('entry-nav-design-index'));

    expect(window.location.pathname).toBe('/design-index');
    expect(parseRoute(window.location.pathname)).toEqual({ kind: 'home', view: 'design-index' });
  });

  it('marks the entry as the current page while the view is open', () => {
    renderRail(WORKSPACE_CONTEXT, 'design-index');
    expect(screen.getByTestId('entry-nav-design-index').getAttribute('aria-current')).toBe('page');
  });
});
