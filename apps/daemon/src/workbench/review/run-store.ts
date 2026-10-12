import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { parseReviewRun, WORKBENCH_REVIEW_RUN_ID_PATTERN, type ReviewRun } from '@open-design/contracts';

const MAX_LISTED = 200;
export type ReviewInventoryRecord = { projectKey: string; id: string | null };
export type ReviewRunReadResult = { status: 'found'; run: ReviewRun } | { status: 'missing' | 'corrupt' | 'unavailable' };

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/**
 * Review-run records and their screenshots live under the daemon data root the
 * caller passes (RUNTIME_DATA_DIR in the daemon). The project directory is a
 * hash, so a project id never becomes a path segment; run ids are validated
 * before they touch a path.
 */
export function createReviewRunStore(dataDir: string) {
  if (!path.isAbsolute(dataDir)) throw new Error('Review runs need an absolute daemon data root');
  const root = path.join(dataDir, 'workbench-review', 'runs');
  const projectKey = (projectId: string) => createHash('sha256').update(projectId, 'utf8').digest('hex').slice(0, 32);
  const projectDir = (projectId: string) => path.join(root, projectKey(projectId));
  const checkedId = (runId: string) => { if (!WORKBENCH_REVIEW_RUN_ID_PATTERN.test(runId)) throw new Error('Invalid review run id'); return runId; };

  // Metadata retains ordering without retaining every full run or reparsing its JSON.
  const index = new Map<string, { signature: string; createdAt: string | null }>();
  const pageCache = new Map<string, { signature: string; run: ReviewRun }>();
  const warn = (file: string, error: unknown) => console.warn('[review-store] Unreadable or corrupt review record', file, error);

  async function decode(file: string, projectId?: string, runId?: string): Promise<ReviewRunReadResult> {
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      warn(file, error); return { status: 'unavailable' };
    }
    try {
      const run = parseReviewRun(JSON.parse(text));
      if ((projectId !== undefined && run.projectId !== projectId) || (runId !== undefined && run.id !== runId)) throw new Error('Review record identity mismatch');
      return { status: 'found', run };
    } catch (error) { warn(file, error); return { status: 'corrupt' }; }
  }

  function cache(file: string, signature: string, run: ReviewRun): void {
    pageCache.delete(file);
    pageCache.set(file, { signature, run });
    if (pageCache.size > MAX_LISTED) pageCache.delete(pageCache.keys().next().value!);
  }

  async function save(run: ReviewRun): Promise<void> {
    const valid = parseReviewRun(run);
    const dir = projectDir(valid.projectId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.${valid.id}.${randomUUID()}.tmp`);
    const file = path.join(dir, `${valid.id}.json`);
    try {
      await writeFile(temp, `${JSON.stringify(valid)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
    index.delete(file); pageCache.delete(file);
  }

  async function readResult(projectId: string, runId: string): Promise<ReviewRunReadResult> {
    if (!WORKBENCH_REVIEW_RUN_ID_PATTERN.test(runId)) return { status: 'missing' };
    return decode(path.join(projectDir(projectId), `${runId}.json`), projectId, runId);
  }

  async function read(projectId: string, runId: string): Promise<ReviewRun | null> {
    const result = await readResult(projectId, runId);
    return result.status === 'found' ? result.run : null;
  }

  /** Newest 200 readable records; unchanged history needs metadata stats, not JSON parsing. */
  async function list(projectId: string): Promise<ReviewRun[]> {
    const dir = projectDir(projectId);
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const files = names.filter(name => name.endsWith('.json') && WORKBENCH_REVIEW_RUN_ID_PATTERN.test(name.slice(0, -5))).map(name => path.join(dir, name));
    const present = new Set(files);
    for (const file of index.keys()) if (path.dirname(file) === dir && !present.has(file)) { index.delete(file); pageCache.delete(file); }
    for (const file of files) {
      let signature: string;
      try {
        const info = await stat(file);
        signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      } catch { index.delete(file); pageCache.delete(file); continue; }
      if (index.get(file)?.signature === signature) continue;
      const result = await decode(file, projectId, path.basename(file, '.json'));
      if (result.status === 'unavailable') { index.delete(file); pageCache.delete(file); continue; }
      index.set(file, { signature, createdAt: result.status === 'found' ? result.run.createdAt : null });
      pageCache.delete(file);
      if (result.status === 'found') cache(file, signature, result.run);
    }
    // Snapshot metadata before awaiting page reads: concurrent lists may invalidate the shared index.
    const ordered = files.flatMap(file => {
      const entry = index.get(file);
      return entry?.createdAt != null ? [{ file, ...entry, createdAt: entry.createdAt }] : [];
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const runs: ReviewRun[] = [];
    for (const { file, signature } of ordered) {
      if (runs.length === MAX_LISTED) break;
      const cached = pageCache.get(file);
      let run = cached?.signature === signature ? cached.run : undefined;
      if (!run) {
        const result = await decode(file, projectId, path.basename(file, '.json'));
        if (result.status !== 'found') { index.delete(file); continue; }
        run = result.run;
      }
      cache(file, signature, run);
      // A caller must not mutate a later listing through the cache.
      runs.push(structuredClone(run));
    }
    return runs;
  }

  /** Runs across every project, for restart reconciliation. */
  async function inventory(): Promise<{ runs: ReviewRun[]; unavailable: ReviewInventoryRecord[] }> {
    let dirs: Dirent[];
    try { dirs = await readdir(root, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], unavailable: [] }; throw error; }
    const runs: ReviewRun[] = [];
    const unavailable: ReviewInventoryRecord[] = [];
    for (const entry of dirs) {
      if (!entry.isDirectory() || !/^[0-9a-f]{32}$/u.test(entry.name)) continue;
      const project = await inventoryProject(entry.name);
      runs.push(...project.runs); unavailable.push(...project.unavailable);
    }
    return { runs, unavailable };
  }

  async function inventoryProject(key: string): Promise<{ runs: ReviewRun[]; unavailable: ReviewInventoryRecord[] }> {
    if (!/^[0-9a-f]{32}$/u.test(key)) throw new Error('Invalid review project key');
    let names: string[];
    try { names = await readdir(path.join(root, key)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], unavailable: [] };
      warn(path.join(root, key), error);
      return { runs: [], unavailable: [{ projectKey: key, id: null }] };
    }
    const runs: ReviewRun[] = [];
    const unavailable: ReviewInventoryRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !WORKBENCH_REVIEW_RUN_ID_PATTERN.test(name.slice(0, -5))) continue;
      const record = { projectKey: key, id: name.slice(0, -5) };
      const result = await readInventoryResult(record);
      if (result.status === 'unavailable') unavailable.push(record);
      if (result.status === 'found') runs.push(result.run);
    }
    return { runs, unavailable };
  }

  async function listAll(): Promise<ReviewRun[]> { return (await inventory()).runs; }

  /** Retry an inventory record whose unreadable bytes could not provide a project id. */
  async function readInventoryResult(record: { projectKey: string; id: string }): Promise<ReviewRunReadResult> {
    if (!/^[0-9a-f]{32}$/u.test(record.projectKey)) throw new Error('Invalid review project key');
    const result = await decode(path.join(root, record.projectKey, `${checkedId(record.id)}.json`), undefined, record.id);
    if (result.status === 'found' && projectKey(result.run.projectId) !== record.projectKey) {
      warn(record.id, new Error('Review record project mismatch'));
      return { status: 'corrupt' };
    }
    return result;
  }

  const keyFile = (projectId: string, key: string) => path.join(projectDir(projectId), 'keys', `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`);

  /** The run an Idempotency-Key started, from a per-key index (never limited to the newest listed runs). */
  async function findByKeyResult(projectId: string, key: string): Promise<ReviewRunReadResult> {
    const file = keyFile(projectId, key);
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      warn(file, error); return { status: 'unavailable' };
    }
    try {
      const value: unknown = JSON.parse(text);
      const runId = value && typeof value === 'object' && 'runId' in value ? value.runId : null;
      if (typeof runId !== 'string' || !WORKBENCH_REVIEW_RUN_ID_PATTERN.test(runId)) throw new Error('Invalid review key index');
      const result = await readResult(projectId, runId);
      if (result.status === 'found' || result.status === 'unavailable') return result;
      throw new Error('Review key references a missing or corrupt run');
    } catch (error) {
      warn(file, error);
      // Reads preserve the original link for recovery and never allow key reuse.
      return { status: 'corrupt' };
    }
  }

  async function findByKey(projectId: string, key: string): Promise<ReviewRun | null> {
    const result = await findByKeyResult(projectId, key);
    return result.status === 'found' ? result.run : null;
  }

  /** Records the key → run link; `wx` means a key is never re-pointed at another run. */
  async function saveKey(projectId: string, key: string, runId: string): Promise<void> {
    checkedId(runId);
    const file = keyFile(projectId, key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify({ runId })}\n`, { mode: 0o600, flag: 'wx' });
  }

  function screenshotDir(projectId: string, runId: string): string { return path.join(projectDir(projectId), `${checkedId(runId)}.screens`); }

  /** Writes one viewport PNG and returns its absolute path. */
  async function saveScreenshot(projectId: string, runId: string, width: number, base64: string): Promise<string | null> {
    if (!Number.isInteger(width) || width < 1) return null;
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > MAX_SCREENSHOT_BYTES || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    const dir = screenshotDir(projectId, runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${width}.png`);
    await writeFile(target, bytes, { mode: 0o600 });
    return target;
  }

  return { save, read, readResult, list, listAll, inventory, inventoryProject, readInventoryResult, findByKey, findByKeyResult, saveKey, screenshotDir, saveScreenshot };
}
export type ReviewRunStore = ReturnType<typeof createReviewRunStore>;
