#!/usr/bin/env node
// Builds a Mish pack (.zip) from a private checkout.
//
//   node scripts/build-pack.mjs <sourceRepoDir> <outZip> [--map <file>] [--id <id>] [--name <text>]
//                               [--version <v>] [--dry-run] [--json]
//
// The private checkout is only read. What goes into the pack is decided by a declarative map
// (`scripts/pack-map.json`, or --map for a map you keep private): paths in the checkout, where
// each lands in the pack, and which `provides` key it fills. This repository holds the map and
// this script; it never holds the content the map points at. See docs/packs.md.
//
// Rules the builder enforces:
//   - the output must be outside the source checkout, and must not exist yet;
//   - symbolic links are skipped, never followed; a file reached through a linked folder, or one that
//     resolves outside the source checkout, is left out and reported;
//   - metadata, `.git`, `node_modules` and anything that looks like a credential file are left out
//     and reported;
//   - names the daemon would refuse at install time are left out and reported;
//   - the finished manifest is validated with the same schema the daemon uses (when
//     `packages/contracts` is built), so a pack that would be refused is not written.

import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
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
  /\.(pem|key|p12|pfx|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
];
const CHILD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function fail(message) {
  console.error(`build-pack: ${message}`);
  process.exit(1);
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
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('-')) fail(`unknown option ${arg}`);
    else args.positional.push(arg);
  }
  return args;
}

const USAGE = `Usage: node scripts/build-pack.mjs <sourceRepoDir> <outZip> [options]

Options:
  --map <file>      Mapping file (default: scripts/pack-map.json)
  --id <id>         Pack id (default: from the map)
  --name <text>     Pack name (default: from the map)
  --version <v>     Pack version (default: from the map, else today's date)
  --dry-run         List what would be packed; write nothing
  --json            Print the summary as JSON`;

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

  warn(message) {
    this.warnings.push(message);
  }

  skip(reason, name) {
    const list = this.skipped.get(reason) ?? [];
    if (list.length < 5) list.push(name);
    this.skipped.set(reason, list);
    this.skippedCount = (this.skippedCount ?? 0) + 1;
  }

  addFile(zipPath, absolutePath, size, resource) {
    this.entries.push({ zipPath, absolutePath, size, resource });
  }

  addBuffer(zipPath, buffer, resource) {
    this.entries.push({ zipPath, buffer, size: buffer.length, resource });
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
async function planPath(plan, root, absolute, zipPrefix, resource) {
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) return plan.skip('symbolic link', zipPrefix);
  if (info.isFile()) {
    const name = path.basename(absolute);
    if (SKIP_NAMES.has(name) || name.startsWith('._')) return;
    if (SECRET_NAME.some((pattern) => pattern.test(name))) return plan.skip('looks like a credential file', zipPrefix);
    if (!readableName(name)) return plan.skip('name the daemon refuses', zipPrefix);
    const problem = await containmentProblem(plan, root, absolute);
    if (problem) return plan.skip(problem, zipPrefix);
    return plan.addFile(zipPrefix, absolute, info.size, resource);
  }
  if (!info.isDirectory()) return plan.skip('not a regular file', zipPrefix);
  for (const entry of (await readdir(absolute)).sort()) {
    if (SKIP_NAMES.has(entry) || entry.startsWith('._')) continue;
    await planPath(plan, root, path.join(absolute, entry), `${zipPrefix}/${entry}`, resource);
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
        await planPath(ctx.plan, ctx.source, path.join(base, entry.name), `${resource.to}/${entry.name}`, resource.provides);
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

async function loadContractsValidator() {
  const dist = path.join(repoRoot, 'packages', 'contracts', 'dist', 'index.mjs');
  if (!existsSync(dist)) return null;
  const contracts = await import(pathToFileURL(dist).href);
  return typeof contracts.mishPackManifestSchema?.safeParse === 'function' ? contracts.mishPackManifestSchema : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  if (args.positional.length !== 2) return fail(`expected <sourceRepoDir> <outZip>\n${USAGE}`);
  if (!existsSync(args.positional[0])) return fail(`no such folder: ${args.positional[0]}`);
  const source = realpathSync(path.resolve(args.positional[0]));
  // Compare real paths: a temp folder or a symlinked checkout must not hide an output inside it.
  const outRequested = path.resolve(args.positional[1]);
  const outParent = existsSync(path.dirname(outRequested)) ? realpathSync(path.dirname(outRequested)) : path.dirname(outRequested);
  const outZip = path.join(outParent, path.basename(outRequested));
  if (isInside(source, outZip) || outZip === source) return fail('the output must be outside the source checkout, which is only read');
  if (isInside(realpathSync(repoRoot), outZip) && !args.dryRun) return fail('write the pack outside this repository: it never holds pack content');
  if (!args.dryRun && existsSync(outZip)) return fail(`${outZip} already exists`);

  const map = await jsonFile(args.map);
  if (map.schemaVersion !== 1 || !Array.isArray(map.resources)) return fail('the map must have schemaVersion 1 and a "resources" list');

  const plan = new Plan();
  const provides = {};
  const report = [];
  const cleanup = [];
  const ctx = {
    source,
    plan,
    cleanup,
    provided(resource) {
      const value = resource.to;
      setProvides(provides, resource.provides, value);
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

    if (map.env && Object.keys(map.env).length > 0) provides.env = map.env;
    if (Array.isArray(map.mcpServers) && map.mcpServers.length > 0) provides.mcpServers = map.mcpServers;

    const today = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
    const manifest = {
      schemaVersion: 1,
      id: args.id ?? map.pack?.id ?? 'team-packet',
      name: args.name ?? map.pack?.name ?? 'Team packet',
      version: args.version ?? map.pack?.version ?? today,
      ...(map.pack?.description ? { description: map.pack.description } : {}),
      provides,
    };
    const validator = await loadContractsValidator();
    if (validator) {
      const parsed = validator.safeParse(manifest);
      if (!parsed.success) {
        return fail(`the manifest would be refused: ${parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
      }
    } else {
      plan.warn('packages/contracts is not built, so the manifest was not validated here (the daemon validates at install)');
    }

    plan.addBuffer('mish-pack.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 'manifest');
    plan.entries.sort((a, b) => (a.zipPath < b.zipPath ? -1 : a.zipPath > b.zipPath ? 1 : 0));

    const totalBytes = plan.entries.reduce((sum, entry) => sum + entry.size, 0);
    const summary = {
      out: args.dryRun ? null : outZip,
      id: manifest.id,
      version: manifest.version,
      files: plan.entries.length,
      bytes: totalBytes,
      resources: report,
      skipped: Object.fromEntries(plan.skipped),
      skippedCount: plan.skippedCount ?? 0,
      warnings: plan.warnings,
    };

    if (!args.dryRun) {
      const zip = new ZipWriter(outZip);
      try {
        for (const entry of plan.entries) {
          if (entry.buffer) await zip.addBuffer(entry.zipPath, entry.buffer);
          else await zip.addFile(entry.zipPath, entry.absolutePath);
        }
        await zip.finish();
      } catch (error) {
        zip.abort();
        await rm(outZip, { force: true });
        throw error;
      }
      summary.zipBytes = (await stat(outZip)).size;
    }

    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`${args.dryRun ? 'Would pack' : 'Packed'} ${summary.files} files (${(totalBytes / 1048576).toFixed(1)} MiB) as ${manifest.id} ${manifest.version}`);
      for (const item of report) console.log(`  ${item.status.padEnd(8)} ${item.resource}${item.detail ? ` (${item.detail})` : ''}`);
      for (const [reason, names] of plan.skipped) console.log(`  left out: ${reason}: ${names.join(', ')}${names.length >= 5 ? ', ...' : ''}`);
      for (const warning of plan.warnings) console.log(`  note: ${warning}`);
      if (!args.dryRun) console.log(`Wrote ${outZip} (${(summary.zipBytes / 1048576).toFixed(1)} MiB)`);
    }
  } finally {
    await Promise.all(cleanup.map((task) => task()));
  }
}

main().catch((error) => {
  console.error(`build-pack: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
