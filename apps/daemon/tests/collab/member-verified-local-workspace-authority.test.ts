import { describe, expect, it, vi } from 'vitest';
import { resolveMemberVerifiedLocalWorkspaceRequestAuthority } from '../../src/collab/workspace-resource-mutation.js';
import { workspaceContextFromDirectoryItem } from '../../src/collab/vela-workspace-context.js';

function fakeReq(headers: Record<string, string> = {}): any {
  return { get: (name: string) => headers[name] ?? undefined };
}

const PAIR = {
  'x-od-workspace-id': 'workspace-a',
  'x-od-workspace-member-id': 'member-a',
};

function verifiedAs(workspaceId: string, workspaceMemberId: string) {
  return vi.fn(async () => ({
    ok: true as const,
    context: workspaceContextFromDirectoryItem({
      workspaceId,
      workspaceName: 'Workspace',
      workspaceType: 'team',
      workspaceMemberId,
      role: 'owner',
      memberStatus: 'active',
      lifecycleState: 'locked',
    }),
  }));
}

describe('resolveMemberVerifiedLocalWorkspaceRequestAuthority', () => {
  it('keeps the headerless local lane without consulting the directory', async () => {
    const verify = verifiedAs('workspace-a', 'member-a');
    await expect(
      resolveMemberVerifiedLocalWorkspaceRequestAuthority(fakeReq(), verify),
    ).resolves.toEqual({ ok: true, context: null });
    expect(verify).not.toHaveBeenCalled();
  });

  it('keeps a partial pair a 400 without consulting the directory', async () => {
    const verify = verifiedAs('workspace-a', 'member-a');
    const result = await resolveMemberVerifiedLocalWorkspaceRequestAuthority(
      fakeReq({ 'x-od-workspace-id': 'workspace-a' }),
      verify,
    );
    expect(result).toMatchObject({ ok: false, status: 400, code: 'WORKSPACE_CONTEXT_INCOMPLETE' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('passes a directory refusal through unchanged', async () => {
    const refusal = {
      ok: false as const,
      status: 503 as const,
      code: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
      message: 'unavailable',
      retryable: true as const,
    };
    await expect(
      resolveMemberVerifiedLocalWorkspaceRequestAuthority(fakeReq(PAIR), async () => refusal),
    ).resolves.toEqual(refusal);
  });

  it('refuses a verified context that names a different member', async () => {
    const result = await resolveMemberVerifiedLocalWorkspaceRequestAuthority(
      fakeReq(PAIR),
      verifiedAs('workspace-a', 'member-b'),
    );
    expect(result).toMatchObject({ ok: false, status: 403, code: 'WORKSPACE_ACCESS_DENIED' });
  });

  it('returns the local context for a verified pair without inheriting lifecycle', async () => {
    const result = await resolveMemberVerifiedLocalWorkspaceRequestAuthority(
      fakeReq(PAIR),
      verifiedAs('workspace-a', 'member-a'),
    );
    expect(result).toMatchObject({
      ok: true,
      context: {
        workspaceId: 'workspace-a',
        workspaceMemberId: 'member-a',
        role: 'member',
        lifecycleState: 'active',
      },
    });
  });
});
