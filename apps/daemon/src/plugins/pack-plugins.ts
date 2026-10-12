// Licensed packs: the `plugins` content handler (P1-5).
//
// A pack's `plugins` entry lists plugin folders (`<entry.path>/<id>/`). On
// activate, each listed plugin is registered through the ordinary plugin
// installer (`installFromLocalFolder`), so it is a normal
// `local` plugin row under the data root's plugins folder, visible wherever
// plugins are listed. Every row is tagged `source` = `resolvedSource` =
// `pack:<packId>@<version>`; that tag is the only way this handler finds its
// rows again.
//
// Rules:
//   - Only verified bytes are registered. Each listed file of the plugin is
//     read from the live pack folder (no symlinks), checked against the size
//     and sha256 in pack.json, and copied into a private (0700) staging
//     folder; the installer copies from there, and the copied folder must
//     match the roster exactly before the row is written. A mismatch at
//     either step skips that plugin.
//   - Trust follows the pack's install source, with the installer's own
//     defaults (`defaultTrustForRecord`): a local `.tgz` or folder pack gives
//     trusted plugins, a `github:` pack restricted ones, like a direct GitHub
//     plugin install. A new version or a switch between a local and a
//     remote source starts from that default; a same-version, same-source
//     repair (`ctx.repair`) re-registers only plugins whose row is missing
//     or whose folder no longer matches the roster, so healthy rows keep the
//     user's trust and capability grants.
//   - Ownership is decided under the plugin-id lock (`plugin-id-lock.ts`),
//     which every plugin install and uninstall holds: the installer's
//     `allowReplacePlugin` and the uninstaller's `onlyIf` re-read the row
//     there, so a user install of the same id can never be overwritten or
//     deleted by a check that went stale.
//   - A listed folder whose plugin manifest names another id is refused.
//   - Collisions: an id already held by a plugin this pack did not register
//     (user, marketplace, bundled, another pack) is never replaced. That one
//     plugin is skipped with a warning; the rest still activate and the kind
//     stays `active` (a re-install cannot fix a collision, so it is not a
//     failure).
//   - Upgrade and repair are idempotent: after the listed plugins are
//     registered, every other row tagged `pack:<packId>@` (any version, so
//     `previousVersion` and anything older) is unregistered. A plugin the
//     new version still lists but could not register is unregistered too,
//     so no row keeps pointing at bytes the pack no longer vouches for.
//   - Any skip other than a collision makes activate throw after the whole
//     list is processed, so the receipt records `failed:<CODE>` and the pack
//     shows degraded (a re-install repairs it).
//   - Retract removes every row tagged `pack:<packId>@` and needs nothing
//     from the manifest, so it works with `entries: []` (a damaged pack). A
//     plugin folder that cannot be removed keeps its row and fails the
//     retract (RETRACT_FAILED), so the removal can be retried.
//   - Pack plugins are not written to the plugin lockfile: the pack, not the
//     lockfile, is how they are reproduced, and uninstall never prunes it.

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fsp, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  packPluginSource,
  PACK_PLUGIN_SOURCE_PREFIX,
  type InstalledPluginRecord,
  type PackFileEntry,
  type TrustTier,
} from '@open-design/contracts';
import type Database from 'better-sqlite3';

import { isRemotePackSource, type PackContentHandler, type PackContentHandlerContext } from '../packs/handlers.js';
import { O_NOFOLLOW } from '../packs/manifest.js';
import { ensureRealDir, PACK_STAGING_DIRNAME } from '../packs/registry.js';
import { installFromLocalFolder, uninstallPlugin } from './installer.js';
import { getInstalledPlugin, resolvePluginFolder, type RegistryRoots } from './registry.js';
import { defaultTrustForRecord } from './trust.js';

type SqliteDb = Database.Database;

export interface PluginsPackHandlerOptions {
  /**
   * The daemon database. A getter, because the pack service is built before
   * server.ts opens the database; it must return the open database by the
   * time a handler runs.
   */
  db: () => SqliteDb | null;
  /** The server's `registryRootsForDataDir(RUNTIME_DATA_DIR)`; never `defaultRegistryRoots()`. */
  roots: RegistryRoots;
  /** Test seams; production never sets them. */
  testHooks?: {
    /** After a plugin's verified files are staged, before the installer runs. */
    afterStage?: (id: string, stagedDir: string) => Promise<void>;
    /** Forwarded to the installer: after its ownership check, before it writes. */
    afterOwnershipCheck?: (id: string) => Promise<void>;
    /** Before one pack row is unregistered. */
    beforeUnregister?: (id: string) => Promise<void>;
    /** Forwarded to uninstallPlugin: replaces the folder removal. */
    removeFolder?: (folder: string) => Promise<void>;
  };
}

type SkipCode = 'PLUGIN_INTEGRITY' | 'PLUGIN_INVALID' | 'PLUGIN_INSTALL_FAILED' | 'PLUGIN_RETRACT_FAILED';

class SkipPlugin extends Error {
  constructor(
    readonly code: SkipCode,
    readonly warning: string,
  ) {
    super(warning);
  }
}

function handlerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function packPrefix(packId: string): string {
  return `${PACK_PLUGIN_SOURCE_PREFIX}${packId}@`;
}

/** True when `record` is a row this pack registered (any version). */
export function isPackPluginRow(record: Pick<InstalledPluginRecord, 'sourceKind' | 'resolvedSource'>, packId: string): boolean {
  return (
    record.sourceKind !== 'bundled' &&
    typeof record.resolvedSource === 'string' &&
    record.resolvedSource.startsWith(packPrefix(packId))
  );
}

/** Ids of every row tagged `pack:<packId>@`, by the tag alone. */
export function packPluginRowIds(db: SqliteDb, packId: string): string[] {
  const prefix = packPrefix(packId);
  const rows = db
    .prepare(
      `SELECT id FROM installed_plugins
        WHERE source_kind != 'bundled' AND substr(resolved_source, 1, length(?)) = ?
        ORDER BY id`,
    )
    .all(prefix, prefix) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function requireDb(options: PluginsPackHandlerOptions): SqliteDb {
  const db = options.db();
  if (!db) throw handlerError('PLUGIN_DB_UNAVAILABLE', 'the plugin database is not open');
  return db;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Read one listed file from the live pack, refusing links and anything that does not match its row. */
async function readVerified(packDir: string, packReal: string, file: PackFileEntry): Promise<Buffer> {
  const source = path.join(packDir, ...file.path.split('/'));
  let real: string;
  try {
    real = realpathSync(source);
  } catch {
    throw new Error('missing');
  }
  if (!real.startsWith(packReal + path.sep)) throw new Error('outside the pack');
  const handle = await fsp.open(source, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.bytes) throw new Error('size mismatch');
    const bytes = await handle.readFile();
    if (bytes.length !== file.bytes) throw new Error('size mismatch');
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('sha256 mismatch');
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Trust a pack's plugins start with: the default the plugin installer gives
 * the same kind of source (`defaultTrustForRecord`). A pack installed from a
 * local `.tgz` or folder counts as a local install (trusted); a `github:`
 * pack, or an unknown source, counts as a remote install (restricted until
 * the user grants trust).
 */
export function trustForPackSource(installSource: string): TrustTier {
  return defaultTrustForRecord({ sourceKind: isRemotePackSource(installSource) ? 'github' : 'local' });
}

/** True when `folder` holds exactly the roster's files, each with its size and sha256. */
async function folderMatchesRoster(folder: string, roster: PackFileEntry[], folderPrefix: string): Promise<boolean> {
  const expected = new Map(roster.map((file) => [file.path.slice(folderPrefix.length), file]));
  const seen = new Set<string>();
  const queue: string[] = [''];
  while (queue.length > 0) {
    const rel = queue.pop()!;
    const entries = await fsp.readdir(path.join(folder, ...rel.split('/').filter(Boolean)), { withFileTypes: true });
    for (const dirent of entries) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        queue.push(childRel);
        continue;
      }
      const file = expected.get(childRel);
      if (!dirent.isFile() || !file) return false;
      const bytes = await fsp.readFile(path.join(folder, ...childRel.split('/')));
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) return false;
      seen.add(childRel);
    }
  }
  return seen.size === expected.size;
}

export function createPluginsPackHandler(options: PluginsPackHandlerOptions): PackContentHandler<'plugins'> {
  const { roots, testHooks: hooks } = options;

  /**
   * Unregister one pack row. Ownership is re-read under the plugin-id lock
   * (`onlyIf`): a row someone else took over since it was listed is left
   * alone. A folder that cannot be removed keeps its row and reports failure.
   */
  async function unregister(db: SqliteDb, packId: string, id: string): Promise<'removed' | 'skipped' | 'failed'> {
    await hooks?.beforeUnregister?.(id);
    const result = await uninstallPlugin(db, id, roots, {
      onlyIf: (row) => row !== null && isPackPluginRow(row, packId),
      ...(hooks?.removeFolder ? { removeFolder: hooks.removeFolder } : {}),
    });
    if (result.skipped) return 'skipped';
    return result.ok ? 'removed' : 'failed';
  }

  /** This version's row matches what registration would write, and its folder holds exactly the pack's roster. */
  async function isHealthyRegistration(
    db: SqliteDb,
    ctx: PackContentHandlerContext<'plugins'>,
    entry: PackContentHandlerContext<'plugins'>['entries'][number],
    id: string,
  ): Promise<boolean> {
    // Healthy means the row is exactly what registration would write now
    // (tag, source, source kind, install path, plugin version) and the
    // folder holds exactly the roster. Anything else is re-registered.
    const tag = packPluginSource(ctx.packId, ctx.version);
    const folder = path.join(roots.userPluginsRoot, id);
    const row = getInstalledPlugin(db, id);
    if (
      !row ||
      !isPackPluginRow(row, ctx.packId) ||
      row.resolvedSource !== tag ||
      row.source !== tag ||
      row.sourceKind !== 'local' ||
      row.fsPath !== folder
    ) {
      return false;
    }
    const folderPrefix = `${entry.path}/${id}/`;
    const files = entry.files.filter((file) => file.path.startsWith(folderPrefix));
    if (files.length === 0) return false;
    try {
      if (!(await folderMatchesRoster(folder, files, folderPrefix))) return false;
      const expected = await resolvePluginFolder({ folder, folderId: id, sourceKind: 'local', source: tag });
      return expected.ok && expected.record.id === id && expected.record.version === row.version;
    } catch {
      return false;
    }
  }

  async function registerOne(
    db: SqliteDb,
    ctx: PackContentHandlerContext<'plugins'>,
    packReal: string,
    stagingRoot: string,
    entry: PackContentHandlerContext<'plugins'>['entries'][number],
    id: string,
  ): Promise<'registered' | 'collision'> {
    const tag = packPluginSource(ctx.packId, ctx.version);
    // Collisions first (a cheap pre-check; the installer repeats it under
    // the plugin-id lock): never touch an id this pack does not own.
    const existing = getInstalledPlugin(db, id);
    if (existing ? !isPackPluginRow(existing, ctx.packId) : await exists(path.join(roots.userPluginsRoot, id))) {
      return 'collision';
    }

    const folderPrefix = `${entry.path}/${id}/`;
    const files = entry.files.filter((file) => file.path.startsWith(folderPrefix));
    if (files.length === 0) {
      throw new SkipPlugin('PLUGIN_INVALID', `plugin ${id} was not registered: the pack lists no files for it`);
    }
    const staged = path.join(stagingRoot, id);
    for (const file of files) {
      let bytes: Buffer;
      try {
        bytes = await readVerified(ctx.packDir, packReal, file);
      } catch {
        throw new SkipPlugin('PLUGIN_INTEGRITY', `plugin ${id} was not registered: its files do not match the pack`);
      }
      const target = path.join(staged, ...file.path.slice(folderPrefix.length).split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes, { flag: 'wx' });
    }

    await hooks?.afterStage?.(id, staged);

    const probe = await resolvePluginFolder({ folder: staged, folderId: id, sourceKind: 'local', source: tag });
    if (!probe.ok) {
      throw new SkipPlugin('PLUGIN_INVALID', `plugin ${id} was not registered: its plugin manifest is not valid`);
    }
    if (probe.record.id !== id) {
      throw new SkipPlugin('PLUGIN_INVALID', `plugin ${id} was not registered: its manifest names a different plugin id`);
    }

    let installed = false;
    let collided = false;
    let tampered = false;
    for await (const event of installFromLocalFolder(db, {
      source: tag,
      _stagedFolder: staged,
      roots,
      resolvedSource: tag,
      // The default of the pack's own install source, never a carried-over grant.
      trust: trustForPackSource(ctx.installSource),
      overwriteExisting: true,
      eventKind: existing ? 'upgraded' : 'installed',
      ...(hooks?.afterOwnershipCheck ? { _afterOwnershipCheck: hooks.afterOwnershipCheck } : {}),
      // Runs under the plugin-id lock, right before bytes are replaced: the
      // authoritative ownership check. A folder with no row is not ours either.
      allowReplacePlugin: (pluginId) => {
        const row = getInstalledPlugin(db, pluginId);
        if (pluginId === id && row !== null && isPackPluginRow(row, ctx.packId)) return true;
        collided = true;
        return `plugin ${pluginId} is not owned by pack ${ctx.packId}`;
      },
      // Still under the lock, before the row is written: the copied bytes
      // must be exactly the pack's roster for this plugin.
      verifyCopiedFolder: async (folder) => {
        if (await folderMatchesRoster(folder, files, folderPrefix)) return null;
        tampered = true;
        return `plugin ${id} does not match the pack`;
      },
    })) {
      if (event.kind === 'success') installed = event.plugin.id === id;
    }
    if (collided) return 'collision';
    if (tampered) {
      throw new SkipPlugin('PLUGIN_INTEGRITY', `plugin ${id} was not registered: its files do not match the pack`);
    }
    if (!installed) {
      throw new SkipPlugin('PLUGIN_INSTALL_FAILED', `plugin ${id} could not be registered`);
    }
    return 'registered';
  }

  return {
    kind: 'plugins',

    async activate(ctx) {
      const db = requireDb(options);
      const packsDir = path.dirname(ctx.packDir);
      const stagingParent = path.join(packsDir, PACK_STAGING_DIRNAME);
      await ensureRealDir(stagingParent);
      const stagingRoot = path.join(stagingParent, `plugins-${randomUUID()}`);
      // Private to the daemon user: staged bytes are copied into the plugin
      // root, and the copy is checked again against the roster.
      await fsp.mkdir(stagingRoot, { mode: 0o700 });
      await fsp.chmod(stagingRoot, 0o700);
      const registered = new Set<string>();
      let failure: SkipCode | null = null;
      try {
        const packReal = realpathSync(ctx.packDir);
        for (const entry of ctx.entries) {
          for (const id of entry.ids) {
            try {
              // Repair (same version, same source): a healthy registration
              // is left alone, with the user's trust and capability grants.
              if (ctx.repair && (await isHealthyRegistration(db, ctx, entry, id))) {
                registered.add(id);
                continue;
              }
              const outcome = await registerOne(db, ctx, packReal, stagingRoot, entry, id);
              if (outcome === 'registered') registered.add(id);
              else ctx.warn(`plugin ${id} was not registered: a plugin with that id is already installed`);
            } catch (error) {
              if (!(error instanceof SkipPlugin)) throw error;
              ctx.warn(error.warning);
              failure ??= error.code;
            }
          }
        }
      } finally {
        await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      }

      // Drop every row of this pack the activation did not (re)register:
      // ids an upgrade dropped, older versions, and listed ids that failed.
      for (const id of packPluginRowIds(db, ctx.packId)) {
        if (registered.has(id)) continue;
        if ((await unregister(db, ctx.packId, id)) === 'failed') {
          ctx.warn(`plugin ${id} from an earlier pack version could not be unregistered`);
          failure ??= 'PLUGIN_RETRACT_FAILED';
        }
      }
      if (failure) throw handlerError(failure, 'some pack plugins could not be registered');
    },

    async retract(ctx) {
      const db = requireDb(options);
      const stuck: string[] = [];
      for (const id of packPluginRowIds(db, ctx.packId)) {
        if ((await unregister(db, ctx.packId, id)) === 'failed') stuck.push(id);
      }
      if (stuck.length > 0) {
        for (const id of stuck) ctx.warn(`plugin ${id} could not be unregistered`);
        throw handlerError('PLUGIN_RETRACT_FAILED', 'some pack plugins could not be unregistered');
      }
    },
  };
}
