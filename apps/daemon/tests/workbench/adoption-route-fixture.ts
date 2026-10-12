import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { PlacementAdoptionExecutor } from '../../src/workbench/placement/adoption-executor.js';
import { CatalogueSavedUnitStore } from '../../src/workbench/adoption/saved-units.js';
import { AdoptionBlobStore } from '../../src/workbench/placement/adoption-files.js';
import type { AdoptionMover } from '../../src/workbench/placement/adoption-mover.js';
import { AdoptionStore, migratePlacementAdoption } from '../../src/workbench/placement/adoption-store.js';
import { migratePlacementJournal, PlacementJournal } from '../../src/workbench/placement/journal.js';
import { createFenceOnlyProjectWrites } from '../../src/workbench/placement/project-writes.js';
import type { PlacementRuntimeStatus } from '../../src/workbench/placement/runtime-status.js';
import { CatalogueAdoptionManager, type CatalogueMaterialSource } from '../../src/workbench/adoption/catalogue-adoption.js';
import type { ResourceSourceAdapter } from '../../src/workbench/resources.js';

/**
 * Real adoption executor over temporary managed projects, with the portable test
 * mover (identity-checked rename) that catalogue-adoption.test.ts uses. Shared by
 * the B7-3 reference-source, Aceternity and owned-import specs. Assertions read
 * bytes on disk, never an HTTP status alone.
 */
export const ENTRY = 'export default function App() { return <main>original</main>; }\n';

export interface AdoptionFixture {
  root: string;
  db: Database.Database;
  projects: Record<string, string>;
  executor: PlacementAdoptionExecutor;
  tree(projectId: string): Record<string, string>;
  storedPlans(): number;
}

export function adoptionFixture(roots: string[], projectIds: readonly string[] = ['p1', 'p2']): AdoptionFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b7-adoption-'))); roots.push(root);
  const projects: Record<string, string> = {};
  for (const id of projectIds) {
    const project = join(root, 'projects', id); projects[id] = project;
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src', 'App.tsx'), ENTRY);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: {} }));
  }
  const db = new Database(join(root, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
  migratePlacementJournal(db); migratePlacementAdoption(db);
  const identity = { device: '1', inode: '2', volumeUUID: '11111111-2222-3333-4444-555555555555' };
  const mover: AdoptionMover = {
    inspectDirectory: async (dir: string) => existsSync(dir) && lstatSync(dir).isDirectory() ? { kind: 'qualified', identity } : { kind: 'unsupported', reason: 'missing' } as never,
    prepare: async ({ source, destination, expected }) => ({ kind: 'ready', move: {
      execute: async intent => {
        await intent();
        if (String(lstatSync(source, { bigint: true }).ino) !== expected.inode) return { kind: 'conflict', invocationId: randomUUID(), reason: 'source', mutation: 'none', observation: null, child: null };
        renameSync(source, destination);
        return { kind: 'observed-move', invocationId: randomUUID(), observation: {} as never, child: { pid: null, exited: true, exitCode: 0, signal: null }, contentVerification: 'required' };
      },
      close: async () => undefined,
    } }),
  };
  const executor = new PlacementAdoptionExecutor({
    journal: new PlacementJournal({ db, incarnationId: `incarnation-${randomUUID()}` }), store: new AdoptionStore(db),
    blobs: new AdoptionBlobStore(join(root, 'work', 'blobs')), mover, workRoot: join(root, 'work'), managedRoot: join(root, 'projects'),
    projectWrites: createFenceOnlyProjectWrites({ assertMutationAdmissible: () => undefined }),
    resolveTarget: projectId => ({ projectId, kind: 'managed', physicalRoot: projects[projectId]!, identity: null, gateKey: projectId }),
  });
  const tree = (id: string) => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = join(dir, name); if (lstatSync(full).isDirectory()) walk(full); else out[relative(projects[id]!, full)] = readFileSync(full, 'utf8'); } };
    walk(projects[id]!); return out;
  };
  const storedPlans = () => (db.prepare('SELECT COUNT(*) AS n FROM placement_adoption_plans').get() as { n: number }).n;
  return { root, db, projects, executor, tree, storedPlans };
}

/** Adoption plus resource routes over real HTTP. `allowed` projects pass the project gate. */
export async function adoptionServer(servers: Server[], f: AdoptionFixture, options: {
  materials?: readonly CatalogueMaterialSource[]; sources: readonly ResourceSourceAdapter[]; allowed?: readonly string[];
  /** Provision saved units under the executor's work root, as the daemon's default catalogue does. */
  savedUnits?: boolean;
}): Promise<string> {
  const app = express(); app.use(express.json({ limit: '4mb' }));
  const allowed = new Set(options.allowed ?? Object.keys(f.projects));
  const authorizeProjectRequest = async (_req: unknown, res: express.Response, projectId: string) => {
    if (allowed.has(projectId)) return true;
    sendApiError(res, 403, 'FORBIDDEN', 'Project scope is not authorized'); return false;
  };
  const placement = { adoption: f.executor, status: () => ({ state: 'ready' }) as unknown as PlacementRuntimeStatus };
  registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {},
    http: { sendApiError }, authorizeProjectRequest: authorizeProjectRequest as never, placement,
    catalogue: new CatalogueAdoptionManager({ executor: f.executor, materials: options.materials ?? [], ...(options.savedUnits ? { savedUnits: new CatalogueSavedUnitStore(f.executor.savedUnitsRoot) } : {}) }),
  });
  registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: authorizeProjectRequest as never, sourcesForRequest: () => options.sources });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(done => server.once('listening', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function closeAll(servers: Server[], roots: string[]): Promise<void> {
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
