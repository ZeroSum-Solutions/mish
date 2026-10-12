import type Database from 'better-sqlite3';
import { migratePlacementJournal } from './journal.js';
import { migrateSourceRecords } from '../../storage/workbench-source-store.js';
import { migratePlacementAdoption, PLACEMENT_ADOPTION_TABLES } from './adoption-store.js';
import { migratePlacementRootSeals, PLACEMENT_ROOT_SEAL_TABLES } from './root-seal.js';

export class OwnedMigrationError extends Error {
  constructor(readonly reason: 'version-unsupported' | 'unversioned-schema-present' | 'schema-incomplete' | 'durability-unqualified', readonly migration: string) {
    super(`Owned workbench migration refused (${migration}): ${reason}`); this.name = 'OwnedMigrationError';
  }
}

/** Runtime evidence tables owned by the coordinated bootstrap and supervisor. */
export function migratePlacementRuntime(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS placement_runtime_boots (
      incarnation_id TEXT PRIMARY KEY REFERENCES placement_journal_incarnations(id),
      record_json TEXT NOT NULL CHECK(json_valid(record_json))
    );
    CREATE TABLE IF NOT EXISTS placement_launch_observations (
      digest TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES placement_journal_launches(id),
      fact TEXT NOT NULL CHECK(fact IN ('spawn','exit','drain','member','member-exit')),
      observation_json TEXT NOT NULL CHECK(json_valid(observation_json))
    );
  `);
}

interface OwnedMigration { name: string; version: 1; tables: readonly string[]; apply(db: Database.Database, canonicalDataRoot: string): void }
export const OWNED_WORKBENCH_MIGRATIONS: readonly OwnedMigration[] = Object.freeze([
  { name: 'placement-journal', version: 1, tables: ['placement_journal_incarnations', 'placement_journal_current', 'placement_journal_operations', 'placement_journal_launches'], apply: db => migratePlacementJournal(db) },
  { name: 'source-records', version: 1, tables: ['workbench_source_meta', 'workbench_source_records', 'workbench_source_heads'], apply: (db, root) => migrateSourceRecords(db, root) },
  { name: 'placement-runtime', version: 1, tables: ['placement_runtime_boots', 'placement_launch_observations'], apply: db => migratePlacementRuntime(db) },
  { name: 'placement-adoption', version: 1, tables: PLACEMENT_ADOPTION_TABLES, apply: db => migratePlacementAdoption(db) },
  // B4-1b: the clean-shutdown seal's generation and epoch record (root-seal.ts).
  { name: 'placement-root-seal', version: 1, tables: PLACEMENT_ROOT_SEAL_TABLES, apply: db => migratePlacementRootSeals(db) },
]);

/**
 * Versioned registration on the already-owned existing database. Only the
 * coordinated bootstrap calls this, after native ownership. A first unreleased
 * schema has no backfill: tables without a version row (a draft predecessor)
 * refuse, as do unknown versions and partial version-recorded schemas. All
 * registrations commit in one outermost immediate transaction.
 */
export function registerOwnedWorkbenchMigrations(db: Database.Database, canonicalDataRoot: string): { applied: readonly string[] } {
  if (db.inTransaction || db.pragma('journal_mode', { simple: true }) !== 'wal' || Number(db.pragma('synchronous', { simple: true })) < 2 || Number(db.pragma('foreign_keys', { simple: true })) !== 1) throw new OwnedMigrationError('durability-unqualified', 'registry');
  const applied: string[] = [];
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS workbench_owned_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    const tables = () => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    for (const migration of OWNED_WORKBENCH_MIGRATIONS) {
      const row = db.prepare('SELECT version FROM workbench_owned_migrations WHERE name=?').get(migration.name) as { version: number } | undefined;
      const present = tables();
      if (row) {
        if (row.version !== migration.version) throw new OwnedMigrationError('version-unsupported', migration.name);
        if (!migration.tables.every(name => present.has(name))) throw new OwnedMigrationError('schema-incomplete', migration.name);
        migration.apply(db, canonicalDataRoot);
        continue;
      }
      if (migration.tables.some(name => present.has(name))) throw new OwnedMigrationError('unversioned-schema-present', migration.name);
      migration.apply(db, canonicalDataRoot);
      db.prepare('INSERT INTO workbench_owned_migrations VALUES (?,?,?)').run(migration.name, migration.version, Date.now());
      applied.push(migration.name);
    }
  }).immediate();
  return { applied };
}
