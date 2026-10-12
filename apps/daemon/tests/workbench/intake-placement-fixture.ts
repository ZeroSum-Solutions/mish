import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateLibrary } from '../../src/library-store.js';
import { ensureProject, ensureValidatedProjectSubdir } from '../../src/projects.js';
import { createCoordinatedProjectWrites, createFenceOnlyProjectWrites, type PlacementFinalIO, type PlacementProjectWrites } from '../../src/workbench/placement/project-writes.js';
import { PlacementProjectRegistry, type PlacementProjectSource } from '../../src/workbench/placement/project-registry.js';
import { authorizePlacementRecovery, bindPlacementRuntimeOwner, PlacementCoordinationError, PlacementWriteCoordinator } from '../../src/workbench/placement/write-coordinator.js';

/**
 * Intake custody fixture: real SQLite, real managed/imported directories and
 * bytes, the real coordinator, registry and coordinated project writes. The
 * owner binding is synthetic (as in placement/project-writes.test.ts); the
 * actual native owner is exercised by the isolated compiled-daemon proof.
 */
export interface IntakeAuthority {
  rootWrite<T>(work: (finalIO: PlacementFinalIO) => Promise<T>): Promise<T>;
  projectWrites: PlacementProjectWrites;
}

/** Ordinary `not-activated` fence authority: admit at entry, recheck before each final effect. */
export function ordinaryIntakeAuthority(assertMutationAdmissible: (projectId?: string) => void = () => undefined): IntakeAuthority {
  return {
    async rootWrite(work) {
      assertMutationAdmissible();
      const accepted = { active: true };
      const finalIO: PlacementFinalIO = Object.freeze({ assertCurrent: () => {
        if (!accepted.active) throw new PlacementCoordinationError('PERMIT_RELEASED', 'Final I/O is outside its accepted write');
        assertMutationAdmissible();
      } });
      try { return await work(finalIO); } finally { accepted.active = false; }
    },
    projectWrites: createFenceOnlyProjectWrites({ assertMutationAdmissible }),
  };
}

export const intakeRoots: string[] = [];
export function cleanupIntakeRoots(): void { for (const root of intakeRoots.splice(0)) rmSync(root, { recursive: true, force: true }); }
export const ticks = async (count = 20) => { for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve)); };
export async function waitFor(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out waiting for ${label}`);
}
export const outcome = (promise: Promise<unknown>) => Promise.race([
  promise.then(() => 'settled', (error: { code?: string }) => error?.code ?? String(error)),
  new Promise(resolve => setTimeout(() => resolve('pending'), 150)),
]);
/** Every file name below a directory (recursive), for "no bytes landed anywhere" assertions. */
export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.relative(dir, path.join(entry.parentPath, entry.name))).sort();
}

export interface IntakeItemFixtureRow { state: string; error_json: string | null; materializations_json: string; asset_id: string | null }
export interface CoordinatedIntake {
  root: string; projects: string; libraryDir: string; external: string;
  db: Database.Database; sources: Map<string, PlacementProjectSource>;
  registry: PlacementProjectRegistry; coordinator: PlacementWriteCoordinator; projectWrites: PlacementProjectWrites; authority: IntakeAuthority;
  state: { held: boolean; recovery: 'ready' | 'required' };
  imported(id: string, name?: string): string; managed(id: string, create?: boolean): string;
  projectDirectory(id: string, dir: string, finalIO?: PlacementFinalIO): Promise<string>;
  loseRecovery(): void; recover(): void;
  row(batchId: string, fileId: string): IntakeItemFixtureRow; count(table: string): number;
}
export function coordinatedIntake(options: { open?: boolean } = {}): CoordinatedIntake {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'intake-custody-'))); intakeRoots.push(root);
  const projects = path.join(root, 'data', 'projects'), libraryDir = path.join(root, 'data', 'library'), external = path.join(root, 'external');
  mkdirSync(projects, { recursive: true }); mkdirSync(external, { recursive: true });
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrateLibrary(db);
  const sources = new Map<string, PlacementProjectSource>();
  const registry = new PlacementProjectRegistry({ projectsRoot: projects, readProject: id => sources.get(id) ?? null, listProjects: () => [...sources.values()] });
  registry.load();
  const state = { held: true, recovery: 'ready' as 'ready' | 'required' };
  const owner = bindPlacementRuntimeOwner({ canonicalDataRoot: path.join(root, 'owner'), inspect: () => ({ held: state.held, qualified: true }),
    readPreviousIncarnationRecovery: () => { if (state.recovery !== 'ready') throw new Error('unresolved prior launch'); return { blockedProjectRoots: [] }; } });
  const coordinator = new PlacementWriteCoordinator({ owner, ...(options.open === false ? {} : { recovery: authorizePlacementRecovery(owner) }), resolveProjectRoot: registry.resolveProjectRoot, observeProjectRoot: registry.observeProjectRoot });
  registry.attach(coordinator);
  const projectWrites = createCoordinatedProjectWrites({ coordinator, registry });
  /** The frozen daemon-local authority shape: data-root CAS/receipt custody plus the shared project admission. */
  const authority: IntakeAuthority = {
    async rootWrite(work) {
      const permit = await coordinator.acquireMutation({ projectRoots: [] });
      try { return await coordinator.withDataRootWrite(permit, work); } finally { coordinator.releaseMutation(permit); }
    },
    projectWrites,
  };
  const imported = (id: string, name = id) => { const dir = path.join(external, name); mkdirSync(dir, { recursive: true }); sources.set(id, { id, metadata: { baseDir: dir } }); return dir; };
  const managed = (id: string, create = false) => { sources.set(id, { id }); const dir = path.join(projects, id); if (create) mkdirSync(dir, { recursive: true }); return dir; };
  /** Mirrors the route: guarded project-root creation, then the validated folder. */
  const projectDirectory = async (id: string, dir: string, finalIO?: PlacementFinalIO) => {
    const source = sources.get(id); if (!source) throw new Error('Project not found');
    await ensureProject(projects, id, source.metadata, finalIO); finalIO?.assertCurrent();
    return (await ensureValidatedProjectSubdir(projects, id, dir, source.metadata, finalIO)).absDir;
  };
  /** Recovery becomes unresolved: the next coordinator check refuses (503) and closes new admission. */
  const loseRecovery = () => { state.recovery = 'required'; };
  /** Qualified recovery again: reopen admission once every registration drained. */
  const recover = () => { state.recovery = 'ready'; coordinator.openAdmission(authorizePlacementRecovery(owner)); };
  const row = (batchId: string, fileId: string) => db.prepare('SELECT * FROM workbench_intake_items WHERE batch_id = ? AND client_file_id = ?').get(batchId, fileId) as IntakeItemFixtureRow;
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { root, projects, libraryDir, external, db, sources, registry, coordinator, projectWrites, authority, state, imported, managed, projectDirectory, loseRecovery, recover, row, count };
}

export function intakeManifest(destination: { kind: 'pending' } | { kind: 'project'; projectId: string; conversationId?: string; dir?: string } = { kind: 'pending' }, sizes = [3]) {
  return { intakeBatchId: randomUUID(), destination, files: sizes.map((size, order) => ({ clientFileId: randomUUID(), order, filename: order === 0 ? 'héllo.bin' : `file-${order}.bin`, size })) };
}
