// Licensed packs: the content-handler hook.
//
// Most kinds are pulled: consumers ask the pack registry for them at request
// time (`component-kit`, `cult-catalog`, `genui-overlay`). A pushed kind needs
// a handler that registers it somewhere else when a pack is activated and
// takes it back before the pack is removed. Today that is `plugins`: P1-5's
// handler (`plugins/pack-plugins.ts`, registered in server.ts) calls the
// plugin installer's `installFromLocalFolder` for each listed folder (rows
// `local`, `resolvedSource: 'pack:<id>@<version>'`) and uninstalls exactly
// those rows on retract.
//
// Rules the service applies:
//   - `activate` runs once per kind present in the pack, after the new bytes
//     are live and the receipt is written. It must be an idempotent upsert:
//     a re-install of the same version calls it again to repair.
//   - A failing `activate` keeps the bytes and marks the pack `degraded`
//     (receipt status `failed:<CODE>`); a re-install repairs it.
//   - `retract` runs for every handled kind before the bytes are removed. A
//     failing `retract` aborts the removal, so no registration is left
//     pointing at deleted bytes.
//   - An upgrade that drops a kind retracts it against the old manifest,
//     before the swap; if the upgrade then fails, the kind is activated
//     again on the old version.
//   - A pushed kind with no handler installs with a warning and receipt
//     status `unhandled`; `PackService.activatePending()` runs it later.
//   - A handler must be able to retract by `pack:<packId>@<version>` alone.
//     When pack.json is unreadable (a damaged pack being removed or
//     replaced), `retract` gets the id and version from the install receipt
//     and an EMPTY `entries` list, and must remove whatever it registered for
//     that pack (P1-5: rows whose resolvedSource starts with `pack:<packId>@`).
//     Kinds the receipt marks `unhandled` are skipped.

import path from 'node:path';

import {
  PACK_CONTENT_KINDS,
  packFilesUnder,
  type PackContentEntryOf,
  type PackContentKind,
  type PackFileEntry,
  type PackManifest,
} from '@mish/contracts';

/** Kinds consumers read through the registry; they need no handler. */
export const PACK_PULL_KINDS: ReadonlySet<PackContentKind> = new Set(['component-kit', 'cult-catalog', 'genui-overlay']);

export type PackHandlerStatus = 'active' | 'pending' | 'unhandled' | `failed:${string}`;

export type PackContentEntryWithPath<K extends PackContentKind> = PackContentEntryOf<K> & {
  /** Absolute path of the entry under the live pack folder. */
  absPath: string;
  /**
   * The manifest's `files[]` rows under the entry's path, with the sha256 and
   * size the install verified (the same list as `ResolvedPackContent.files`).
   * A handler that copies bytes out of the pack re-checks them against these.
   */
  files: PackFileEntry[];
};

export interface PackContentHandlerContext<K extends PackContentKind> {
  packId: string;
  version: string;
  /** Absolute path of the live pack folder (`<packsDir>/<id>`). */
  packDir: string;
  /** Every entry of this kind in the manifest, in manifest order. */
  entries: PackContentEntryWithPath<K>[];
  /** The version this activation replaces, or null for a first install. */
  previousVersion: string | null;
  /**
   * Where the installed version came from: the receipt's `source`
   * (`github:owner/repo[@version]`, `local:<file name>`, `folder:<folder name>`),
   * or `''` when unknown. Handlers that grant anything by provenance (the
   * plugins handler's trust default) must treat `''` as remote.
   */
  installSource: string;
  /**
   * True for a same-version, same-source re-activation (a plain reinstall,
   * `activatePending`, a restore after a failed removal). A handler should
   * then repair only what is missing or broken and leave healthy
   * registrations, and the user's choices on them, untouched.
   */
  repair: boolean;
  signal?: AbortSignal | undefined;
  /** Add a user-facing warning (fixed text; no paths). */
  warn(message: string): void;
}

export interface PackContentHandler<K extends PackContentKind = PackContentKind> {
  kind: K;
  activate(ctx: PackContentHandlerContext<K>): Promise<void>;
  retract(ctx: PackContentHandlerContext<K>): Promise<void>;
}

export type AnyPackContentHandler = { [K in PackContentKind]: PackContentHandler<K> }[PackContentKind];

export type PackHandlerMap = ReadonlyMap<PackContentKind, AnyPackContentHandler>;

export function createPackHandlerMap(handlers: readonly AnyPackContentHandler[] = []): PackHandlerMap {
  const map = new Map<PackContentKind, AnyPackContentHandler>();
  for (const handler of handlers) {
    if (!(PACK_CONTENT_KINDS as readonly string[]).includes(handler.kind)) {
      throw new TypeError('pack content handler for an unknown kind');
    }
    if (map.has(handler.kind)) throw new TypeError(`two pack content handlers for kind ${handler.kind}`);
    map.set(handler.kind, handler);
  }
  return map;
}

/** Kinds present in a manifest, in first-seen order. */
export function manifestKinds(manifest: PackManifest): PackContentKind[] {
  const kinds: PackContentKind[] = [];
  for (const entry of manifest.contents) if (!kinds.includes(entry.kind)) kinds.push(entry.kind);
  return kinds;
}

/** Kinds that need a handler (not pulled through the registry). */
export function pushedKinds(manifest: PackManifest): PackContentKind[] {
  return manifestKinds(manifest).filter((kind) => !PACK_PULL_KINDS.has(kind));
}

/**
 * True when a receipt `source` is remote (`github:`, or anything unknown) and
 * false for a local `.tgz` (`local:`) or folder (`folder:`) install. Trust
 * defaults key on it, so a same-version install that changes it is a
 * replacement, not `unchanged`.
 */
export function isRemotePackSource(source: string | null | undefined): boolean {
  return !(typeof source === 'string' && (source.startsWith('local:') || source.startsWith('folder:')));
}

export function unhandledWarning(kind: PackContentKind): string {
  return `${kind} content is not registered by this build`;
}

const HANDLER_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A handler error's code when it is a plain UPPER_SNAKE token, else HANDLER_FAILED. */
export function handlerFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && HANDLER_CODE_RE.test(code) ? code : 'HANDLER_FAILED';
}

export function buildHandlerContext<K extends PackContentKind>(
  kind: K,
  args: {
    manifest: PackManifest;
    packDir: string;
    previousVersion: string | null;
    installSource?: string | undefined;
    repair?: boolean | undefined;
    signal?: AbortSignal | undefined;
    warnings: string[];
  },
): PackContentHandlerContext<K> {
  const entries = args.manifest.contents
    .filter((entry): entry is PackContentEntryOf<K> => entry.kind === kind)
    .map((entry) => ({
      ...entry,
      absPath: path.join(args.packDir, ...entry.path.split('/')),
      files: packFilesUnder(entry.path, args.manifest.files),
    }));
  return {
    packId: args.manifest.id,
    version: args.manifest.version,
    packDir: args.packDir,
    entries,
    previousVersion: args.previousVersion,
    installSource: args.installSource ?? '',
    repair: args.repair ?? false,
    signal: args.signal,
    warn: (message) => {
      args.warnings.push(message);
    },
  };
}

async function callHandler(
  handler: AnyPackContentHandler,
  op: 'activate' | 'retract',
  args: Parameters<typeof buildHandlerContext>[1],
): Promise<void> {
  // The map guarantees handler.kind matches the context kind.
  const ctx = buildHandlerContext(handler.kind, args);
  await (handler[op] as (ctx: PackContentHandlerContext<PackContentKind>) => Promise<void>)(ctx);
}

/**
 * Run `activate` for each pushed kind in `kinds` (default: all in the
 * manifest). Returns the status per pushed kind; never throws.
 */
export async function activatePackContent(args: {
  handlers: PackHandlerMap;
  manifest: PackManifest;
  packDir: string;
  previousVersion: string | null;
  installSource?: string | undefined;
  repair?: boolean | undefined;
  signal?: AbortSignal | undefined;
  kinds?: readonly PackContentKind[];
}): Promise<{ statuses: Partial<Record<PackContentKind, PackHandlerStatus>>; warnings: string[] }> {
  const statuses: Partial<Record<PackContentKind, PackHandlerStatus>> = {};
  const warnings: string[] = [];
  for (const kind of args.kinds ?? pushedKinds(args.manifest)) {
    const handler = args.handlers.get(kind);
    if (!handler) {
      statuses[kind] = 'unhandled';
      warnings.push(unhandledWarning(kind));
      continue;
    }
    try {
      await callHandler(handler, 'activate', { ...args, warnings });
      statuses[kind] = 'active';
    } catch (error) {
      const code = handlerFailureCode(error);
      statuses[kind] = `failed:${code}`;
      warnings.push(`${kind} content could not be registered (${code})`);
    }
  }
  return { statuses, warnings };
}

/**
 * Retract by receipt alone (pack.json unreadable): one `retract` per kind in
 * `kinds` that has a handler, with the receipt's id and version and no
 * entries. Stops at the first failure; never throws.
 */
export async function retractByReceipt(args: {
  handlers: PackHandlerMap;
  packId: string;
  version: string;
  packDir: string;
  installSource?: string | undefined;
  signal?: AbortSignal | undefined;
  kinds: readonly PackContentKind[];
}): Promise<{ ok: true; warnings: string[] } | { ok: false; kind: PackContentKind; code: string; warnings: string[] }> {
  const warnings: string[] = [];
  for (const kind of args.kinds) {
    const handler = args.handlers.get(kind);
    if (!handler) continue;
    const ctx: PackContentHandlerContext<PackContentKind> = {
      packId: args.packId,
      version: args.version,
      packDir: args.packDir,
      entries: [],
      previousVersion: null,
      installSource: args.installSource ?? '',
      repair: false,
      signal: args.signal,
      warn: (message) => {
        warnings.push(message);
      },
    };
    try {
      await (handler.retract as (ctx: PackContentHandlerContext<PackContentKind>) => Promise<void>)(ctx);
    } catch (error) {
      return { ok: false, kind, code: handlerFailureCode(error), warnings };
    }
  }
  return { ok: true, warnings };
}

/** Pushed kinds a receipt says were registered or attempted: every status but `unhandled`. */
export function receiptRegisteredKinds(
  statuses: Partial<Record<PackContentKind, PackHandlerStatus>>,
): PackContentKind[] {
  return (Object.entries(statuses) as [PackContentKind, PackHandlerStatus][])
    .filter(([kind, status]) => status !== 'unhandled' && !PACK_PULL_KINDS.has(kind))
    .map(([kind]) => kind);
}

/**
 * Run `retract` for each handled kind in `kinds` (default: all pushed kinds
 * in the manifest). Stops at the first failure and returns its kind and code;
 * never throws.
 */
export async function retractPackContent(args: {
  handlers: PackHandlerMap;
  manifest: PackManifest;
  packDir: string;
  installSource?: string | undefined;
  signal?: AbortSignal | undefined;
  kinds?: readonly PackContentKind[];
}): Promise<{ ok: true; warnings: string[] } | { ok: false; kind: PackContentKind; code: string; warnings: string[] }> {
  const warnings: string[] = [];
  for (const kind of args.kinds ?? pushedKinds(args.manifest)) {
    const handler = args.handlers.get(kind);
    if (!handler) continue;
    try {
      await callHandler(handler, 'retract', { ...args, previousVersion: null, warnings });
    } catch (error) {
      return { ok: false, kind, code: handlerFailureCode(error), warnings };
    }
  }
  return { ok: true, warnings };
}
