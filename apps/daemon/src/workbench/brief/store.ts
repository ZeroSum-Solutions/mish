import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DesignBrief, DesignBriefRecordView } from '@open-design/contracts';

/** Persisted record. Revisions are immutable files beside it. */
export interface StoredBriefRecord {
  id: string;
  projectId: string;
  status: DesignBriefRecordView['status'];
  originalText: string;
  failure: DesignBriefRecordView['failure'];
  revisions: number[];
  /** Requested and CLI-reported model of the transformer turn; absent on records written before R15-1. */
  transformer?: DesignBriefRecordView['transformer'];
  createdAt: string;
  updatedAt: string;
}

const ID = /^brief_[a-f0-9]{32}$/u;

/**
 * File store under the daemon data root (`<dataDir>/workbench/briefs/<id>/`).
 * The caller passes the resolved RUNTIME_DATA_DIR; this module never derives a
 * data path of its own.
 */
export function createBriefStore(dataDir: string) {
  const root = path.join(dataDir, 'workbench', 'briefs');
  const dirOf = (id: string) => {
    if (!ID.test(id)) return null;
    return path.join(root, id);
  };
  async function atomicWrite(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, file);
  }
  async function readJson<T>(file: string): Promise<T | null> {
    try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return null; }
  }
  return {
    isId: (id: string) => ID.test(id),
    async readRecord(id: string): Promise<StoredBriefRecord | null> {
      const dir = dirOf(id); return dir ? readJson<StoredBriefRecord>(path.join(dir, 'record.json')) : null;
    },
    async writeRecord(record: StoredBriefRecord): Promise<void> {
      const dir = dirOf(record.id); if (!dir) throw new Error('Invalid brief id');
      await atomicWrite(path.join(dir, 'record.json'), record);
    },
    async readRevision(id: string, revision: number): Promise<DesignBrief | null> {
      const dir = dirOf(id); if (!dir || !Number.isSafeInteger(revision) || revision < 1) return null;
      return readJson<DesignBrief>(path.join(dir, `revision-${revision}.json`));
    },
    async writeRevision(brief: DesignBrief): Promise<void> {
      const dir = dirOf(brief.id); if (!dir) throw new Error('Invalid brief id');
      await atomicWrite(path.join(dir, `revision-${brief.revision}.json`), brief);
    },
  };
}
export type BriefStore = ReturnType<typeof createBriefStore>;
