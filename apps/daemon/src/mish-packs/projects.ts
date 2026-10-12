// Mish packs: saved projects.
//
// A pack's `projects` folder holds `projects.json` (the project rows) and one `<id>/` folder per
// row. A pack imports each project once: the folder is copied to `<projects dir>/<id>` under its
// original id and the row is inserted, but only when neither the folder nor the row exists yet, so
// a project the person already has is never replaced. A pack never deletes a project: removing or
// replacing the pack leaves every imported project, its files and its row, in place as the
// person's own. That keeps conversations, deployments and anything else that hangs off a project
// out of the pack's reach.

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import {
  MISH_PACK_PROJECTS_FILENAME,
  mishPackProjectsFileSchema,
  type MishPackProjectRow,
} from '@mish/contracts';

import { getProject, insertProject } from '../db.js';
import { MishPackError } from './errors.js';

export type ProjectDb = Database.Database;

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
