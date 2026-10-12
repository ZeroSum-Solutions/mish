import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ResourceRef } from '@mish/contracts';
import { createComponentGateForRequest } from '../../src/workbench/component-gate.js';
import { readComponentTargetForEntry } from '../../src/workbench/component-target.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';
import { PlacementAdoptionExecutor } from '../../src/workbench/placement/adoption-executor.js';
import { AdoptionBlobStore } from '../../src/workbench/placement/adoption-files.js';
import type { AdoptionMover } from '../../src/workbench/placement/adoption-mover.js';
import { AdoptionStore, migratePlacementAdoption } from '../../src/workbench/placement/adoption-store.js';
import { migratePlacementJournal, PlacementJournal } from '../../src/workbench/placement/journal.js';
import { createFenceOnlyProjectWrites } from '../../src/workbench/placement/project-writes.js';
import type { PlacementRuntimeStatus } from '../../src/workbench/placement/runtime-status.js';
import { resourceRefKey } from '../../src/workbench/context-ranking.js';
import { CatalogueAdoptionManager, type CatalogueMaterialSource } from '../../src/workbench/adoption/catalogue-adoption.js';
import { createSelectedShadcnResourceSource, createShadcnCatalogueMaterials } from '../../src/workbench/adoption/shadcn-material.js';

/**
 * AC-R04.3 / AC-R04.4 at the daemon and HTTP/od boundary. One selected
 * shadcn item goes through the existing shadcn importer's resolution (with an
 * injected registry fetch), the catalogue adoption manager and U5's F5
 * executor. The mover is the portable test double (plain rename after an
 * identity check); the native exclusive move is proved by
 * placement-adoption.test.ts. Every assertion that matters reads bytes on
 * disk, never an HTTP status alone.
 */
const BUTTON_V1 = 'import { cn } from "@/lib/utils";\nexport function Button() {\n  return <button className={cn("btn")}>v1</button>;\n}\n';
const BUTTON_V2 = 'import { cn } from "@/lib/utils";\nexport function Button() {\n  return <button className={cn("btn", "btn-v2")}>v2</button>;\n}\n';
const UTILS = 'export function cn(...parts: string[]) { return parts.join(" "); }\n';
const ENTRY = 'export default function App() { return <main>original</main>; }\n';
const SATISFIED = { dependencies: { '@radix-ui/react-slot': '^1.1.0', 'class-variance-authority': '^0.7.1', clsx: '^2.1.1', 'tailwind-merge': '^3.0.0' } };
const BUTTON_URL = 'https://registry.example.com/r/button.json';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registry() {
  const state = { button: BUTTON_V1 };
  const documents = (): Record<string, unknown> => ({
    [BUTTON_URL]: { name: 'button', type: 'registry:ui', dependencies: ['@radix-ui/react-slot', 'class-variance-authority'], registryDependencies: ['utils'], files: [{ path: 'registry/ui/button.tsx', type: 'registry:ui', content: state.button }] },
    'https://registry.example.com/r/utils.json': { name: 'utils', type: 'registry:lib', dependencies: ['clsx', 'tailwind-merge@^3.0.0'], files: [{ path: 'registry/lib/utils.ts', type: 'registry:lib', content: UTILS }] },
  });
  const fetchImpl = async (url: string) => {
    const doc = documents()[url];
    return doc === undefined
      ? { ok: false, status: 404, statusText: 'Not Found', text: async () => '' }
      : { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(doc) };
  };
  return { state, fetchImpl };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'catalogue-adoption-'))); roots.push(root);
  const projects: Record<string, string> = {};
  for (const id of ['p1', 'p2', 'pmissing']) {
    const project = join(root, 'projects', id); projects[id] = project;
    mkdirSync(join(project, 'src', 'components', 'ui'), { recursive: true }); mkdirSync(join(project, 'src', 'lib'), { recursive: true });
    writeFileSync(join(project, 'src', 'App.tsx'), ENTRY);
    writeFileSync(join(project, 'package.json'), JSON.stringify(id === 'pmissing' ? { dependencies: { '@radix-ui/react-slot': '^1.1.0', clsx: '^2.1.1', 'tailwind-merge': '^2.5.0' } } : SATISFIED));
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
  const reg = registry();
  const shadcn = createShadcnCatalogueMaterials({ fetchImpl: reg.fetchImpl, items: [{ itemId: 'button', reference: BUTTON_URL, title: 'Button', packageName: 'shadcn/ui', licence: { spdx: 'MIT', notice: 'MIT License. Copyright (c) 2023 shadcn. Permission is hereby granted, free of charge, …' } }] });
  const manager = new CatalogueAdoptionManager({ executor, materials: [shadcn] });
  const tree = (id: string) => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = join(dir, name); if (lstatSync(full).isDirectory()) walk(full); else out[relative(projects[id]!, full)] = readFileSync(full, 'utf8'); } };
    walk(projects[id]!); return out;
  };
  const storedPlans = () => (db.prepare('SELECT COUNT(*) AS n FROM placement_adoption_plans').get() as { n: number }).n;
  return { root, projects, executor, manager, shadcn, registry: reg, tree, storedPlans };
}
async function currentRefKey(source: CatalogueMaterialSource, itemId: string): Promise<string> {
  const material = await source.materialize(itemId);
  if (!material) throw new Error('material missing');
  return resourceRefKey(material.ref);
}
const request = (projectId: string, refKey: string, extra: Record<string, unknown> = {}) => ({ projectId, refKey, entryPath: 'src/App.tsx', ...extra });

describe('AC-R04.3 apply from the catalogue', () => {
  it('apply saves permitted dependencies and assets locally, reports missing or incompatible dependencies, and supports undo', async () => {
    const f = fixture();
    const refKey = await currentRefKey(f.shadcn, 'button');

    const before = f.tree('pmissing');
    const refusal = await f.manager.prepare('local-owner', request('pmissing', refKey)).catch(error => error);
    expect(refusal).toMatchObject({ status: 422, reason: 'dependencies-unsatisfied' });
    expect(refusal.details.missing).toEqual([{ name: 'class-variance-authority', range: '*' }]);
    expect(refusal.details.incompatible).toEqual([{ name: 'tailwind-merge', required: '^3.0.0', installed: '^2.5.0' }]);
    expect(f.tree('pmissing')).toEqual(before);
    expect(f.storedPlans()).toBe(0);

    const { plan, catalogue } = await f.manager.prepare('local-owner', request('p1', refKey));
    expect(plan.writes.map(w => [w.path, w.kind, w.after.role])).toEqual([
      ['src/components/ui/button.tsx', 'create', 'source'],
      ['src/lib/utils.ts', 'create', 'source'],
      ['src/components/ui/NOTICE.shadcn-button.md', 'create', 'notice'],
      ['src/App.tsx', 'replace', 'entry'],
    ]);
    expect(plan.source).toMatchObject({ implementationOrigin: 'official', terms: { version: 'MIT' }, resourceRef: { sourceId: 'shadcn', itemId: 'button' } });
    expect(catalogue).toMatchObject({ identity: { sourceId: 'shadcn', itemId: 'button', packageName: 'shadcn/ui', licence: 'MIT' }, notices: ['src/components/ui/NOTICE.shadcn-button.md'] });
    expect(catalogue.dependencies.satisfied.map((d: { name: string }) => d.name).sort()).toEqual(['@radix-ui/react-slot', 'class-variance-authority', 'clsx', 'tailwind-merge']);

    const applied = await f.executor.apply('local-owner', { planId: plan.id, planDigest: plan.digest });
    expect(applied).toMatchObject({ kind: 'apply', state: 'done' });
    const after = f.tree('p1');
    expect(after['src/components/ui/button.tsx']).toBe(BUTTON_V1);
    expect(after['src/lib/utils.ts']).toBe(UTILS);
    expect(after['src/components/ui/NOTICE.shadcn-button.md']).toContain('MIT License');
    expect(after['src/components/ui/NOTICE.shadcn-button.md']).toContain(BUTTON_URL);
    expect(after['src/App.tsx']).toContain(ENTRY);
    expect(after['src/App.tsx']).toContain('od:adopted shadcn/button');

    expect(await f.executor.undo('local-owner', applied.operationId)).toMatchObject({ kind: 'undo', state: 'done' });
    const restored = f.tree('p1');
    expect(restored['src/App.tsx']).toBe(ENTRY);
    expect(Object.keys(restored).sort()).toEqual(['package.json', 'src/App.tsx']);
  });

  it('a stale source shows a diff before replacement', async () => {
    const f = fixture();
    const v1 = await currentRefKey(f.shadcn, 'button');
    const first = await f.manager.prepare('local-owner', request('p1', v1));
    await f.executor.apply('local-owner', { planId: first.plan.id, planDigest: first.plan.digest });

    f.registry.state.button = BUTTON_V2;
    const stale = await f.manager.prepare('local-owner', request('p1', v1)).catch(error => error);
    expect(stale).toMatchObject({ status: 409, reason: 'resource-ref-stale' });
    const v2 = await currentRefKey(f.shadcn, 'button');
    expect(stale.details.currentRefKey).toBe(v2);

    const snapshot = f.tree('p1');
    const review = await f.manager.prepare('local-owner', request('p1', v2)).catch(error => error);
    expect(review).toMatchObject({ status: 409, reason: 'replacement-review-required' });
    // The previous revision's notice differs from the new one, so it is reviewed with the source file.
    expect(review.details.review.files.map((file: { path: string }) => file.path)).toEqual(['src/components/ui/button.tsx', 'src/components/ui/NOTICE.shadcn-button.md']);
    const diff: string = review.details.review.files[0].diff;
    expect(diff).toContain('-  return <button className={cn("btn")}>v1</button>;');
    expect(diff).toContain('+  return <button className={cn("btn", "btn-v2")}>v2</button>;');
    expect(f.tree('p1')).toEqual(snapshot);

    await expect(f.manager.prepare('local-owner', request('p1', v2, { acceptReplacement: 'f'.repeat(64) }))).rejects.toMatchObject({ status: 409, reason: 'replacement-review-required' });
    const accepted = await f.manager.prepare('local-owner', request('p1', v2, { acceptReplacement: review.details.review.replacementDigest }));
    expect(accepted.plan.writes.find(w => w.path === 'src/components/ui/button.tsx')).toMatchObject({ kind: 'replace' });
    const replaced = await f.executor.apply('local-owner', { planId: accepted.plan.id, planDigest: accepted.plan.digest });
    expect(f.tree('p1')['src/components/ui/button.tsx']).toBe(BUTTON_V2);
    await f.executor.undo('local-owner', replaced.operationId);
    expect(f.tree('p1')).toEqual(snapshot);
  });

  it('a user-edited licence notice is reviewed before it is replaced', async () => {
    const f = fixture();
    const refKey = await currentRefKey(f.shadcn, 'button');
    const first = await f.manager.prepare('local-owner', request('p1', refKey));
    await f.executor.apply('local-owner', { planId: first.plan.id, planDigest: first.plan.digest });
    const noticePath = join(f.projects.p1!, 'src', 'components', 'ui', 'NOTICE.shadcn-button.md');
    writeFileSync(noticePath, `${readFileSync(noticePath, 'utf8')}\nLocal note kept by the user.\n`);
    const snapshot = f.tree('p1');

    const review = await f.manager.prepare('local-owner', request('p1', refKey)).catch(error => error);
    expect(review).toMatchObject({ status: 409, reason: 'replacement-review-required' });
    expect(review.details.review.files.map((file: { path: string }) => file.path)).toEqual(['src/components/ui/NOTICE.shadcn-button.md']);
    expect(review.details.review.files[0].diff).toContain('-Local note kept by the user.');
    expect(f.tree('p1')).toEqual(snapshot);
    const accepted = await f.manager.prepare('local-owner', request('p1', refKey, { acceptReplacement: review.details.review.replacementDigest }));
    expect(accepted.plan.writes.find(w => w.path === 'src/components/ui/NOTICE.shadcn-button.md')).toMatchObject({ kind: 'replace' });
  });
});

describe('shadcn registry dependency closure', () => {
  const doc = (name: string, deps: string[]) => ({ name, type: 'registry:lib', dependencies: [], registryDependencies: deps, files: [{ path: `registry/lib/${name}.ts`, type: 'registry:lib', content: `export const ${name.replace(/-/gu, '_')} = 1;\n` }] });
  const serve = (documents: Record<string, unknown>) => async (url: string) => {
    const found = documents[url];
    return found === undefined ? { ok: false, status: 404, statusText: 'Not Found', text: async () => '' } : { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(found) };
  };
  const at = (name: string) => `https://registry.example.com/r/${name}.json`;
  const select = (fetchImpl: ReturnType<typeof serve>) => createShadcnCatalogueMaterials({ fetchImpl, items: [{ itemId: 'button', reference: at('button'), title: 'Button', packageName: 'shadcn/ui', licence: { spdx: 'MIT', notice: 'MIT' } }] });

  it('saves dependencies of dependencies, so no applied file imports a helper that was left behind', async () => {
    const material = await select(serve({ [at('button')]: { ...doc('button', ['utils']), type: 'registry:ui' }, [at('utils')]: doc('utils', ['tokens']), [at('tokens')]: doc('tokens', []) })).materialize('button');
    expect(material!.files.map(file => file.path)).toEqual(['lib/button.ts', 'lib/utils.ts', 'lib/tokens.ts']);
  });

  it('refuses an item whose registry closure exceeds the bound with a typed 422 instead of dropping files', async () => {
    const names = Array.from({ length: 11 }, (_, index) => `dep-${index}`);
    const documents: Record<string, unknown> = { [at('button')]: doc('button', names) };
    for (const name of names) documents[at(name)] = doc(name, []);
    const result = await select(serve(documents)).materialize('button').then(value => value, error => error);
    expect(result).toMatchObject({ status: 422, reason: 'registry-closure-too-large' });
  });
});

describe('AC-R04.4 catalogue admission boundaries', () => {
  it('restricted and reference-only sources cannot be prepared, while listing them still works', async () => {
    const f = fixture();
    const reactBits: ResourceRef = { sourceType: 'reference', sourceId: 'react-bits', itemId: 'blur-text', revisionOrDigest: 'sha256:abc' };
    await expect(f.manager.prepare('local-owner', request('p1', resourceRefKey(reactBits)))).rejects.toMatchObject({ status: 422, reason: 'reference-only' });
    const referenceOnly: CatalogueMaterialSource = {
      sourceId: 'gsap',
      async materialize(itemId) {
        return { ref: { sourceType: 'reference', sourceId: 'gsap', itemId, revisionOrDigest: 'sha256:1' }, title: 'ScrollTrigger recipe', origin: 'official',
          rights: { status: 'reference-only', licence: 'GSAP standard licence', notice: 'n', sourceUrl: 'https://gsap.com', packageName: 'gsap' }, files: [], packageDependencies: [] };
      },
    };
    const manager = new CatalogueAdoptionManager({ executor: f.executor, materials: [referenceOnly] });
    await expect(manager.prepare('local-owner', request('p1', await currentRefKey(referenceOnly, 'scroll')))).rejects.toMatchObject({ status: 422, reason: 'reference-only' });
    expect(f.storedPlans()).toBe(0);
    const listed = await createSelectedShadcnResourceSource(f.shadcn).list({ principalId: 'local-daemon' });
    expect(listed.items.map(item => [item.ref.sourceId, item.ref.itemId, item.rightsStatus])).toEqual([['shadcn', 'button', 'permitted']]);
    expect(listed.items[0]!.operationGrants).toContainEqual({ operation: 'incorporation', state: 'permitted', reason: null });
  });

  it('every applied file set carries the source identity and licence notice; a sourced plan without notices is rejected', async () => {
    const f = fixture();
    const silent = createShadcnCatalogueMaterials({ fetchImpl: f.registry.fetchImpl, items: [{ itemId: 'button', reference: BUTTON_URL, title: 'Button', packageName: 'shadcn/ui', licence: { spdx: 'MIT', notice: '' } }] });
    const manager = new CatalogueAdoptionManager({ executor: f.executor, materials: [silent] });
    await expect(manager.prepare('local-owner', request('p1', await currentRefKey(silent, 'button')))).rejects.toMatchObject({ status: 422, reason: 'notice-missing' });

    const material = (await f.shadcn.materialize('button'))!;
    const admission = { resourceRef: material.ref, implementationOrigin: 'official' as const, terms: { version: 'MIT', text: material.rights.notice }, notices: [] };
    const draft = { projectId: 'p1', entryPath: 'src/App.tsx', source: { implementationOrigin: 'official' as const, resourceRef: material.ref },
      writes: [{ path: 'src/App.tsx', role: 'entry' as const, contentBase64: Buffer.from(`${ENTRY}// x\n`).toString('base64') }] };
    await expect(f.executor.prepare('local-owner', draft, admission)).rejects.toMatchObject({ status: 422, reason: 'notice-missing' });
    expect(f.storedPlans()).toBe(0);
  });
});

describe('AC-R04.4 inspect → apply → save → second-project reuse → undo over HTTP and od', () => {
  it('reapplies the same admitted ref into a second project with its own plan and undo', async () => {
    const f = fixture();
    const status = { mode: 'coordinated', activation: { adoption: 'open', gates: [] } } as unknown as PlacementRuntimeStatus;
    const app = express(); app.use(express.json({ limit: '64mb' }));
    registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async () => true, sourcesForRequest: () => [createSelectedShadcnResourceSource(f.shadcn)] });
    for (const project of Object.values(f.projects)) {
      writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { ...JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).dependencies, react: '^18.3.1', 'react-dom': '^18.3.1' } }));
      writeFileSync(join(project, 'tsconfig.json'), '{}');
      for (const name of ['react', 'react-dom']) { mkdirSync(join(project, 'node_modules', name), { recursive: true }); writeFileSync(join(project, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '18.3.1' })); }
    }
    const originalP2 = f.tree('p2'), originalP1 = f.tree('p1');
    registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: createComponentGateForRequest({ sourcesForRequest: () => [createSelectedShadcnResourceSource(f.shadcn)], factsForRequest: async (_req, projectId, insertion) => ({ componentTarget: await readComponentTargetForEntry(f.projects[projectId] ?? null, insertion) }) }), http: { sendApiError }, authorizeProjectRequest: async () => true, placement: { adoption: f.executor, status: () => status }, catalogue: f.manager });
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', () => done()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const od = async (args: string[]) => { let body: any; const code = await runAdoptionCli(args, { baseUrl: url, write: value => { body = value; } }); return { code, body }; };

    const refKey = await currentRefKey(f.shadcn, 'button');
    const inspected = await fetch(`${url}/api/workbench/resources/${refKey}`);
    expect(inspected.status).toBe(200);
    expect(((await inspected.json()) as any).resource).toMatchObject({ refKey, rightsStatus: 'permitted', ref: { sourceId: 'shadcn' } });

    const prepared = await fetch(`${url}/api/workbench/adoption/catalogue/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request('p1', refKey)) });
    expect(prepared.status).toBe(201);
    const p1 = (await prepared.json()) as any;
    const applied1 = await od(['apply', '--plan', p1.plan.id, '--digest', p1.plan.digest, '--json']);
    expect(applied1).toMatchObject({ code: 0, body: { operation: { state: 'done', projectId: 'p1' } } });
    const saved = await od(['show', '--operation', applied1.body.operation.operationId, '--json']);
    expect(saved.body.operation.writes.map((w: { path: string }) => w.path)).toContain('src/components/ui/button.tsx');
    expect(f.tree('p1')['src/components/ui/button.tsx']).toBe(BUTTON_V1);

    const p2 = await od(['catalogue-prepare', '--ref', refKey, '--project', 'p2', '--entry', 'src/App.tsx', '--json']);
    expect(p2.code).toBe(0);
    expect(p2.body.plan.id).not.toBe(p1.plan.id);
    expect(p2.body.catalogue.identity).toMatchObject({ sourceId: 'shadcn', itemId: 'button' });
    const applied2 = await od(['apply', '--plan', p2.body.plan.id, '--digest', p2.body.plan.digest, '--json']);
    expect(applied2.body.operation).toMatchObject({ state: 'done', projectId: 'p2' });
    expect(f.tree('p2')['src/lib/utils.ts']).toBe(UTILS);

    const refused = await od(['catalogue-prepare', '--ref', refKey, '--project', 'pmissing', '--entry', 'src/App.tsx', '--json']);
    expect(refused).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'dependencies-unsatisfied', missing: [{ name: 'class-variance-authority' }] } } } });

    expect((await od(['undo', '--operation', applied2.body.operation.operationId, '--json'])).body.operation).toMatchObject({ kind: 'undo', state: 'done' });
    expect(f.tree('p2')).toEqual(originalP2);
    expect(f.tree('p1')['src/components/ui/button.tsx']).toBe(BUTTON_V1);
    await od(['undo', '--operation', applied1.body.operation.operationId, '--json']);
    expect(f.tree('p1')).toEqual(originalP1);
  });
});
