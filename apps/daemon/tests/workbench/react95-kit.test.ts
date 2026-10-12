import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { build } from 'esbuild';
// @ts-expect-error -- jsdom has no bundled type declarations.
import { JSDOM, VirtualConsole } from 'jsdom';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResourceDetailResponse, parseResourceSearchResponse, type ResourceCandidate } from '@open-design/contracts';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { registerWorkbenchKitRoutes } from '../../src/routes/workbench-kits.js';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';
import type { PlacementRuntimeStatus } from '../../src/workbench/placement/runtime-status.js';
import { resourceRefKey } from '../../src/workbench/context-ranking.js';
import { CatalogueAdoptionManager } from '../../src/workbench/adoption/catalogue-adoption.js';
import { CatalogueSavedUnitStore } from '../../src/workbench/adoption/saved-units.js';
import type { ResourceSourceAdapter } from '../../src/workbench/resources.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { runRecipeCli } from '../../src/workbench/recipes/recipe-cli.js';
import { REACT95_KIT } from '../../src/workbench/kits/react95/kit.generated.js';
import { REACT95_PREVIEWS } from '../../src/workbench/kits/react95/preview.generated.js';
import { createReact95Materials, createReact95ResourceSource } from '../../src/workbench/kits/react95/materials.js';
import { G02_REACT95_RECEIPT } from '../../src/workbench/targets/react/g02-react95-receipt.js';
import { createGsapRecipeMaterials, createGsapResourceSource } from '../../src/workbench/recipes/gsap/index.js';
import { adoptionFixture } from './gsap-recipes-fixture.js';
import { typecheckUnit } from './react95-typecheck.js';

/**
 * AC-R17.2 (isolated preview), AC-R17.3 (apply/edit/save/second-project
 * insertion/build/action/undo with notices, UI/API/od parity, per-component
 * tracking) and AC-R17.4 (retro query finds the kit; ordinary searches do
 * not; Dell 1996 stays a subordinate reference) over the existing catalogue
 * adoption manager and the F5 executor (portable mover).
 */
const MANIFEST = { dependencies: { react: '18.3.1', 'react-dom': '18.3.1', 'styled-components': '^5.3.11' }, devDependencies: { typescript: '5.9.3', '@types/styled-components': '^5.1.36' } };
const ENTRY = 'export default function App() {\n  return <main>original</main>;\n}\n';
const INSTALL = { react: '18.3.1', 'react-dom': '18.3.1', 'styled-components': '5.3.11', '@types/styled-components': '5.1.36' };
const PROJECTS = {
  r95a: { 'package.json': JSON.stringify(MANIFEST), 'src/App.tsx': ENTRY },
  r95b: { 'package.json': JSON.stringify(MANIFEST), 'src/App.tsx': ENTRY },
  sc6: { 'package.json': JSON.stringify({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, 'styled-components': '^6.1.0' } }), 'src/App.tsx': ENTRY },
  nosc: { 'package.json': JSON.stringify({ dependencies: { react: '18.3.1', 'react-dom': '18.3.1' }, devDependencies: { typescript: '5.9.3' } }), 'src/App.tsx': ENTRY },
  oldsc: { 'package.json': JSON.stringify({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, 'styled-components': '^5.0.0' } }), 'src/App.tsx': ENTRY },
  react19: { 'package.json': JSON.stringify({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, react: '19.1.0', 'react-dom': '19.1.0' } }), 'src/App.tsx': ENTRY },
  vue: { 'package.json': JSON.stringify({ dependencies: { vue: '^3.5.0', 'styled-components': '^5.3.11' } }), 'src/App.tsx': ENTRY },
  // Declares ^5.3.11, but the lockfile installed v6: the installed version decides.
  sc6installed: { 'package.json': JSON.stringify(MANIFEST), 'src/App.tsx': ENTRY },
  // Declares ^5.3.11 with nothing installed: no covered version can be read.
  scabsent: { 'package.json': JSON.stringify(MANIFEST), 'src/App.tsx': ENTRY },
} as const;
type Project = keyof typeof PROJECTS;
const INSTALLED: Partial<Record<Project, Record<string, Record<string, string>>>> = {
  r95a: { '': INSTALL }, r95b: { '': INSTALL }, sc6: { '': { ...INSTALL, 'styled-components': '6.1.0' } }, nosc: { '': { react: '18.3.1', 'react-dom': '18.3.1' } },
  oldsc: { '': { ...INSTALL, 'styled-components': '5.1.0' } }, sc6installed: { '': { ...INSTALL, 'styled-components': '6.1.0' } },
  scabsent: { '': { react: '18.3.1', 'react-dom': '18.3.1', '@types/styled-components': '5.1.36' } }, react19: { '': { ...INSTALL, react: '19.1.0', 'react-dom': '19.1.0' } }, vue: { '': { vue: '3.5.0' } },
};
const daemonRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const REMOTE_REFERENCE = /(?:src|href)\s*=\s*["']?(?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/|import\s*(?:[^'"]*from\s*)?["'](?:https?:)?\/\/|fetch\(\s*["'](?:https?:)?\/\//iu;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A reference-only retro analysis (Awesome DESIGN.md's Dell 1996) and an ordinary modern block, as a second source. */
function referenceSource(): ResourceSourceAdapter {
  const base = {
    rightsStatus: 'permitted' as const, fitReasons: ['fixture'], adoptionCapability: { available: false, reason: 'reference-only' },
    operationGrants: [], needDecision: 'reference-only' as const, needReason: 'Reference fixture',
  };
  const items: ResourceCandidate[] = [
    { ...base, ref: { sourceType: 'reference', sourceId: 'design-md', itemId: 'dell-1996', revisionOrDigest: 'sha256:dell' }, title: 'Dell 1996 DESIGN.md analysis', category: 'reference', readiness: 'reference-only',
      compatibility: { nativeFormat: 'markdown', targets: [], state: 'unsupported', reason: 'reference' }, previewCapability: { available: false, kind: 'none', reason: 'reference-only' },
      sourceAttribution: { title: 'Awesome DESIGN.md · Dell 1996' }, styleClass: 'retro', styleTags: ['windows95', 'retro'], admissionStage: 'reference-only' },
    { ...base, ref: { sourceType: 'reference', sourceId: 'design-md', itemId: 'linear-settings', revisionOrDigest: 'sha256:linear' }, title: 'Premium settings form layout', category: 'reference', readiness: 'reference-only',
      compatibility: { nativeFormat: 'markdown', targets: [], state: 'unsupported', reason: 'reference' }, previewCapability: { available: false, kind: 'none', reason: 'reference-only' },
      sourceAttribution: { title: 'Awesome DESIGN.md · Linear' }, styleTags: ['modern'], admissionStage: 'reference-only' },
  ];
  return { sourceId: 'design-md', list: async () => ({ items, status: { sourceId: 'design-md', state: 'searched', reason: null, itemCount: items.length, listingDigest: 'fixture' } }) };
}

async function harness() {
  const f = adoptionFixture<Project>(roots, PROJECTS, INSTALLED);
  const kit = createReact95Materials();
  const gsap = createGsapRecipeMaterials();
  const manager = new CatalogueAdoptionManager({ executor: f.executor, materials: [kit, gsap], savedUnits: new CatalogueSavedUnitStore(join(f.root, 'work', 'saved-units')) });
  const status = { mode: 'coordinated', activation: { adoption: 'open', gates: [] } } as unknown as PlacementRuntimeStatus;
  const app = express(); app.use(express.json({ limit: '64mb' }));
  registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async () => true, sourcesForRequest: () => [createReact95ResourceSource(kit), createGsapResourceSource(gsap), referenceSource()] });
  registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {}, http: { sendApiError }, authorizeProjectRequest: async () => true, placement: { adoption: f.executor, status: () => status }, catalogue: manager });
  registerWorkbenchKitRoutes(app, { http: { sendApiError }, react95: kit });
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', () => done()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const od = async (args: string[]) => {
    let body: any;
    const write = (value: unknown) => { body = value; };
    const code = args[0] === 'adoption' ? await runAdoptionCli(args.slice(1), { baseUrl: url, write })
      : args[0] === 'recipe' ? await runRecipeCli(args.slice(1), { baseUrl: url, write }) : await runWorkbenchCli(args, { baseUrl: url, write });
    return { code, body };
  };
  const refKeyOf = async (itemId: string) => resourceRefKey((await kit.materialize(itemId))!.ref);
  let queries = 0;
  const search = async (query: string) => {
    const file = join(f.root, `query-${queries++}.txt`);
    writeFileSync(file, query);
    const result = await od(['search', '--prompt-file', file, '--limit', '100', '--json']);
    if (result.code !== 0) throw new Error(JSON.stringify(result.body));
    return parseResourceSearchResponse(result.body).results;
  };
  return { ...f, kit, manager, url, od, refKeyOf, search };
}
const prepare = (h: Awaited<ReturnType<typeof harness>>, projectId: Project, refKey: string, entry = 'src/App.tsx', extra: string[] = []) =>
  h.od(['adoption', 'catalogue-prepare', '--ref', refKey, '--project', projectId, '--entry', entry, ...extra, '--json']);

describe('AC-R17.2 isolated enlarged preview (HTTP, UI path and od share it)', () => {
  it('serves the receipt-hashed self-contained preview with a no-network CSP, its theme switch inside, and no font file', async () => {
    const h = await harness();
    for (const template of REACT95_KIT.templates) {
      const refKey = await h.refKeyOf(`template-${template.id}`);
      const detail = parseResourceDetailResponse(await (await fetch(`${h.url}/api/workbench/resources/${refKey}`)).json());
      // The declared styled-components dependency makes it a styled-components preview (AC-R07 preamble).
      expect(detail.resource.previewCapability).toEqual({ available: true, kind: 'html', url: `/api/workbench/kits/react95/template-${template.id}/preview`, reason: null, adapter: 'styled-components' });
      const response = await fetch(`${h.url}${detail.resource.previewCapability.url}`);
      expect(response.status).toBe(200);
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp).toContain('sandbox allow-scripts');
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("font-src 'none'");
      expect(csp).not.toMatch(/https?:/u);
      const html = await response.text();
      expect(sha(html)).toBe(G02_REACT95_RECEIPT!.templates.find(entry => entry.template === template.id)!.outputs.preview.sha256);
      expect(html).not.toMatch(REMOTE_REFERENCE);
      expect(html).not.toMatch(/@font-face|\.woff2?|ms_sans_serif/u);
      expect(html).toContain('class="od-preview-themes"');
      expect(html).toContain(`data-od-react95="${template.id}"`);
      const out = join(h.root, `${template.id}.html`);
      expect(await h.od(['recipe', 'preview', '--ref', refKey, '--out', out, '--json'])).toMatchObject({ code: 0, body: { itemId: `template-${template.id}`, sha256: sha(html) } });
      expect(readFileSync(out, 'utf8')).toBe(html);
    }
    expect((await fetch(`${h.url}/api/workbench/kits/react95/component-window/preview`)).status).toBe(404);
  });

  it('refuses to serve a preview that differs from the receipt', async () => {
    const tampered = createReact95Materials({ previews: { ...REACT95_PREVIEWS, 'window-app': `${REACT95_PREVIEWS['window-app']}<!-- changed -->` } });
    await expect(tampered.preview('template-window-app')).rejects.toMatchObject({ reason: 'react95-preview-unverified' });
  });
});

describe('AC-R17.3 per-component tracking and readiness from the receipt', () => {
  it('lists both templates usable with receipt evidence and every shipped component individually, none usable', async () => {
    const h = await harness();
    const results = (await h.search('react95')).filter(result => result.ref.sourceId === 'react95');
    const templates = results.filter(result => result.category === 'template');
    expect(templates.map(result => result.ref.itemId).sort()).toEqual(['template-settings-form', 'template-window-app']);
    for (const template of templates) {
      expect(template).toMatchObject({
        readiness: 'usable', rightsStatus: 'permitted', styleClass: 'retro', admissionStage: 'admitted', needDecision: 'required',
        adoptionCapability: { available: true, reason: null }, compatibility: { nativeFormat: 'tsx', targets: ['react'], state: 'compatible' },
        acceptanceEvidence: { sourceDigest: template.ref.revisionOrDigest, passed: true },
      });
      expect(template.styleTags).toEqual(expect.arrayContaining(['windows95', 'react95']));
      expect(template.operationGrants.find(grant => grant.operation === 'redistribution')).toMatchObject({ state: 'unknown' });
    }
    const components = results.filter(result => result.category === 'component');
    expect(components).toHaveLength(REACT95_KIT.inventory.components.length);
    expect(components).toHaveLength(40);
    expect(components.every(result => result.readiness !== 'usable' && !result.adoptionCapability.available && !result.previewCapability.available)).toBe(true);
    const needsRepair = components.filter(result => result.readiness === 'needs-repair').map(result => result.ref.itemId).sort();
    expect(needsRepair).toEqual(['component-menu-list', 'component-text-input', 'component-window']);
    expect(components.find(result => result.ref.itemId === 'component-legacy-bar')!.title).toContain('deprecated upstream');
    expect(components.find(result => result.ref.itemId === 'component-slider')!.fitReasons).toContain('Not used by an admitted template');
  });

  it('a template whose receipt is missing stays unverified and not adoptable', async () => {
    const kit = createReact95Materials({ receipt: null });
    const listed = await createReact95ResourceSource(kit, { receipt: null }).list({ principalId: 'p' } as never);
    const template = listed.items.find(item => item.ref.itemId === 'template-window-app')!;
    expect(template).toMatchObject({ readiness: 'unverified', adoptionCapability: { available: false, reason: 'acceptance-receipt-pending' } });
    expect(template.acceptanceEvidence).toBeUndefined();
  });
});

describe('AC-R17.3 apply, edit, save, second-project insertion, build, action and undo (HTTP and od)', () => {
  it('writes the template, adapter, vendored closure, licence and notice; saves the edited unit; inserts it elsewhere; builds and acts; undoes', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('template-window-app');
    const first = await prepare(h, 'r95a', refKey);
    expect(first.code).toBe(0);
    expect(first.body.catalogue.target).toMatchObject({ adapter: 'react-source/v1', framework: 'react', reactMajor: 18, typescript: true, styleRuntime: 'styled-components' });
    const paths = first.body.catalogue.files.map((file: { path: string }) => file.path);
    expect(paths).toEqual(expect.arrayContaining(['src/React95WindowApp.tsx', 'src/React95Theme.d.ts', 'src/react95.Window.Window.tsx', 'src/react95.LICENSE', 'src/NOTICE.react95-template-window-app.md', 'src/App.tsx']));
    // One directory: the executor writes only into existing directories.
    expect(paths.every((path: string) => /^src\/[^/]+$/u.test(path))).toBe(true);
    expect(paths.some((path: string) => /\.(?:woff2?|ttf|png|psd)$/u.test(path))).toBe(false);
    expect(first.body.catalogue.identity).toMatchObject({ sourceId: 'react95', sourceUrl: `https://github.com/react95-io/React95/tree/${REACT95_KIT.source.commit}` });
    expect(first.body.catalogue.dependencies.satisfied.map((d: { name: string }) => d.name)).toEqual(['styled-components', '@types/styled-components']);
    const a1 = await h.od(['adoption', 'apply', '--plan', first.body.plan.id, '--digest', first.body.plan.digest, '--json']);
    expect(a1.body.operation).toMatchObject({ state: 'done', projectId: 'r95a' });
    const tree = h.tree('r95a');
    expect(tree['src/react95.LICENSE']).toBe(REACT95_KIT.notices.code.text);
    const notice = tree['src/NOTICE.react95-template-window-app.md']!;
    expect(notice).toContain(`react95-io/React95 at commit ${REACT95_KIT.source.commit}`);
    expect(notice).toContain('Permission is hereby granted, free of charge');
    expect(notice).toContain('Creative Commons Attribution Share Alike');
    expect(notice).toMatch(/Fonts: none are shipped/u);
    expect(notice).toMatch(/styled-components 5\.3\.11 package ships no licence file/u);
    expect(notice).toContain('arturbien/React95');
    expect(notice).toContain(`react95.Window.Window.tsx (upstream src/Window/Window.tsx): blob ${REACT95_KIT.vendored.find(file => file.path === 'src/Window/Window.tsx')!.gitBlob}, modified:`);
    for (const [path, text] of Object.entries(tree)) if (/^src\/(?:react95\.|React95)/u.test(path)) expect(text).not.toMatch(REMOTE_REFERENCE);

    // Edit and iterate in project A, then save the edited unit privately.
    const edited = tree['src/React95WindowApp.tsx']!.replace("title = 'Notepad'", "title = 'Field notes'");
    expect(edited).not.toBe(tree['src/React95WindowApp.tsx']);
    writeFileSync(join(h.projects.r95a, 'src/React95WindowApp.tsx'), edited);
    // A changed licence file cannot be saved for reuse: the notice must travel unmodified.
    writeFileSync(join(h.projects.r95a, 'src/react95.LICENSE'), 'edited');
    expect(await h.od(['adoption', 'catalogue-save', '--project', 'r95a', '--operation', a1.body.operation.operationId, '--json'])).toMatchObject({ code: 3, body: { status: 409, error: { details: { reason: 'runtime-asset-modified' } } } });
    writeFileSync(join(h.projects.r95a, 'src/react95.LICENSE'), REACT95_KIT.notices.code.text);
    const saved = await h.od(['adoption', 'catalogue-save', '--project', 'r95a', '--operation', a1.body.operation.operationId, '--json']);
    expect(saved.code).toBe(0);
    expect(saved.body.savedUnit).toMatchObject({ refKey, sourceProjectId: 'r95a', target: 'react-source/v1' });

    // Insert the saved unit into project B through HTTP (the canvas path) and apply with od.
    const reuse = await fetch(`${h.url}/api/workbench/adoption/catalogue/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'r95b', refKey, entryPath: 'src/App.tsx', savedUnitId: saved.body.savedUnit.id }) });
    expect(reuse.status).toBe(201);
    const second = (await reuse.json()) as any;
    const a2 = await h.od(['adoption', 'apply', '--plan', second.plan.id, '--digest', second.plan.digest, '--json']);
    expect(a2.body.operation).toMatchObject({ state: 'done', projectId: 'r95b' });
    const b = h.tree('r95b');
    expect(b['src/React95WindowApp.tsx']).toBe(edited);
    expect(b['src/NOTICE.react95-template-window-app.md']).toContain(`Saved unit ${saved.body.savedUnit.id}`);
    expect(b['src/NOTICE.react95-template-window-app.md']).toContain('Permission is hereby granted, free of charge');

    // Build evidence: project B renders the inserted unit; it type-checks under the profile and builds.
    writeFileSync(join(h.projects.r95b, 'src/App.tsx'), "import React95WindowApp from './React95WindowApp';\nexport default function App() {\n  return <main><React95WindowApp /></main>;\n}\n");
    const copy = mkdtempSync(join(tmpdir(), 'react95-project-b-')); roots.push(copy);
    cpSync(join(h.projects.r95b, 'src'), join(copy, 'src'), { recursive: true });
    writeFileSync(join(copy, 'src/main.tsx'), "import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n");
    expect(typecheckUnit(join(copy, 'src'), ['main.tsx', 'React95Theme.d.ts'])).toEqual([]);
    const bundle = await build({ entryPoints: ['src/main.tsx'], absWorkingDir: copy, nodePaths: [join(daemonRoot, 'node_modules')], bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    // Action evidence: the built project runs, shows the edited title, and its close/reopen action works.
    const errors: string[] = [];
    const virtualConsole = new VirtualConsole(); virtualConsole.on('error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole });
    dom.window.eval(bundle.outputFiles[0]!.text);
    await new Promise(done => setTimeout(done, 50));
    const doc = dom.window.document;
    expect(doc.querySelector('[role="region"] h2')?.textContent).toBe('Field notes');
    doc.querySelector('button[aria-label="Close Field notes"]').click();
    await new Promise(done => setTimeout(done, 30));
    expect(doc.querySelector('[role="region"]')).toBeNull();
    doc.querySelector('[aria-label="Taskbar"] button').click();
    await new Promise(done => setTimeout(done, 30));
    expect(doc.querySelector('[role="region"]')).not.toBeNull();
    expect(errors).toEqual([]);
    dom.window.close();
    writeFileSync(join(h.projects.r95b, 'src/App.tsx'), b['src/App.tsx']!);

    // Undo in project B restores it exactly and leaves project A untouched.
    expect((await h.od(['adoption', 'undo', '--operation', a2.body.operation.operationId, '--json'])).body.operation).toMatchObject({ kind: 'undo', state: 'done' });
    expect(h.tree('r95b')).toEqual(PROJECTS.r95b);
    expect(h.tree('r95a')['src/React95WindowApp.tsx']).toBe(edited);
  }, 60_000);

  it('refuses incompatible targets and packages before anything is stored, and admits only receipt-covered React', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('template-settings-form');
    expect(await prepare(h, 'vue', refKey)).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'target-incompatible', targetReason: 'target-not-react' } } } });
    const react19 = await prepare(h, 'react19', refKey);
    expect(react19).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'target-receipt-pending', receiptReason: 'react-major-uncovered', reactMajor: 19, coveredReactMajors: [18] } } } });
    expect(react19.body.error.message).not.toMatch(/HTML artifact/u);
    expect(await prepare(h, 'nosc', refKey)).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'dependencies-unsatisfied', missing: [{ name: 'styled-components', range: '^5.3.11' }, { name: '@types/styled-components', range: '^5.1.36' }] } } } });
    expect(await prepare(h, 'sc6', refKey)).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'dependencies-unsatisfied', incompatible: [{ name: 'styled-components', required: '^5.3.11', installed: '^6.1.0' }] } } } });
    expect(await prepare(h, 'oldsc', refKey)).toMatchObject({ code: 3, body: { status: 422, error: { details: { reason: 'dependency-below-minimum', belowMinimum: [{ name: 'styled-components', minimum: '5.3.11', declared: '^5.0.0', installed: '5.1.0' }] } } } });
    expect(h.storedPlans()).toBe(0);
  });

  it('fails closed on a styled-components major the receipt does not cover, read from the installed package', async () => {
    const h = await harness();
    const refKey = await h.refKeyOf('template-window-app');
    expect(await prepare(h, 'sc6installed', refKey)).toMatchObject({ code: 3, body: { status: 422, error: { details: {
      reason: 'dependency-major-uncovered', uncovered: [{ name: 'styled-components', coveredMajors: [5], declared: '^5.3.11', installed: '6.1.0' }],
    } } } });
    expect(await prepare(h, 'scabsent', refKey)).toMatchObject({ code: 3, body: { status: 422, error: { details: {
      reason: 'dependency-major-uncovered', uncovered: [{ name: 'styled-components', coveredMajors: [5], installed: null }],
    } } } });
    expect(h.storedPlans()).toBe(0);
  });
});

describe('AC-R17.4 opt-in retro discovery', () => {
  it('a Windows95 query finds the kit first, with Dell 1996 as a subordinate reference after it', async () => {
    const h = await harness();
    for (const query of ['windows95', 'Windows95 settings form', 'react95 window']) {
      const results = await h.search(query);
      const ids = results.map(result => result.ref.itemId);
      expect(ids[0]).toMatch(/^template-/u);
      if (ids.includes('dell-1996')) {
        const lastKit = Math.max(...results.map((result, index) => result.ref.sourceId === 'react95' ? index : -1));
        expect(ids.indexOf('dell-1996')).toBeGreaterThan(lastKit);
      }
    }
    expect((await h.search('windows95')).map(result => result.ref.itemId)).toContain('dell-1996');
  });

  it('ordinary searches never surface the retro kit, even when a generic phrase is in a template title', async () => {
    const h = await harness();
    for (const query of ['settings form', 'application window', 'form', 'premium settings form layout', 'window', '']) {
      const results = await h.search(query);
      expect(results.filter(result => result.styleClass === 'retro').map(result => result.ref.itemId)).toEqual([]);
    }
    expect((await h.search('settings form')).map(result => result.ref.itemId)).toEqual(['linear-settings']);
  });
});
