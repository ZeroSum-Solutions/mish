// Mish packs: saved projects.
//
// A pack's `projects` folder holds `projects.json` (the project rows) and one `<id>/` folder per
// row. Activation copies each folder to `<projects dir>/<id>` under its original id and inserts the
// row, but only when neither the folder nor the row exists yet: a project the person already has is
// never replaced. The receipt records each project placed, with a digest of its folder and the row
// as inserted, so removal can tell an untouched copy from one the person worked on:
//   - untouched (same files, same row, no conversation, not moved into a workspace): deleted;
//   - files changed but nothing else: the folder is moved to `<projects dir>/.mish-pack-backups/`
//     and the row is removed, the same backup rule skills and design systems follow;
//   - renamed, chatted in or moved into a workspace: left in place as the person's own project, so
//     no conversation is lost.

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import {
  MISH_PACK_PROJECTS_FILENAME,
  mishPackProjectsFileSchema,
  type MishPackProjectRow,
} from '@mish/contracts';

import { deleteProject, getProject, insertProject } from '../db.js';
import { MishPackError } from './errors.js';

export type ProjectDb = Database.Database;

/** What the receipt keeps for one project the pack placed. */
export interface PackProjectRecord {
  /** `folderDigest` of the folder as placed; null when it could not be read. */
  digest: string | null;
  /** The row as inserted, to notice a rename or any later update. */
  name: string;
  updatedAt: number;
}

export type RetireOutcome =
  | { kind: 'gone' }
  | { kind: 'deleted'; row: MishPackProjectRow | null }
  | { kind: 'held'; path: string; row: MishPackProjectRow | null }
  | { kind: 'kept'; reason: string }
  | { kind: 'backup'; path: string; row: MishPackProjectRow | null };

/** Reads and checks `projects.json` in a pack's projects folder. Throws MISSING_RESOURCE or INVALID_MANIFEST. */
export async function readPackProjectRows(dir: string): Promise<MishPackProjectRow[]> {
  const file = path.join(dir, MISH_PACK_PROJECTS_FILENAME);
  let text: string;
  try {
    const info = await fsp.stat(file);
    if (!info.isFile()) throw new Error('not a file');
    text = await fsp.readFile(file, 'utf8');
  } catch {
    throw new MishPackError('MISSING_RESOURCE', `projects must contain ${MISH_PACK_PROJECTS_FILENAME}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MishPackError('INVALID_MANIFEST', `projects/${MISH_PACK_PROJECTS_FILENAME} is not valid JSON`);
  }
  const parsed = mishPackProjectsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new MishPackError('INVALID_MANIFEST', `projects/${MISH_PACK_PROJECTS_FILENAME} is invalid: ${detail}`);
  }
  return parsed.data.projects;
}

/**
 * Checks `projects.json` and that each row's folder, when the pack has one, is a folder. A row
 * without a folder is a project with no files (a .zip carries no empty folders); it is placed empty.
 * Run at install, before anything is placed.
 */
export async function verifyPackProjects(dir: string): Promise<void> {
  for (const row of await readPackProjectRows(dir)) {
    let info;
    try {
      info = await fsp.lstat(path.join(dir, row.id));
    } catch {
      continue;
    }
    if (!info.isDirectory()) throw new MishPackError('MISSING_RESOURCE', `projects/${row.id} must be a folder`);
  }
}

/**
 * The row to insert, or why the row is skipped. A pack may not point a project at a folder outside
 * it (`baseDir`), and folders it links (`linkedDirs`) name another computer's paths, so they are
 * dropped.
 */
export function prepareProjectRow(row: MishPackProjectRow): { row: MishPackProjectRow; dropped: string[] } | { skip: string } {
  const metadata = row.metadata ?? null;
  if (metadata && Object.hasOwn(metadata, 'baseDir')) return { skip: 'its files live in a folder outside the pack' };
  if (!metadata || !Object.hasOwn(metadata, 'linkedDirs')) return { row, dropped: [] };
  const { linkedDirs: _linked, ...rest } = metadata;
  return { row: { ...row, metadata: rest }, dropped: ['linkedDirs'] };
}

/** True when the person has worked in the project: a conversation, or a workspace binding. */
function hasUserActivity(db: ProjectDb, id: string): boolean {
  const counts = db.prepare(
    `SELECT (SELECT COUNT(*) FROM conversations WHERE project_id = ?) AS conversations,
            (SELECT COUNT(*) FROM workspace_projects WHERE project_id = ?) AS bindings`,
  ).get(id, id) as { conversations: number; bindings: number };
  return counts.conversations > 0 || counts.bindings > 0;
}

export function projectRowExists(db: ProjectDb, id: string): boolean {
  return getProject(db, id) !== null;
}

/** Inserts a project row exactly as the pack carries it (after `prepareProjectRow`). */
export function insertPackProjectRow(db: ProjectDb, row: MishPackProjectRow): void {
  insertProject(db, {
    id: row.id,
    name: row.name,
    skillId: row.skillId ?? null,
    designSystemId: row.designSystemId ?? null,
    pendingPrompt: row.pendingPrompt ?? null,
    metadata: row.metadata ?? null,
    customInstructions: row.customInstructions ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export interface RetireProjectInput {
  db: ProjectDb;
  projectsDir: string;
  id: string;
  record: PackProjectRecord;
  /** `<projects dir>/.mish-pack-backups/<pack>-<stamp>`, created only when a backup is made. */
  backupDir: string;
  digest: (dir: string) => Promise<string | null>;
  /**
   * During a replacement: an untouched project is moved into this folder instead of being deleted,
   * so a failed replacement can put it back.
   */
  holdDir?: string;
}

/** The stored row of a project, in the shape a pack carries, so it can be inserted again. */
function snapshotRow(project: Record<string, unknown> | null): MishPackProjectRow | null {
  if (!project) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const metadata = project.metadata;
  return {
    id: String(project.id),
    name: String(project.name),
    skillId: text(project.skillId),
    designSystemId: text(project.designSystemId),
    pendingPrompt: text(project.pendingPrompt),
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : null,
    customInstructions: text(project.customInstructions),
    createdAt: Number(project.createdAt),
    updatedAt: Number(project.updatedAt),
  };
}

async function moveAside(dir: string, intoDir: string, id: string): Promise<string> {
  await fsp.mkdir(intoDir, { recursive: true });
  let target = path.join(intoDir, id);
  for (let n = 2; await pathExists(target); n += 1) target = path.join(intoDir, `${id}-${n}`);
  await fsp.rename(dir, target);
  return target;
}

/** Takes away one project the pack placed, following the rules at the top of this file. */
export async function retirePackProject(input: RetireProjectInput): Promise<RetireOutcome> {
  const { db, projectsDir, id, record } = input;
  const dir = path.join(projectsDir, id);
  const project = getProject(db, id) as (Record<string, unknown> & { name: string; updatedAt: number }) | null;
  let dirExists = false;
  try {
    dirExists = (await fsp.lstat(dir)).isDirectory();
  } catch {
    dirExists = false;
  }
  if (!project && !dirExists) return { kind: 'gone' };
  if (project && (project.name !== record.name || Number(project.updatedAt) !== record.updatedAt || hasUserActivity(db, id))) {
    return { kind: 'kept', reason: 'it was changed or used after the pack added it' };
  }
  const row = snapshotRow(project);
  const unchanged = !dirExists || (record.digest !== null && (await input.digest(dir)) === record.digest);
  if (unchanged) {
    let held: string | null = null;
    if (dirExists && input.holdDir) held = await moveAside(dir, input.holdDir, id);
    else if (dirExists) await fsp.rm(dir, { recursive: true, force: true });
    if (project) deleteProject(db, id);
    return held ? { kind: 'held', path: held, row } : { kind: 'deleted', row };
  }
  const target = await moveAside(dir, input.backupDir, id);
  if (project) deleteProject(db, id);
  return { kind: 'backup', path: target, row };
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fsp.lstat(file);
    return true;
  } catch {
    return false;
  }
}
