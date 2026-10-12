import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCaptureRecord, WORKBENCH_CAPTURE_ID_PATTERN, type CaptureRecord } from '@open-design/contracts';

const MAX_SCANNED = 2_000;

/**
 * Capture records live under the daemon data root the caller passes
 * (RUNTIME_DATA_DIR in the daemon). A project id is hashed, never used as a
 * path segment; capture ids are validated before they touch a path. Records
 * are written once (`wx`) and never rewritten: a capture is immutable.
 */
export function createCaptureStore(dataDir: string) {
  if (!path.isAbsolute(dataDir)) throw new Error('Capture records need an absolute daemon data root');
  const root = path.join(dataDir, 'workbench-capture', 'projects');
  const projectDir = (projectId: string) => path.join(root, createHash('sha256').update(projectId, 'utf8').digest('hex').slice(0, 32));
  const keyFile = (projectId: string, key: string) => path.join(projectDir(projectId), 'keys', `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`);

  async function writeOnce(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    // link-then-unlink would refuse an existing target; rename over an id we just
    // minted cannot collide, and ids are never reused.
    await rename(temp, file);
  }

  async function save(record: CaptureRecord): Promise<void> {
    const valid = parseCaptureRecord(record);
    await writeOnce(path.join(projectDir(valid.projectId), `${valid.id}.json`), valid);
  }

  async function read(projectId: string, captureId: string): Promise<CaptureRecord | null> {
    if (!WORKBENCH_CAPTURE_ID_PATTERN.test(captureId)) return null;
    let text: string;
    try { text = await readFile(path.join(projectDir(projectId), `${captureId}.json`), 'utf8'); } catch { return null; }
    const record = parseCaptureRecord(JSON.parse(text));
    return record.projectId === projectId ? record : null;
  }

  /** Every readable record of a project, newest first; a damaged record is skipped, never repaired silently. */
  async function list(projectId: string): Promise<CaptureRecord[]> {
    let names: string[];
    try { names = await readdir(projectDir(projectId)); } catch { return []; }
    const records: CaptureRecord[] = [];
    for (const name of names.slice(0, MAX_SCANNED)) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!WORKBENCH_CAPTURE_ID_PATTERN.test(id)) continue;
      try { const record = await read(projectId, id); if (record) records.push(record); } catch { /* skipped */ }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async function findByKey(projectId: string, key: string): Promise<{ captureId: string; digest: string } | null> {
    try {
      const value = JSON.parse(await readFile(keyFile(projectId, key), 'utf8')) as { captureId?: unknown; digest?: unknown };
      return typeof value.captureId === 'string' && typeof value.digest === 'string' ? { captureId: value.captureId, digest: value.digest } : null;
    } catch { return null; }
  }

  /** `wx`: a key is never re-pointed at another capture. */
  async function saveKey(projectId: string, key: string, captureId: string, digest: string): Promise<void> {
    const file = keyFile(projectId, key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify({ captureId, digest })}\n`, { mode: 0o600, flag: 'wx' });
  }

  return { save, read, list, findByKey, saveKey };
}
export type CaptureStore = ReturnType<typeof createCaptureStore>;
