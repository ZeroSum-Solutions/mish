/**
 * Reads the private Cult UI Pro source kit (the snapshot of record) and validates it at the
 * boundary. Layout: `registry/index.json` (the full shadcn registry index), `registry/<name>.json`
 * (one fetched item, `files[].content` inline) and `src/<name>/<path>` (a materialized copy).
 *
 * `registry/<name>.json` is authoritative. An item file that is missing, not JSON, or JSON that
 * does not claim to be an item at all (no `name`: an upstream error body, `{}` from an interrupted
 * write) makes that item `pending-fetch` with a warning — the fetcher is rate-limited and fills the
 * snapshot over time. A file that claims to be an item but disagrees with the index (another name,
 * another file list, a file without content) is a fatal issue, as is a `src/` copy that disagrees
 * with its registry item; a missing `src/` copy is only a warning.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface IndexFile { path: string; type: string; target: string }

export interface IndexItem {
  name: string;
  type: string;
  title: string;
  description: string;
  dependencies: string[];
  registryDependencies: string[];
  files: IndexFile[];
  category: string;
  tags: string[];
  useCases: string[];
  style: Record<string, unknown> | null;
  features: string[];
  externalServices: string[];
  envCount: number;
}

export interface FetchedFile extends IndexFile { content: string }

export interface FetchedItem { registrySha256: string; files: FetchedFile[] }

export interface KitSnapshot {
  indexSha256: string;
  items: IndexItem[];
  fetched: Map<string, FetchedItem>;
  /** name → why the item is not usable yet. */
  pending: Map<string, string>;
  issues: string[];
  warnings: string[];
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 over the sorted `<name> <sha256>` lines (LF-terminated) of every fetched item. */
export function snapshotDigest(fetched: ReadonlyMap<string, FetchedItem>): string {
  const lines = [...fetched.entries()]
    .map(([name, item]) => `${name} ${item.registrySha256}\n`)
    .sort();
  return sha256(lines.join(''));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where}: expected a string`);
  return value;
}

function strList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${where}: expected a string array`);
  }
  return [...(value as string[])];
}

/** Registry paths are compared after collapsing repeated slashes (the upstream index has some). */
function safePath(value: unknown, where: string): string {
  const path = str(value, where).replace(/\/{2,}/g, '/');
  if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) {
    throw new Error(`${where}: unsafe path ${JSON.stringify(path)}`);
  }
  return path;
}

function parseIndexFile(value: unknown, where: string): IndexFile {
  if (!isObject(value)) throw new Error(`${where}: expected an object`);
  return {
    path: safePath(value.path, `${where}.path`),
    type: str(value.type, `${where}.type`),
    target: str(value.target ?? '', `${where}.target`),
  };
}

export function parseIndexItem(value: unknown, where: string): IndexItem {
  if (!isObject(value)) throw new Error(`${where}: expected an object`);
  const name = str(value.name, `${where}.name`);
  if (!NAME.test(name)) throw new Error(`${where}.name: invalid item name ${JSON.stringify(name)}`);
  const meta = isObject(value.meta) ? value.meta : {};
  const files = Array.isArray(value.files) ? value.files : [];
  return {
    name,
    type: str(value.type, `${where}.type`),
    title: str(value.title, `${where}.title`),
    description: str(value.description ?? '', `${where}.description`),
    dependencies: strList(value.dependencies, `${where}.dependencies`),
    registryDependencies: strList(value.registryDependencies, `${where}.registryDependencies`),
    files: files.map((f, i) => parseIndexFile(f, `${where}.files[${i}]`)),
    category: str(meta.category ?? '', `${where}.meta.category`),
    tags: strList(meta.tags, `${where}.meta.tags`),
    useCases: strList(meta.useCases, `${where}.meta.useCases`),
    style: isObject(meta.style) ? meta.style : null,
    features: strList(meta.features, `${where}.meta.features`),
    externalServices: strList(meta.externalServices, `${where}.meta.externalServices`),
    envCount: Array.isArray(meta.env) ? meta.env.length : 0,
  };
}

export function parseIndex(value: unknown): IndexItem[] {
  if (!isObject(value) || !Array.isArray(value.items)) throw new Error('registry/index.json: expected { items: [] }');
  const items = value.items.map((item, i) => parseIndexItem(item, `index.items[${i}]`));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.name)) throw new Error(`registry/index.json: duplicate item ${item.name}`);
    seen.add(item.name);
  }
  return items;
}

/** Parses one fetched item and checks it describes the same files as the index. */
export function parseFetchedItem(value: unknown, entry: IndexItem): FetchedFile[] {
  const where = `registry/${entry.name}.json`;
  if (!isObject(value)) throw new Error(`${where}: expected an object`);
  if (value.name !== entry.name) throw new Error(`${where}: name ${JSON.stringify(value.name)} does not match`);
  if (!Array.isArray(value.files)) throw new Error(`${where}: files missing`);
  const files = value.files.map((f, i) => {
    const base = parseIndexFile(f, `${where}.files[${i}]`);
    const content = isObject(f) ? f.content : undefined;
    return { ...base, content: str(content, `${where}.files[${i}].content`) };
  });
  const indexPaths = entry.files.map((f) => f.path).sort().join('\n');
  const itemPaths = files.map((f) => f.path).sort().join('\n');
  if (indexPaths !== itemPaths) throw new Error(`${where}: file list differs from registry/index.json`);
  return files;
}

export function readKit(kitDir: string): KitSnapshot {
  const indexPath = join(kitDir, 'registry', 'index.json');
  if (!existsSync(indexPath)) throw new Error(`No registry index at ${indexPath}`);
  const indexRaw = readFileSync(indexPath);
  const items = parseIndex(JSON.parse(indexRaw.toString('utf8')));
  const snapshot: KitSnapshot = {
    indexSha256: sha256(indexRaw),
    items,
    fetched: new Map(),
    pending: new Map(),
    issues: [],
    warnings: [],
  };
  for (const entry of items) readItem(kitDir, entry, snapshot);
  return snapshot;
}

function readItem(kitDir: string, entry: IndexItem, snapshot: KitSnapshot): void {
  const itemPath = join(kitDir, 'registry', `${entry.name}.json`);
  if (!existsSync(itemPath)) {
    snapshot.pending.set(entry.name, 'registry item not fetched yet');
    return;
  }
  const raw = readFileSync(itemPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    snapshot.pending.set(entry.name, 'registry item file is incomplete or not JSON');
    snapshot.warnings.push(`registry/${entry.name}.json is not valid JSON; treated as pending-fetch`);
    return;
  }
  if (isObject(parsed) && (parsed.name === undefined || parsed.name === '')) {
    if (typeof parsed.error === 'string') {
      // The rate-limited fetcher can save an upstream error body (e.g. a 429) under the item's name.
      snapshot.pending.set(entry.name, 'registry item file holds an upstream error, not the item');
      snapshot.warnings.push(`registry/${entry.name}.json is an upstream error body (${parsed.error}); treated as pending-fetch`);
    } else {
      snapshot.pending.set(entry.name, 'registry item file is incomplete (no item name)');
      snapshot.warnings.push(`registry/${entry.name}.json has no item name; treated as pending-fetch`);
    }
    return;
  }
  try {
    const files = parseFetchedItem(parsed, entry);
    snapshot.fetched.set(entry.name, { registrySha256: sha256(raw), files });
    checkMaterializedCopy(kitDir, entry.name, files, snapshot);
  } catch (error) {
    snapshot.issues.push((error as Error).message);
  }
}

function checkMaterializedCopy(kitDir: string, name: string, files: FetchedFile[], snapshot: KitSnapshot): void {
  for (const file of files) {
    const copy = join(kitDir, 'src', name, file.path);
    if (!existsSync(copy)) {
      snapshot.warnings.push(`src/${name}/${file.path} is not materialized`);
    } else if (sha256(readFileSync(copy)) !== sha256(file.content)) {
      snapshot.issues.push(`src/${name}/${file.path} differs from registry/${name}.json (changed hash)`);
    }
  }
}
