import { RESOURCE_SOURCE_IDS } from '@open-design/contracts';
import { checkG02ReactReceipt } from './targets/react/receipt.js';
import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { readPackageFile } from './resources-design-systems.js';
import { checkReactTarget, detectProjectTarget } from './targets/react/detect.js';
import path from 'node:path';
import { parseVersion, type InstalledPackage } from './adoption/installed-packages.js';
import type { ComponentTargetFacts } from './component-ranking.js';

/** Async equivalent for root packages, with the same project confinement and name/version checks. */
async function installedPackage(root: string, name: string, fromDir = ''): Promise<InstalledPackage> {
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(name)) return { state: 'unreadable', reason: 'invalid-name' };
  const parts = fromDir ? fromDir.split('/') : [];
  let filename: string | undefined, physical: string | null = null;
  for (let depth = parts.length; depth >= 0; depth--) {
    filename = path.join(root, ...parts.slice(0, depth), 'node_modules', ...name.split('/'), 'package.json');
    physical = await realpath(filename).catch(() => null);
    if (physical) break;
  }
  if (!physical || !filename) return { state: 'absent' };
  if (!physical.startsWith(root + path.sep)) return { state: 'unreadable', reason: 'escapes-project' };
  const bytes = await readPackageFile(root, path.relative(root, physical));
  if (!bytes || await realpath(filename).catch(() => null) !== physical) return { state: 'unreadable', reason: 'io' };
  try {
    const manifest: unknown = JSON.parse(bytes.toString('utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { state: 'unreadable', reason: 'invalid-manifest' };
    const record = manifest as { name?: unknown; version?: unknown };
    if (record.name !== name) return { state: 'unreadable', reason: 'name-mismatch' };
    const version = typeof record.version === 'string' ? record.version : '';
    const parsed = parseVersion(version);
    return parsed ? { state: 'resolved', version, major: parsed[0] } : { state: 'unreadable', reason: 'invalid-version' };
  } catch { return { state: 'unreadable', reason: 'invalid-manifest' }; }
}
/** Bounded, short-lived picker cache; mutation checks always bypass it. Failed reads are evicted. */
export function createComponentTargetReader({ observe = readComponentTarget, now = Date.now, ttlMs = 1000, maxEntries = 128 }: { observe?: typeof readComponentTarget; now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
  const cache = new Map<string, { expires: number; value: Promise<ComponentTargetFacts | null> }>();
  return (root: string | null, fresh = false): Promise<ComponentTargetFacts | null> => {
    if (!root) return Promise.resolve(null);
    if (fresh) { cache.delete(root); return observe(root); }
    const entry = cache.get(root);
    if (entry && entry.expires > now()) return entry.value;
    cache.delete(root);
    if (maxEntries < 1) return observe(root);
    while (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
    const value = observe(root);
    const next = { expires: now() + ttlMs, value };
    cache.set(root, next);
    void value.catch(() => { if (cache.get(root) === next) cache.delete(root); });
    return value;
  };
}
/** Read-only root-target observation. Nested packages remain unknown until Apply checks their exact entry. */
export async function readComponentTarget(root: string | null, fromDir = ''): Promise<ComponentTargetFacts | null> {
  if (!root) return null;
  root = await realpath(root).catch(() => null);
  if (!root) return null;
  if (fromDir && (path.isAbsolute(fromDir) || fromDir.includes('\\') || fromDir.split('/').some(part => !part || part === '..' || part === '.'))) return null;
  const directory = await realpath(path.join(root, fromDir)).catch(() => null);
  if (!directory || directory !== root && !directory.startsWith(root + path.sep)) return null;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const htmlNames = entries.length <= 512 ? entries.filter(entry => entry.isFile() && /\.html?$/iu.test(entry.name)).map(entry => entry.name).sort().slice(0, 32) : [];
  const [bytes, tsconfig, ...htmlFiles] = await Promise.all(['package.json', 'tsconfig.json', ...htmlNames].map(file => readPackageFile(root, fromDir ? `${fromDir}/${file}` : file)));
  const html = htmlFiles.some(file => !!file);
  let manifest: Record<string, unknown> | null = null;
  if (bytes) {
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      manifest = parsed as Record<string, unknown>;
    } catch { return null; }
  }
  const profile = detectProjectTarget(manifest, { tsconfig: !!tsconfig });
  const dependencyDigest = createHash('sha256').update(JSON.stringify([fromDir, bytes?.toString('base64') ?? null, !!tsconfig, !!html])).digest('hex');
  if (profile.framework === 'none') return { target: html ? 'html' : null, targets: html ? ['html'] : [], verified: html, dependencyDigest };
  const [react, reactDom] = await Promise.all(['react', 'react-dom'].map(name => installedPackage(root!, name, fromDir)));
  const installed = { react: react!, reactDom: reactDom! };
  const packages: Record<string, string> = {};
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const values = manifest?.[section];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    // Bound root discovery. A larger dependency set stays unknown rather than doing unbounded work.
    const names = Object.keys(values);
    if (names.length > 256) return { target: null, verified: false, dependencyDigest };
    for (const name of names) {
      const found = await installedPackage(root, name, fromDir);
      if (found.state === 'resolved') packages[name] = found.version;
    }
  }
  const result = checkReactTarget(manifest, { tsconfig: !!tsconfig, installed });
  // shadcn uses the existing catalogue-files adapter; G02 governs react-source/v1 sources.
  return { target: result.ok ? 'react' : html ? 'html' : null, targets: [...(html ? ['html' as const] : []), ...(result.ok ? ['react' as const] : [])], verified: result.ok || html, packages, adapterSources: result.ok ? RESOURCE_SOURCE_IDS.filter(sourceId => sourceId === 'shadcn' || checkG02ReactReceipt(result.profile.reactMajor, sourceId).ok) : [], dependencyDigest: createHash('sha256').update(JSON.stringify([dependencyDigest, installed, packages])).digest('hex') };
}

export interface ComponentGateTarget { entryPath?: string | undefined; targetDir?: string | undefined }
/** Fresh nearest-manifest observation for the exact insertion directory; never a picker-cache read. */
export async function readComponentTargetForEntry(root: string | null, target: ComponentGateTarget = {}): Promise<ComponentTargetFacts | null> {
  if (!root) return null;
  root = await realpath(root).catch(() => null);
  if (!root) return null;
  const dir = target.targetDir ?? (target.entryPath ? path.posix.dirname(target.entryPath).replace(/^\.$/u, '') : '');
  if (path.isAbsolute(dir) || dir.includes('\\') || dir && dir.split('/').some(part => !part || part === '..' || part === '.')) return null;
  const parts = dir ? dir.split('/') : [];
  for (let depth = parts.length; depth >= 0; depth--) {
    const relative = parts.slice(0, depth).join('/');
    const file = relative ? `${relative}/package.json` : 'package.json';
    const present = await lstat(path.join(root, file)).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? false : null);
    if (present === null) return null;
    if (present) return await readPackageFile(root, file) ? readComponentTarget(root, relative) : null;
  }
  return readComponentTarget(root, dir);
}
