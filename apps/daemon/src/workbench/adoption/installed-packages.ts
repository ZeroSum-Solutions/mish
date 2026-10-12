import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * What a project actually has installed for one npm package, read from its
 * `node_modules/<name>/package.json` the way Node resolves it (nearest
 * node_modules from the starting directory up to the project root). Read-only
 * evidence for the target and dependency gates: nothing is installed,
 * repaired or written.
 */
export type InstalledPackage =
  | { state: 'resolved'; version: string; major: number }
  | { state: 'absent' }
  | { state: 'unreadable'; reason: 'invalid-name' | 'invalid-directory' | 'escapes-project' | 'not-a-file' | 'invalid-manifest' | 'name-mismatch' | 'invalid-version' | 'io' };

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const strictlyInside = (root: string, candidate: string) => candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/** A resolved version as [major, minor, patch]; null when it is not a plain semver release. */
export function parseVersion(version: string): [number, number, number] | null {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative, zero or positive as `a` is below, equal to or above `b` (release numbers only). */
export function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function readManifest(location: string, name: string): InstalledPackage {
  let fd: number | null = null;
  try {
    try { fd = openSync(location, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW); } catch { return { state: 'unreadable', reason: 'io' }; }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return { state: 'unreadable', reason: 'not-a-file' };
    const bytes = Buffer.alloc(stat.size); let length = 0;
    for (let read = -1; read !== 0 && length < bytes.length;) { read = readSync(fd, bytes, length, bytes.length - length, length); length += read; }
    let manifest: unknown;
    try { manifest = JSON.parse(bytes.subarray(0, length).toString('utf8')); } catch { return { state: 'unreadable', reason: 'invalid-manifest' }; }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { state: 'unreadable', reason: 'invalid-manifest' };
    const record = manifest as { name?: unknown; version?: unknown };
    if (record.name !== name) return { state: 'unreadable', reason: 'name-mismatch' };
    const version = typeof record.version === 'string' ? record.version : '';
    const parsed = parseVersion(version);
    return parsed ? { state: 'resolved', version, major: parsed[0] } : { state: 'unreadable', reason: 'invalid-version' };
  } catch { return { state: 'unreadable', reason: 'io' }; }
  finally { if (fd !== null) closeSync(fd); }
}

/**
 * Resolves `name` from the project-relative directory `fromDir`, nearest
 * node_modules first, never above the project root. A package whose real path
 * (after every symlink, pnpm's included) leaves the project's real root is
 * `unreadable` (`escapes-project`), never followed.
 */
export function resolveInstalledPackage(physicalRoot: string, fromDir: string, name: string): InstalledPackage {
  if (!PACKAGE_NAME.test(name)) return { state: 'unreadable', reason: 'invalid-name' };
  const parts = fromDir ? fromDir.split('/') : [];
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.includes('\\'))) return { state: 'unreadable', reason: 'invalid-directory' };
  let root: string;
  try { root = realpathSync(physicalRoot); } catch { return { state: 'unreadable', reason: 'io' }; }
  for (let depth = parts.length; depth >= 0; depth--) {
    const candidate = path.join(root, ...parts.slice(0, depth), 'node_modules', ...name.split('/'), 'package.json');
    let real: string;
    try { real = realpathSync(candidate); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return { state: 'unreadable', reason: 'io' };
    }
    if (!strictlyInside(root, real)) return { state: 'unreadable', reason: 'escapes-project' };
    const read = readManifest(real, name);
    // The name must still resolve to the same file after the read (no swap between the checks).
    try { if (realpathSync(candidate) !== real) return { state: 'unreadable', reason: 'io' }; } catch { return { state: 'unreadable', reason: 'io' }; }
    return read;
  }
  return { state: 'absent' };
}

const COMPARATOR = /^(\^|~|>=|>|<=|<|=|v)?\s*(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const part = (value: string | undefined) => value === undefined || /^[xX*]$/u.test(value) ? 0 : Number(value);

/**
 * The lowest release a declared npm range admits ([0,0,0] for `*` or a range
 * with only upper bounds); null for anything that is not a plain semver range
 * (dist-tags, `workspace:`, `npm:`, `file:` or git specs). A `>` bound counts
 * as its own version, so the answer never overstates the lower bound.
 */
export function rangeLowerBound(spec: string): [number, number, number] | null {
  const trimmed = spec.trim();
  if (trimmed.includes('||')) {
    const bounds = trimmed.split('||').map(rangeLowerBound);
    if (bounds.some(bound => bound === null)) return null;
    return (bounds as [number, number, number][]).reduce((low, bound) => compareVersions(bound, low) < 0 ? bound : low);
  }
  const hyphen = /^(\S+)\s+-\s+\S+$/u.exec(trimmed);
  if (hyphen) return rangeLowerBound(`>=${hyphen[1]}`);
  if (trimmed === '') return [0, 0, 0];
  let low: [number, number, number] = [0, 0, 0];
  for (const comparator of trimmed.replace(/(\^|~|>=|>|<=|<|=)\s+/gu, '$1').split(/\s+/u)) {
    const match = COMPARATOR.exec(comparator);
    if (!match) return null;
    if (match[1] === '<' || match[1] === '<=') continue;
    const bound: [number, number, number] = [part(match[2]), part(match[3]), part(match[4])];
    if (compareVersions(bound, low) > 0) low = bound;
  }
  return low;
}
