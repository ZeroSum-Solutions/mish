import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_OPERATIONS } from '@open-design/contracts';
import { createLocalResourceSources, searchResources } from '../../src/workbench/resources.js';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { createAceternityCatalogueMaterials } from '../../src/workbench/adoption/aceternity-material.js';
import { CatalogueAdoptionManager } from '../../src/workbench/adoption/catalogue-adoption.js';
import { CatalogueSavedUnitStore } from '../../src/workbench/adoption/saved-units.js';
import { createShadcnCatalogueMaterials } from '../../src/workbench/adoption/shadcn-material.js';
import { ACETERNITY_FREE_RIGHTS_ASSESSMENTS } from '../../src/workbench/aceternity-rights.js';
import type { ShadcnFetch } from '../../src/design-systems/shadcn-import.js';
import { ENTRY, adoptionFixture, adoptionServer, closeAll, post } from './adoption-route-fixture.js';

/**
 * AC-R18.6: Aceternity is discovered through the existing shadcn registry route as a
 * `project-fetch` source. Each evaluated item carries its exact registry locator and
 * digests. Owner decision 2026-10-09 admits its private operations under the
 * `owner-accepted-private-use` basis, so apply works for all three evaluated items
 * through HTTP and od: the daemon fetches the registry item, checks the pinned digest,
 * writes the component with a notice and undoes exactly. tabs and card-hover-effect stay
 * marked needs-repair. Nothing is purchased or mirrored.
 */
const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => closeAll(servers, roots));

const sources = () => createLocalResourceSources({ listPlugins: async () => [] });
const MANIFEST = {
  'bento-grid': '9d988ea63b4209b65e386aa26dba37005d67667e122184c8905b6d31eda32482',
  'card-hover-effect': '6f9451d50fdce14344c0fbab29f8f47ac29bd11d11dc11fb95f3fc94bce271af',
  tabs: 'a0f2d1eb503190ec2e53ee5887a9b33d7c94e3f6d6548f07afd0a79ef0effcaa',
} as const;
type ItemId = keyof typeof MANIFEST;
const ITEMS = Object.keys(MANIFEST) as ItemId[];
const FIXTURES = fileURLToPath(new URL('../fixtures/workbench/aceternity/', import.meta.url));
const registryText = (id: ItemId) => readFileSync(join(FIXTURES, `${id}.json`), 'utf8');
const componentOf = (id: ItemId): string => JSON.parse(registryText(id)).files[0].content;
const DEPENDENCIES = { dependencies: { '@tabler/icons-react': '^3.0.0', motion: '^12.0.0', '@radix-ui/react-tabs': '^1.1.0', cn: '^0.4.0' } };
/** shadcn's MIT `utils` helper (new-york-v4), byte-pinned: retrieved 2026-10-09T01:48:37Z. */
const SHADCN_UTILS = 'export { cn } from "cn"\n';
const SHADCN_UTILS_SHA256 = '14300d758170c270c75b057f38fedb3793a5920ea872f0477e29fb131185e8a7';

/** The executor writes only into existing directories, as for the shadcn cohort. */
function prepareProject(project: string, manifest: unknown = DEPENDENCIES): void {
  mkdirSync(join(project, 'src', 'components', 'ui'), { recursive: true });
  mkdirSync(join(project, 'src', 'lib'), { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify(manifest));
}

/** Serves the recorded registry documents; `override` replaces one item's bytes. */
function registryFetch(requested: string[], override: Partial<Record<ItemId, string>> = {}): ShadcnFetch {
  return async url => {
    requested.push(url);
    const id = /^https:\/\/ui\.aceternity\.com\/registry\/([a-z-]+)\.json$/u.exec(url)?.[1] as ItemId | undefined;
    const body = id && id in MANIFEST ? override[id] ?? registryText(id) : null;
    return { ok: body !== null, status: body === null ? 404 : 200, statusText: body === null ? 'Not Found' : 'OK', text: async () => body ?? '' };
  };
}

async function aceternity() {
  return searchResources({ query: '', facets: { sourceIds: ['aceternity'] }, limit: 50 }, { principalId: 'local-daemon' }, sources());
}

describe('Aceternity project-fetch discovery (AC-R18.6)', () => {
  it('lists the evaluated registry items with exact locator, digest and project-fetch acquisition', async () => {
    const response = await aceternity();
    expect(response.sourceStatuses.find(status => status.sourceId === 'aceternity')?.state).toBe('searched');
    expect(response.results.map(item => item.ref.itemId).sort()).toEqual([...ITEMS].sort());
    for (const item of response.results) {
      const name = item.ref.itemId as ItemId;
      expect(item.ref.revisionOrDigest).toBe(`sha256:${MANIFEST[name]}`);
      expect(createHash('sha256').update(registryText(name)).digest('hex')).toBe(MANIFEST[name]);
      expect(item.sourceIdentity).toMatchObject({ acquisitionMode: 'project-fetch', registryLocator: `https://ui.aceternity.com/registry/${name}.json`, documentedConnector: null });
      expect(item.compatibility).toMatchObject({ nativeFormat: 'react-tsx', targets: ['react'] });
      expect(item.compatibility.state).not.toBe('compatible');
      expect(item.needDecision).toBe('justified');
      expect(item.readiness).not.toBe('usable');
    }
  });

  it('admits private operations under the dated owner decision and offers apply without an acceptance receipt', async () => {
    const results = (await aceternity()).results;
    expect(results).toHaveLength(3);
    for (const item of results) {
      const identity = item.sourceIdentity!;
      expect(identity.operationRights.map(right => right.operation).sort()).toEqual([...SOURCE_OPERATIONS].sort());
      for (const right of identity.operationRights) {
        expect(right.decision, right.operation).toBe(right.operation === 'redistribute-unit' ? 'blocked' : 'allowed');
        expect(right.reason).toMatch(/owner decision 2026-10-09/);
      }
      expect(identity.rightsAssessment).toMatchObject({
        id: `aceternity-free-rights:${item.ref.itemId}`, evaluatorRole: 'source-curator', basis: 'owner-accepted-private-use',
        termsUrl: 'https://ui.aceternity.com/licence', ownerDecision: { decidedAt: '2026-10-09', decidedBy: 'owner' },
      });
      expect(item.rightsStatus).toBe('permitted');
      expect(item.operationGrants).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'host-preview', state: 'permitted' }),
        expect.objectContaining({ operation: 'incorporation', state: 'permitted' }),
        expect.objectContaining({ operation: 'redistribution', state: 'blocked' }),
      ]));
      expect(item.previewCapability.kind).not.toBe('html');
      expect(item.adoptionCapability).toEqual({ available: false, reason: 'acceptance-receipt-pending' });
    }
  });

  it('od workbench inspect --json carries the same cited assessment and decisions as the search result', async () => {
    const f = adoptionFixture(roots);
    const url = await adoptionServer(servers, f, { sources: sources() });
    const bento = (await aceternity()).results.find(item => item.ref.itemId === 'bento-grid')!;
    let cli: any; const code = await runWorkbenchCli(['inspect', '--ref', bento.refKey, '--json'], { baseUrl: url, write: value => { cli = value; } });
    expect(code).toBe(0);
    expect(cli.resource.sourceIdentity.rightsAssessment).toEqual(bento.sourceIdentity!.rightsAssessment);
    expect(cli.resource.sourceIdentity.operationRights).toEqual(bento.sourceIdentity!.operationRights);
  });

  it('keeps the observed tab and card-hover failures as a repair state', async () => {
    const results = (await aceternity()).results;
    for (const id of ['tabs', 'card-hover-effect']) {
      const item = results.find(entry => entry.ref.itemId === id)!;
      expect(item.readiness).toBe('needs-repair');
      expect(item.admissionStage).toBe('needs-repair');
    }
  });
});

describe('Aceternity apply under owner-accepted private use (AC-R18.6)', () => {
  it('applies each evaluated item through HTTP and od with a notice, and undo restores the project', async () => {
    const f = adoptionFixture(roots, ['p1', 'p2', 'p3']);
    for (const project of Object.values(f.projects)) prepareProject(project);
    const requested: string[] = [];
    const url = await adoptionServer(servers, f, { sources: sources(), materials: [createAceternityCatalogueMaterials({ fetchImpl: registryFetch(requested) })] });
    const od = async (args: string[]) => { let body: any; const code = await runAdoptionCli(args, { baseUrl: url, write: value => { body = value; } }); return { code, body }; };
    const results = (await aceternity()).results;
    const projects: Record<ItemId, string> = { 'bento-grid': 'p1', 'card-hover-effect': 'p2', tabs: 'p3' };
    const operations: string[] = [];
    for (const id of ITEMS) {
      const refKey = results.find(item => item.ref.itemId === id)!.refKey;
      const projectId = projects[id];
      // bento-grid prepares through od; the others through HTTP. Both surfaces share the endpoint.
      const prepared = id === 'bento-grid'
        ? (await od(['catalogue-prepare', '--ref', refKey, '--project', projectId, '--entry', 'src/App.tsx', '--json'])).body
        : (await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId, refKey, entryPath: 'src/App.tsx' })).body;
      expect(prepared.error, id).toBeUndefined();
      expect(prepared.catalogue.identity).toMatchObject({ sourceId: 'aceternity', itemId: id });
      const applied = await od(['apply', '--plan', prepared.plan.id, '--digest', prepared.plan.digest, '--json']);
      expect(applied).toMatchObject({ code: 0, body: { operation: { state: 'done', projectId } } });
      operations.push(applied.body.operation.operationId);
      const tree = f.tree(projectId);
      expect(tree[`src/components/ui/${id}.tsx`]).toBe(componentOf(id));
      const notice = tree[`src/components/ui/NOTICE.aceternity-${id}.md`]!;
      expect(notice).toContain('https://ui.aceternity.com/licence');
      expect(notice).toContain('owner-accepted-private-use');
      expect(notice).toMatch(/2026-10-09/);
      expect(tree['src/App.tsx']).toContain(`od:adopted aceternity/${id} sha256:${MANIFEST[id]}`);
      // The project had no `@/lib/utils`: apply supplied shadcn's pinned MIT helper as a recorded write.
      expect(tree['src/lib/utils.ts']).toBe(SHADCN_UTILS);
      expect(createHash('sha256').update(tree['src/lib/utils.ts']!).digest('hex')).toBe(SHADCN_UTILS_SHA256);
      expect(prepared.catalogue.files.map((file: { path: string }) => file.path)).toContain('src/lib/utils.ts');
      expect(prepared.catalogue.dependencies.satisfied.map((dependency: { name: string }) => dependency.name)).toContain('cn');
      expect(notice).toContain('MIT License');
      expect(notice).toContain('Copyright (c) 2023 shadcn');
    }
    expect(requested.sort()).toEqual(ITEMS.map(id => `https://ui.aceternity.com/registry/${id}.json`).sort());
    for (const [index, id] of ITEMS.entries()) {
      expect((await od(['undo', '--operation', operations[index]!, '--json'])).body.operation).toMatchObject({ kind: 'undo', state: 'done' });
      expect(f.tree(projects[id])).toEqual({ 'package.json': JSON.stringify(DEPENDENCIES), 'src/App.tsx': ENTRY });
    }
  });

  it('keeps a project\'s own `@/lib/utils` cn untouched and does not require the helper\'s package', async () => {
    const f = adoptionFixture(roots, ['p1']);
    const own = 'import { clsx } from "clsx";\nexport function cn(...inputs: string[]) { return clsx(inputs); }\n';
    const manifest = { dependencies: { '@tabler/icons-react': '^3.0.0' } };
    prepareProject(f.projects.p1!, manifest);
    writeFileSync(join(f.projects.p1!, 'src', 'lib', 'utils.ts'), own);
    const url = await adoptionServer(servers, f, { sources: sources(), materials: [createAceternityCatalogueMaterials({ fetchImpl: registryFetch([]) })] });
    const refKey = (await aceternity()).results.find(item => item.ref.itemId === 'bento-grid')!.refKey;
    const prepared = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p1', refKey, entryPath: 'src/App.tsx' });
    expect(prepared.status).toBe(201);
    expect(prepared.body.catalogue.files.map((file: { path: string }) => file.path)).not.toContain('src/lib/utils.ts');
    expect(prepared.body.plan.writes?.map?.((write: { path: string }) => write.path) ?? []).not.toContain('src/lib/utils.ts');
    expect(f.tree('p1')['src/lib/utils.ts']).toBe(own);
  });

  it('refuses when an existing `@/lib/utils` does not export cn, rather than overwrite it', async () => {
    const f = adoptionFixture(roots, ['p1']);
    prepareProject(f.projects.p1!);
    writeFileSync(join(f.projects.p1!, 'src', 'lib', 'utils.ts'), 'export const other = 1;\n');
    const url = await adoptionServer(servers, f, { sources: sources(), materials: [createAceternityCatalogueMaterials({ fetchImpl: registryFetch([]) })] });
    const refKey = (await aceternity()).results.find(item => item.ref.itemId === 'bento-grid')!.refKey;
    const refused = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p1', refKey, entryPath: 'src/App.tsx' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toMatchObject({ reason: 'helper-conflict', path: 'src/lib/utils.ts', export: 'cn' });
    expect(f.tree('p1')['src/lib/utils.ts']).toBe('export const other = 1;\n');
    expect(f.storedPlans()).toBe(0);
  });

  it('reports the tabs component\'s undeclared `motion` import and refuses apply without it', async () => {
    const f = adoptionFixture(roots, ['p1']);
    prepareProject(f.projects.p1!, { dependencies: { '@radix-ui/react-tabs': '^1.1.0', cn: '^0.4.0' } });
    const url = await adoptionServer(servers, f, { sources: sources(), materials: [createAceternityCatalogueMaterials({ fetchImpl: registryFetch([]) })] });
    const refKey = (await aceternity()).results.find(item => item.ref.itemId === 'tabs')!.refKey;
    const before = f.tree('p1');
    const refused = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p1', refKey, entryPath: 'src/App.tsx' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toMatchObject({ reason: 'dependencies-unsatisfied', missing: [{ name: 'motion' }] });
    expect(f.tree('p1')).toEqual(before);
    expect(f.storedPlans()).toBe(0);
  });

  it('refuses a registry item whose bytes no longer match the inspected digest, and writes nothing', async () => {
    const f = adoptionFixture(roots, ['p1']);
    prepareProject(f.projects.p1!);
    const changed = registryText('bento-grid').replace('BentoGrid', 'BentoGridChanged');
    const url = await adoptionServer(servers, f, { sources: sources(), materials: [createAceternityCatalogueMaterials({ fetchImpl: registryFetch([], { 'bento-grid': changed }) })] });
    const refKey = (await aceternity()).results.find(item => item.ref.itemId === 'bento-grid')!.refKey;
    const before = f.tree('p1');
    const refused = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p1', refKey, entryPath: 'src/App.tsx' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe('resource-ref-stale');
    expect(f.tree('p1')).toEqual(before);
    expect(f.storedPlans()).toBe(0);
  });

  it('refuses a hand-written plan that claims Aceternity provenance outside the catalogue fetch', async () => {
    const f = adoptionFixture(roots, ['p1']);
    const url = await adoptionServer(servers, f, { sources: sources() });
    const ref = (await aceternity()).results.find(item => item.ref.itemId === 'bento-grid')!.ref;
    const forged = await post(`${url}/api/workbench/adoption/prepare`, {
      projectId: 'p1', entryPath: 'src/App.tsx', adapter: { id: 'catalogue-files', version: '1' },
      source: { implementationOrigin: 'official', resourceRef: ref },
      writes: [{ path: 'src/App.tsx', role: 'entry', contentBase64: Buffer.from('forged').toString('base64') }],
    });
    expect(forged.status).toBe(422);
    expect(forged.body.error.details.reason).toBe('catalogue-apply-required');
    expect(f.storedPlans()).toBe(0);
  });

  it('reports the declared npm dependencies a project is missing instead of applying', async () => {
    const f = adoptionFixture(roots, ['p1']);
    prepareProject(f.projects.p1!, { dependencies: {} });
    const url = await adoptionServer(servers, f, { sources: sources(), materials: [createAceternityCatalogueMaterials({ fetchImpl: registryFetch([]) })] });
    const refKey = (await aceternity()).results.find(item => item.ref.itemId === 'card-hover-effect')!.refKey;
    const refused = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p1', refKey, entryPath: 'src/App.tsx' });
    expect(refused.status).toBe(422);
    // The component's own package and, because the project has no `@/lib/utils`, the helper's.
    expect(refused.body.error.details).toMatchObject({ reason: 'dependencies-unsatisfied', missing: [{ name: 'motion' }, { name: 'cn' }] });
    expect(f.storedPlans()).toBe(0);
  });
});

describe('apply re-checks the source rights gate (G38 review round 2)', () => {
  it('a revoked owner decision refuses apply of an already-prepared plan, and nothing is written', async () => {
    const f = adoptionFixture(roots, ['p1']);
    prepareProject(f.projects.p1!);
    let revoked = false;
    const rights = (itemId: string) => ACETERNITY_FREE_RIGHTS_ASSESSMENTS.find(record => record.source.ref.itemId === itemId)!.operationRights
      .map(right => ({ operation: right.operation, decision: revoked && right.operation !== 'redistribute-unit' ? 'unknown' as const : right.decision }));
    const url = await adoptionServer(servers, f, { sources: sources(), materials: [createAceternityCatalogueMaterials({ fetchImpl: registryFetch([]), rights })] });
    const od = async (args: string[]) => { let body: any; const code = await runAdoptionCli(args, { baseUrl: url, write: value => { body = value; } }); return { code, body }; };
    const refKey = (await aceternity()).results.find(item => item.ref.itemId === 'bento-grid')!.refKey;
    const prepared = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p1', refKey, entryPath: 'src/App.tsx' });
    expect(prepared.status).toBe(201);
    const before = f.tree('p1');
    revoked = true;
    const refused = await od(['apply', '--plan', prepared.body.plan.id, '--digest', prepared.body.plan.digest, '--json']);
    expect(refused.code).toBe(3);
    expect(refused.body).toMatchObject({ status: 422, error: { details: { reason: 'source-rights-revoked' } } });
    expect(f.tree('p1')).toEqual(before);
    revoked = false;
    const applied = await od(['apply', '--plan', prepared.body.plan.id, '--digest', prepared.body.plan.digest, '--json']);
    expect(applied.body.operation).toMatchObject({ state: 'done', projectId: 'p1' });
  });

  it('reuses a saved, edited unit in a second project; the plan records its saved-unit origin, a revoked decision and a forged origin refuse', async () => {
    const f = adoptionFixture(roots, ['p1', 'p2']);
    for (const project of Object.values(f.projects)) prepareProject(project);
    let revoked = false;
    const rights = (itemId: string) => ACETERNITY_FREE_RIGHTS_ASSESSMENTS.find(record => record.source.ref.itemId === itemId)!.operationRights
      .map(right => ({ operation: right.operation, decision: revoked && right.operation !== 'redistribute-unit' ? 'unknown' as const : right.decision }));
    const materials = createAceternityCatalogueMaterials({ fetchImpl: registryFetch([]), rights });
    const url = await adoptionServer(servers, f, { sources: sources(), materials: [materials], savedUnits: true });
    const od = async (args: string[]) => { let body: any; const code = await runAdoptionCli(args, { baseUrl: url, write: value => { body = value; } }); return { code, body }; };
    const refKey = (await aceternity()).results.find(item => item.ref.itemId === 'bento-grid')!.refKey;
    const assessed = `sha256:${MANIFEST['bento-grid']}`;

    // First project: a plain catalogue apply records the source origin at its assessed revision.
    const first = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p1', refKey, entryPath: 'src/App.tsx' });
    expect(first.status).toBe(201);
    expect(first.body.plan.source.origin).toEqual({ kind: 'source', resourceRef: first.body.plan.source.resourceRef, assessedRevision: assessed });
    const applied = await od(['apply', '--plan', first.body.plan.id, '--digest', first.body.plan.digest, '--json']);
    expect(applied.body.operation).toMatchObject({ state: 'done', projectId: 'p1' });

    // The user edits the applied component, then saves the unit for private reuse.
    const edited = `${componentOf('bento-grid')}\n// Edited in project p1: tighter grid gap.\n`;
    writeFileSync(join(f.projects.p1!, 'src', 'components', 'ui', 'bento-grid.tsx'), edited);
    const saved = await post(`${url}/api/workbench/adoption/catalogue/save`, { projectId: 'p1', operationId: applied.body.operation.operationId });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const savedUnitId: string = saved.body.savedUnit.id;

    // Second project: the plan records the saved-unit origin and the original source at its assessed revision.
    const reuse = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p2', refKey, entryPath: 'src/App.tsx', savedUnitId });
    expect(reuse.status, JSON.stringify(reuse.body)).toBe(201);
    expect(reuse.body.plan.source.origin).toEqual({
      kind: 'saved-unit', savedUnitId, recordDigest: savedUnitId,
      resourceRef: expect.objectContaining({ sourceId: 'aceternity', itemId: 'bento-grid', revisionOrDigest: assessed }), assessedRevision: assessed,
    });

    // A revoked decision still refuses the saved-unit plan, and nothing is written.
    const before = f.tree('p2');
    revoked = true;
    const refused = await od(['apply', '--plan', reuse.body.plan.id, '--digest', reuse.body.plan.digest, '--json']);
    expect(refused.body).toMatchObject({ status: 422, error: { details: { reason: 'source-rights-revoked' } } });
    expect(f.tree('p2')).toEqual(before);

    // With the decision in force, the edited unit applies: its bytes are not compared with the assessed component.
    revoked = false;
    const reused = await od(['apply', '--plan', reuse.body.plan.id, '--digest', reuse.body.plan.digest, '--json']);
    expect(reused.body.operation, JSON.stringify(reused.body)).toMatchObject({ state: 'done', projectId: 'p2' });
    expect(f.tree('p2')['src/components/ui/bento-grid.tsx']).toBe(edited);

    // A plan that claims a saved-unit origin with no matching saved record is refused before anything runs.
    const manager = new CatalogueAdoptionManager({ executor: f.executor, materials: [materials], savedUnits: new CatalogueSavedUnitStore(f.executor.savedUnitsRoot) });
    const origin = reuse.body.plan.source.origin;
    const forged = (patch: Record<string, unknown>, principalId = reuse.body.plan.principalId) => manager.recheck({ ...reuse.body.plan, principalId, source: { ...reuse.body.plan.source, origin: { ...origin, ...patch } } });
    await expect(forged({ savedUnitId: 'f'.repeat(64), recordDigest: 'f'.repeat(64) })).rejects.toMatchObject({ status: 409, reason: 'saved-unit-origin-unmatched' });
    await expect(forged({ recordDigest: 'e'.repeat(64) })).rejects.toMatchObject({ status: 409, reason: 'saved-unit-origin-unmatched' });
    await expect(forged({ resourceRef: { ...origin.resourceRef, itemId: 'tabs' } })).rejects.toMatchObject({ status: 409, reason: 'saved-unit-origin-unmatched' });
    await expect(forged({}, 'member:someone-else')).rejects.toMatchObject({ status: 409, reason: 'saved-unit-origin-unmatched' });
    await expect(manager.recheck(reuse.body.plan)).resolves.toBeUndefined();
  });

  it('refuses a plan whose item bytes no longer match the assessed digest', async () => {
    const material = createAceternityCatalogueMaterials({ fetchImpl: registryFetch([]) });
    const ref = ACETERNITY_FREE_RIGHTS_ASSESSMENTS.find(record => record.source.ref.itemId === 'bento-grid')!.source.ref;
    const component = createHash('sha256').update(componentOf('bento-grid')).digest('hex');
    expect(await material.recheck!(ref, [{ path: 'src/components/ui/bento-grid.tsx', role: 'source', sha256: component }])).toBeNull();
    expect(await material.recheck!(ref, [{ path: 'src/components/ui/bento-grid.tsx', role: 'source', sha256: 'f'.repeat(64) }])).toMatchObject({ status: 409, reason: 'resource-ref-stale' });
    expect(await material.recheck!({ ...ref, revisionOrDigest: 'sha256:' + 'e'.repeat(64) }, [])).toMatchObject({ status: 409, reason: 'resource-ref-stale' });
  });

  it('the shadcn cohort answers the same re-check, so every catalogue path is re-checked at apply', async () => {
    const shadcn = createShadcnCatalogueMaterials();
    expect(typeof shadcn.recheck).toBe('function');
    expect(await shadcn.recheck!({ sourceType: 'library', sourceId: 'shadcn', itemId: 'not-selected', revisionOrDigest: 'sha256:' + 'a'.repeat(64) }, [])).toMatchObject({ status: 404, reason: 'resource-ref-unknown' });
  });
});
