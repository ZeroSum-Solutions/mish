import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  materializeWorkspaceScopedTeamResource,
  readWorkspaceScopedTeamResourceFile,
  readTeamResourceMaterialization,
  teamResourceMaterializationDir,
} from '../../src/collab/team-resource-materialization.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-team-resource-scope-'));
  roots.push(root);
  return root;
}

describe('workspace-scoped Team resource materialization', () => {
  it.each(['design_system', 'plugin', 'skill'] as const)(
    'keeps Workspace A and B copies of the same %s id physically and logically isolated',
    async (kind) => {
      const root = await tempRoot();
      for (const [workspaceId, content] of [
        ['workspace-a', 'content-from-a'],
        ['workspace-b', 'content-from-b'],
      ] as const) {
        await materializeWorkspaceScopedTeamResource({
          kindRoot: root,
          identity: {
            kind,
            workspaceId,
            resourceId: 'same-id',
            hubResourceId: `${kind}-${workspaceId}-same-id`,
          },
          pullInto: async (dir) => {
            await writeFile(path.join(dir, 'content.txt'), content);
          },
          verifyWorkspaceScope: async () => true,
          verifyStillShared: async () => true,
        });
      }

      const aDir = teamResourceMaterializationDir(root, 'workspace-a', 'same-id');
      const bDir = teamResourceMaterializationDir(root, 'workspace-b', 'same-id');
      expect(aDir).not.toBe(bDir);
      await expect(
        readWorkspaceScopedTeamResourceFile(
          root,
          'workspace-a',
          'same-id',
          'content.txt',
        ),
      ).resolves.toEqual(Buffer.from('content-from-a'));
      await expect(
        readWorkspaceScopedTeamResourceFile(
          root,
          'workspace-b',
          'same-id',
          'content.txt',
        ),
      ).resolves.toEqual(Buffer.from('content-from-b'));
      await expect(
        readTeamResourceMaterialization(root, 'workspace-a', 'same-id'),
      ).resolves.toMatchObject({
        workspaceId: 'workspace-a',
        resourceId: 'same-id',
        sourceKey: `team:${kind}:workspace-a:same-id`,
      });
      await expect(
        readTeamResourceMaterialization(root, 'workspace-b', 'same-id'),
      ).resolves.toMatchObject({
        workspaceId: 'workspace-b',
        resourceId: 'same-id',
        sourceKey: `team:${kind}:workspace-b:same-id`,
      });
    },
  );

  it.each([
    ['membership revoked', false, true],
    ['resource unshared', true, false],
  ] as const)(
    'does not expose downloaded bytes or update the registry when %s before commit',
    async (_label, scopeValid, stillShared) => {
      const root = await tempRoot();
      const result = await materializeWorkspaceScopedTeamResource({
        kindRoot: root,
        identity: {
          kind: 'skill',
          workspaceId: 'workspace-a',
          resourceId: 'revoked-during-pull',
          hubResourceId: 'skill-workspace-a-revoked-during-pull',
        },
        pullInto: async (dir) => {
          await writeFile(path.join(dir, 'downloaded.txt'), 'must-stay-invisible');
        },
        verifyWorkspaceScope: async () => scopeValid,
        verifyStillShared: async () => stillShared,
      });

      expect(result).toEqual({ status: 'revoked' });
      await expect(
        readTeamResourceMaterialization(root, 'workspace-a', 'revoked-during-pull'),
      ).resolves.toBeNull();
      await expect(
        readFile(
          path.join(
            teamResourceMaterializationDir(
              root,
              'workspace-a',
              'revoked-during-pull',
            ),
            'downloaded.txt',
          ),
          'utf8',
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('serializes commits when two calls spell the same directory differently', async () => {
    const root = await tempRoot();
    const relativeRoot = path.relative(process.cwd(), root);
    expect(relativeRoot).not.toBe(root);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const firstRunning = new Promise<void>((resolve) => { firstStarted = resolve; });
    const materialize = (kindRoot: string, label: string, gate?: Promise<void>) =>
      materializeWorkspaceScopedTeamResource({
        kindRoot,
        identity: {
          kind: 'skill',
          workspaceId: 'workspace-a',
          resourceId: 'same-dir',
          hubResourceId: 'skill-workspace-a-same-dir',
        },
        pullInto: async (dir) => {
          events.push(`${label}:start`);
          if (gate) {
            firstStarted();
            await gate;
          }
          await writeFile(path.join(dir, 'content.txt'), label);
          events.push(`${label}:end`);
        },
        verifyWorkspaceScope: async () => true,
        verifyStillShared: async () => true,
      });

    const first = materialize(root, 'absolute', firstGate);
    await firstRunning;
    const second = materialize(relativeRoot, 'relative');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['absolute:start']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'committed' }),
      expect.objectContaining({ status: 'committed' }),
    ]);
    expect(events).toEqual(['absolute:start', 'absolute:end', 'relative:start', 'relative:end']);
    await expect(
      readWorkspaceScopedTeamResourceFile(root, 'workspace-a', 'same-dir', 'content.txt'),
    ).resolves.toEqual(Buffer.from('relative'));
  });

  it('preserves the previously committed copy when a replacement loses authority', async () => {
    const root = await tempRoot();
    const identity = {
      kind: 'plugin' as const,
      workspaceId: 'workspace-a',
      resourceId: 'same-plugin',
      hubResourceId: 'plugin-workspace-a-same-plugin',
    };
    await materializeWorkspaceScopedTeamResource({
      kindRoot: root,
      identity,
      pullInto: (dir) => writeFile(path.join(dir, 'content.txt'), 'version-one'),
      verifyWorkspaceScope: async () => true,
      verifyStillShared: async () => true,
    });
    const before = await readTeamResourceMaterialization(
      root,
      'workspace-a',
      'same-plugin',
    );

    await expect(
      materializeWorkspaceScopedTeamResource({
        kindRoot: root,
        identity,
        pullInto: (dir) => writeFile(path.join(dir, 'content.txt'), 'revoked-version-two'),
        verifyWorkspaceScope: async () => true,
        verifyStillShared: async () => false,
      }),
    ).resolves.toEqual({ status: 'revoked' });

    await expect(
      readWorkspaceScopedTeamResourceFile(
        root,
        'workspace-a',
        'same-plugin',
        'content.txt',
      ),
    ).resolves.toEqual(Buffer.from('version-one'));
    await expect(
      readTeamResourceMaterialization(root, 'workspace-a', 'same-plugin'),
    ).resolves.toEqual(before);
  });

  it('refuses a materialized symlink that escapes the scoped Workspace root', async () => {
    const root = await tempRoot();
    const outside = path.join(root, 'outside-secret.txt');
    await writeFile(outside, 'must-not-be-readable');
    await materializeWorkspaceScopedTeamResource({
      kindRoot: root,
      identity: {
        kind: 'skill',
        workspaceId: 'workspace-a',
        resourceId: 'symlink-skill',
        hubResourceId: 'skill-workspace-a-symlink-skill',
      },
      pullInto: async (dir) => {
        await symlink(outside, path.join(dir, 'escaped.txt'));
      },
      verifyWorkspaceScope: async () => true,
      verifyStillShared: async () => true,
    });

    await expect(
      readWorkspaceScopedTeamResourceFile(
        root,
        'workspace-a',
        'symlink-skill',
        'escaped.txt',
      ),
    ).resolves.toBeNull();
  });
});
