// @vitest-environment jsdom
//
// The decorative art cluster must not reference image files that are not
// shipped (apps/web/public/team-avatars/ is empty): they rendered as broken
// images.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { InviteDialog } from '../../src/components/InviteDialog';
import { workspaceContextFixture } from '../helpers/workspace-context';

afterEach(cleanup);

describe('InviteDialog — art cluster', () => {
  it('renders no <img> elements pointing at missing team-avatars files', () => {
    render(
      <InviteDialog
        open
        onClose={() => {}}
        workspaceContext={workspaceContextFixture({
          workspaceId: 'workspace-team',
          workspaceMemberId: 'member-inviter',
        })}
        availableSeats={3}
      />,
    );
    const art = document.querySelector('.entry-invite__art');
    expect(art).not.toBeNull();
    expect(art!.querySelectorAll('img').length).toBe(0);
    expect(document.body.innerHTML).not.toContain('/team-avatars/');
  });
});
