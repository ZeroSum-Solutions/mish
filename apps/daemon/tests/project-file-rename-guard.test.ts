import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { projectFileRenameTestHooks, renameProjectFile } from '../src/projects.js';
import { PlacementCoordinationError } from '../src/workbench/placement/write-coordinator.js';

/**
 * renameProjectFile's compensation and cleanup under the trusted final-I/O
 * guard, with real files. The guard is SYNTHETIC: it loses authority when a
 * named physical state is reached (no native owner, no host proof).
 */
const roots: string[] = [];
afterEach(() => { projectFileRenameTestHooks.beforeCommit = null; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() {
  const projectsRoot = mkdtempSync(path.join(tmpdir(), 'rename-guard-')); roots.push(projectsRoot);
  const dir = path.join(projectsRoot, 'p'); mkdirSync(dir); writeFileSync(path.join(dir, 'a.txt'), 'bytes');
  const temps = () => readdirSync(dir).filter(name => name.startsWith('.od-rename-'));
  return { projectsRoot, dir, temps };
}
/** Throws `make()` once `lost()` holds, at every later final-I/O check. */
function guardLostWhen(lost: () => boolean, make: () => Error = () => new PlacementCoordinationError('OWNER_UNQUALIFIED', 'synthetic owner loss')) {
  return { checks: 0, assertCurrent() { this.checks += 1; if (lost()) throw make(); } };
}

describe('renameProjectFile compensation and cleanup under the final-I/O guard', () => {
  it('authority lost after source->temp keeps the owned temp and the typed refusal (no unguarded restore)', async () => {
    const p = project();
    const guard = guardLostWhen(() => !existsSync(path.join(p.dir, 'a.txt')) && p.temps().length === 1);
    await expect(renameProjectFile(p.projectsRoot, 'p', 'a.txt', 'b.txt', undefined, guard)).rejects.toMatchObject({ code: 'OWNER_UNQUALIFIED' });
    expect(existsSync(path.join(p.dir, 'a.txt'))).toBe(false); // not restored after the loss
    expect(existsSync(path.join(p.dir, 'b.txt'))).toBe(false);
    expect(p.temps()).toHaveLength(1); expect(readFileSync(path.join(p.dir, p.temps()[0]!), 'utf8')).toBe('bytes');
  });
  it('authority lost after link refuses the temp unlink with a typed error instead of success', async () => {
    const p = project();
    const guard = guardLostWhen(() => existsSync(path.join(p.dir, 'b.txt')));
    await expect(renameProjectFile(p.projectsRoot, 'p', 'a.txt', 'b.txt', undefined, guard)).rejects.toMatchObject({ code: 'OWNER_UNQUALIFIED' });
    expect(readFileSync(path.join(p.dir, 'b.txt'), 'utf8')).toBe('bytes');
    expect(p.temps()).toHaveLength(1); // the refused unlink left the owned temp link in place
    expect(existsSync(path.join(p.dir, 'a.txt'))).toBe(false); // and no restore duplicated the source
  });
  it('controls: with current authority or no guard, a failed link still restores the source', async () => {
    for (const guard of [{ assertCurrent() {} }, undefined]) {
      const p = project();
      // The target appears after the existence checks: link fails EEXIST (ordinary, non-placement).
      projectFileRenameTestHooks.beforeCommit = ({ target }) => { writeFileSync(target, 'racer'); };
      await expect(renameProjectFile(p.projectsRoot, 'p', 'a.txt', 'b.txt', undefined, guard)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readFileSync(path.join(p.dir, 'a.txt'), 'utf8')).toBe('bytes');
      expect(readFileSync(path.join(p.dir, 'b.txt'), 'utf8')).toBe('racer'); expect(p.temps()).toEqual([]);
    }
  });
  it('control: an ordinary (non-placement) temp cleanup failure stays best effort', async () => {
    const p = project();
    const guard = guardLostWhen(() => existsSync(path.join(p.dir, 'b.txt')), () => new Error('ordinary cleanup failure'));
    await expect(renameProjectFile(p.projectsRoot, 'p', 'a.txt', 'b.txt', undefined, guard)).resolves.toMatchObject({ newName: 'b.txt' });
    expect(readFileSync(path.join(p.dir, 'b.txt'), 'utf8')).toBe('bytes');
  });
});
