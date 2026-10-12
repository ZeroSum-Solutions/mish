import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InstalledPluginRecordSchema } from '@mish/contracts';
import { readProjectFile, resolveProjectDir } from '../../src/projects.js';
import { listInstalledPlugins, upsertInstalledPlugin } from '../../src/plugins/registry.js';
import { createLocalResourceSources, searchResources } from '../../src/workbench/resources.js';
import { afterEach, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, ensureWorkspaceResource, updateWorkspaceResource, insertProject, getProject } from '../../src/db.js';
import { insertLibraryAsset, addLibraryAssetSource } from '../../src/library-store.js';
import * as designSystems from '../../src/design-systems/index.js';
import { createDesignSystemServerServices } from '../../src/design-systems/server-services.js';
import { workspaceTeamDesignSystemBindingResourceId } from '../../src/design-systems/workspace-team-binding.js';
import { teamResourceWorkspaceRoot } from '../../src/collab/team-resource-materialization.js';
import { createProjectContextReferenceResolver } from '../../src/workbench/context-reference-services.js';
import { designSystemReferenceDigest, resolveProjectContextReferences } from '../../src/workbench/context-references.js';
import { adapter, candidate } from './context-ranking-fixture.js';
import { buildTransformPrompt } from '../../src/workbench/brief/prompt.js';
import { contextDraft } from './project-context-fixture.js';
import { registerWorkbenchContextRoutes } from '../../src/routes/workbench-context.js';
import { readProjectContext, putProjectContext, type ProjectContextReferences } from '../../src/workbench/project-context.js';
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); closeDatabase(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const request = (workspaceId: string | null = null, workspaceMemberId: string | null = null) => ({ query: {}, get: (header: string) => header === 'x-od-workspace-id' ? workspaceId : header === 'x-od-workspace-member-id' ? workspaceMemberId : undefined }) as unknown as Request;
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'context-refs-')); roots.push(root);
  const installed = path.join(root, 'systems'); const builtIn = path.join(root, 'built-in');
  await Promise.all([mkdir(installed), mkdir(builtIn)]);
  const db = openDatabase(root, { dataDir: root });
  const services = createDesignSystemServerServices({
    getDb: () => db, roots: { SKILL_ROOTS: [], DESIGN_TEMPLATE_ROOTS: [], ALL_SKILL_LIKE_ROOTS: [] },
    paths: { PROJECTS_DIR: path.join(root, 'projects'), DESIGN_SYSTEMS_DIR: builtIn, USER_DESIGN_SYSTEMS_DIR: installed },
    skills: {} as never, designSystems: designSystems as never, projects: { getProject, isSafeId: (id: string) => /^[a-z0-9-]+$/.test(id), readProjectFile, resolveProjectDir } as never,
  });
  const list = vi.fn(services.listAllDesignSystems); const read = vi.fn(services.readAvailableDesignSystem);
  const source = adapter([candidate('hero')]);
  const makeResolver = (sources: Parameters<typeof createProjectContextReferenceResolver>[0]['requestScopedSources'], authorizeProject: Parameters<typeof createProjectContextReferenceResolver>[0]['authorizeProject'] = () => true) => createProjectContextReferenceResolver({
    db, authorizeProject, requestScopedSources: sources,
    teamPluginDirectory: (workspace, id) => path.join(root, workspace, id),
    listAllDesignSystems: list, readAvailableDesignSystem: read, readWorkspaceFile: services.readDesignSystemWorkspaceTextFile,
    designSystemSourceKey: services.designSystemReferenceSourceKey,
  });
  const resolve = makeResolver(() => [source]);
  const writeSystem = async (base: string, id: string, body: string, metadata = {}) => {
    const dir = path.join(base, id); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'DESIGN.md'), body); await writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata));
  };
  return { db, root, installed, builtIn, list, read, source, resolve, makeResolver, writeSystem };
}
const empty = () => ({ assets: [] as string[], resources: [] as ReturnType<typeof candidate>['ref'][], designSystems: [] as { id: string; revisionOrDigest: string }[] });
it('accepts current origin/association assets and exact scoped resources; rejects foreign/missing/stale refs', async () => {
  const f = await fixture();
  for (const [id, owner] of [['owned', 'p'], ['associated', 'q'], ['foreign', 'q']]) insertLibraryAsset(f.db, { id: id!, originProjectId: owner!, kind: 'text', storage: 'owned', capturedAt: 1, archivedDate: '2026-10-03', contentHash: id! });
  addLibraryAssetSource(f.db, { assetId: 'associated', sourceKind: 'agent-task', projectId: 'p' });
  const refs = empty(); refs.assets = ['owned', 'associated', 'foreign', 'missing'];
  refs.resources = [candidate('hero').ref, { ...candidate('hero').ref, revisionOrDigest: 'old' }, candidate('missing').ref];
  const resolved = await f.resolve(request(), 'p', refs);
  f.db.transaction(() => {
    expect(resolved.asset('p', 'owned')).toBe(true); expect(resolved.asset('p', 'associated')).toBe(true);
    expect(resolved.asset('p', 'foreign')).toBe(false); expect(resolved.asset('p', 'missing')).toBe(false); expect(resolved.asset('q', 'owned')).toBe(false);
    expect(resolved.resource('p', refs.resources[0]!)).toBe(true); expect(resolved.resource('p', refs.resources[1]!)).toBe(false); expect(resolved.resource('p', refs.resources[2]!)).toBe(false);
    f.db.prepare("DELETE FROM library_asset_sources WHERE asset_id='associated'").run(); expect(resolved.asset('p', 'associated')).toBe(false);
    f.db.prepare("UPDATE library_assets SET origin_project_id='q' WHERE id='owned'").run(); expect(resolved.asset('p', 'owned')).toBe(false);
  }).immediate();
});

it.each(['local', 'built-in', 'team', 'editing', 'imported-editing'])('fences changed or missing %s DESIGN.md bytes in the final synchronous transaction', async lane => {
  const f = await fixture(); const scoped = lane === 'team' ? request('w', 'm') : request();
  const id = lane === 'built-in' ? 'current' : 'user:current';
  const base = lane === 'team' ? teamResourceWorkspaceRoot(f.installed, 'w') : lane === 'built-in' ? f.builtIn : f.installed;
  let file = path.join(base, 'current', 'DESIGN.md');
  const linked = lane === 'editing' || lane === 'imported-editing';
  await f.writeSystem(base, 'current', '# Current', linked ? { projectId: 'editing' } : lane === 'team' ? { workspaceId: 'w', teamSynced: true } : {});
  if (lane === 'team') ensureWorkspaceResource(f.db, 'design_system', 'w', workspaceTeamDesignSystemBindingResourceId('w', id), { visibility: 'team', resourceState: 'active' });
  if (linked) {
    const baseDir = lane === 'imported-editing' ? path.join(f.root, 'external-editing') : path.join(f.root, 'projects', 'editing');
    insertProject(f.db, { id: 'editing', name: 'Editing', metadata: lane === 'imported-editing' ? { importedFolder: true, baseDir } : {}, createdAt: 1, updatedAt: 1 });
    await mkdir(baseDir, { recursive: true }); file = path.join(baseDir, 'DESIGN.md'); await writeFile(file, '# Current');
  }
  const refs = empty(); refs.designSystems = [{ id, revisionOrDigest: designSystemReferenceDigest('# Current') }];
  const resolved = await f.resolve(scoped, 'p', refs);
  expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(true);
  await writeFile(file, '# Changed');
  f.db.transaction(() => { expect(f.db.inTransaction).toBe(true); expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(false); }).immediate();
  await writeFile(file, '# Current'); expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(true);
  await rm(file);
  f.db.transaction(() => { expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(false); }).immediate();
});

it.each(['plugin', 'design-system'] as const)('rejects a %s source changed after resolution without advancing context or history; equal accepted retries remain valid', async kind => {
  const f = await fixture(); insertProject(f.db, { id: 'p', name: 'P', createdAt: 1, updatedAt: 1 });
  const draft = contextDraft(); let file: string; let source: Parameters<typeof f.makeResolver>[0] = () => [];
  if (kind === 'plugin') {
    const pluginDir = path.join(f.root, 'plugin'); await mkdir(pluginDir); file = path.join(pluginDir, 'index.html'); await writeFile(file, 'Original');
    upsertInstalledPlugin(f.db, InstalledPluginRecordSchema.parse({ id: 'example', title: 'Example', version: '1.0.0', sourceKind: 'local', source: 'local:test', trust: 'restricted', capabilitiesGranted: [], fsPath: pluginDir, installedAt: 0, updatedAt: 0, manifest: { name: 'example', version: '1.0.0', title: 'Example', description: 'Test' } }));
    source = (_req, observe) => createLocalResourceSources({ listPlugins: async () => { const plugins = listInstalledPlugins(f.db, null, null); observe?.(plugins); return plugins; } });
    const page = await searchResources({ query: '', facets: { sourceIds: ['plugins'] }, limit: 10 }, { principalId: 'local-daemon', projectId: 'p' }, source(request()));
    draft.factSources[0]!.source = { resourceRef: page.results[0]!.ref };
  } else {
    await f.writeSystem(f.installed, 'current', 'Original'); file = path.join(f.installed, 'current', 'DESIGN.md');
    draft.designSystemRef = { id: 'user:current', revisionOrDigest: designSystemReferenceDigest('Original') };
    for (const [field, value] of Object.entries(draft.designSystemRef)) if (value !== undefined) draft.factSources.push({ ...draft.factSources[0]!, fieldPath: `/designSystemRef/${field}`, value });
  }
  const resolve = f.makeResolver(source); const app = express(); app.use(express.json());
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(done => { started = done; }); const resume = new Promise<void>(done => { release = done; });
  const resolver = vi.fn(async (...args: Parameters<typeof resolve>) => {
    expect(f.db.inTransaction).toBe(false); const resolved = await resolve(...args); started(); await resume;
    const guarded: ProjectContextReferences = {
      ...resolved,
      resource: (...input) => { expect(f.db.inTransaction).toBe(true); return resolved.resource(...input); },
      designSystem: (...input) => { expect(f.db.inTransaction).toBe(true); return resolved.designSystem(...input); },
    };
    return guarded;
  });
  registerWorkbenchContextRoutes(app, { db: f.db, http: { sendApiError: (res, status, code, message) => res.status(status).json({ error: { code, message } }) }, authorizeProjectRequest: async () => true, authorizeProjectCommit: () => true, referencesForProject: resolver });
  const server = app.listen(0); servers.push(server); await new Promise<void>(done => server.once('listening', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workbench/projects/p/context`;
  const save = () => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, draft }) });
  const pending = save(); await ready; await writeFile(file, 'Modified'); release();
  const refused = await pending; expect(refused.status).toBe(422); expect(await refused.json()).toEqual({ error: { code: 'VALIDATION_FAILED', message: 'Project reference is invalid or unavailable' } });
  expect(readProjectContext(f.db, 'p').revision).toBe(0);
  expect(f.db.prepare('SELECT count(*) AS n FROM workbench_project_context_history').get()).toEqual({ n: 0 });
  await rm(file); expect((await save()).status).toBe(422);
  expect(readProjectContext(f.db, 'p').revision).toBe(0); expect(f.db.prepare('SELECT count(*) AS n FROM workbench_project_context_history').get()).toEqual({ n: 0 });
  await writeFile(file, 'Original'); const accepted = await save(); expect(accepted.status).toBe(200); const saved = await accepted.json();
  await rm(file); const retry = await save(); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(saved);
  expect(resolver).toHaveBeenCalledTimes(3); expect(f.db.prepare('SELECT count(*) AS n FROM workbench_project_context_history').get()).toEqual({ n: 1 });
});

it('fences changed selection metadata and an editing mirror appearing after registry fallback resolution', async () => {
  const f = await fixture(); const id = 'user:current'; const body = '# Current';
  await f.writeSystem(f.installed, 'current', body, { projectId: 'editing' });
  insertProject(f.db, { id: 'editing', name: 'Editing', createdAt: 1, updatedAt: 1 });
  const refs = empty(); refs.designSystems = [{ id, revisionOrDigest: designSystemReferenceDigest(body) }];
  const resolved = await f.resolve(request(), 'p', refs); expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(true);
  const metadata = path.join(f.installed, 'current', 'metadata.json');
  await writeFile(metadata, JSON.stringify({ projectId: 'another-editing' }));
  f.db.transaction(() => { expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(false); }).immediate();
  await writeFile(metadata, JSON.stringify({ projectId: 'editing' })); expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(true);
  const mirror = path.join(f.root, 'projects', 'editing'); await mkdir(mirror, { recursive: true }); await writeFile(path.join(mirror, 'DESIGN.md'), '# New mirror');
  f.db.transaction(() => { expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(false); }).immediate();
});
it('uses explicit null scope and exact DESIGN.md bytes while hiding claimed local systems', async () => {
  const f = await fixture(); await f.writeSystem(f.installed, 'local', '# Local'); await f.writeSystem(f.installed, 'foreign', '# Foreign', { workspaceId: 'other' });
  const refs = empty(); refs.designSystems = [{ id: 'user:local', revisionOrDigest: designSystemReferenceDigest('# Local') }, { id: 'user:foreign', revisionOrDigest: designSystemReferenceDigest('# Foreign') }, { id: 'user:missing', revisionOrDigest: 'unknown' }];
  const resolved = await f.resolve(request(), 'p', refs);
  expect(f.list).toHaveBeenCalledWith({ workspaceId: null, workspaceMemberId: null, exactTeam: false });
  expect(f.read).toHaveBeenCalledWith('user:local', { workspaceId: null, workspaceMemberId: null, exactTeam: false });
  expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(true);
  expect(resolved.designSystem('p', refs.designSystems[1]!)).toBe(false); expect(resolved.designSystem('p', refs.designSystems[2]!)).toBe(false);
  await writeFile(path.join(f.installed, 'local', 'DESIGN.md'), '# Changed');
  expect((await f.resolve(request(), 'p', refs)).designSystem('p', refs.designSystems[0]!)).toBe(false);
  ensureWorkspaceResource(f.db, 'design_system', 'other', 'user:local', { visibility: 'personal', createdByWorkspaceMemberId: 'owner', resourceState: 'active' });
  expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(false);
});
it('selects the exact Team copy and rejects revoked Team bindings without same-id Personal fallback', async () => {
  const f = await fixture(); const id = 'user:same'; const team = teamResourceWorkspaceRoot(f.installed, 'w');
  await f.writeSystem(f.installed, 'same', '# Personal'); await f.writeSystem(team, 'same', '# Team', { workspaceId: 'w', teamSynced: true });
  const bindingId = workspaceTeamDesignSystemBindingResourceId('w', id);
  ensureWorkspaceResource(f.db, 'design_system', 'w', bindingId, { visibility: 'team', resourceState: 'active' });
  const refs = empty(); refs.designSystems = [{ id, revisionOrDigest: designSystemReferenceDigest('# Team') }];
  const resolved = await f.resolve(request('w', 'm'), 'p', refs);
  expect(f.read).toHaveBeenCalledWith(id, { workspaceId: 'w', workspaceMemberId: 'm', exactTeam: true }); expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(true);
  await writeFile(path.join(f.installed, 'same', 'DESIGN.md'), '# Unselected personal change');
  expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(true);
  updateWorkspaceResource(f.db, 'design_system', 'w', bindingId, { resourceState: 'deleted' });
  expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(false);
  refs.designSystems[0]!.revisionOrDigest = designSystemReferenceDigest('# Personal');
  expect((await f.resolve(request('w', 'm'), 'p', refs)).designSystem('p', refs.designSystems[0]!)).toBe(false);
});
it('rechecks visibility when a personal binding is revoked during asynchronous file reading', async () => {
  const f = await fixture(); const id = 'user:mine'; await f.writeSystem(f.installed, 'mine', '# Mine', { workspaceId: 'w' });
  ensureWorkspaceResource(f.db, 'design_system', 'w', id, { visibility: 'personal', createdByWorkspaceMemberId: 'm', resourceState: 'active' });
  f.read.mockImplementationOnce(async () => { const body = await readFile(path.join(f.installed, 'mine', 'DESIGN.md'), 'utf8'); updateWorkspaceResource(f.db, 'design_system', 'w', id, { resourceState: 'deleted' }); return body; });
  const refs = empty(); refs.designSystems = [{ id, revisionOrDigest: designSystemReferenceDigest('# Mine') }];
  const resolved = await f.resolve(request('w', 'm'), 'p', refs); expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(false);
});

it('validates a plugin digest under exact member scope and rechecks its selected binding at commit', async () => {
  const f = await fixture(); const pluginDir = path.join(f.root, 'plugin'); await mkdir(pluginDir); await writeFile(path.join(pluginDir, 'index.html'), '<button>Example</button>');
  const nested = path.join(pluginDir, 'nested'); await mkdir(nested);
  const largeBody = 'a'.repeat(70_000); await writeFile(path.join(nested, 'large.txt'), largeBody);
  await mkdir(path.join(pluginDir, 'node_modules')); await mkdir(path.join(pluginDir, '.git'));
  const plugin = InstalledPluginRecordSchema.parse({ id: 'example', title: 'Example', version: '1.0.0', sourceKind: 'local', source: 'local:test', trust: 'restricted', capabilitiesGranted: [], fsPath: pluginDir, installedAt: 0, updatedAt: 0, manifest: { name: 'example', version: '1.0.0', title: 'Example', description: 'Test', od: { preview: { entry: 'index.html' } } } });
  upsertInstalledPlugin(f.db, plugin);
  ensureWorkspaceResource(f.db, 'plugin', 'w', plugin.id, { visibility: 'personal', createdByWorkspaceMemberId: 'm', resourceState: 'active' });
  const sources: Parameters<typeof createProjectContextReferenceResolver>[0]['requestScopedSources'] = (req, observe) => createLocalResourceSources({ listPlugins: async () => {
    const plugins = listInstalledPlugins(f.db, req.get('x-od-workspace-id') ?? null, req.get('x-od-workspace-member-id') ?? null); observe?.(plugins); return plugins;
  } });
  const scoped = request('w', 'm');
  const page = await searchResources({ query: '', facets: { sourceIds: ['plugins'] }, limit: 10 }, { principalId: 'workspace:w:m', projectId: 'p' }, sources(scoped));
  const ref = page.results[0]!.ref; const refs = empty(); refs.resources = [ref]; const resolve = f.makeResolver(sources);
  const resolved = await resolve(scoped, 'p', refs); expect(resolved.resource('p', ref)).toBe(true);
  await writeFile(path.join(pluginDir, 'node_modules', 'ignored'), 'dependency change'); await writeFile(path.join(pluginDir, '.git', 'ignored'), 'git change');
  expect(resolved.resource('p', ref)).toBe(true);
  await writeFile(path.join(nested, 'large.txt'), `${largeBody}changed`);
  // Final digest memoization belongs to one save; later saves resolve anew.
  const edited = await resolve(scoped, 'p', refs);
  f.db.transaction(() => { expect(edited.resource('p', ref)).toBe(false); }).immediate();
  await writeFile(path.join(nested, 'large.txt'), largeBody); expect((await resolve(scoped, 'p', refs)).resource('p', ref)).toBe(true);
  await rm(path.join(nested, 'large.txt')); expect((await resolve(scoped, 'p', refs)).resource('p', ref)).toBe(false);
  await writeFile(path.join(nested, 'large.txt'), largeBody);
  expect((await resolve(request('w', 'foreign-member'), 'p', refs)).resource('p', ref)).toBe(false);
  expect((await resolve(request(), 'p', refs)).resource('p', ref)).toBe(false);
  updateWorkspaceResource(f.db, 'plugin', 'w', plugin.id, { resourceState: 'deleted' });
  expect(resolved.resource('p', ref)).toBe(false); expect((await resolve(scoped, 'p', refs)).resource('p', ref)).toBe(false);
});

it('uses the authorized linked project file and fences its association; denies foreign editing roots', async () => {
  const f = await fixture(); const id = 'user:editing';
  insertProject(f.db, { id: 'editing', name: 'Editing', metadata: {}, createdAt: 1, updatedAt: 1 });
  const projectRoot = path.join(f.root, 'projects', 'editing'); await mkdir(projectRoot, { recursive: true }); await writeFile(path.join(projectRoot, 'DESIGN.md'), '# Editing bytes');
  await f.writeSystem(f.installed, 'editing', '# Registry bytes', { projectId: 'editing' });
  const refs = empty(); refs.designSystems = [{ id, revisionOrDigest: designSystemReferenceDigest('# Editing bytes') }];
  const authorized = await f.resolve(request(), 'p', refs); expect(authorized.designSystem('p', refs.designSystems[0]!)).toBe(true);
  const denied = f.makeResolver(() => [], (_req, _res, project) => project !== 'editing');
  expect((await denied(request(), 'p', refs)).designSystem('p', refs.designSystems[0]!)).toBe(false);
  f.db.prepare("UPDATE projects SET metadata_json='{}', updated_at=2 WHERE id='editing'").run();
  expect(authorized.designSystem('p', refs.designSystems[0]!)).toBe(false);
});

it.each(['local', 'personal'])('accepts the exact registry digest with authorized absent/invalid editing roots under %s scope', async lane => {
  const f = await fixture(); const scoped = lane === 'personal' ? request('w', 'm') : request();
  for (const projectId of ['missing-editing', 'invalid:editing']) {
    const name = projectId === 'missing-editing' ? 'missing-link' : 'invalid-link'; const id = `user:${name}`;
    await f.writeSystem(f.installed, name, '# Registry fallback', { projectId, ...(lane === 'personal' ? { workspaceId: 'w' } : {}) });
    if (lane === 'personal') ensureWorkspaceResource(f.db, 'design_system', 'w', id, { visibility: 'personal', createdByWorkspaceMemberId: 'm', resourceState: 'active' });
    const refs = empty(); refs.designSystems = [{ id, revisionOrDigest: designSystemReferenceDigest('# Registry fallback') }];
    let allowed = true;
    const resolve = f.makeResolver(() => [], (_req, _res, linked) => linked === projectId && allowed);
    const resolved = await resolve(scoped, 'p', refs);
    f.db.transaction(() => { expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(true); }).immediate();
    allowed = false;
    expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(false);
    const reads = f.read.mock.calls.length;
    expect((await resolve(scoped, 'p', refs)).designSystem('p', refs.designSystems[0]!)).toBe(false);
    expect(f.read.mock.calls.length).toBe(reads);
  }
});

it('fences an absent editing project that appears during registry lookup or before the final transaction', async () => {
  const f = await fixture(); const id = 'user:missing-link'; const projectId = 'appearing-editing';
  await f.writeSystem(f.installed, 'missing-link', '# Registry fallback', { projectId });
  const refs = empty(); refs.designSystems = [{ id, revisionOrDigest: designSystemReferenceDigest('# Registry fallback') }];
  const insert = () => insertProject(f.db, { id: projectId, name: 'Appeared', createdAt: 1, updatedAt: 1 });
  const originalRead = f.read.getMockImplementation()!;
  f.read.mockImplementationOnce(async (...args) => { const body = await originalRead(...args); insert(); return body; });
  expect((await f.resolve(request(), 'p', refs)).designSystem('p', refs.designSystems[0]!)).toBe(false);
  expect(f.read).toHaveBeenCalled();
  f.db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
  const resolved = await f.resolve(request(), 'p', refs);
  expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(true);
  insert();
  f.db.transaction(() => { expect(resolved.designSystem('p', refs.designSystems[0]!)).toBe(false); }).immediate();
});

it('rejects a saved kit from a different source before legacy design-system resolution', async () => {
  const readDesignSystem = vi.fn(async () => ({ body: 'Kit', bindingKey: 'binding', sourceCurrent: () => true }));
  const ref = { sourceId: 'plugins' as const, id: 'same-id', revisionOrDigest: designSystemReferenceDigest('Kit') };
  const resolved = await resolveProjectContextReferences('p', { assets: [], resources: [], designSystems: [ref] }, { getAsset: () => null, requestContext: { principalId: 'local-daemon', projectId: 'p' }, requestScopedSources: [], resourceBindingKey: () => null, resourceSourceCurrent: () => false, readDesignSystem, designSystemBindingKey: () => 'binding' });
  expect(readDesignSystem).not.toHaveBeenCalled();
  expect(resolved.designSystem('p', ref)).toBe(false);
});

it('uses unreviewed kit bytes only as digest evidence, never as saved context or prompt input', async () => {
  const f = await fixture(); insertProject(f.db, { id: 'p', name: 'P', createdAt: 1, updatedAt: 1 });
  const body = '# Unreviewed kit body — MUST NEVER ENTER THE PROMPT';
  await f.writeSystem(f.installed, 'current', body, { status: 'draft' });
  expect((await f.list({ workspaceId: null, workspaceMemberId: null }))[0]!.approval?.status).toBe('unreviewed');
  const draft = contextDraft();
  draft.designSystemRef = { id: 'user:current', revisionOrDigest: designSystemReferenceDigest(body) };
  for (const [field, value] of Object.entries(draft.designSystemRef)) {
    if (value !== undefined) draft.factSources.push({ ...draft.factSources[0]!, fieldPath: `/designSystemRef/${field}`, value });
  }
  const refs = empty(); refs.designSystems = [draft.designSystemRef];
  const evidence = await f.resolve(request(), 'p', refs);
  const saved = putProjectContext(f.db, 'p', { expectedRevision: 0, draft }, evidence);
  expect(saved.context?.designSystemRef).toEqual(draft.designSystemRef);
  const context = readProjectContext(f.db, 'p').context;
  const prompt = buildTransformPrompt({ originalText: 'Build a booking page', projectContext: context, overrides: {}, styleDirections: [], targetRuntime: null, references: [] });
  expect(prompt.user).toContain(draft.designSystemRef.revisionOrDigest);
  expect(JSON.stringify(saved)).not.toContain(body);
  expect(prompt.user).not.toContain(body);
  expect(prompt.system).not.toContain(body);
});
