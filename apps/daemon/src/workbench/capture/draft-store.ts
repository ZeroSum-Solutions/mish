import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCaptureDraftRevision, WORKBENCH_CAPTURE_DRAFT_ID_PATTERN, type CaptureDraftRevision } from '@mish/contracts';

const actorKey = (principal: string) => createHash('sha256').update(principal).digest('hex');

/** Immutable request and terminal files. An atomic hard link publishes without replacing a revision. */
export function createCaptureDraftStore(dataDir: string) {
  if (!path.isAbsolute(dataDir)) throw new Error('Draft storage requires the resolved absolute daemon data root');
  const root = path.join(dataDir, 'workbench-capture-drafts');
  const actor = (principal: string) => path.join(root, actorKey(principal));
  const validId = (id: string) => { if (!WORKBENCH_CAPTURE_DRAFT_ID_PATTERN.test(id)) throw new Error('Invalid draft identity'); return id; };
  const revisionFile = (principal: string, id: string, revision: number, terminal = false) => {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid draft revision');
    return path.join(actor(principal), validId(id), `${revision}${terminal ? '.result' : ''}.json`);
  };
  async function once(file: string, value: unknown): Promise<boolean> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    try { await link(temp, file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    finally { await unlink(temp); }
  }
  async function json(file: string): Promise<unknown | null> {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async function read(principal: string, id: string, revision: number): Promise<CaptureDraftRevision | null> {
    if (!WORKBENCH_CAPTURE_DRAFT_ID_PATTERN.test(id) || !Number.isSafeInteger(revision) || revision < 1) return null;
    const request = await json(revisionFile(principal, id, revision));
    if (!request) return null;
    const stored = parseCaptureDraftRevision(await json(revisionFile(principal, id, revision, true)) ?? request);
    if (stored.draftId !== id || stored.revision !== revision) throw new Error('Draft record identity mismatch');
    if (stored.status === 'ready' && createHash('sha256').update(stored.html!).digest('hex') !== stored.outputSha256) throw new Error('Draft output digest mismatch');
    return stored;
  }
  async function revisions(principal: string, id: string): Promise<CaptureDraftRevision[]> {
    if (!WORKBENCH_CAPTURE_DRAFT_ID_PATTERN.test(id)) return [];
    let names: string[];
    try { names = await readdir(path.join(actor(principal), id)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: CaptureDraftRevision[] = [];
    for (const name of names) {
      if (!/^[1-9][0-9]*\.json$/u.test(name)) continue;
      const record = await read(principal, id, Number(name.slice(0, -5)));
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.revision - b.revision);
  }
  async function list(principal: string, projectId: string): Promise<CaptureDraftRevision[]> {
    let names: string[];
    try { names = await readdir(actor(principal)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: CaptureDraftRevision[] = [];
    for (const name of names) {
      if (!WORKBENCH_CAPTURE_DRAFT_ID_PATTERN.test(name)) continue;
      records.push(...(await revisions(principal, name)).filter(record => record.projectId === projectId));
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.revision - a.revision).slice(0, 500);
  }
  const keyFile = (principal: string, key: string) => path.join(actor(principal), 'keys', `${createHash('sha256').update(key).digest('hex')}.json`);
  return {
    read, revisions, list,
    request: (principal: string, record: CaptureDraftRevision) => once(revisionFile(principal, record.draftId, record.revision), parseCaptureDraftRevision(record)),
    complete: (principal: string, record: CaptureDraftRevision) => once(revisionFile(principal, record.draftId, record.revision, true), parseCaptureDraftRevision(record)),
    key: async (principal: string, key: string) => await json(keyFile(principal, key)) as { digest: string; draftId: string; revision: number } | null,
    saveKey: (principal: string, key: string, value: { digest: string; draftId: string; revision: number }) => once(keyFile(principal, key), value),
  };
}
