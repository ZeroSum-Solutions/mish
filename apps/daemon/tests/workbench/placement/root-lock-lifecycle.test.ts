import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePlacementBootstrap } from '../../../src/workbench/placement/owner-bootstrap.js';
import { acquireExclusiveRootLock, PLACEMENT_ROOT_LOCK } from '../../../src/workbench/placement/root-seal.js';
import { attachPlacementRuntime } from '../../../src/workbench/placement/runtime.js';

/**
 * B4-1b (Sol r2 WARN 1): an ordinary daemon holds the shared root lock only
 * while it runs. Stopping it (or a failed startup, see
 * daemon-startup-placement.test.ts) releases the descriptor, so repeated
 * starts in one process leak nothing and a later coordinated bootstrap in
 * that process can take the lock exclusively. Darwin only (O_SHLOCK/O_EXLOCK).
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'darwin')('ordinary root lock lifecycle', () => {
  it('start and stop an ordinary daemon twice in one process, then the lock is free for a coordinated bootstrap', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'root-lock-'))); roots.push(parent);
    const root = join(parent, 'data'); mkdirSync(join(root, 'projects'), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, PLACEMENT_ROOT_LOCK), '', { mode: 0o600 }); // A coordinated daemon used this root before.
    for (let run = 0; run < 2; run++) {
      const bootstrap = preparePlacementBootstrap({ env: { OD_DATA_DIR: root }, projectRoot: '/x', rootLockWaitMs: 0 });
      expect(bootstrap).toMatchObject({ mode: 'ordinary-uncoordinated', reason: 'not-activated' });
      if (bootstrap.mode !== 'ordinary-uncoordinated') throw new Error('ordinary');
      expect(bootstrap.rootLock).not.toBeNull();
      expect(acquireExclusiveRootLock(root, { create: false })).toEqual({ kind: 'busy' }); // Held while it runs.
      const db = new Database(':memory:');
      const runtime = attachPlacementRuntime(bootstrap, { db, projectsDir: join(root, 'projects'), readProject: () => null, listProjects: () => [] });
      runtime.close();
      db.close();
    }
    const exclusive = acquireExclusiveRootLock(root, { create: false });
    expect(exclusive.kind).toBe('held');
    if (exclusive.kind === 'held') exclusive.lock.release();
  });
});
