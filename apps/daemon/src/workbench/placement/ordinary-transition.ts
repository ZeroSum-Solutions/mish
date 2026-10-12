import Database from 'better-sqlite3';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { inspectPlacementJournalReadOnly } from './journal.js';

export interface SqliteSidecarPresence { wal: boolean; shm: boolean }
export interface OrdinaryTransitionInspection {
  kind: 'no-database' | 'never-activated' | 'inspected' | 'unreadable';
  /** Trusted reason that globally closes ordinary mutations, or null. */
  global: string | null;
  unresolvedLaunches: readonly string[];
  fencedProjectRoots: readonly string[];
  /** Captured WAL/SHM presence around the read-only open (SQLite may need/create SHM). */
  sidecars: { before: SqliteSidecarPresence | null; after: SqliteSidecarPresence | null };
}
function presence(file: string): SqliteSidecarPresence | null {
  const exists = (target: string) => {
    try { lstatSync(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  try { return { wal: exists(`${file}-wal`), shm: exists(`${file}-shm`) }; } catch { return null; }
}

/**
 * Coordinated→ordinary pre-check, before ordinary initialization or project
 * mutation. Opens the existing daemon database strictly read-only; never a
 * mutating open, incarnation or migration. Missing database/tables invent no
 * history. Corrupt, ambiguous or inaccessible state, including an unusable
 * WAL/SHM read path, fails closed globally. Ordinary mode cannot clear any
 * resulting fence; only a later qualified coordinated recovery can.
 */
export function inspectOrdinaryTransition(dataRoot: string): OrdinaryTransitionInspection {
  const file = path.join(dataRoot, 'app.sqlite');
  const empty = { unresolvedLaunches: [], fencedProjectRoots: [] };
  try { lstatSync(file); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'no-database', global: null, ...empty, sidecars: { before: null, after: null } };
    return { kind: 'unreadable', global: `journal-unreadable:${code ?? 'stat'}`, ...empty, sidecars: { before: null, after: null } };
  }
  const before = presence(file);
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const inspection = inspectPlacementJournalReadOnly(db);
    db.close(); db = null;
    const sidecars = { before, after: presence(file) };
    if (inspection.kind === 'absent') return { kind: 'never-activated', global: null, ...empty, sidecars };
    return { kind: 'inspected', global: inspection.unresolvedLaunches.length ? 'launch-unresolved' : null,
      unresolvedLaunches: inspection.unresolvedLaunches, fencedProjectRoots: inspection.fencedProjectRoots, sidecars };
  } catch (error) {
    try { db?.close(); } catch { /* the failure below already closes mutations */ }
    const code = (error as { code?: unknown }).code;
    return { kind: 'unreadable', global: `journal-unreadable:${typeof code === 'string' ? code : 'read'}`, ...empty, sidecars: { before, after: presence(file) } };
  }
}
