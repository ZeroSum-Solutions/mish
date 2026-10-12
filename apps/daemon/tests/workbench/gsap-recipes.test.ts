import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseResourceDetailResponse, parseResourceSearchResponse } from '@mish/contracts';
import { createComponentGateForRequest } from '../../src/workbench/component-gate.js';
import { readComponentTargetForEntry } from '../../src/workbench/component-target.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { registerWorkbenchRecipeRoutes } from '../../src/routes/workbench-recipes.js';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';
import type { PlacementRuntimeStatus } from '../../src/workbench/placement/runtime-status.js';
import { resourceRefKey } from '../../src/workbench/context-ranking.js';
import { CatalogueAdoptionManager, type CatalogueAdoptionDeps } from '../../src/workbench/adoption/catalogue-adoption.js';
import { CatalogueSavedUnitStore } from '../../src/workbench/adoption/saved-units.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { runRecipeCli } from '../../src/workbench/recipes/recipe-cli.js';
import { GSAP_PIN, GSAP_RECIPE_IDS, GsapRuntimeError, createGsapRecipeMaterials, createGsapResourceSource, loadGsapRuntime } from '../../src/workbench/recipes/gsap/index.js';
import { G02_REACT_RECEIPT } from '../../src/workbench/targets/react/g02-receipt.js';
import { checkG02ReactReceipt, currentReactUnits, validateReactTargetReceipt } from '../../src/workbench/targets/react/receipt.js';
import { adoptionFixture, HTML_ENTRY, REACT_ENTRY, REACT_MANIFEST, type FixtureProject } from './gsap-recipes-fixture.js';

/**
 * AC-R08.5 (required GSAP integration) and AC-R08.2 for GSAP: discover →
 * inspect → isolated preview → apply/edit → save → second-project reuse →
 * undo through HTTP and `od`, over the existing catalogue adoption manager
 * and F5 executor (portable mover). G02: the React variant lands only in a
 * React project (`react-source/v1`); everywhere else it is a typed refusal.
 */
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const daemonRequire = createRequire(fileURLToPath(new URL('../../package.json', import.meta.url)));
const pinnedBytes = (file: string) => readFileSync(daemonRequire.resolve(`gsap/dist/${file}`));
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** Any network reference a browser would follow: script/link/img src or href, CSS url(), ES import or fetch of a remote origin. */
const REMOTE_REFERENCE = /(?:src|href)\s*=\s*["']?(?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/|import\s*(?:[^'"]*from\s*)?["'](?:https?:)?\/\/|fetch\(\s*["'](?:https?:)?\/\//iu;

async function harness(options: Pick<CatalogueAdoptionDeps, 'targetReceipts'> & { extraMaterials?: CatalogueAdoptionDeps['materials']; denyRead?: Set<string>; realGate?: boolean } = {}) {
  const f = adoptionFixture(roots);
  const materials = createGsapRecipeMaterials();
  const { extraMaterials = [], denyRead, realGate, ...deps } = options;
  const manager = new CatalogueAdoptionManager({ executor: f.executor, materials: [materials, ...extraMaterials], savedUnits: new CatalogueSavedUnitStore(join(f.root, 'work', 'saved-units')), ...deps });
  // Project authority double: a project in `denyRead` refuses reads with 403, like the real guard.
  const authorizeProjectRequest = async (_req: unknown, res: any, projectId: string) => {
    if (denyRead?.has(projectId)) { sendApiError(res, 403, 'FORBIDDEN', 'Project read denied'); return false; }
    return true;
  };
  const status = { mode: 'coordinated', activation: { adoption: 'open', gates: [] } } as unknown as PlacementRuntimeStatus;
  const app = express(); app.use(express.json({ limit: '64mb' }));
  registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async () => true, sourcesForRequest: () => [createGsapResourceSource(materials)] });
  registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: realGate ? createComponentGateForRequest({ sourcesForRequest: () => [createGsapResourceSource(materials)], factsForRequest: async (_req, projectId, insertion) => ({ componentTarget: await readComponentTargetForEntry(f.projects[projectId as FixtureProject] ?? null, insertion) }) }) : async () => {}, http: { sendApiError }, authorizeProjectRequest, placement: { adoption: f.executor, status: () => status }, catalogue: manager });
  registerWorkbenchRecipeRoutes(app, { http: { sendApiError }, gsap: materials });
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', () => done()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const od = async (args: string[]) => {
    let body: any;
    const code = args[0] === 'adoption'
      ? await runAdoptionCli(args.slice(1), { baseUrl: url, write: value => { body = value; } })
      : args[0] === 'recipe' ? await runRecipeCli(args.slice(1), { baseUrl: url, write: value => { body = value; } })
        : await runWorkbenchCli(args, { baseUrl: url, write: value => { body = value; } });
    return { code, body };
  };
  const refKeyOf = async (itemId: string) => resourceRefKey((await materials.materialize(itemId))!.ref);
  return { ...f, materials, manager, url, od, refKeyOf, denyRead };
}
const prepare = (h: Awaited<ReturnType<typeof harness>>, projectId: FixtureProject, refKey: string, entry: string) =>
  h.od(['adoption', 'catalogue-prepare', '--ref', refKey, '--project', projectId, '--entry', entry, '--json']);

describe('AC-R08.5 GSAP pin, licence and local runtime', () => {
  it('pins gsap 3.15.0 from the workspace package and records the Standard no-charge licence terms, without inventing MIT', () => {
    const runtime = loadGsapRuntime();
    expect(GSAP_PIN).toMatchObject({ packageName: 'gsap', version: '3.15.0', commit: '13e2b790546426a1a2e0e9b409f3f8dc6d6611f2', licenceUrl: 'https://gsap.com/standard-license' });
    expect(runtime.version).toBe('3.15.0');
    for (const file of ['gsap', 'ScrollTrigger', 'Flip'] as const) {
      expect(runtime.files[file].bytes.equals(pinnedBytes(`${file}.min.js`))).toBe(true);
      expect(runtime.files[file].sha256).toBe(sha(pinnedBytes(`${file}.min.js`)));
      // Upstream notices stay intact inside the shipped bytes.
      expect(runtime.files[file].bytes.toString('utf8')).toContain('Subject to the terms at https://gsap.com/standard-license');
    }
  });

  it('each notice lists only the runtime files that unit ships, with their hashes, in measured licence language (W5)', async () => {
    const materials = createGsapRecipeMaterials();
    const notice = async (itemId: string) => (await materials.materialize(itemId))!.rights.notice;
    for (const text of [await notice('section-entrance-html'), await notice('section-entrance-react')]) {
      expect(text).toMatch(/Standard ['"]?no charge['"]? licen[cs]e/iu);
      expect(text).toContain('https://gsap.com/standard-license');
      expect(text).toMatch(/visual animation/iu);
      expect(text).not.toMatch(/\bMIT\b/u);
      expect(text).not.toMatch(/outside that restriction/u);
    }
    const entrance = await notice('section-entrance-html');
    expect(entrance).toContain(`gsap-section-entrance.gsap.min.js: ${sha(pinnedBytes('gsap.min.js'))}`);
    expect(entrance).not.toContain('ScrollTrigger.min.js');
    expect(entrance).not.toContain('Flip.min.js');
    const scroll = await notice('scroll-story-html');
    expect(scroll).toContain(`gsap-scroll-story.ScrollTrigger.min.js: ${sha(pinnedBytes('ScrollTrigger.min.js'))}`);
    expect(scroll).not.toContain('Flip.min.js');
    const react = await notice('flip-filter-react');
    expect(react).not.toMatch(/\.min\.js/u);
    expect(react).toMatch(/no GSAP runtime files are shipped/iu);
    expect(react).toContain('gsap ^3.15.0');
  });

  it('fails closed with a typed reason when the pinned package is missing or a different version', () => {
    expect(() => loadGsapRuntime(() => join(tmpdir(), 'no-such-gsap-package'))).toThrow(expect.objectContaining({ reason: 'gsap-runtime-missing' }));
    const wrong = mkdtempSync(join(tmpdir(), 'gsap-wrong-')); roots.push(wrong);
    writeFileSync(join(wrong, 'package.json'), JSON.stringify({ name: 'gsap', version: '3.14.2' }));
    expect(() => loadGsapRuntime(() => wrong)).toThrow(expect.objectContaining({ reason: 'gsap-runtime-version-mismatch' }));
  });
});

describe('AC-R08.5 discover and inspect GSAP recipes (UI and od share the endpoint)', () => {
  it('lists all registered recipes in both targets with purpose, plugins, adapter, reduced-motion and need fields', async () => {
    const h = await harness();
    const search = await h.od(['search', '--category', 'motion', '--limit', '50', '--json']);
    expect(search.code).toBe(0);
    const results = parseResourceSearchResponse(search.body).results.filter(r => r.ref.sourceId === 'gsap');
    expect(results.map(r => r.ref.itemId).sort()).toEqual(GSAP_RECIPE_IDS.flatMap(id => [`${id}-html`, `${id}-react`]).sort());
    expect(GSAP_RECIPE_IDS).toEqual(expect.arrayContaining(['section-entrance', 'scroll-story', 'flip-filter', 'svg-feedback']));
    expect(new Set(GSAP_RECIPE_IDS).size).toBe(GSAP_RECIPE_IDS.length);
    for (const result of results) {
      const react = result.ref.itemId.endsWith('-react');
      expect(result).toMatchObject({
        category: 'motion', rightsStatus: 'permitted', readiness: 'unverified', implementationOrigin: 'adapted',
        compatibility: { nativeFormat: react ? 'tsx' : 'html', targets: [react ? 'react' : 'html'] },
        needDecision: 'required', motionMetadata: { state: 'reduced-compatible', basis: 'declared', sourceRevisionOrDigest: result.ref.revisionOrDigest },
        adoptionCapability: { available: false, reason: 'acceptance-receipt-pending' },
      });
      expect(result.needReason).toMatch(/owner-confirmed/iu);
      expect(result.compatibility.reason).toMatch(react ? /react-source\/v1/u : /html-artifact\/v1/u);
      expect(result.fitReasons.join(' ')).toMatch(/plugins?:/iu);
      expect(result.fitReasons.join(' ')).toMatch(/reduced motion/iu);
      expect(result.operationGrants).toEqual(expect.arrayContaining([
        { operation: 'host-preview', state: 'permitted', reason: null },
        { operation: 'incorporation', state: 'permitted', reason: null },
        { operation: 'private-reuse', state: 'permitted', reason: null },
        { operation: 'export', state: 'permitted', reason: null },
      ]));
      // Reusable-source redistribution is not cleared by the standard licence assessment.
      expect(result.operationGrants.find(g => g.operation === 'redistribution')).toMatchObject({ state: 'unknown' });
    }
    const scroll = results.find(r => r.ref.itemId === 'scroll-story-html')!;
    expect(scroll.fitReasons.join(' ')).toContain('ScrollTrigger');
    expect(results.find(r => r.ref.itemId === 'flip-filter-react')!.fitReasons.join(' ')).toContain('Flip');

    const html = results.find(r => r.ref.itemId === 'section-entrance-html')!;
    const inspected = await h.od(['inspect', '--ref', html.refKey, '--json']);
    expect(inspected.code).toBe(0);
    expect(parseResourceDetailResponse(inspected.body).resource).toMatchObject({ refKey: html.refKey, previewCapability: { available: true, kind: 'html', reason: null } });
    const viaHttp = await fetch(`${h.url}/api/workbench/resources/${html.refKey}`);
    expect(((await viaHttp.json()) as any).resource).toEqual(inspected.body.resource);
  });
});

describe('AC-R08.5 isolated preview: local runtime, no CDN, notices', () => {
  it('serves a self-contained preview document with the pinned runtime inline and a no-network CSP; od writes the same bytes', async () => {
    const h = await harness();
    for (const id of GSAP_RECIPE_IDS) {
      const refKey = await h.refKeyOf(`${id}-html`);
      const detail = parseResourceDetailResponse(((await (await fetch(`${h.url}/api/workbench/resources/${refKey}`)).json())));
      const previewUrl = detail.resource.previewCapability.url!;
      expect(previewUrl).toBe(`/api/workbench/recipes/gsap/${id}-html/preview`);
      const response = await fetch(`${h.url}${previewUrl}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/html/u);
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain('sandbox allow-scripts');
      expect(csp).not.toMatch(/https?:/u);
      const html = await response.text();
      expect(html).not.toMatch(REMOTE_REFERENCE);
      expect(html).toContain('GSAP 3.15.0');
      expect(html).toContain(pinnedBytes('gsap.min.js').toString('utf8').slice(0, 2000));
      if (id === 'scroll-story') expect(html).toContain('ScrollTrigger 3.15.0');
      if (id === 'flip-filter') expect(html).toContain('Flip 3.15.0');
      expect(html).toMatch(/prefers-reduced-motion/u);

      const out = join(h.root, `${id}.preview.html`);
      const written = await h.od(['recipe', 'preview', '--ref', refKey, '--out', out, '--json']);
      expect(written).toMatchObject({ code: 0, body: { itemId: `${id}-html`, path: out, sha256: sha(html) } });
      expect(readFileSync(out, 'utf8')).toBe(html);
    }
  });

  it('the React variant shows no substitute preview: it names the HTML rendering of the same recipe as a related item', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('section-entrance-react');
    const detail = parseResourceDetailResponse(((await (await fetch(`${h.url}/api/workbench/resources/${refKey}`)).json())));
    expect(detail.resource.previewCapability).toEqual({ available: false, kind: 'none', reason: 'react-preview-adapter-pending' });
    expect(detail.resource.relatedRefs).toEqual([{ ref: (await h.materials.materialize('section-entrance-html'))!.ref, relation: 'same-recipe-html' }]);
    expect((await fetch(`${h.url}/api/workbench/recipes/gsap/section-entrance-react/preview`)).status).toBe(404);
    expect((await fetch(`${h.url}/api/workbench/recipes/gsap/unknown/preview`)).status).toBe(404);
    expect((await h.od(['recipe', 'preview', '--ref', refKey, '--out', join(h.root, 'x.html'), '--json'])).code).toBe(3);
  });
});

describe('AC-R08.5 HTML target (html-artifact/v1): apply, edit, save, second-project reuse, undo', () => {
  it('writes an editable standalone unit with the local runtime and the GSAP notice, and undoes exactly', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('scroll-story-html');
    const prepared = await prepare(h, 'html', refKey, 'index.html');
    expect(prepared.code).toBe(0);
    expect(prepared.body.catalogue.target).toMatchObject({ adapter: 'html-artifact/v1' });
    expect(prepared.body.catalogue.files).toEqual([
      { path: 'gsap-scroll-story.html', role: 'source' },
      { path: 'gsap-scroll-story.css', role: 'style' },
      { path: 'gsap-scroll-story.js', role: 'source' },
      { path: 'gsap-scroll-story.gsap.min.js', role: 'asset' },
      { path: 'gsap-scroll-story.ScrollTrigger.min.js', role: 'asset' },
      { path: 'NOTICE.gsap-scroll-story-html.md', role: 'notice' },
      { path: 'index.html', role: 'entry' },
    ]);
    expect(prepared.body.catalogue.identity).toMatchObject({ sourceId: 'gsap', packageName: 'gsap@3.15.0', licence: expect.stringMatching(/Standard/u) });
    const applied = await h.od(['adoption', 'apply', '--plan', prepared.body.plan.id, '--digest', prepared.body.plan.digest, '--json']);
    expect(applied.body.operation).toMatchObject({ state: 'done', projectId: 'html' });

    const tree = h.tree('html');
    expect(Buffer.from(tree['gsap-scroll-story.gsap.min.js']!).equals(pinnedBytes('gsap.min.js'))).toBe(true);
    expect(Buffer.from(tree['gsap-scroll-story.ScrollTrigger.min.js']!).equals(pinnedBytes('ScrollTrigger.min.js'))).toBe(true);
    expect(tree['gsap-scroll-story.Flip.min.js']).toBeUndefined();
    for (const file of ['gsap-scroll-story.html', 'gsap-scroll-story.css', 'gsap-scroll-story.js']) expect(tree[file]).not.toMatch(REMOTE_REFERENCE);
    expect(tree['gsap-scroll-story.html']).toContain('src="./gsap-scroll-story.gsap.min.js"');
    expect(tree['gsap-scroll-story.html']).toContain('src="./gsap-scroll-story.ScrollTrigger.min.js"');
    expect(tree['gsap-scroll-story.html']).toContain('src="./gsap-scroll-story.js"');
    expect(tree['gsap-scroll-story.js']).not.toContain('gsap/all');
    expect(tree['NOTICE.gsap-scroll-story-html.md']).toContain('https://gsap.com/standard-license');
    expect(tree['NOTICE.gsap-scroll-story-html.md']).toContain(sha(pinnedBytes('ScrollTrigger.min.js')));
    expect(tree['index.html']).toContain(HTML_ENTRY);
    expect(tree['index.html']).toContain('od:adopted gsap/scroll-story-html');

    await h.od(['adoption', 'undo', '--operation', applied.body.operation.operationId, '--json']);
    expect(h.tree('html')).toEqual({ 'index.html': HTML_ENTRY });
  });
});

describe('G02 React target (react-source/v1) and AC-R08.5 React recipes', () => {
  it('a React unit is refused in a Vue project with the detected target, before any dependency check, and nothing is stored', async () => {
    const h = await harness();
    const before = h.tree('vue');
    const refused = await prepare(h, 'vue', await h.refKeyOf('flip-filter-react'), 'src/App.tsx');
    expect(refused).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'target-incompatible', adapter: 'react-source/v1', targetReason: 'target-not-react', detected: { framework: 'vue', reactMajor: null } } } } });
    expect(h.tree('vue')).toEqual(before);
    expect(h.storedPlans()).toBe(0);
    // The HTML artifact of the same recipe is a standalone unit and is not React-bound.
    const html = await prepare(h, 'vue', await h.refKeyOf('flip-filter-html'), 'src/App.tsx');
    expect(html.code).toBe(0);
  });

  it('a React project without gsap/@gsap/react is told exactly what to install; the daemon never installs packages', async () => {
    const h = await harness();
    const refused = await prepare(h, 'nogsap', await h.refKeyOf('section-entrance-react'), 'src/App.tsx');
    expect(refused).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'dependencies-unsatisfied' } } } });
    expect(refused.body.error.details.missing).toEqual([{ name: 'gsap', range: '^3.15.0' }, { name: '@gsap/react', range: '^2.1.2' }]);
    expect(h.storedPlans()).toBe(0);
  });

  it('applies an editable TSX unit, reuses it in a second React project, and undoes each without touching the other', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('section-entrance-react');
    const first = await prepare(h, 'react1', refKey, 'src/App.tsx');
    expect(first.code).toBe(0);
    expect(first.body.catalogue.target).toMatchObject({ adapter: 'react-source/v1', framework: 'react', reactMajor: 18, typescript: true });
    expect(first.body.catalogue.files).toEqual([
      { path: 'src/GsapSectionEntrance.tsx', role: 'source' },
      { path: 'src/NOTICE.gsap-section-entrance-react.md', role: 'notice' },
      { path: 'src/App.tsx', role: 'entry' },
    ]);
    expect(first.body.catalogue.dependencies.satisfied.map((d: { name: string }) => d.name)).toEqual(['gsap', '@gsap/react']);
    const a1 = await h.od(['adoption', 'apply', '--plan', first.body.plan.id, '--digest', first.body.plan.digest, '--json']);
    const unit = h.tree('react1')['src/GsapSectionEntrance.tsx']!;
    expect(unit.startsWith("'use client';")).toBe(true);
    expect(unit).toContain("from '@gsap/react'");
    expect(unit).toContain('useGSAP(');
    expect(unit).toContain('scope:');
    expect(unit).not.toContain('gsap/all');
    expect(unit).not.toMatch(REMOTE_REFERENCE);

    // Edit in project 1, then reuse in project 2: a second plan with its own preimages.
    const edited = unit.replace('Book a visit', 'Book your visit');
    writeFileSync(join(h.projects.react1, 'src/GsapSectionEntrance.tsx'), edited);
    const second = await prepare(h, 'react2', refKey, 'src/App.tsx');
    expect(second.body.plan.id).not.toBe(first.body.plan.id);
    const a2 = await h.od(['adoption', 'apply', '--plan', second.body.plan.id, '--digest', second.body.plan.digest, '--json']);
    expect(a2.body.operation).toMatchObject({ state: 'done', projectId: 'react2' });
    expect(h.tree('react2')['src/GsapSectionEntrance.tsx']).toBe(unit);

    expect((await h.od(['adoption', 'undo', '--operation', a2.body.operation.operationId, '--json'])).body.operation).toMatchObject({ kind: 'undo', state: 'done' });
    expect(h.tree('react2')).toEqual({ 'package.json': JSON.stringify(REACT_MANIFEST), 'src/App.tsx': REACT_ENTRY });
    expect(h.tree('react1')['src/GsapSectionEntrance.tsx']).toBe(edited);
    // The user's edit since apply blocks undo of project 1 instead of being discarded.
    const blocked = await h.od(['adoption', 'undo', '--operation', a1.body.operation.operationId, '--json']);
    expect(blocked).toMatchObject({ code: 3, body: { status: 409, error: { details: { reason: 'changed-since-apply' } } } });
    expect(h.tree('react1')['src/GsapSectionEntrance.tsx']).toBe(edited);
  });
});

describe('W2 target gate: nearest manifest, ambiguity and TypeScript', () => {
  it('the nearest package.json from the target directory decides, bounded by the project root', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('section-entrance-react');
    const nested = await prepare(h, 'mono', refKey, 'app/src/App.tsx');
    expect(nested.code).toBe(0);
    expect(nested.body.catalogue.target).toMatchObject({ adapter: 'react-source/v1', framework: 'react', reactMajor: 18 });
    expect(nested.body.catalogue.files[0]).toEqual({ path: 'app/src/GsapSectionEntrance.tsx', role: 'source' });
    const vue = await prepare(h, 'monovue', refKey, 'site/src/App.tsx');
    expect(vue).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'target-incompatible', targetReason: 'target-not-react', detected: { framework: 'vue' } } } } });
  });

  it('a JavaScript-only React project is refused with typescript-missing; nothing is stored', async () => {
    const h = await harness();
    const refused = await prepare(h, 'jsreact', await h.refKeyOf('svg-feedback-react'), 'src/App.tsx');
    expect(refused).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'target-incompatible', targetReason: 'typescript-missing' } } } });
    expect(h.storedPlans()).toBe(0);
  });
});

describe('W1 G02 receipt gate (react-source/v1)', () => {
  it('the production gate accepts the committed receipt for every registered unit', () => {
    expect(checkG02ReactReceipt()).toEqual({ ok: true });
    expect(validateReactTargetReceipt(G02_REACT_RECEIPT, currentReactUnits())).toEqual({ ok: true });
  });
  it('until a receipt validates, React apply refuses with target-receipt-pending; HTML artifacts are unaffected', async () => {
    const h = await harness({ targetReceipts: { 'react-source/v1': () => ({ ok: false, reason: 'receipt-missing' }) } });
    const refused = await prepare(h, 'react1', await h.refKeyOf('section-entrance-react'), 'src/App.tsx');
    expect(refused).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'target-receipt-pending', adapter: 'react-source/v1', receiptReason: 'receipt-missing' } } } });
    expect(h.storedPlans()).toBe(0);
    expect((await prepare(h, 'html', await h.refKeyOf('section-entrance-html'), 'index.html')).code).toBe(0);
  });

  it('a non-React project still gets target-incompatible first, not the receipt gate', async () => {
    const h = await harness({ targetReceipts: { 'react-source/v1': () => ({ ok: false, reason: 'receipt-missing' }) } });
    const refused = await prepare(h, 'vue', await h.refKeyOf('section-entrance-react'), 'src/App.tsx');
    expect(refused.body.error.details.reason).toBe('target-incompatible');
  });
});

describe('W4 AC-R08.5 save and reuse: the saved edited unit lands in a second project (HTTP and od)', () => {
  it('saves the edited unit privately and reuses those exact bytes elsewhere, with its notice, target gate and its own undo', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('flip-filter-react');
    const first = await prepare(h, 'react1', refKey, 'src/App.tsx');
    const applied = await h.od(['adoption', 'apply', '--plan', first.body.plan.id, '--digest', first.body.plan.digest, '--json']);
    const unitPath = join(h.projects.react1, 'src/GsapFlipFilter.tsx');
    const edited = readFileSync(unitPath, 'utf8').replace("label: 'Implants'", "label: 'Implant care'").replace('"Implants"', '"Implant care"');
    expect(edited).not.toBe(readFileSync(unitPath, 'utf8'));
    writeFileSync(unitPath, edited);

    const saved = await h.od(['adoption', 'catalogue-save', '--project', 'react1', '--operation', applied.body.operation.operationId, '--json']);
    expect(saved.code).toBe(0);
    expect(saved.body.savedUnit).toMatchObject({ refKey, sourceProjectId: 'react1', target: 'react-source/v1', files: [{ path: 'GsapFlipFilter.tsx', role: 'source', sha256: sha(edited) }] });
    // Saving again is idempotent for the same bytes.
    expect((await h.od(['adoption', 'catalogue-save', '--project', 'react1', '--operation', applied.body.operation.operationId, '--json'])).body.savedUnit.id).toBe(saved.body.savedUnit.id);
    const listed = await fetch(`${h.url}/api/workbench/adoption/catalogue/saved?refKey=${refKey}`);
    expect(((await listed.json()) as any).savedUnits.map((unit: { id: string }) => unit.id)).toEqual([saved.body.savedUnit.id]);
    expect((await h.od(['adoption', 'catalogue-saved', '--ref', refKey, '--json'])).body.savedUnits).toHaveLength(1);

    // Project 1 changes again after saving: the saved unit keeps the bytes it saved.
    writeFileSync(unitPath, `${edited}\n// later local change\n`);
    const reuse = await fetch(`${h.url}/api/workbench/adoption/catalogue/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'react2', refKey, entryPath: 'src/App.tsx', savedUnitId: saved.body.savedUnit.id }) });
    expect(reuse.status).toBe(201);
    const plan = (await reuse.json()) as any;
    expect(plan.catalogue.files.map((file: { path: string }) => file.path)).toEqual(['src/GsapFlipFilter.tsx', 'src/NOTICE.gsap-flip-filter-react.md', 'src/App.tsx']);
    const a2 = await h.od(['adoption', 'apply', '--plan', plan.plan.id, '--digest', plan.plan.digest, '--json']);
    expect(a2.body.operation).toMatchObject({ state: 'done', projectId: 'react2' });
    expect(h.tree('react2')['src/GsapFlipFilter.tsx']).toBe(edited);
    expect(h.tree('react2')['src/NOTICE.gsap-flip-filter-react.md']).toContain(`Saved unit ${saved.body.savedUnit.id}`);
    // The saved unit still passes the target gate of the new project.
    const odReuse = await h.od(['adoption', 'catalogue-prepare', '--ref', refKey, '--project', 'vue', '--entry', 'src/App.tsx', '--saved-unit', saved.body.savedUnit.id, '--json']);
    expect(odReuse.body.error.details.reason).toBe('target-incompatible');

    await h.od(['adoption', 'undo', '--operation', a2.body.operation.operationId, '--json']);
    expect(h.tree('react2')).toEqual({ 'package.json': JSON.stringify(REACT_MANIFEST), 'src/App.tsx': REACT_ENTRY });
  });

  it('refuses to save an undone apply, an unknown operation, and a saved unit of another ref', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('svg-feedback-html');
    const first = await prepare(h, 'html', refKey, 'index.html');
    const applied = await h.od(['adoption', 'apply', '--plan', first.body.plan.id, '--digest', first.body.plan.digest, '--json']);
    const saved = await h.od(['adoption', 'catalogue-save', '--project', 'html', '--operation', applied.body.operation.operationId, '--json']);
    expect(saved.body.savedUnit.files.map((file: { path: string }) => file.path)).toEqual(['gsap-svg-feedback.html', 'gsap-svg-feedback.css', 'gsap-svg-feedback.js', 'gsap-svg-feedback.gsap.min.js']);
    const other = await prepare(h, 'react1', await h.refKeyOf('svg-feedback-react'), 'src/App.tsx');
    expect(other.code).toBe(0);
    const mismatch = await h.od(['adoption', 'catalogue-prepare', '--ref', await h.refKeyOf('svg-feedback-react'), '--project', 'react1', '--entry', 'src/App.tsx', '--saved-unit', saved.body.savedUnit.id, '--json']);
    expect(mismatch).toMatchObject({ code: 3, body: { status: 409, error: { details: { reason: 'saved-unit-ref-mismatch' } } } });
    await h.od(['adoption', 'undo', '--operation', applied.body.operation.operationId, '--json']);
    const undone = await h.od(['adoption', 'catalogue-save', '--project', 'html', '--operation', applied.body.operation.operationId, '--json']);
    expect(undone).toMatchObject({ code: 3, body: { status: 409, error: { details: { reason: 'operation-not-applied' } } } });
    expect((await h.od(['adoption', 'catalogue-save', '--project', 'html', '--operation', 'apply-unknown', '--json'])).body.status).toBe(404);
    expect((await h.od(['adoption', 'catalogue-prepare', '--ref', refKey, '--project', 'html', '--entry', 'index.html', '--saved-unit', 'f'.repeat(64), '--json'])).body.status).toBe(404);
  });
});

describe('Sol B5/6 WARN: removing a saved unit (HTTP and od)', () => {
  it('od workbench adoption catalogue-saved delete <id> removes the caller\'s unit; a second delete is 404', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('section-entrance-html');
    const prepared = await prepare(h, 'html', refKey, 'index.html');
    const applied = await h.od(['adoption', 'apply', '--plan', prepared.body.plan.id, '--digest', prepared.body.plan.digest, '--json']);
    const saved = await h.od(['adoption', 'catalogue-save', '--project', 'html', '--operation', applied.body.operation.operationId, '--json']);
    const id = saved.body.savedUnit.id as string;
    expect((await h.od(['adoption', 'catalogue-saved', '--ref', refKey, '--json'])).body.savedUnits.map((unit: { id: string }) => unit.id)).toEqual([id]);
    expect(await h.od(['adoption', 'catalogue-saved', 'delete', id, '--json'])).toEqual({ code: 0, body: { deleted: id } });
    expect((await h.od(['adoption', 'catalogue-saved', '--ref', refKey, '--json'])).body.savedUnits).toEqual([]);
    expect(await h.od(['adoption', 'catalogue-saved', 'delete', id, '--json'])).toMatchObject({ code: 3, body: { status: 404, error: { details: { reason: 'saved-unit-unknown' } } } });
    const response = await fetch(`${h.url}/api/workbench/adoption/catalogue/saved/${'f'.repeat(64)}`, { method: 'DELETE' });
    expect(response.status).toBe(404);
  });
});

describe('NITs: preview output safety and listing errors', () => {
  it('od recipe preview creates the output exclusively unless --force, and never writes through a symlink', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('section-entrance-html');
    const out = join(h.root, 'preview.html');
    expect((await h.od(['recipe', 'preview', '--ref', refKey, '--out', out, '--json'])).code).toBe(0);
    expect(await h.od(['recipe', 'preview', '--ref', refKey, '--out', out, '--json'])).toMatchObject({ code: 2, body: { error: { code: 'output-exists' } } });
    expect((await h.od(['recipe', 'preview', '--ref', refKey, '--out', out, '--force', '--json'])).code).toBe(0);
    const target = join(h.root, 'elsewhere.txt'); writeFileSync(target, 'keep');
    const link = join(h.root, 'link.html'); symlinkSync(target, link);
    expect(await h.od(['recipe', 'preview', '--ref', refKey, '--out', link, '--force', '--json'])).toMatchObject({ code: 2, body: { error: { code: 'output-symlink' } } });
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('only a missing runtime makes the listing unavailable; any other failure surfaces as an error', async () => {
    const missing = createGsapResourceSource(createGsapRecipeMaterials({ runtime: () => { throw new GsapRuntimeError('gsap-runtime-missing', 'missing'); } }));
    expect((await missing.list({ principalId: 'local-owner' })).status).toMatchObject({ state: 'unavailable', reason: 'gsap-runtime-missing' });
    const broken = createGsapResourceSource(createGsapRecipeMaterials({ runtime: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } }));
    await expect(broken.list({ principalId: 'local-owner' })).rejects.toThrow('EACCES');
  });
});

describe('fail-closed follow-ups: receipt-covered React majors and nested dependency scope', () => {
  it('admits only React majors a validating receipt covers: React 17 and 19 get target-receipt-pending naming the major', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('section-entrance-react');
    for (const [project, major] of [['react19', 19], ['react17', 17]] as const) {
      const refused = await prepare(h, project, refKey, 'src/App.tsx');
      expect(refused).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'target-receipt-pending', adapter: 'react-source/v1', receiptReason: 'react-major-uncovered', reactMajor: major, coveredReactMajors: [18] } } } });
      expect(refused.body.error.message).toContain(`React ${major}`);
    }
    expect(h.storedPlans()).toBe(0);
    expect((await prepare(h, 'react1', refKey, 'src/App.tsx')).code).toBe(0);
  });

  it('Sol B5/6 BLOCK: a range spanning majors is decided by the installed React; >=18.0.0 with React 19 installed is refused', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('section-entrance-react');
    const refused = await prepare(h, 'rangereact19', refKey, 'src/App.tsx');
    expect(refused).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'target-receipt-pending', adapter: 'react-source/v1', receiptReason: 'react-major-uncovered', reactMajor: 19, coveredReactMajors: [18] } } } });
    expect(h.storedPlans()).toBe(0);
  });

  it('Sol B5/6 BLOCK: without a resolvable installed react and react-dom inside the project root, the target is refused react-version-unresolved', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('section-entrance-react');
    for (const project of ['uninstalled', 'escape'] as const) {
      const refused = await prepare(h, project, refKey, 'src/App.tsx');
      expect(refused, project).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'target-incompatible', adapter: 'react-source/v1', targetReason: 'react-version-unresolved' } } } });
    }
    expect(h.storedPlans()).toBe(0);
  });

  it('Sol B5/6 WARN: gsap ^3.0.0 with GSAP 3.12.5 installed is below the recipe minimum 3.15.0 and is refused dependency-below-minimum', async () => {
    const h = await harness();
    const refused = await prepare(h, 'oldgsap', await h.refKeyOf('section-entrance-react'), 'src/App.tsx');
    expect(refused).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'dependency-below-minimum' } } } });
    expect(refused.body.error.details.belowMinimum).toEqual([{ name: 'gsap', minimum: '3.15.0', declared: '^3.0.0', installed: '3.12.5' }]);
    expect(h.storedPlans()).toBe(0);
  });

  it('Sol B5/6 WARN: a declared range whose lower bound is below the minimum is refused even when a new enough GSAP is installed', async () => {
    const h = await harness();
    const refused = await prepare(h, 'loosegsap', await h.refKeyOf('section-entrance-react'), 'src/App.tsx');
    expect(refused).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'dependency-below-minimum' } } } });
    expect(refused.body.error.details.belowMinimum).toEqual([{ name: 'gsap', minimum: '3.15.0', declared: '^3.0.0', installed: '3.15.0' }]);
    expect(h.storedPlans()).toBe(0);
  });

  it('an edit to the nearest package.json or its lockfile between prepare and apply is refused with no mutation', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('section-entrance-react');
    const manifest = join(h.projects.mono, 'app', 'package.json');
    const original = readFileSync(manifest, 'utf8');
    const first = await prepare(h, 'mono', refKey, 'app/src/App.tsx');
    expect(first.code).toBe(0);
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), dependencies: { ...JSON.parse(original).dependencies, gsap: '^3.14.0' } }));
    const before = h.tree('mono');
    const refused = await h.od(['adoption', 'apply', '--plan', first.body.plan.id, '--digest', first.body.plan.digest, '--json']);
    expect(refused).toMatchObject({ code: 3, body: { status: 409, error: { details: { reason: 'dependency-set-changed' } } } });
    expect(h.tree('mono')).toEqual(before);

    writeFileSync(manifest, original);
    const second = await prepare(h, 'mono', refKey, 'app/src/App.tsx');
    writeFileSync(join(h.projects.mono, 'app', 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const lockRefused = await h.od(['adoption', 'apply', '--plan', second.body.plan.id, '--digest', second.body.plan.digest, '--json']);
    expect(lockRefused.body.error.details.reason).toBe('dependency-set-changed');
    rmSync(join(h.projects.mono, 'app', 'pnpm-lock.yaml'));
    const applied = await h.od(['adoption', 'apply', '--plan', second.body.plan.id, '--digest', second.body.plan.digest, '--json']);
    expect(applied.body.operation).toMatchObject({ state: 'done' });
  });
});

describe('round 3: runtime asset integrity, receipt source coverage, dependency ancestry, source-project authority', () => {
  it('W2 a runtime file edited in project A is refused at save and never reaches project B', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('svg-feedback-html');
    const first = await prepare(h, 'html', refKey, 'index.html');
    const applied = await h.od(['adoption', 'apply', '--plan', first.body.plan.id, '--digest', first.body.plan.digest, '--json']);
    const runtimePath = join(h.projects.html, 'gsap-svg-feedback.gsap.min.js');
    const stripped = readFileSync(runtimePath, 'utf8').replace(/^\/\*![\s\S]*?\*\/\s*/u, '');
    expect(stripped).not.toContain('standard-license');
    writeFileSync(runtimePath, stripped);
    const refused = await h.od(['adoption', 'catalogue-save', '--project', 'html', '--operation', applied.body.operation.operationId, '--json']);
    expect(refused).toMatchObject({ code: 3, body: { status: 409, error: { details: { reason: 'runtime-asset-modified', path: 'gsap-svg-feedback.gsap.min.js' } } } });
  });

  it('W2 reuse writes the pinned runtime bytes and a notice built from the bytes it writes, whatever a stored record holds', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('svg-feedback-html');
    const material = (await h.materials.materialize('svg-feedback-html'))!;
    const forged = new CatalogueSavedUnitStore(join(h.root, 'work', 'saved-units')).save({
      principalId: 'local-owner', ref: material.ref, title: material.title, target: 'html-artifact/v1', sourceProjectId: 'html', sourceOperationId: 'apply-x',
      files: material.files.map(file => file.role === 'asset' ? { ...file, bytes: Buffer.from('/* stripped */') } : file) as never,
    });
    const reuse = await h.od(['adoption', 'catalogue-prepare', '--ref', refKey, '--project', 'vue', '--entry', 'src/App.tsx', '--saved-unit', forged.id, '--json']);
    const applied = await h.od(['adoption', 'apply', '--plan', reuse.body.plan.id, '--digest', reuse.body.plan.digest, '--json']);
    expect(applied.body.operation.state).toBe('done');
    const tree = h.tree('vue');
    expect(Buffer.from(tree['src/gsap-svg-feedback.gsap.min.js']!).equals(pinnedBytes('gsap.min.js'))).toBe(true);
    expect(tree['src/NOTICE.gsap-svg-feedback-html.md']).toContain(`gsap-svg-feedback.gsap.min.js: ${sha(pinnedBytes('gsap.min.js'))}`);
  });

  it('the receipt gate covers only the sources its receipt names: another react-source/v1 source stays pending', async () => {
    const other = {
      sourceId: 'react-bits' as const,
      async materialize(itemId: string) {
        return { ref: { sourceType: 'library' as const, sourceId: 'react-bits' as const, itemId, revisionOrDigest: 'sha256:1' }, title: 'Blur text', origin: 'adapted' as const, target: 'react-source/v1' as const,
          rights: { status: 'permitted' as const, licence: 'test', notice: 'test notice', sourceUrl: 'https://example.com', packageName: 'test' },
          files: [{ path: 'BlurText.tsx', role: 'source' as const, bytes: Buffer.from('export default function BlurText() { return null; }\n') }], packageDependencies: [] };
      },
    };
    const h = await harness({ extraMaterials: [other] });
    const refKey = resourceRefKey((await other.materialize('blur-text')).ref);
    const refused = await prepare(h, 'react1', refKey, 'src/App.tsx');
    expect(refused).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'target-receipt-pending', receiptReason: 'receipt-source-uncovered' } } } });
  });

  it('a nearer package.json or a new tsconfig.json between prepare and apply is refused', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('section-entrance-react');
    const nearer = await prepare(h, 'mono', refKey, 'app/src/App.tsx');
    writeFileSync(join(h.projects.mono, 'app', 'src', 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }));
    expect((await h.od(['adoption', 'apply', '--plan', nearer.body.plan.id, '--digest', nearer.body.plan.digest, '--json'])).body.error.details.reason).toBe('dependency-set-changed');
    rmSync(join(h.projects.mono, 'app', 'src', 'package.json'));
    const tsconfig = await prepare(h, 'mono', refKey, 'app/src/App.tsx');
    writeFileSync(join(h.projects.mono, 'app', 'tsconfig.json'), '{"compilerOptions":{"jsx":"preserve"}}');
    expect((await h.od(['adoption', 'apply', '--plan', tsconfig.body.plan.id, '--digest', tsconfig.body.plan.digest, '--json'])).body.error.details.reason).toBe('dependency-set-changed');
  });

  it('reuse re-checks read access to the project the unit was saved from', async () => {
    const h = await harness({ denyRead: new Set() });
    const refKey = await h.refKeyOf('flip-filter-react');
    const first = await prepare(h, 'react1', refKey, 'src/App.tsx');
    const applied = await h.od(['adoption', 'apply', '--plan', first.body.plan.id, '--digest', first.body.plan.digest, '--json']);
    const saved = await h.od(['adoption', 'catalogue-save', '--project', 'react1', '--operation', applied.body.operation.operationId, '--json']);
    h.denyRead!.add('react1');
    const refused = await h.od(['adoption', 'catalogue-prepare', '--ref', refKey, '--project', 'react2', '--entry', 'src/App.tsx', '--saved-unit', saved.body.savedUnit.id, '--json']);
    expect(refused).toMatchObject({ code: 3, body: { status: 403 } });
    expect(h.storedPlans()).toBe(1);
  });
});

it.each([['html', 'section-entrance-html', 'index.html'], ['react1', 'section-entrance-react', 'src/App.tsx'], ['mono', 'section-entrance-react', 'app/src/App.tsx'], ['vue', 'section-entrance-html', 'src/App.tsx']] as const)('D17 real HTTP hook preserves GSAP prepare/apply without acceptance evidence (%s)', async (projectId, itemId, entry) => {
  const h = await harness({ realGate: true });
  const refKey = await h.refKeyOf(itemId);
  const source = await createGsapResourceSource(h.materials).list({ principalId: 'local-daemon' });
  expect(source.items.find(item => item.ref.itemId === itemId)?.acceptanceEvidence).toBeUndefined();
  const prepared = await prepare(h, projectId, refKey, entry);
  expect(prepared).toMatchObject({ code: 0 });
  const applied = await h.od(['adoption', 'apply', '--plan', prepared.body.plan.id, '--digest', prepared.body.plan.digest, '--json']);
  expect(applied.body.operation).toMatchObject({ state: 'done', projectId });
});
