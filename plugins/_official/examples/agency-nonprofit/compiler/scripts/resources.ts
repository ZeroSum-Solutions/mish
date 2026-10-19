import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The compiler's static text resources: the vendored family CSS, the synced catalog component
 * files and the catalog JSON, keyed by their path relative to this `scripts/` folder (for example
 * `catalog/hyperui/practice.css`). Shared: edit plugins/_official/shared/agency-compiler, then sync.
 *
 * Outside a scope a resource is read from disk next to this file, as the compiler always has: a
 * read that succeeds is kept for the process, a missing optional file is checked again next time,
 * and a missing required file raises the filesystem's own error. `withCompilerResources(table, fn)`
 * runs `fn` against an explicit table instead: every read inside `fn` comes from the table, a key
 * the table lacks is reported as missing, and nothing touches the filesystem. The publisher library
 * (`packages/publisher`) renders headless this way. Rendering is synchronous, so the scope cannot
 * leak into another render.
 *
 * Derived caches (parsed catalog JSON, checked component text) are keyed by the table object, so a
 * frozen table is parsed once. A table that is not frozen is copied and frozen for the scope, so an
 * edit between renders is always seen.
 */
export type CompilerResources = Readonly<Record<string, string>>;

const RESOURCE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;
/** Stands for "read from disk" as a cache key, so derived caches never mix a table with the disk. */
const DISK: CompilerResources = Object.freeze({});
const diskCache = new Map<string, string>();
let active: CompilerResources | undefined;

function checkKey(relative: string): void {
  if (!RESOURCE.test(relative) || relative.split('/').includes('..')) throw new Error(`compiler resource: ${JSON.stringify(relative)} is not a relative resource path`);
}

/** A file next to this one. Absent: `undefined` when optional; the native read error when required. */
function fromDisk(relative: string, required: boolean): string | undefined {
  const hit = diskCache.get(relative);
  if (hit !== undefined) return hit;
  const file = path.join(import.meta.dirname, relative);
  if (!required && !existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  diskCache.set(relative, text);
  return text;
}

/**
 * A supplied table must be a plain object of strings. Anything else is refused rather than read as
 * "no table", which would quietly send every read to the disk.
 */
function checkTable(resources: unknown): asserts resources is CompilerResources {
  const prototype = typeof resources === 'object' && resources !== null ? Object.getPrototypeOf(resources) : undefined;
  if ((prototype !== Object.prototype && prototype !== null) || Array.isArray(resources)) throw new TypeError('compiler resources must be a plain object of strings');
  for (const value of Object.values(resources as object)) if (typeof value !== 'string') throw new TypeError('compiler resources must be a plain object of strings');
}

/** Runs `fn` with every resource read served from `resources`; restores the previous source after. */
export function withCompilerResources<T>(resources: CompilerResources, fn: () => T): T {
  checkTable(resources);
  const previous = active;
  active = Object.isFrozen(resources) ? resources : Object.freeze({ ...resources });
  try {
    return fn();
  } finally {
    active = previous;
  }
}

/** The source reads come from now: the active table, or a fixed token for the disk. */
export function compilerResourceSource(): CompilerResources {
  return active ?? DISK;
}

/** The resource's text, or `undefined` when this copy does not carry it. */
export function findCompilerResource(relative: string): string | undefined {
  checkKey(relative);
  if (active) return Object.hasOwn(active, relative) ? active[relative] : undefined;
  return fromDisk(relative, false);
}

/** The resource's text. Throws when this copy does not carry it (on disk, the native read error). */
export function readCompilerResource(relative: string): string {
  if (!active) {
    checkKey(relative);
    return fromDisk(relative, true)!;
  }
  const text = findCompilerResource(relative);
  if (text === undefined) throw new Error(`compiler resource ${relative} is not in the supplied resource table`);
  return text;
}
