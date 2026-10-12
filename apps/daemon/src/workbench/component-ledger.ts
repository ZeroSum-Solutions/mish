/**
 * AC-R13.1 every-ID component ledger: inventory, refresh and gate.
 *
 * `collectComponentInventory` reads what this checkout actually exposes as executable
 * components (the GenUI catalog, HyperUI and family sections from the section catalog, the
 * owned 21st.dev alternatives and the selected shadcn cohort) and derives each row's original
 * reference, expected state set, dependencies, exact source version, rights and default repair
 * owner from the vendored or ported bytes, never from an upstream HEAD. Licensed pack cohorts
 * (Cult UI Pro sections and rows, MotionSites templates) are counted at source level here:
 * owner decision 2026-10-08, public-core items ship preloaded and licensed pack items count
 * once installed, in the ledger the pack carries.
 *
 * The committed ledger is `component-ledger.json` beside this file. `checkComponentLedger`
 * is the gate every later addition passes through (a newly exposed ID without a row, a row
 * whose item is gone, changed source bytes, or a changed cohort all fail). Refresh it with
 * `pnpm exec tsx apps/daemon/scripts/r13-component-ledger.ts --write` and review the diff.
 * The running daemon reads the generated JSON through component-ledger-report.ts and adds
 * the live installed-pack inventory. See docs/packs.md, "Read the component ledger".
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  RESOURCE_SOURCE_IDS,
  parseComponentLedger,
  type ComponentLedger,
  type ComponentLedgerCohort,
  type ComponentLedgerRow,
  type ComponentState,
} from '@open-design/contracts';
import type { SectionCatalogEntry } from '@open-design/contracts/api/section-catalog';
import { genuiCatalog } from '@open-design/genui-catalog/data';
import type { CatalogEntry } from '@open-design/genui-catalog';
import sectionCatalogJson from '@open-design/section-catalog/catalog.json' with { type: 'json' };
import cultCatalogJson from '@open-design/cult-ui-catalog/catalog.json' with { type: 'json' };
import twenty1stJson from '@open-design/21st-catalog/generated/21st-items.json' with { type: 'json' };
import originalsJson from '@open-design/21st-catalog/generated/21st-originals.json' with { type: 'json' };
import type { React95Kit } from './kits/react95/kit-types.js';
import { react95UnitFiles } from './kits/react95/unit.js';
import { REACT95_KIT } from './kits/react95/kit.generated.js';
import { GSAP_RECIPES } from './recipes/gsap/recipes.js';
import { canonical, digestOf, sha256, genuiComponentDigest } from './component-ledger-digest.js';
import { GSAP_PIN, GSAP_REACT_PIN } from './recipes/gsap/runtime.js';
import { SELECTED_SHADCN_ITEMS } from './adoption/shadcn-material.js';

export interface ComponentInventory {
  cohorts: ComponentLedgerCohort[];
  /** Rows as derived from the exposed bytes, with their default disposition and owner. */
  items: ComponentLedgerRow[];
}
export type ComponentLedgerFinding = { kind: 'missing-row' | 'orphan-row' | 'stale-version' | 'derived-drift' | 'cohort-drift'; id: string };

/** Lane that owns exhaustive component dependency-family repairs (execution-and-review.md, C1). */
export const DEFAULT_REPAIR_OWNER = 'C1';
export const REVIEW_VIEWPORTS = [390, 1280] as const;
export const COMPONENT_LEDGER_SCOPE_DECISION = {
  text: 'R13 covers public-core items, which may ship preloaded (MIT or other permissive rights, owned originals and clean-room ports). Licensed pack items count once the pack is installed and are tracked in the pack ledger.',
  decidedBy: 'owner',
  decidedOn: '2026-10-08',
} as const;

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Repository root in a source checkout (`src/workbench` and `dist/workbench` both sit four levels down). */
export function defaultRepositoryRoot(): string {
  return path.resolve(import.meta.dirname, '../../../..');
}

// ---------------------------------------------------------------------------------------------
// GenUI: owned ports in packages/genui-catalog.

const GENUI_ACTIONS: Record<CatalogEntry['category'], { action: string; states: ComponentState[] }> = {
  hover: { action: 'Pointer hover or keyboard focus plays the effect on the host element', states: ['hover', 'focus-visible'] },
  surface: { action: 'Renders the surface treatment around the host content', states: [] },
  text: { action: 'Renders or animates the host text', states: [] },
  scroll: { action: 'Scroll position drives the effect', states: [] },
  gallery: { action: 'Browse the items by pointer or keyboard', states: ['hover', 'focus-visible'] },
  hero: { action: 'Renders the hero composition', states: [] },
  background: { action: 'Renders a decorative background behind the host content', states: [] },
  navigation: { action: 'Open the menu and follow its entries by pointer or keyboard', states: ['hover', 'focus-visible', 'open'] },
  input: { action: 'Enter text or press the control', states: ['hover', 'focus-visible', 'disabled'] },
};

function genuiRow(root: string, entry: CatalogEntry): ComponentLedgerRow {
  const packageRoot = path.join(root, 'packages/genui-catalog');
  const files = [entry.entry, entry.css, entry.demo].filter((file): file is string => typeof file === 'string')
    .map(file => ({ file, bytes: readFileSync(path.join(packageRoot, file)) }));
  const source = files.find(file => file.file === entry.entry)?.bytes.toString('utf8') ?? '';
  const webgl = /getContext\(\s*['"]webgl/u.test(source);
  const ported = entry.status === 'ported' && files.length > 0;
  const family = !ported ? 'genui-unported' : webgl ? 'genui-webgl' : entry.kind === 'css-only' ? 'genui-css' : 'genui-js';
  const { action, states } = GENUI_ACTIONS[entry.category];
  const motion = entry.reducedMotion !== 'none-needed';
  const upstream = entry.source.dependencies.split(',').map(name => name.trim()).filter(name => name && !/^(none|not documented|undocumented)$/iu.test(name));
  const origin = entry.licenceDecision === 'licensed' ? 'licensed' : entry.licenceDecision === 'port-with-attribution' ? 'vendored' : ported ? 'clean-room' : 'not-implemented';
  return {
    id: `genui:${entry.id}`, sourceId: 'genui', itemId: entry.id, title: entry.name, built: ported, family, nativeFormat: 'html',
    originalReference: { url: /^https:\/\//u.test(entry.sourceUrl) ? entry.sourceUrl : null, upstreamRevision: null, referenceImage: null, note: /^https:\/\//u.test(entry.sourceUrl) ? null : `Upstream ${entry.source.name} ${entry.source.component}` },
    expectedStates: {
      primaryAction: action,
      states: ['default', ...states, ...(motion ? ['reduced-motion' as const] : []), ...(webgl ? ['no-webgl-fallback' as const] : [])],
      viewports: [...REVIEW_VIEWPORTS], reducedMotion: motion ? 'required' : 'not-applicable',
    },
    dependencies: [
      ...(ported ? [{ name: '@open-design/genui-catalog runtime', kind: 'runtime' as const, version: null }] : []),
      ...(webgl ? [{ name: 'webgl', kind: 'capability' as const, version: null }] : []),
      ...[...new Set(upstream)].map(name => ({ name, kind: 'upstream-declared' as const, version: null })),
    ],
    sourceVersion: { revision: `genui-catalog/${entry.status}`, digest: genuiComponentDigest(entry, files.map(file => ({ file: file.file, sha256: sha256(file.bytes) }))), pinned: true },
    rights: { license: entry.source.license, decision: entry.licenceDecision, implementationOrigin: origin, evidence: `packages/genui-catalog/NOTICE; packages/genui-catalog/catalog.json ${entry.id} rationale` },
    repairOwner: DEFAULT_REPAIR_OWNER,
    disposition: ported ? 'repair-pending' : 'quarantined',
    dispositionReason: ported ? null : `Not ported (status ${entry.status}, licence decision ${entry.licenceDecision}); no executable source exists to repair`,
    evidence: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Section catalog: vendored HyperUI blocks and same-family reconstructions.

interface HyperuiManifest { upstream: { repo: string; commit: string }; tailwindCliVersion: string; blocks: Array<{ id: string; file: string; images: number; scripts: number }> }

function hyperuiRow(root: string, manifest: HyperuiManifest, entry: SectionCatalogEntry): ComponentLedgerRow {
  if (entry.content.kind !== 'vendored-block') throw new Error(`HyperUI entry ${entry.id} is not a vendored block`);
  const blockId = entry.content.blockId;
  const block = manifest.blocks.find(candidate => candidate.id === blockId);
  if (!block) throw new Error(`HyperUI block ${blockId} is missing from the vendored kit manifest`);
  const bytes = readFileSync(path.join(root, 'plugins/_official/shared/ui-kits/hyperui', block.file));
  const html = bytes.toString('utf8');
  const interactive = /<(a|button)\b/iu.test(html);
  const fields = /<(input|select|textarea)\b/iu.test(html);
  const motion = /\b(transition|animate-|duration-)/u.test(html);
  const states: ComponentState[] = ['default'];
  if (interactive || fields) states.push('hover', 'focus-visible');
  if (/<details\b/iu.test(html)) states.push('open');
  if (/aria-(current|selected)=/iu.test(html)) states.push('selected');
  if (/\bdisabled\b/iu.test(html)) states.push('disabled');
  if (motion) states.push('reduced-motion');
  const group = blockId.split('/').slice(0, 2).join('/');
  return {
    id: `sections:${entry.id}`, sourceId: 'sections', itemId: entry.id, title: entry.title, built: true, family: 'hyperui-tailwind4', nativeFormat: 'html',
    originalReference: { url: `https://www.hyperui.dev/components/${group}`, upstreamRevision: `${manifest.upstream.repo}@${manifest.upstream.commit}`, referenceImage: null, note: null },
    expectedStates: {
      primaryAction: interactive || fields ? 'Follow the block links and controls by pointer or keyboard' : 'Static content block with no action of its own',
      states, viewports: [...REVIEW_VIEWPORTS], reducedMotion: motion ? 'required' : 'not-applicable',
    },
    dependencies: [
      { name: 'tailwindcss', kind: 'stylesheet', version: manifest.tailwindCliVersion },
      ...(block.images > 0 ? [{ name: 'images', kind: 'capability' as const, version: null }] : []),
      ...(block.scripts > 0 ? [{ name: 'scripts', kind: 'capability' as const, version: null }] : []),
    ],
    sourceVersion: { revision: `${manifest.upstream.repo}@${manifest.upstream.commit}:${block.file}`, digest: sha256(bytes), pinned: true },
    rights: { license: entry.rights.license, decision: entry.rights.decision, implementationOrigin: 'vendored', evidence: entry.rights.evidence },
    repairOwner: DEFAULT_REPAIR_OWNER, disposition: 'repair-pending', dispositionReason: null, evidence: [],
  };
}

function familySectionRow(entry: SectionCatalogEntry): ComponentLedgerRow {
  if (entry.content.kind !== 'family-section') throw new Error(`Family entry ${entry.id} has no family content`);
  const family = entry.content.family;
  return {
    id: `sections:${entry.id}`, sourceId: 'sections', itemId: entry.id, title: entry.title, built: true, family: `family-section-${family}`, nativeFormat: 'family-section',
    originalReference: { url: null, upstreamRevision: null, referenceImage: null, note: `Same-family reconstruction; reference ${entry.rights.evidence}` },
    expectedStates: { primaryAction: `Composes into a ${family} family build; no standalone action`, states: ['default'], viewports: [...REVIEW_VIEWPORTS], reducedMotion: 'not-applicable' },
    dependencies: [{ name: `${family} family build`, kind: 'runtime', version: null }],
    sourceVersion: { revision: `section-catalog:${family}/${entry.content.sectionId}`, digest: digestOf(entry), pinned: true },
    rights: { license: entry.rights.license, decision: entry.rights.decision, implementationOrigin: 'owned-original', evidence: entry.rights.evidence },
    repairOwner: DEFAULT_REPAIR_OWNER,
    disposition: 'reference-only',
    dispositionReason: `Catalog availability ${entry.availability}: selectable only inside the ${family} family build, with no standalone preview or adoption adapter`,
    evidence: [],
  };
}

// ---------------------------------------------------------------------------------------------
// 21st.dev: the saved upstream rows are reference-only; the executable items are the owned,
// independently authored alternatives in packages/21st-catalog/originals.

interface Original { id: string; slug: string; title: string; description: string; referenceUrl: string; provenance: string; files: Array<{ path: string; content: string }> }

function twentyFirstRow(row: { id: string; name: string; itemUrl: string; rights: string }, original: Original | undefined): ComponentLedgerRow {
  const base = { id: `21st-dev:${row.id}`, sourceId: '21st-dev' as const, itemId: row.id, repairOwner: DEFAULT_REPAIR_OWNER, evidence: [] };
  if (!original) {
    return {
      ...base, title: row.name, built: false, family: '21st-reference', nativeFormat: 'react',
      originalReference: { url: row.itemUrl, upstreamRevision: null, referenceImage: null, note: null },
      expectedStates: { primaryAction: 'Reference link only', states: ['default'], viewports: [...REVIEW_VIEWPORTS], reducedMotion: 'not-applicable' },
      dependencies: [], sourceVersion: { revision: `21st:${row.id}`, digest: digestOf(row), pinned: true },
      rights: { license: row.rights, decision: 'reference-only', implementationOrigin: 'not-implemented', evidence: 'packages/21st-catalog/generated/21st-items.json' },
      disposition: 'quarantined', dispositionReason: 'No owned alternative exists; the upstream item is reference-only', evidence: [],
    };
  }
  const text = original.files.map(file => file.content).join('\n');
  const motion = /\b(transition|animation|@keyframes)\b/u.test(text);
  const states: ComponentState[] = ['default', 'hover', 'focus-visible'];
  if (/<dialog\b|showModal\(/u.test(text)) states.push('open');
  if (/aria-(selected|pressed|current)/u.test(text)) states.push('selected');
  if (/\bdisabled\b/u.test(text)) states.push('disabled');
  if (motion) states.push('reduced-motion');
  return {
    ...base, title: original.title, built: true, family: '21st-owned-html', nativeFormat: 'html',
    originalReference: { url: original.referenceUrl, upstreamRevision: null, referenceImage: null, note: null },
    expectedStates: { primaryAction: original.description, states, viewports: [...REVIEW_VIEWPORTS], reducedMotion: motion ? 'required' : 'not-applicable' },
    dependencies: [{ name: 'owned preview runtime', kind: 'runtime', version: null }],
    sourceVersion: { revision: `21st-catalog/originals/${original.slug}`, digest: digestOf(original.files.map(file => [file.path, sha256(file.content)])), pinned: true },
    rights: {
      license: `owned (${original.provenance}); upstream ${row.rights}`, decision: 'owned-alternative', implementationOrigin: 'owned-original',
      evidence: `packages/21st-catalog/generated/21st-originals.json (${original.id}, embedded NOTICE.txt and provenance)`,
    },
    disposition: 'repair-pending', dispositionReason: null,
  };
}

function shadcnRows(): ComponentLedgerRow[] {
  return SELECTED_SHADCN_ITEMS.map(item => ({
    id: `shadcn:${item.itemId}`, sourceId: 'shadcn', itemId: item.itemId, title: item.title, built: false, family: 'shadcn-react', nativeFormat: 'react',
    originalReference: { url: item.reference, upstreamRevision: null, referenceImage: null, note: null },
    expectedStates: { primaryAction: 'Press the control', states: ['default', 'hover', 'focus-visible', 'active', 'disabled'], viewports: [...REVIEW_VIEWPORTS], reducedMotion: 'not-applicable' },
    dependencies: [{ name: item.packageName, kind: 'package', version: null }],
    // Fetched per project from the registry; its bytes are only known at acquisition.
    sourceVersion: { revision: item.reference, digest: null, pinned: false },
    rights: { license: item.licence.spdx, decision: 'selected-cohort', implementationOrigin: 'fetched', evidence: 'apps/daemon/src/workbench/adoption/shadcn-material.ts (SELECTED_SHADCN_ITEMS licence notice)' },
    repairOwner: DEFAULT_REPAIR_OWNER, disposition: 'repair-pending', dispositionReason: null, evidence: [],
  }));
}

// ---------------------------------------------------------------------------------------------
// Additional shipped cohorts use the same IDs as their resource adapters.
export function collectReact95ComponentRows(kit: React95Kit = REACT95_KIT): ComponentLedgerRow[] {
  const vendored = new Map(kit.vendored.map(file => [file.path, sha256(file.text)]));
  const units = [
    ...kit.inventory.components.map(item => ({ itemId: `component-${item.id}`, title: item.name,
      built: item.files.every(file => vendored.get(file.path) === file.sha256),
      bytes: { files: item.files.map(file => ({ ...file, actualDigest: vendored.get(file.path) ?? null })), shared: kit.inventory.shared, vendored: [...vendored], dependencies: kit.source.peerDependencies } })),
    ...kit.templates.map(item => ({ itemId: `template-${item.id}`, title: item.title, built: true,
      bytes: { files: react95UnitFiles(kit, item.id)!.map(file => [file.path, sha256(file.bytes)]), dependencies: kit.source.peerDependencies } })),
  ];
  return units.map(unit => ({
    id: `react95:${unit.itemId}`, sourceId: 'react95', itemId: unit.itemId, title: unit.title, built: unit.built,
    family: 'react95-styled-components', nativeFormat: 'react',
    originalReference: { url: `${kit.source.repository}/tree/${kit.source.commit}`, upstreamRevision: kit.source.commit, referenceImage: null, note: null },
    expectedStates: { primaryAction: 'Exercise the documented React95 control or template actions', states: ['default', 'hover', 'focus-visible', 'disabled'], viewports: [...REVIEW_VIEWPORTS], reducedMotion: 'not-applicable' },
    dependencies: Object.entries(kit.source.peerDependencies).map(([name, version]) => ({ name, kind: 'package', version })),
    sourceVersion: { revision: kit.source.commit, digest: digestOf(unit.bytes), pinned: true },
    rights: { license: kit.source.manifestLicense, decision: 'vendored', implementationOrigin: 'vendored', evidence: `apps/daemon/src/workbench/kits/react95/kit.generated.ts (notices.code, LICENSE git blob ${kit.notices.code.gitBlob})` },
    repairOwner: DEFAULT_REPAIR_OWNER, disposition: 'repair-pending', dispositionReason: null, evidence: [],
  }));
}

function gsapRows(): ComponentLedgerRow[] {
  return Object.values(GSAP_RECIPES).flatMap(recipe => (['html', 'react'] as const).map(target => ({
    id: `gsap:${recipe.id}-${target}`, sourceId: 'gsap' as const, itemId: `${recipe.id}-${target}`, title: `${recipe.title} (${target})`, built: true,
    family: 'gsap-recipes', nativeFormat: target,
    originalReference: { url: 'https://gsap.com/docs/v3/', upstreamRevision: GSAP_PIN.commit, referenceImage: null, note: recipe.purpose },
    expectedStates: { primaryAction: recipe.trigger, states: ['default', 'hover', 'focus-visible', 'reduced-motion'] as ComponentState[], viewports: [...REVIEW_VIEWPORTS], reducedMotion: 'required' as const },
    dependencies: [
      { name: 'gsap', kind: 'package' as const, version: GSAP_PIN.version },
      ...(target === 'react' ? [
        { name: GSAP_REACT_PIN.packageName, kind: 'package' as const, version: GSAP_REACT_PIN.version },
        { name: 'react', kind: 'package' as const, version: '>=17' },
        { name: 'react-dom', kind: 'package' as const, version: '>=17' },
      ] : []),
    ],
    sourceVersion: { revision: `gsap/${GSAP_PIN.version}`, digest: digestOf({ recipe: recipe[target], runtime: GSAP_PIN, companion: target === 'react' ? GSAP_REACT_PIN : null, plugins: recipe.plugins }), pinned: true },
    rights: { license: 'GSAP Standard License', decision: 'owned-recipe', implementationOrigin: 'owned-original' as const, evidence: 'apps/daemon/src/workbench/recipes/gsap/runtime.ts (gsapNotice)' },
    repairOwner: DEFAULT_REPAIR_OWNER, disposition: 'repair-pending' as const, dispositionReason: null, evidence: [],
  })));
}

// Cohorts: every roster source carries a scope, so a new source cannot expose items unnoticed.

const NOT_COMPONENT: Partial<Record<(typeof RESOURCE_SOURCE_IDS)[number], string>> = {
  plugins: 'Installed plugins are templates and skills, not components; component sections they bundle are inventoried through their own catalog',
  library: 'User library files and assets, not components',
  'design-systems': 'Design-system packages expose tokens, fonts and preview pages, not executable components',
  'project-tokens': 'Project design tokens, not components',
  'brief-derived-tokens': 'Brief-derived tokens, not components',
  fonts: 'Font families, not components',
  'generated-media': 'Generated images, video and audio, not components',
  refero: 'Reference screens, not executable components',
  'design-skills': 'Agent skills, not components',
  'design-md': 'DESIGN.md documents, not components',
  'design-system-checklist': 'Checklist criteria; they attach to ledger rows under AC-R13.4',
  mobbin: 'Reference screens, not executable components',
  motion: 'Motion runtime library used by recipes, not a component catalog',
  lucide: 'Icon set, not a component catalog',
  gsap: 'Animation runtime used by recipes, not a component catalog',
  hyperframes: 'Video scaffolding, not a component catalog',
};
const SECTIONS_ROUTED = 'HyperUI vendored blocks are exposed through the sections source (cohort sections/hyperui); this roster row has no adapter of its own';

function cohort(id: string, sourceId: ComponentLedgerCohort['sourceId'], scope: ComponentLedgerCohort['scope'], listing: unknown[] | null, reason: string): ComponentLedgerCohort {
  return { id, sourceId, scope, itemCount: listing ? listing.length : null, listingDigest: listing ? digestOf(listing) : null, reason };
}
const rowListing = (rows: ComponentLedgerRow[]) => rows.map(row => [row.id, row.sourceVersion.digest ?? row.sourceVersion.revision]);

export function collectComponentInventory(root: string = defaultRepositoryRoot()): ComponentInventory {
  const sections = (sectionCatalogJson as { entries: SectionCatalogEntry[] }).entries;
  const manifest = JSON.parse(readFileSync(path.join(root, 'plugins/_official/shared/ui-kits/hyperui/manifest.json'), 'utf8')) as HyperuiManifest;
  const originals = (originalsJson as { items: Original[] }).items;
  const genui = genuiCatalog.manifest.components.map(entry => genuiRow(root, entry as CatalogEntry)).sort(byId);
  const hyperui = sections.filter(entry => entry.sourceKind === 'hyperui').map(entry => hyperuiRow(root, manifest, entry)).sort(byId);
  const families = sections.filter(entry => entry.sourceKind === 'family-section').map(familySectionRow).sort(byId);
  const twentyFirst = (twenty1stJson as { rows: Array<{ id: string; name: string; itemUrl: string; rights: string }> }).rows
    .map(row => twentyFirstRow(row, originals.find(original => original.id === row.id))).sort(byId);
  const shadcn = shadcnRows().sort(byId);
  const react95 = collectReact95ComponentRows().sort(byId);
  const gsap = gsapRows().sort(byId);
  const unknownKinds = [...new Set(sections.map(entry => entry.sourceKind))].filter(kind => !['hyperui', 'family-section', 'cult-pro'].includes(kind));
  if (unknownKinds.length) throw new Error(`Section catalog source kinds without a ledger scope: ${unknownKinds.join(', ')}`);
  const cultSections = sections.filter(entry => entry.sourceKind === 'cult-pro').map(entry => [entry.id, digestOf(entry.content)]).sort();
  const cultRows = (cultCatalogJson as { rows: Array<{ id: string; source: { registrySha256: string } }> }).rows.map(row => [row.id, row.source.registrySha256]).sort();
  const cohorts: ComponentLedgerCohort[] = [
    cohort('genui', 'genui', 'public-core', rowListing(genui), 'Owned GenUI ports (clean-room, attributed or licensed ports) shipped with the app'),
    cohort('sections/hyperui', 'sections', 'public-core', rowListing(hyperui), 'MIT HyperUI blocks vendored at a pinned upstream commit'),
    cohort('sections/family-section', 'sections', 'public-core', rowListing(families), 'Same-family reconstructions shipped with the agency examples'),
    cohort('sections/cult-pro', 'sections', 'licensed-pack', cultSections, 'Cult UI Pro sections are licensed pack items; they count once the pack is installed'),
    cohort('cult/cult-ui-pro', 'cult', 'licensed-pack', cultRows, 'Cult UI Pro catalog rows are licensed pack items; they count once the pack is installed'),
    cohort('21st-dev/owned-alternatives', '21st-dev', 'public-core', rowListing(twentyFirst), 'Owned alternatives for the saved 21st.dev references; the upstream items stay reference-only'),
    cohort('shadcn/selected', 'shadcn', 'public-core', rowListing(shadcn), 'The selected MIT shadcn cohort, fetched per project'),
    cohort('react95', 'react95', 'public-core', rowListing(react95), 'Shipped React95 inventory and templates; each item requires its own verification'),
    cohort('gsap/recipes', 'gsap', 'public-core', rowListing(gsap), 'Authored GSAP recipes in both supported target formats'),
    cohort('motionsites', 'motionsites', 'licensed-pack', null, 'MotionSites templates come from a signed-in remote catalog and move to the licensed pack; no fixed local count'),
  ];
  for (const sourceId of RESOURCE_SOURCE_IDS) {
    if (cohorts.some(item => item.sourceId === sourceId)) continue;
    const notComponent = NOT_COMPONENT[sourceId];
    cohorts.push(notComponent
      ? cohort(sourceId, sourceId, 'not-component', null, notComponent)
      : cohort(sourceId, sourceId, 'not-exposed', null, sourceId === 'hyperui' ? SECTIONS_ROUTED : 'No executable items exposed in this checkout; admitted items enter this ledger before exposure'));
  }
  const items = [...genui, ...hyperui, ...families, ...twentyFirst, ...shadcn, ...react95, ...gsap].sort(byId);
  validateComponentLedgerCitations(root, items);
  return { cohorts: cohorts.sort(byId), items };
}

// ---------------------------------------------------------------------------------------------
// Gate and refresh.

/** Evidence may include a fragment or a description after the cited repository file. */
export function validateComponentLedgerCitations(root: string, rows: ComponentLedgerRow[]): void {
  for (const row of rows) {
    const citations = row.rights.evidence.match(/(?:apps|packages|plugins|skills|design-systems|docs)\/[A-Za-z0-9_./-]+/gu) ?? [];
    for (const citation of citations) {
      const file = path.resolve(root, citation);
      if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Invalid cited file: ${row.id}: ${citation}`);
      try {
        if (!statSync(file).isFile()) throw new Error('Not a file');
      } catch {
        throw new Error(`Missing cited file: ${row.id}: ${citation}`);
      }
    }
  }
}


const versionKey = (row: ComponentLedgerRow) => canonical(row.sourceVersion);
const derivedKey = (row: ComponentLedgerRow) => canonical({
  sourceId: row.sourceId, itemId: row.itemId, title: row.title, built: row.built, family: row.family, nativeFormat: row.nativeFormat,
  originalReference: { ...row.originalReference, referenceImage: null }, dependencies: row.dependencies, rights: row.rights,
});

/** Empty when the ledger matches what the inventory exposes. */
export function checkComponentLedger(ledger: ComponentLedger, inventory: ComponentInventory): ComponentLedgerFinding[] {
  const findings: ComponentLedgerFinding[] = [];
  const rows = new Map(ledger.rows.map(row => [row.id, row]));
  const items = new Map(inventory.items.map(item => [item.id, item]));
  for (const item of inventory.items) {
    const row = rows.get(item.id);
    if (!row) findings.push({ kind: 'missing-row', id: item.id });
    else if (versionKey(row) !== versionKey(item)) findings.push({ kind: 'stale-version', id: item.id });
    else if (derivedKey(row) !== derivedKey(item)) findings.push({ kind: 'derived-drift', id: item.id });
  }
  for (const row of ledger.rows) if (!items.has(row.id)) findings.push({ kind: 'orphan-row', id: row.id });
  const ledgerCohorts = new Map(ledger.cohorts.map(item => [item.id, canonical(item)]));
  const inventoryCohorts = new Map(inventory.cohorts.map(item => [item.id, canonical(item)]));
  for (const id of new Set([...ledgerCohorts.keys(), ...inventoryCohorts.keys()])) {
    if (ledgerCohorts.get(id) !== inventoryCohorts.get(id)) findings.push({ kind: 'cohort-drift', id });
  }
  return findings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/**
 * Rebuilds the ledger from the inventory. Derived fields always follow the exposed bytes.
 * Curated fields (repair owner, state set, reference image, disposition, reason, evidence)
 * survive while the source version is unchanged; changed bytes return the row to its derived
 * default, because evidence is bound to the version it proved.
 */
export function refreshComponentLedger(existing: ComponentLedger | null, inventory: ComponentInventory, frozenAt: string): ComponentLedger {
  const previous = new Map((existing?.rows ?? []).map(row => [row.id, row]));
  const rows = inventory.items.map(item => {
    const prior = previous.get(item.id);
    if (!prior || versionKey(prior) !== versionKey(item)) return item;
    return {
      ...item,
      originalReference: { ...item.originalReference, referenceImage: prior.originalReference.referenceImage },
      expectedStates: prior.expectedStates,
      repairOwner: prior.repairOwner,
      disposition: prior.disposition,
      dispositionReason: prior.dispositionReason,
      evidence: prior.evidence,
    };
  }).sort(byId);
  return parseComponentLedger({
    schema: 'component-ledger/1', scope: 'public-core', frozenAt,
    scopeDecision: existing?.scopeDecision ?? COMPONENT_LEDGER_SCOPE_DECISION,
    cohorts: inventory.cohorts, rows,
  });
}

export function componentLedgerPath(root: string = defaultRepositoryRoot()): string {
  return path.join(root, 'apps/daemon/src/workbench/component-ledger.json');
}
export function readComponentLedger(file: string = componentLedgerPath()): ComponentLedger | null {
  return existsSync(file) ? parseComponentLedger(JSON.parse(readFileSync(file, 'utf8'))) : null;
}
