import { readSync, openSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { InstalledPluginRecordSchema } from '@open-design/contracts';
import { currentPluginResourceRevision, createPluginResourceRevisionValidator, PLUGIN_SOURCE_VALIDATION_LIMITS, createLocalResourceSources, searchResources } from '../../src/workbench/resources.js';
import { createProjectContextReferenceResolver } from '../../src/workbench/context-reference-services.js';
import { closeDatabase, openDatabase, insertProject, ensureWorkspaceResource } from '../../src/db.js';
import { upsertInstalledPlugin } from '../../src/plugins/registry.js';
import { putProjectContext, readProjectContext } from '../../src/workbench/project-context.js';
import { contextDraft } from './project-context-fixture.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync), openSync: vi.fn(actual.openSync) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); closeDatabase(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(body = '<button>Owned fixture</button>') {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-source-budget-')); roots.push(root);
  const fsPath = path.join(root, 'plugin'); await mkdir(fsPath); await writeFile(path.join(fsPath, 'index.html'), body);
  const plugin = InstalledPluginRecordSchema.parse({ id: 'owned', title: 'Owned', version: '1.0.0', sourceKind: 'local', source: 'local:fixture', trust: 'restricted', capabilitiesGranted: [], fsPath, installedAt: 0, updatedAt: 0, manifest: { name: 'owned', version: '1.0.0', title: 'Owned', description: 'Test', od: { preview: { entry: 'index.html' } } } });
  return { root, plugin, body };
}
const readBytes = () => vi.mocked(readSync).mock.results.reduce((total, result) => total + (result.type === 'return' && typeof result.value === 'number' ? result.value : 0), 0);
it('hashes each plugin once in a save, rechecks every binding, and detects edits on a second save', async () => {
  const { root, plugin, body } = await fixture(); const db = openDatabase(root, { dataDir: root });
  insertProject(db, { id: 'p', name: 'Owned', createdAt: 1, updatedAt: 1 }); upsertInstalledPlugin(db, plugin);
  const req = { query: {}, get: () => undefined } as unknown as Request;
  const sources = (_req: Request, observe?: (plugins: readonly typeof plugin[]) => void) => createLocalResourceSources({ listPlugins: async () => { observe?.([plugin]); return [plugin]; } });
  const resolve = createProjectContextReferenceResolver({ db, authorizeProject: () => true, requestScopedSources: sources, teamPluginDirectory: () => 'unused', listAllDesignSystems: (() => []) as never, readAvailableDesignSystem: (() => null) as never, readWorkspaceFile: (() => null) as never, designSystemSourceKey: (() => null) as never });
  const page = await searchResources({ query: '', facets: { sourceIds: ['plugins'] }, limit: 10 }, { principalId: 'local-daemon', projectId: 'p' }, sources(req));
  const ref = page.results[0]!.ref; const requested = { assets: [], resources: [ref, ref, ref], designSystems: [] };
  const references = await resolve(req, 'p', requested); const draft = contextDraft();
  draft.factSources = draft.factSources.map(fact => ({ ...fact, source: { resourceRef: ref } }));
  vi.mocked(readSync).mockClear();
  const saved = putProjectContext(db, 'p', { expectedRevision: 0, draft }, references); expect(saved.revision).toBe(1);
  expect(readBytes()).toBe(Buffer.byteLength(body));
  const second = await resolve(req, 'p', requested); await writeFile(path.join(plugin.fsPath, 'index.html'), body.replace('Owned', 'Other'));
  expect(() => putProjectContext(db, 'p', { expectedRevision: 1, draft: { ...draft, assumptions: ['Second save'] } }, second)).toThrow('Project reference is invalid or unavailable');
  expect(readProjectContext(db, 'p').revision).toBe(1);
  vi.mocked(readSync).mockClear();
  expect(putProjectContext(db, 'p', { expectedRevision: 0, draft }, second)).toEqual(saved);
  expect(readSync).not.toHaveBeenCalled();
  // Digest reuse must never reuse a binding decision, even inside this operation.
  const current = currentPluginResourceRevision(plugin)!; const fresh = await resolve(req, 'p', { ...requested, resources: [{ ...ref, revisionOrDigest: current }] });
  const currentRef = { ...ref, revisionOrDigest: current }; expect(fresh.resource('p', currentRef)).toBe(true);
  ensureWorkspaceResource(db, 'plugin', 'foreign', plugin.id, { visibility: 'personal', createdByWorkspaceMemberId: 'foreign', resourceState: 'active' });
  expect(fresh.resource('p', currentRef)).toBe(false);
});
it('refuses an over-budget file before synchronously reading its source bytes', async () => {
  const { plugin } = await fixture(); await writeFile(path.join(plugin.fsPath, 'large.bin'), Buffer.alloc(32 * 1024 * 1024 + 1));
  vi.mocked(readSync).mockClear(); expect(currentPluginResourceRevision(plugin)).toBeNull();
  expect(readBytes()).toBeLessThan(64 * 1024);
});
it('matches discovery for nested bytes while excluding symlinks and dependency/git trees', async () => {
  const { root, plugin } = await fixture();
  await mkdir(path.join(plugin.fsPath, 'nested')); await writeFile(path.join(plugin.fsPath, 'nested', 'source.txt'), 'nested-source');
  for (const ignored of ['node_modules', '.git']) { await mkdir(path.join(plugin.fsPath, ignored)); await writeFile(path.join(plugin.fsPath, ignored, 'ignored.txt'), 'ignored'); }
  await writeFile(path.join(root, 'outside.txt'), 'outside'); await symlink(path.join(root, 'outside.txt'), path.join(plugin.fsPath, 'linked.txt'));
  await symlink(root, path.join(plugin.fsPath, 'linked-directory'));
  const sources = createLocalResourceSources({ listPlugins: async () => [plugin] });
  const discovery = await sources[0]!.list({ principalId: 'local-daemon' });
  expect(currentPluginResourceRevision(plugin)).toBe(discovery.items[0]!.ref.revisionOrDigest);
  await writeFile(path.join(root, 'outside.txt'), 'unselected-change');
  expect(currentPluginResourceRevision(plugin)).toBe(discovery.items[0]!.ref.revisionOrDigest);
  expect(currentPluginResourceRevision({ ...plugin, fsPath: path.join(plugin.fsPath, 'linked-directory') })).toBeNull();
});
it('fails closed on unreadable source and elapsed-work exhaustion', async () => {
  const { plugin } = await fixture();
  vi.mocked(readSync).mockImplementationOnce(() => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); });
  expect(currentPluginResourceRevision(plugin)).toBeNull();
  const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(PLUGIN_SOURCE_VALIDATION_LIMITS.milliseconds + 1);
  vi.mocked(openSync).mockClear(); expect(currentPluginResourceRevision(plugin)).toBeNull(); expect(openSync).not.toHaveBeenCalled(); now.mockRestore();
});
it('shares byte work across plugins but starts a fresh budget for another operation', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const first = await fixture(); const second = await fixture();
  for (const { plugin } of [first, second]) await writeFile(path.join(plugin.fsPath, 'large.bin'), Buffer.alloc(20 * 1024 * 1024));
  const validate = createPluginResourceRevisionValidator();
  expect(validate(first.plugin)).not.toBeNull(); expect(validate(second.plugin)).toBeNull();
  expect(createPluginResourceRevisionValidator()(second.plugin)).not.toBeNull();
});
it('bounds regular-file and directory-entry work before reading further files', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const { plugin } = await fixture();
  await Promise.all(Array.from({ length: PLUGIN_SOURCE_VALIDATION_LIMITS.files }, (_, index) => writeFile(path.join(plugin.fsPath, `file-${index}`), '')));
  vi.mocked(openSync).mockClear(); expect(currentPluginResourceRevision(plugin)).toBeNull();
  expect(vi.mocked(openSync).mock.calls.length).toBe(PLUGIN_SOURCE_VALIDATION_LIMITS.files);
  await Promise.all(Array.from({ length: PLUGIN_SOURCE_VALIDATION_LIMITS.entries - PLUGIN_SOURCE_VALIDATION_LIMITS.files }, (_, index) => mkdir(path.join(plugin.fsPath, `directory-${index}`))));
  vi.mocked(openSync).mockClear(); expect(currentPluginResourceRevision(plugin)).toBeNull(); expect(openSync).not.toHaveBeenCalled();
});
it('refuses elapsed operation work even when its source digest is memoized', async () => {
  const { plugin } = await fixture(); let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const validate = createPluginResourceRevisionValidator(); expect(validate(plugin)).not.toBeNull();
  vi.mocked(readSync).mockClear(); now = PLUGIN_SOURCE_VALIDATION_LIMITS.milliseconds + 1;
  expect(validate(plugin)).toBeNull(); expect(readSync).not.toHaveBeenCalled();
});
