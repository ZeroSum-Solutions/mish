import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { loadFamilyCompiler, type LoadedFamilyPackage } from '../src/node.ts';
import type { CompileResult } from '../src/compile.ts';

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
export const EXAMPLES = path.join(REPO_ROOT, 'plugins/_official/examples');
export const SHARED_COMPILER = path.join(REPO_ROOT, 'plugins/_official/shared/agency-compiler/scripts');
export const DIST = path.join(PACKAGE_ROOT, 'dist');

/** The twelve public family packages, every one of which ships `resources.ts`. */
export const FAMILIES = ['app-shell', 'community', 'crm-dashboard', 'docs-hub', 'guide', 'listings', 'marketing-site', 'nonprofit', 'practice', 'publication', 'restaurant', 'storefront'] as const;

/** Booking keys in the widget's `zsb1_` + 64 form; fictional. */
export const KEY_A = `zsb1_${'demoA1b2'.repeat(8)}`;
export const KEY_B = `zsb1_${'demoC3d4'.repeat(8)}`;

const loaded = new Map<string, Promise<LoadedFamilyPackage>>();
export function loadExample(family: string): Promise<LoadedFamilyPackage> {
  if (!loaded.has(family)) loaded.set(family, loadFamilyCompiler(path.join(EXAMPLES, `agency-${family}`), family));
  return loaded.get(family)!;
}

/** The entry page's text. */
export function entryHtml(result: CompileResult): string {
  const file = result.files.find((candidate) => candidate.path === result.entry);
  if (!file) throw new Error('no entry file');
  return new TextDecoder().decode(file.bytes);
}

/** `fs` functions that read, stat, list or open: every way a render could reach the disk. */
const FS_READERS = /^(read|open|stat|lstat|fstat|exists|access|realpath|readdir|readlink|opendir|watch|createReadStream|cp|copyFile|glob)/;

export type AmbientAccess = { fs: string[]; env: string[]; clock: string[]; random: string[] };

/**
 * Makes every ambient input fail or report itself until `restore()`: each reading `fs` and
 * `fs/promises` function throws (named ESM imports included, via `syncBuiltinESMExports`), and
 * these record any use: `process.env` (reads, `in`, key listing, descriptors), the clock (`Date()`
 * called, `new Date()` with no argument, `Date.now`, `performance.now`, `process.hrtime` and
 * `.bigint`), and randomness (`Math.random`, the `node:crypto` random functions, `crypto.randomUUID`
 * and `crypto.getRandomValues`).
 */
export function denyAmbientAccess(): { access: AmbientAccess; restore: () => void } {
  const access: AmbientAccess = { fs: [], env: [], clock: [], random: [] };
  const restorers: Array<() => void> = [];
  const replace = <T extends object>(target: T, key: keyof T & string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, enumerable: original?.enumerable ?? true, writable: true, value });
    restorers.push(() => (original ? Object.defineProperty(target, key, original) : delete (target as Record<string, unknown>)[key]));
  };
  for (const [label, target] of [['fs', fs], ['fs/promises', fsp]] as const) {
    for (const key of Object.keys(target)) {
      const value = (target as unknown as Record<string, unknown>)[key];
      if (typeof value !== 'function' || !FS_READERS.test(key)) continue;
      replace(target as unknown as Record<string, unknown>, key, (...args: unknown[]) => {
        access.fs.push(`${label}.${key}(${String(args[0])})`);
        throw new Error(`denied: ${label}.${key}`);
      });
    }
  }
  try { watchGlobals(access, replace); } catch (error) { for (const undo of restorers.reverse()) undo(); syncBuiltinESMExports(); throw error; }
  // Named ESM imports of `node:fs`, `node:fs/promises` and `node:crypto` see the replacements too.
  syncBuiltinESMExports();
  return {
    access,
    restore: () => {
      for (const undo of restorers.reverse()) undo();
      syncBuiltinESMExports();
    },
  };
}

type Replace = <T extends object>(target: T, key: keyof T & string, value: unknown) => void;

/** `node:crypto` functions that return randomness. */
const NODE_RANDOM = ['randomBytes', 'randomFill', 'randomFillSync', 'randomInt', 'randomUUID', 'generateKey', 'generateKeySync', 'generateKeyPair', 'generateKeyPairSync', 'generatePrime', 'generatePrimeSync'] as const;

function watchGlobals(access: AmbientAccess, replace: Replace): void {
  const env = process.env;
  replace(process, 'env', new Proxy(env, {
    get: (target, key) => { access.env.push(String(key)); return Reflect.get(target, key); },
    has: (target, key) => { access.env.push(String(key)); return Reflect.has(target, key); },
    ownKeys: (target) => { access.env.push('*'); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor: (target, key) => { access.env.push(String(key)); return Reflect.getOwnPropertyDescriptor(target, key); },
  }));
  const RealDate = Date;
  const ClockDate = function (this: unknown, ...args: unknown[]) {
    if (!new.target) { access.clock.push('Date()'); return RealDate(); }
    if (args.length === 0) access.clock.push('new Date()');
    return Reflect.construct(RealDate, args, new.target);
  } as unknown as DateConstructor;
  Object.setPrototypeOf(ClockDate, RealDate);
  (ClockDate as unknown as { prototype: unknown }).prototype = RealDate.prototype;
  (ClockDate as { now: () => number }).now = () => { access.clock.push('Date.now()'); return RealDate.now(); };
  replace(globalThis, 'Date', ClockDate);
  const now = performance.now.bind(performance);
  replace(performance, 'now', () => { access.clock.push('performance.now()'); return now(); });
  const hrtime = process.hrtime;
  const watchedHrtime = Object.assign((time?: [number, number]) => { access.clock.push('process.hrtime()'); return hrtime(time); }, {
    bigint: () => { access.clock.push('process.hrtime.bigint()'); return hrtime.bigint(); },
  });
  replace(process, 'hrtime', watchedHrtime);
  const random = Math.random;
  replace(Math, 'random', () => { access.random.push('Math.random()'); return random(); });
  const node = nodeCrypto as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const key of NODE_RANDOM) {
    const original = node[key];
    // `node:crypto.getRandomValues` is non-configurable; it is the web `getRandomValues`, watched below.
    if (typeof original !== 'function' || Object.getOwnPropertyDescriptor(nodeCrypto, key)?.configurable === false) continue;
    replace(node, key, (...args: unknown[]) => { access.random.push(`crypto.${key}()`); return original.apply(nodeCrypto, args); });
  }
  const web = globalThis.crypto as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const key of ['randomUUID', 'getRandomValues'] as const) {
    const original = web[key]!;
    replace(web, key, (...args: unknown[]) => { access.random.push(`globalThis.crypto.${key}()`); return original.apply(globalThis.crypto, args); });
  }
}
