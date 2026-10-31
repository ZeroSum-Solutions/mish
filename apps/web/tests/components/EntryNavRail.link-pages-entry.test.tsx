// @vitest-environment jsdom
//
// The Link pages entry, pinned the same way as the Catalog entry: it
// renders on both rail branches and the click lands on /link-pages.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@mish/contracts';
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

describe('EntryNavRail link-pages entry', () => {
  it('renders the Link pages entry on the workspace rail', () => {
    renderRail(WORKSPACE_CONTEXT);
    expect(screen.getByTestId('entry-nav-link-pages').textContent).toContain('Link pages');
  });

  it('renders the Link pages entry on the signed-out rail', () => {
    renderRail(null);
    expect(screen.queryByTestId('entry-nav-link-pages')).toBeTruthy();
  });

  it('navigates to the link-pages view when the entry is clicked', () => {
    renderRail(WORKSPACE_CONTEXT);
    fireEvent.click(screen.getByTestId('entry-nav-link-pages'));
    expect(window.location.pathname).toBe('/link-pages');
    expect(parseRoute(window.location.pathname)).toEqual({ kind: 'home', view: 'link-pages' });
  });

  it('marks the entry as the current page while the view is open', () => {
    renderRail(WORKSPACE_CONTEXT, 'link-pages');
    expect(screen.getByTestId('entry-nav-link-pages').getAttribute('aria-current')).toBe('page');
  });
});
