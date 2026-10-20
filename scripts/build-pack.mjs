#!/usr/bin/env node
// Builds Mish packs (.zip) from a private checkout.
//
//   node scripts/build-pack.mjs <sourceRepoDir> <outZip> [--map <file>] [--id <id>] [--name <text>]
//                               [--version <v>] [--dry-run] [--json]
//   node scripts/build-pack.mjs <sourceRepoDir> <outDir> --split [--max-bytes <size>] [...]
//
// The private checkout is only read. What goes into the pack is decided by a declarative map
// (`scripts/pack-map.json`, or --map for a map you keep private): paths in the checkout, where
// each lands in the pack, and which `provides` key it fills. This repository holds the map and
// this script; it never holds the content the map points at. See docs/packs.md.
//
// With --split, every resource names a module in the map and each module becomes its own pack, so
// a team installs only what it needs and each file stays small enough for a release asset. A
// module larger than --max-bytes (1.5 GiB by default, counted before compression) is cut into
// numbered parts along whole child folders (one design system, one project). The output folder
// gets one .zip per pack, a SHA256SUMS file and inventory.json (id, version, file, size, sha256).
//
// Rules the builder enforces:
//   - the output must be outside the source checkout, and must not exist yet (an output folder may
//     exist when it is empty);
//   - symbolic links are skipped, never followed; a file reached through a linked folder, or one that
//     resolves outside the source checkout, is left out and reported;
//   - metadata, `.git`, `node_modules` and anything that looks like a credential file are left out
//     and reported;
//   - names the daemon would refuse at install time are left out and reported;
//   - a database the map names is copied to a temporary folder and opened read-only there, so not
//     even SQLite's own index files are written next to the checkout;
//   - the finished manifest is validated with the same schema the daemon uses (when
//     `packages/contracts` is built), so a pack that would be refused is not written.

import { createReadStream, existsSync, lstatSync, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ZipWriter } from './lib/zip-writer.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const DEFAULT_MAP = path.join(import.meta.dirname, 'pack-map.json');

const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db', '__MACOSX']);
const SECRET_NAME = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^(mcp-tokens|mcp-oauth-clients|credentials?|secrets?)(\..*)?$/i,
  // MCP client configs. The app writes `.mcp.json` into a project for each agent run, with the
  // live Authorization headers of the connected servers in it; the next run writes it again.
  // The name may carry a prefix (`agent.mcp.json`) and a suffix: the app writes the file through
  // `.mcp.json.<hex>.tmp`, and editors leave `.bak` and `~` copies.
  /(^|\.)mcp(-config)?\.json([.~].*)?$/i,
  // Per-machine agent settings (`.claude/settings.local.json` can hold an `env` block) and auth stores.
  /^settings\.local\.json([.~].*)?$/i,
  /^auth\.json([.~].*)?$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
];
const CHILD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/**
 * Credential shapes looked for inside small text files. A match is reported, not left out: captured
 * pages and docs carry look-alikes, and dropping them would break the content. Names that mark a
 * credential file are left out above.
 */
const CREDENTIAL_SHAPES = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/u,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./u,
  /\bsk-[A-Za-z0-9_-]{20,}/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
];
const SCANNED_TEXT = /\.(json|jsonl|md|txt|html?|m?[jt]sx?|cjs|ya?ml|toml|ini|cfg|conf|sh|env\w*|tmp|temp|bak|old|orig|log)$/iu;
const SCAN_MAX_BYTES = 2 * 1024 * 1024;
/** The daemon refuses an entry path longer than this. */
const MAX_ENTRY_PATH = 1024;
const GIB = 1024 * 1024 * 1024;
/** Default size of one pack in --split mode: under a GitHub release asset's 2 GiB limit. */
const DEFAULT_MAX_PACK_BYTES = 1.5 * GIB;
const PROJECTS_FILENAME = 'projects.json';
const PROJECTS_SCHEMA = 'mish-pack-projects/1';

/** Stops the build. Thrown, not exited, so temporary folders are still cleaned up; `main` prints it. */
function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { positional: [], map: DEFAULT_MAP, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[++i];
      if (!value) fail(`${arg} needs a value`);
      return value;
    };
    if (arg === '--map') args.map = path.resolve(takeValue());
    else if (arg === '--id') args.id = takeValue();
    else if (arg === '--name') args.name = takeValue();
    else if (arg === '--version') args.version = takeValue();
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--split') args.split = true;
    else if (arg === '--max-bytes') args.maxBytes = parseSize(takeValue());
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('-')) fail(`unknown option ${arg}`);
    else args.positional.push(arg);
  }
  return args;
}

/** `1610612736`, `1.5GiB`, `512MiB`. */
function parseSize(text) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB)?$/iu.exec(text.trim());
  if (!match) fail(`--max-bytes takes a size such as 1.5GiB or 1610612736, not ${text}`);
  const unit = (match[2] ?? 'B').toLowerCase();
  const scale = { b: 1, kib: 1024, mib: 1024 * 1024, gib: GIB }[unit];
  const value = Math.floor(Number(match[1]) * scale);
  if (!Number.isSafeInteger(value) || value < 1024 * 1024) fail('--max-bytes must be at least 1MiB');
  return value;
}

const USAGE = `Usage: node scripts/build-pack.mjs <sourceRepoDir> <outZip> [options]
       node scripts/build-pack.mjs <sourceRepoDir> <outDir> --split [options]

Options:
  --map <file>       Mapping file (default: scripts/pack-map.json)
  --id <id>          Pack id (default: from the map; one-pack mode only)
  --name <text>      Pack name (default: from the map; one-pack mode only)
  --version <v>      Pack version (default: from the map, else today's date)
  --split            One pack per module of the map, written into <outDir> with SHA256SUMS
                     and inventory.json
  --max-bytes <n>    Largest pack in --split mode before compression (default 1.5GiB);
                     a bigger module is cut into numbered parts
  --dry-run          List what would be packed; write nothing
  --json             Print the summary as JSON`;

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** `*` and `?` glob against one name. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function readableName(name) {
  // Same rules as the daemon's archive check: no control characters, backslash, or `<>:"|?*`; no
  // trailing dot or space.
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f\\<>:"|?*]/u.test(name) && !/[. ]$/u.test(name) && name.length <= 255;
}

class Plan {
  entries = [];
  warnings = [];
  skipped = new Map();
  /** Folder path -> whether it is a symbolic link, so each ancestor is checked once. */
  linkCache = new Map();
  /** Files written per pack from planned data: `provides` key -> { to, rows: Map<unit, row> } (projects). */
  derived = new Map();

  warn(message) {
    this.warnings.push(message);
  }

  /** Paths of packed files that contain a credential shape (reported, still packed). */
  flagged = [];

  skip(reason, name) {
    const list = this.skipped.get(reason) ?? [];
    if (list.length < 5) list.push(name);
    this.skipped.set(reason, list);
    this.skippedCount = (this.skippedCount ?? 0) + 1;
  }

  /**
   * `unit` is the smallest piece --split keeps together: a child folder (one design system, one
   * project) or, for every other resource, the whole resource.
   */
  addFile(zipPath, absolutePath, size, resource, unit = resource) {
    this.entries.push({ zipPath, absolutePath, size, resource, unit });
  }

  addBuffer(zipPath, buffer, resource, unit = resource) {
    this.entries.push({ zipPath, buffer, size: buffer.length, resource, unit });
  }
}

/**
 * Why `file` may not be packed from `root`, or null when it may. `root` must already be a real path.
 * The path check alone is lexical, so it also requires that no folder between `root` and `file` is a
 * symbolic link and that the file's real path stays inside `root`.
 */
async function containmentProblem(plan, root, file) {
  if (!isInside(root, file)) return 'outside the source checkout';
  let current = root;
  for (const part of path.relative(root, file).split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    let linked = plan.linkCache.get(current);
    if (linked === undefined) {
      linked = (await lstat(current)).isSymbolicLink();
      plan.linkCache.set(current, linked);
    }
    if (linked) return 'reached through a symbolic link';
  }
  let real;
  try {
    real = await realpath(file);
  } catch {
    return 'could not be resolved';
  }
  return isInside(root, real) ? null : 'resolves outside the source checkout';
}

/** Walks a folder (or takes one file) under the real folder `root` and plans every regular file under `zipPrefix`. */
async function planPath(plan, root, absolute, zipPrefix, resource, unit = resource) {
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) return plan.skip('symbolic link', zipPrefix);
  if (info.isFile()) {
    const name = path.basename(absolute);
    if (SKIP_NAMES.has(name) || name.startsWith('._')) return;
    if (SECRET_NAME.some((pattern) => pattern.test(name))) return plan.skip('looks like a credential file', zipPrefix);
    if (!readableName(name)) return plan.skip('name the daemon refuses', zipPrefix);
    if (zipPrefix.length > MAX_ENTRY_PATH) return plan.skip('path longer than the daemon accepts', zipPrefix.slice(0, 120));
    const problem = await containmentProblem(plan, root, absolute);
    if (problem) return plan.skip(problem, zipPrefix);
    if (info.size <= SCAN_MAX_BYTES && SCANNED_TEXT.test(name)) {
      const text = await readFile(absolute, 'latin1');
      if (CREDENTIAL_SHAPES.some((shape) => shape.test(text))) plan.flagged.push(zipPrefix);
    }
    return plan.addFile(zipPrefix, absolute, info.size, resource, unit);
  }
  if (!info.isDirectory()) return plan.skip('not a regular file', zipPrefix);
  for (const entry of (await readdir(absolute)).sort()) {
    if (SKIP_NAMES.has(entry) || entry.startsWith('._')) continue;
    if (!readableName(entry)) {
      plan.skip('name the daemon refuses', `${zipPrefix}/${entry}`);
      continue;
    }
    await planPath(plan, root, path.join(absolute, entry), `${zipPrefix}/${entry}`, resource, unit);
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function setProvides(provides, dotted, value) {
  const keys = dotted.split('.');
  let target = provides;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`the map needs ${label}`);
  return value;
}

function sourcePath(source, relative, label) {
  const joined = path.resolve(source, relative);
  if (!isInside(source, joined)) fail(`${label} leaves the source checkout: ${relative}`);
  return joined;
}

async function jsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

const handlers = {
  /** One folder or file copied as is. */
  async dir(ctx, resource) {
    const from = sourcePath(ctx.source, requireString(resource.from, `"from" for ${resource.provides}`), resource.provides);
    if (!(await exists(from))) return ctx.missing(resource, resource.from);
    await planPath(ctx.plan, ctx.source, from, resource.to, resource.provides);
    ctx.provided(resource);
  },

  /** A list of folders or files, each copied to its own place under `to`. */
  async files(ctx, resource) {
    let any = false;
    for (const file of resource.files ?? []) {
      const from = sourcePath(ctx.source, requireString(file.from, `"from" in ${resource.provides}`), resource.provides);
      if (!(await exists(from))) {
        if (!file.optional) ctx.missing(resource, file.from, true);
        continue;
      }
      await planPath(ctx.plan, ctx.source, from, `${resource.to}/${requireString(file.to, `"to" in ${resource.provides}`)}`, resource.provides);
      any = true;
    }
    if (any) ctx.provided(resource);
    else ctx.missing(resource, '(no listed file exists)');
  },

  /** Child folders of one or more folders, picked by name patterns, merged under `to`. */
  async children(ctx, resource) {
    let any = false;
    for (const source of resource.sources ?? []) {
      const base = sourcePath(ctx.source, requireString(source.from, `"from" in ${resource.provides}`), resource.provides);
      if (!(await exists(base))) {
        ctx.plan.warn(`${resource.provides}: ${source.from} not found; skipped`);
        continue;
      }
      const include = (source.include ?? ['*']).map(globToRegExp);
      const exclude = (source.exclude ?? []).map(globToRegExp);
      for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (!include.some((pattern) => pattern.test(entry.name)) || exclude.some((pattern) => pattern.test(entry.name))) continue;
        if (!CHILD_NAME.test(entry.name)) {
          ctx.plan.skip('folder name the daemon refuses to copy', `${source.from}/${entry.name}`);
          continue;
        }
        await planPath(ctx.plan, ctx.source, path.join(base, entry.name), `${resource.to}/${entry.name}`, resource.provides, `${resource.provides}/${entry.name}`);
        any = true;
      }
    }
    if (any) ctx.provided(resource);
    else ctx.missing(resource, '(no matching folder)');
  },

  /** Prebuilt ES modules: one entry file bundled with its lazy chunks. */
  async bundle(ctx, resource) {
    const entry = sourcePath(ctx.source, requireString(resource.entry, `"entry" for ${resource.provides}`), resource.provides);
    if (!(await exists(entry))) return ctx.missing(resource, resource.entry);
    let esbuild;
    try {
      esbuild = createRequire(path.join(repoRoot, 'apps', 'daemon', 'package.json'))('esbuild');
    } catch {
      return fail('esbuild is not installed; run pnpm install in this repository');
    }
    if (await ctx.uncontained(entry, resource.entry)) return;
    const out = await mkdtemp(path.join(tmpdir(), 'mish-pack-bundle-'));
    ctx.cleanup.push(() => rm(out, { recursive: true, force: true }));
    const built = await esbuild.build({
      metafile: true,
      entryPoints: { index: entry },
      outdir: out,
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      chunkNames: 'chunks/[name]-[hash]',
      outExtension: { '.js': '.mjs' },
      logLevel: 'silent',
      absWorkingDir: ctx.source,
    });
    // Every file esbuild read must also live inside the source checkout, so a
    // symlinked import cannot pull outside files into the bundle.
    for (const input of Object.keys(built.metafile.inputs)) {
      // No esbuild plugins run here, so every input except esbuild's own
      // <runtime> entry is a filesystem path; check them all.
      if (input.startsWith('<')) continue;
      if (await ctx.uncontained(path.resolve(ctx.source, input), input)) return;
    }
    const folder = path.posix.dirname(resource.to);
    const realOut = await realpath(out);
    await planPath(ctx.plan, realOut, realOut, folder, resource.provides);
    ctx.provided(resource);
  },

  /** GenUI components whose source is the named licensed source: catalogue rows plus demo documents. */
  async 'genui-overlay'(ctx, resource) {
    const catalogFile = sourcePath(ctx.source, requireString(resource.catalog, `"catalog" for ${resource.provides}`), resource.provides);
    if (!(await exists(catalogFile))) return ctx.missing(resource, resource.catalog);
    if (await ctx.uncontained(catalogFile, resource.catalog)) return;
    const catalog = await jsonFile(catalogFile);
    const entries = (catalog.components ?? []).filter((entry) => entry?.source?.name === resource.sourceName);
    if (entries.length === 0) return ctx.missing(resource, `(no component from ${resource.sourceName})`);
    ctx.plan.addBuffer(`${resource.to}/overlay.json`, Buffer.from(`${JSON.stringify({ entries }, null, 2)}\n`), resource.provides);
    const dist = resource.dist ? sourcePath(ctx.source, resource.dist, resource.provides) : null;
    let demos = 0;
    if (dist && (await exists(dist)) && !(await ctx.uncontained(dist, resource.dist))) {
      const data = await import(pathToFileURL(dist).href);
      for (const entry of entries) {
        const html = data.demoDocument?.(entry.id);
        if (typeof html === 'string' && html.length > 0) {
          ctx.plan.addBuffer(`${resource.to}/demos/${entry.id}.html`, Buffer.from(html), resource.provides);
          demos += 1;
        }
      }
    }
    if (demos < entries.length) ctx.plan.warn(`${resource.provides}: ${demos} of ${entries.length} components have a demo (build the source checkout's GenUI package to include the rest)`);
    ctx.provided(resource);
  },

  /** Catalogue entries the public catalogue does not have. */
  async 'catalog-delta'(ctx, resource) {
    const privateFile = sourcePath(ctx.source, requireString(resource.from, `"from" for ${resource.provides}`), resource.provides);
    if (!(await exists(privateFile))) return ctx.missing(resource, resource.from);
    if (await ctx.uncontained(privateFile, resource.from)) return;
    const publicFile = sourcePath(repoRoot, requireString(resource.againstPublic, `"againstPublic" for ${resource.provides}`), resource.provides);
    const known = new Set(((await jsonFile(publicFile)).entries ?? []).map((entry) => entry.id));
    const entries = ((await jsonFile(privateFile)).entries ?? []).filter((entry) => !known.has(entry.id));
    if (entries.length === 0) return ctx.missing(resource, '(nothing beyond the public catalogue)');
    ctx.plan.addBuffer(resource.to, Buffer.from(`${JSON.stringify({ entries })}\n`), resource.provides);
    ctx.provided(resource);
  },
};

/**
 * The `projects` rows of an app database, by id. The database (and its write-ahead log) is copied
 * to a temporary folder and opened read-only there; the checkout's own files are never opened by
 * SQLite.
 */
async function readProjectRows(ctx, database, label) {
  let Database;
  try {
    Database = createRequire(path.join(repoRoot, 'apps', 'daemon', 'package.json'))('better-sqlite3');
  } catch {
    return fail('better-sqlite3 is not installed; run pnpm install in this repository');
  }
  const snapshot = await mkdtemp(path.join(tmpdir(), 'mish-pack-db-'));
  ctx.cleanup.push(() => rm(snapshot, { recursive: true, force: true }));
  const copy = path.join(snapshot, 'app.sqlite');
  await copyFile(database, copy);
  const wal = `${database}-wal`;
  if (await exists(wal)) {
    if (await ctx.uncontained(wal, `${label}-wal`)) return fail(`${label}-wal may not be read`);
    await copyFile(wal, `${copy}-wal`);
  }
  const db = new Database(copy, { readonly: true, fileMustExist: true });
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name));
    if (!columns.has('id') || !columns.has('name')) return fail(`${label} has no projects table`);
    const pick = (column, alias) => (columns.has(column) ? `${column} AS ${alias}` : `NULL AS ${alias}`);
    const rows = db.prepare(`SELECT id, name, ${pick('skill_id', 'skillId')}, ${pick('design_system_id', 'designSystemId')},
        ${pick('pending_prompt', 'pendingPrompt')}, ${pick('metadata_json', 'metadataJson')},
        ${pick('custom_instructions', 'customInstructions')}, ${pick('created_at', 'createdAt')}, ${pick('updated_at', 'updatedAt')}
      FROM projects`).all();
    const out = new Map();
    for (const row of rows) {
      let metadata = null;
      if (typeof row.metadataJson === 'string') {
        try {
          const parsed = JSON.parse(row.metadataJson);
          metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
          metadata = null;
        }
      }
      const text = (value) => (typeof value === 'string' ? value : null);
      const time = (value) => (Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
      out.set(String(row.id), {
        id: String(row.id),
        name: typeof row.name === 'string' && row.name.length > 0 ? row.name.slice(0, 1000) : String(row.id),
        skillId: text(row.skillId),
        designSystemId: text(row.designSystemId),
        pendingPrompt: text(row.pendingPrompt),
        metadata,
        customInstructions: text(row.customInstructions),
        createdAt: time(row.createdAt),
        updatedAt: time(row.updatedAt),
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Saved projects: every `<id>/` folder under `from` that has a row in the app database `database`,
 * copied under `to/<id>`, and the rows themselves in `to/projects.json` (written per pack, so a
 * split part lists exactly its own projects). A project whose files live outside the checkout
 * (`baseDir`) is left out; links to folders on this computer (`linkedDirs`) are dropped.
 */
handlers.projects = async function projects(ctx, resource) {
  const base = sourcePath(ctx.source, requireString(resource.from, `"from" for ${resource.provides}`), resource.provides);
  const database = sourcePath(ctx.source, requireString(resource.database, `"database" for ${resource.provides}`), resource.provides);
  if (!(await exists(base))) return ctx.missing(resource, resource.from);
  if (!(await exists(database))) return ctx.missing(resource, resource.database);
  if ((await ctx.uncontained(base, resource.from)) || (await ctx.uncontained(database, resource.database))) return;
  const rows = await readProjectRows(ctx, database, resource.database);
  const include = (resource.include ?? ['*']).map(globToRegExp);
  const exclude = (resource.exclude ?? []).map(globToRegExp);
  const derived = { to: resource.to, rows: new Map() };
  const folders = new Set();
  let unlinked = 0;
  let empty = 0;
  for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    folders.add(entry.name);
    if (!include.some((pattern) => pattern.test(entry.name)) || exclude.some((pattern) => pattern.test(entry.name))) continue;
    const label = `${resource.from}/${entry.name}`;
    if (!CHILD_NAME.test(entry.name) || entry.name === PROJECTS_FILENAME) {
      ctx.plan.skip('folder name the daemon refuses to copy', label);
      continue;
    }
    const found = rows.get(entry.name);
    if (!found) {
      ctx.plan.skip('project folder with no row in the app database', label);
      continue;
    }
    if (found.metadata && Object.hasOwn(found.metadata, 'baseDir')) {
      ctx.plan.skip('project whose files live outside the checkout', label);
      continue;
    }
    const row = { ...found };
    if (row.metadata && Object.hasOwn(row.metadata, 'linkedDirs')) {
      const { linkedDirs: _linked, ...rest } = row.metadata;
      row.metadata = rest;
      unlinked += 1;
    }
    // Project rows are packed too: scan their text like a packed file.
    if (CREDENTIAL_SHAPES.some((shape) => shape.test(JSON.stringify([row.name, row.pendingPrompt, row.customInstructions, row.metadata])))) {
      ctx.plan.flagged.push(`${resource.to}/${entry.name} (project row)`);
    }
    const unit = `${resource.provides}/${entry.name}`;
    const before = ctx.plan.entries.length;
    await planPath(ctx.plan, ctx.source, path.join(base, entry.name), `${resource.to}/${entry.name}`, resource.provides, unit);
    // A project with no files is still a project: its row travels, and the daemon makes the folder.
    if (ctx.plan.entries.length === before) empty += 1;
    derived.rows.set(unit, row);
  }
  const orphans = [...rows.keys()].filter((id) => !folders.has(id)).length;
  if (orphans > 0) ctx.plan.warn(`${resource.provides}: ${orphans} project row(s) in the database have no folder and were left out`);
  if (unlinked > 0) ctx.plan.warn(`${resource.provides}: ${unlinked} project(s) linked folders on this computer; the links were left out`);
  if (empty > 0) ctx.plan.warn(`${resource.provides}: ${empty} project(s) have no files to pack; they are added as empty projects`);
  if (derived.rows.size === 0) return ctx.missing(resource, '(no project folder with a database row)');
  ctx.plan.derived.set(resource.provides, derived);
  ctx.provided(resource);
};

async function loadContracts() {
  const dist = path.join(repoRoot, 'packages', 'contracts', 'dist', 'index.mjs');
  if (!existsSync(dist)) return null;
  const contracts = await import(pathToFileURL(dist).href);
  if (typeof contracts.mishPackManifestSchema?.safeParse !== 'function') return null;
  return {
    manifest: contracts.mishPackManifestSchema,
    projects: typeof contracts.mishPackProjectsFileSchema?.safeParse === 'function' ? contracts.mishPackProjectsFileSchema : null,
  };
}

function issueText(error) {
  return error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The entries, `provides` and derived files of one pack made of `units`. `env` and `mcpServers`
 * go in only when asked.
 */
function assemblePack(plan, units, resourceTo, extras) {
  const entries = plan.entries.filter((entry) => units.has(entry.unit));
  const provides = {};
  const resources = [];
  for (const [key, to] of resourceTo) {
    const derived = plan.derived.get(key);
    const rows = derived ? [...derived.rows].filter(([unit]) => units.has(unit)).map(([, row]) => row) : null;
    if (derived && rows.length === 0) continue;
    if (!derived && !entries.some((entry) => entry.resource === key)) continue;
    if (derived) {
      rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const body = { schema: PROJECTS_SCHEMA, projects: rows };
      entries.push({ zipPath: `${derived.to}/${PROJECTS_FILENAME}`, buffer: Buffer.from(`${JSON.stringify(body, null, 2)}\n`), resource: key, unit: key, projectsFile: body });
    }
    setProvides(provides, key, to);
    resources.push(key);
  }
  if (extras.env && Object.keys(extras.env).length > 0) provides.env = extras.env;
  if (extras.mcpServers && extras.mcpServers.length > 0) provides.mcpServers = extras.mcpServers;
  return { entries, provides, resources };
}

/** Refuses a pack the daemon would refuse; returns every entry, the manifest included, in zip order. */
function finalizeManifest(contracts, manifest, entries, plan) {
  if (contracts) {
    const parsed = contracts.manifest.safeParse(manifest);
    if (!parsed.success) return fail(`the manifest would be refused: ${issueText(parsed.error)}`);
    for (const entry of entries) {
      if (!entry.projectsFile || !contracts.projects) continue;
      const projects = contracts.projects.safeParse(entry.projectsFile);
      if (!projects.success) return fail(`${entry.zipPath} would be refused: ${issueText(projects.error)}`);
    }
  } else if (!plan.warnings.some((warning) => warning.startsWith('packages/contracts is not built'))) {
    plan.warn('packages/contracts is not built, so the manifest was not validated here (the daemon validates at install)');
  }
  const all = [...entries, { zipPath: 'mish-pack.json', buffer: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), resource: 'manifest' }];
  for (const entry of all) entry.size = entry.size ?? entry.buffer.length;
  return all.sort((a, b) => (a.zipPath < b.zipPath ? -1 : a.zipPath > b.zipPath ? 1 : 0));
}

async function writeZip(outZip, entries) {
  // Only a file this run creates is ever removed again on failure.
  if (existsSync(outZip)) throw new Error(`${outZip} already exists`);
  const zip = new ZipWriter(outZip);
  try {
    for (const entry of entries) {
      if (entry.buffer) await zip.addBuffer(entry.zipPath, entry.buffer);
      else await zip.addFile(entry.zipPath, entry.absolutePath);
    }
    await zip.finish();
  } catch (error) {
    zip.abort();
    await rm(outZip, { force: true });
    throw error;
  }
  return (await stat(outZip)).size;
}

/**
 * Splits a module's units into parts. A unit's part depends only on its name and the part count, so
 * a unit stays in the same part when the module changes, unlike a split by running size. Parts are
 * sized for 80% of `maxBytes` on average because names spread units unevenly. A module that fits in
 * one pack stays one pack. A unit bigger than the limit on its own gets a warning.
 */
function splitUnits(units, sizes, maxBytes, plan, moduleId) {
  const total = units.reduce((sum, unit) => sum + (sizes.get(unit) ?? 0), 0);
  const count = total <= maxBytes ? 1 : Math.ceil(total / (maxBytes * 0.8));
  const parts = Array.from({ length: count }, () => []);
  for (const unit of units) {
    const size = sizes.get(unit) ?? 0;
    if (size > maxBytes) plan.warn(`${moduleId}: ${unit} alone is ${(size / 1048576).toFixed(1)} MiB, more than --max-bytes`);
    parts[count === 1 ? 0 : createHash('sha256').update(unit).digest().readUInt32BE(0) % count].push(unit);
  }
  if (count > 1) plan.warn(`${moduleId}: split into ${count} parts by unit name; install every part of a module together, and remove the older parts first when the part count changes`);
  return parts;
}

/** Resolves the output path through real folders, so a symlinked checkout cannot hide an output inside it. */
function realOutput(requested) {
  const resolved = path.resolve(requested);
  const parent = existsSync(path.dirname(resolved)) ? realpathSync(path.dirname(resolved)) : path.dirname(resolved);
  return path.join(parent, path.basename(resolved));
}

/** `--split` needs every resource in a module the map lists. Returns the modules in map order. */
function readModules(map) {
  const modules = Array.isArray(map.modules) ? map.modules : [];
  if (modules.length === 0) return fail('--split needs a "modules" list in the map');
  const ids = new Set();
  for (const module of modules) {
    requireString(module.id, '"id" on every module');
    requireString(module.name, `"name" for module ${module.id}`);
    if (!/^[a-z0-9][a-z0-9-]{0,52}$/u.test(module.id)) return fail(`module id ${module.id} is not a pack id (lowercase letters, digits and -)`);
    if (ids.has(module.id)) return fail(`module ${module.id} is listed twice`);
    ids.add(module.id);
  }
  for (const resource of map.resources) {
    if (!ids.has(resource.module)) return fail(`${resource.provides} names module "${resource.module ?? ''}", which the map does not list`);
  }
  return modules;
}

function printPack(pack, dryRun) {
  const size = `${(pack.bytes / 1048576).toFixed(1)} MiB`;
  console.log(`${dryRun ? 'Would pack' : 'Packed'} ${pack.files} files (${size}) as ${pack.id} ${pack.version}${pack.resources ? `: ${pack.resources.join(', ')}` : ''}`);
}

/** Adds the credential-shape report to the warnings once planning is done. */
function noteFlagged(plan) {
  if (plan.flagged.length === 0) return;
  const shown = plan.flagged.slice(0, 10).join(', ');
  plan.warn(`${plan.flagged.length} packed file(s) contain text shaped like a credential; check them before you share the pack: ${shown}${plan.flagged.length > 10 ? ', ...' : ''}`);
}

function printReport(report, plan) {
  for (const item of report) console.log(`  ${item.status.padEnd(8)} ${item.resource}${item.detail ? ` (${item.detail})` : ''}`);
  for (const [reason, names] of plan.skipped) console.log(`  left out: ${reason}: ${names.join(', ')}${names.length >= 5 ? ', ...' : ''}`);
  for (const warning of plan.warnings) console.log(`  note: ${warning}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  if (args.positional.length !== 2) return fail(`expected <sourceRepoDir> <${args.split ? 'outDir' : 'outZip'}>\n${USAGE}`);
  if (!existsSync(args.positional[0])) return fail(`no such folder: ${args.positional[0]}`);
  const source = realpathSync(path.resolve(args.positional[0]));
  const out = realOutput(args.positional[1]);
  try {
    if (lstatSync(out).isSymbolicLink()) return fail('the output may not be a symbolic link');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (isInside(source, out) || out === source) return fail('the output must be outside the source checkout, which is only read');
  if (isInside(realpathSync(repoRoot), out) && !args.dryRun) return fail('write the pack outside this repository: it never holds pack content');
  if (!args.dryRun && existsSync(out)) {
    const emptyFolder = args.split && (await stat(out)).isDirectory() && (await readdir(out)).length === 0;
    if (!emptyFolder) return fail(`${out} already exists`);
  }

  const map = await jsonFile(args.map);
  if (map.schemaVersion !== 1 || !Array.isArray(map.resources)) return fail('the map must have schemaVersion 1 and a "resources" list');
  const modules = args.split ? readModules(map) : null;

  const plan = new Plan();
  /** `provides` key -> where it lands in the pack, for every resource that packed something. */
  const resourceTo = new Map();
  const report = [];
  const cleanup = [];
  const ctx = {
    source,
    plan,
    cleanup,
    provided(resource) {
      resourceTo.set(resource.provides, resource.to);
      report.push({ resource: resource.provides, status: 'packed' });
    },
    /** True (and reported as left out) when `file` may not be read into the pack; see containmentProblem. */
    async uncontained(file, label) {
      const problem = await containmentProblem(plan, source, file);
      if (problem) plan.skip(problem, label);
      return problem !== null;
    },
    missing(resource, what, quiet = false) {
      if (resource.optional === false) fail(`${resource.provides}: ${what} not found in ${source}`);
      if (!quiet) report.push({ resource: resource.provides, status: 'skipped', detail: `${what} not found` });
    },
  };

  try {
    for (const resource of map.resources) {
      const handler = handlers[resource.type];
      if (!handler) return fail(`unknown resource type "${resource.type}" for ${resource.provides}`);
      requireString(resource.provides, '"provides" on every resource');
      requireString(resource.to, `"to" for ${resource.provides}`);
      await handler(ctx, resource);
    }

    noteFlagged(plan);
    const today = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
    const version = args.version ?? map.pack?.version ?? today;
    // The version becomes part of a file name, so it may not carry a path.
    if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(version)) return fail(`the version ${JSON.stringify(version)} may only use letters, digits and . + _ -`);
    const env = map.env && Object.keys(map.env).length > 0 ? map.env : null;
    const mcpServers = Array.isArray(map.mcpServers) && map.mcpServers.length > 0 ? map.mcpServers : null;
    const contracts = await loadContracts();

    if (!modules) {
      const units = new Set(plan.entries.map((entry) => entry.unit));
      for (const key of plan.derived.keys()) units.add(key);
      for (const derived of plan.derived.values()) for (const unit of derived.rows.keys()) units.add(unit);
      const assembled = assemblePack(plan, units, resourceTo, { env, mcpServers });
      const manifest = {
        schemaVersion: 1,
        id: args.id ?? map.pack?.id ?? 'team-packet',
        name: args.name ?? map.pack?.name ?? 'Team packet',
        version,
        ...(map.pack?.description ? { description: map.pack.description } : {}),
        provides: assembled.provides,
      };
      const entries = finalizeManifest(contracts, manifest, assembled.entries, plan);
      const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
      const summary = {
        out: args.dryRun ? null : out,
        id: manifest.id,
        version: manifest.version,
        files: entries.length,
        bytes: totalBytes,
        resources: report,
        skipped: Object.fromEntries(plan.skipped),
        skippedCount: plan.skippedCount ?? 0,
        warnings: plan.warnings,
      };
      if (!args.dryRun) summary.zipBytes = await writeZip(out, entries);
      if (args.json) console.log(JSON.stringify(summary, null, 2));
      else {
        printPack({ id: manifest.id, version: manifest.version, files: entries.length, bytes: totalBytes }, args.dryRun);
        printReport(report, plan);
        if (!args.dryRun) console.log(`Wrote ${out} (${(summary.zipBytes / 1048576).toFixed(1)} MiB)`);
      }
      return;
    }

    // --split: one pack per module, cut into parts where a module is larger than --max-bytes.
    const maxBytes = args.maxBytes ?? DEFAULT_MAX_PACK_BYTES;
    const unitSizes = new Map();
    for (const entry of plan.entries) unitSizes.set(entry.unit, (unitSizes.get(entry.unit) ?? 0) + entry.size);
    const extrasModule = modules.find((module) => module.env === true || module.mcpServers === true)?.id ?? modules[0].id;
    const packs = [];
    for (const module of modules) {
      const moduleResources = map.resources.filter((resource) => resource.module === module.id).map((resource) => resource.provides);
      const units = [];
      for (const key of moduleResources) {
        const own = [...new Set([
          ...plan.entries.filter((entry) => entry.resource === key).map((entry) => entry.unit),
          ...(plan.derived.get(key)?.rows.keys() ?? []),
        ])];
        // Resource order from the map; within a resource, child folders in name order.
        units.push(...own.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      }
      const withExtras = module.id === extrasModule && (env || mcpServers);
      if (units.length === 0 && !withExtras) {
        report.push({ resource: `module ${module.id}`, status: 'skipped', detail: 'nothing to pack' });
        continue;
      }
      const bins = units.length === 0 ? [[]] : splitUnits(units, unitSizes, maxBytes, plan, module.id);
      const firstFilled = Math.max(0, bins.findIndex((bin) => bin.length > 0));
      bins.forEach((bin, index) => {
        if (bin.length === 0 && units.length > 0) return;
        const id = bins.length === 1 ? module.id : `${module.id}-${index + 1}`;
        if (id !== module.id && modules.some((other) => other.id === id)) fail(`part id ${id} is also a module id; rename the module`);
        const name = bins.length === 1 ? module.name : `${module.name} (${index + 1} of ${bins.length})`;
        const first = index === firstFilled;
        const assembled = assemblePack(plan, new Set(bin), resourceTo, {
          env: withExtras && first ? env : null,
          mcpServers: withExtras && first ? mcpServers : null,
        });
        const description = module.description ?? map.pack?.description;
        const manifest = { schemaVersion: 1, id, name, version, ...(description ? { description } : {}), provides: assembled.provides };
        const entries = finalizeManifest(contracts, manifest, assembled.entries, plan);
        packs.push({ id, module: module.id, name, version, file: `${id}-${version}.zip`, entries, resources: assembled.resources, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) });
      });
    }

    if (!args.dryRun) {
      await mkdir(out, { recursive: true });
      for (const pack of packs) {
        const file = path.join(out, pack.file);
        pack.zipBytes = await writeZip(file, pack.entries);
        pack.sha256 = await sha256File(file);
        if (pack.zipBytes > maxBytes) plan.warn(`${pack.file} is ${(pack.zipBytes / 1048576).toFixed(1)} MiB, more than --max-bytes`);
      }
      const inventory = {
        schema: 'mish-pack-inventory/1',
        version,
        packs: packs.map((pack) => ({ id: pack.id, module: pack.module, name: pack.name, version: pack.version, file: pack.file, bytes: pack.zipBytes, sha256: pack.sha256, files: pack.files, resources: pack.resources })),
      };
      await writeFile(path.join(out, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
      const sums = [...packs].sort((a, b) => (a.file < b.file ? -1 : 1)).map((pack) => `${pack.sha256}  ${pack.file}\n`).join('');
      await writeFile(path.join(out, 'SHA256SUMS'), sums);
    }

    const summary = {
      out: args.dryRun ? null : out,
      version,
      maxBytes,
      packs: packs.map((pack) => ({
        id: pack.id, file: pack.file, files: pack.files, bytes: pack.bytes, resources: pack.resources,
        ...(pack.zipBytes !== undefined ? { zipBytes: pack.zipBytes, sha256: pack.sha256 } : {}),
      })),
      resources: report,
      skipped: Object.fromEntries(plan.skipped),
      skippedCount: plan.skippedCount ?? 0,
      warnings: plan.warnings,
    };
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      for (const pack of packs) printPack(pack, args.dryRun);
      printReport(report, plan);
      if (!args.dryRun) {
        for (const pack of packs) console.log(`Wrote ${path.join(out, pack.file)} (${(pack.zipBytes / 1048576).toFixed(1)} MiB)`);
        console.log(`Wrote ${path.join(out, 'SHA256SUMS')} and ${path.join(out, 'inventory.json')}`);
      }
    }
  } finally {
    await Promise.all(cleanup.map((task) => task()));
  }
}

main().catch((error) => {
  console.error(`build-pack: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
