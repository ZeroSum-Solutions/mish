import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseReusableUnitManifest, WORKBENCH_UNIT_ID_PATTERN, type ReusableUnitManifest } from '@mish/contracts';

const SHA256 = /^[a-f0-9]{64}$/u;
export const unitObjectId = (sha256: string) => `unit-object:${sha256}`;

/**
 * Reusable units live under the daemon data root the caller passes
 * (RUNTIME_DATA_DIR in the daemon): content-addressed objects shared by
 * every unit, and immutable per-principal manifests. A principal or key never
 * becomes a path segment (both are hashed); unit ids are validated first.
 */
export function createUnitStore(dataDir: string) {
  if (!path.isAbsolute(dataDir)) throw new Error('Reusable units need an absolute daemon data root');
  const root = path.join(dataDir, 'workbench-units');
  const objects = path.join(root, 'objects');
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
  const principalDir = (principalId: string) => path.join(root, 'principals', hash(principalId));
  const unitDir = (principalId: string, unitId: string) => {
    if (!WORKBENCH_UNIT_ID_PATTERN.test(unitId)) throw new Error('Invalid unit id');
    return path.join(principalDir(principalId), 'units', unitId);
  };

  async function writeNew(file: string, bytes: Buffer | string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  }

  /** Stores bytes once by content; an existing object is verified, never overwritten. */
  async function putObject(bytes: Buffer): Promise<string> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = path.join(objects, sha256.slice(0, 2), sha256);
    try {
      const existing = await readFile(file);
      if (createHash('sha256').update(existing).digest('hex') === sha256) return sha256;
    } catch { /* not stored yet */ }
    await writeNew(file, bytes);
    return sha256;
  }

  async function readObject(sha256: string): Promise<Buffer | null> {
    if (!SHA256.test(sha256)) return null;
    try {
      const bytes = await readFile(path.join(objects, sha256.slice(0, 2), sha256));
      return createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : null;
    } catch { return null; }
  }

  async function saveManifest(manifest: ReusableUnitManifest): Promise<void> {
    const valid = parseReusableUnitManifest(manifest);
    const file = path.join(unitDir(valid.principalId, valid.unitId), `r${valid.revision}.json`);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(valid)}\n`, { mode: 0o600, flag: 'wx' });
  }

  async function readManifest(principalId: string, unitId: string): Promise<ReusableUnitManifest | null> {
    if (!WORKBENCH_UNIT_ID_PATTERN.test(unitId)) return null;
    let names: string[];
    try { names = await readdir(unitDir(principalId, unitId)); } catch { return null; }
    const latest = names.map(name => /^r([1-9][0-9]{0,8})\.json$/u.exec(name)?.[1]).filter((value): value is string => value !== undefined).map(Number).sort((a, b) => b - a)[0];
    if (latest === undefined) return null;
    const manifest = parseReusableUnitManifest(JSON.parse(await readFile(path.join(unitDir(principalId, unitId), `r${latest}.json`), 'utf8')));
    return manifest.principalId === principalId ? manifest : null;
  }

  async function list(principalId: string): Promise<ReusableUnitManifest[]> {
    let ids: string[];
    try { ids = await readdir(path.join(principalDir(principalId), 'units')); } catch { return []; }
    const units: ReusableUnitManifest[] = [];
    for (const id of ids.slice(0, 1_000)) {
      try { const unit = await readManifest(principalId, id); if (unit) units.push(unit); } catch { /* damaged record skipped */ }
    }
    return units.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  }

  const keyFile = (principalId: string, key: string) => path.join(principalDir(principalId), 'keys', `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`);
  async function findByKey(principalId: string, key: string): Promise<{ unitId: string; digest: string } | null> {
    try {
      const value = JSON.parse(await readFile(keyFile(principalId, key), 'utf8')) as { unitId?: unknown; digest?: unknown };
      return typeof value.unitId === 'string' && typeof value.digest === 'string' ? { unitId: value.unitId, digest: value.digest } : null;
    } catch { return null; }
  }
  async function saveKey(principalId: string, key: string, unitId: string, digest: string): Promise<void> {
    const file = keyFile(principalId, key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify({ unitId, digest })}\n`, { mode: 0o600, flag: 'wx' });
  }

  /** A private, throwaway directory for rendering a unit's stored files. */
  async function stage(files: Array<{ path: string; bytes: Buffer }>): Promise<{ dir: string; dispose(): Promise<void> }> {
    const dir = path.join(root, 'staging', randomUUID());
    for (const file of files) {
      const target = path.join(dir, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { mode: 0o600, flag: 'wx' });
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
  }

  return { putObject, readObject, saveManifest, readManifest, list, findByKey, saveKey, stage };
}
export type UnitStore = ReturnType<typeof createUnitStore>;
