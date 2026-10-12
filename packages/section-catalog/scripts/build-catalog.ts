/**
 * Generate catalog.json: one entry per HyperUI block (all 80, from the pinned
 * plugins/_official/shared/ui-kits/hyperui/manifest.json) plus one entry per section of each of
 * the 13 agency families (read from that family's own
 * compiler/scripts/families/<family>/reference.fixture.json — the family's canonical example
 * recipe, so this script tracks a family's real section roster instead of a second hand-kept
 * list that can drift from it).
 *
 * Plus one entry per Cult UI Pro section or page row of the canonical inventory
 * packages/cult-ui-catalog/catalog.json (see `projectCultEntries` below): metadata only, labelled
 * `adapter-needed` until a reviewed adapter exists. That package's own `check` guards its file;
 * this script only projects it, so a change there makes this catalog.json stale until rebuilt.
 *
 * MotionSites entries are federated at request time (src/motionsites.ts) and are never written
 * here — see the design doc, packages/section-catalog §1: "federated metadata ... merged into
 * catalog responses", not baked into the build.
 *
 * sectionKind and spineAffinities come from two small deterministic tables below
 * (HYPERUI_GROUP_SECTION_KIND, FAMILY_SECTION_TYPE_KIND) plus data/overrides.json, a short,
 * hand-reviewed list of exceptions keyed by the final entry id — for HyperUI groups and family
 * section types whose content doesn't fit the table's generic reading of that group/type.
 *
 * Usage:
 *   node --experimental-strip-types scripts/build-catalog.ts          write catalog.json
 *   node --experimental-strip-types scripts/build-catalog.ts --check  write nothing; exit 1 when
 *                                                                     catalog.json is stale or invalid
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSectionCatalog } from '../src/validate.ts';
import {
  CULT_PRO_RIGHTS, INSERTABLE_V1, SECTION_CATALOG_SCHEMA,
  type SectionCatalog, type SectionCatalogEntry, type SectionKind, type SpineAffinities, type SpineCode,
} from '../src/types.ts';

const __filename = fileURLToPath(import.meta.url);
export const packageRoot = path.resolve(path.dirname(__filename), '..');
const repoRoot = path.resolve(packageRoot, '../..');

export const catalogPath = path.join(packageRoot, 'catalog.json');
const overridesPath = path.join(packageRoot, 'data/overrides.json');

const hyperuiRoot = path.join(repoRoot, 'plugins/_official/shared/ui-kits/hyperui');
const familyRegistryPath = path.join(repoRoot, 'packages/agency-fast-lane/src/atlas/family-registry.json');
export const cultCatalogPath = path.join(repoRoot, 'packages/cult-ui-catalog/catalog.json');
const cultGeneratedDir = path.join(repoRoot, 'packages/cult-ui-catalog/generated');

interface HyperuiManifest {
  upstream: { repo: string; commit: string; fetchedAt: string };
  tailwindCliVersion: string;
  blocks: Array<{ id: string; file: string; bytes: number; images: number; scripts: number }>;
}

interface FamilyRegistryEntry { family: string; spine: SpineCode; archetype: string; pageKind: string }
interface FamilyRegistry { families: FamilyRegistryEntry[] }

export interface Overrides {
  [entryId: string]: { sectionKind?: SectionKind; spineAffinities?: SpineAffinities; _why?: string };
}

const OVERRIDE_ENTRY_KEYS = new Set(['sectionKind', 'spineAffinities', '_why']);

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function readOverrides(): Overrides {
  if (!existsSync(overridesPath)) return {};
  const raw = readJson<Overrides>(overridesPath);
  // "_comment" documents the file for a human reader; every other top-level key is an entry id.
  const { _comment: _ignored, ...overrides } = raw as Overrides & { _comment?: unknown };
  for (const [entryId, entry] of Object.entries(overrides)) checkOverrideEntryKeys(entryId, entry);
  return overrides;
}

/**
 * An override object's own keys must be a subset of {sectionKind, spineAffinities, _why} —
 * otherwise a typo (e.g. "sectionkind") is silently dropped by `resolveClassification`'s
 * `override?.sectionKind` lookup, and the override appears to apply while doing nothing. This
 * check is what makes the file's own "_comment" claim ("this file cannot silently go stale") true
 * for the fields inside an entry, not only for its key. Exported so
 * tests/catalog.test.ts can exercise the throw path with a synthetic typo'd key.
 */
export function checkOverrideEntryKeys(entryId: string, entry: Record<string, unknown>): void {
  for (const key of Object.keys(entry)) {
    if (!OVERRIDE_ENTRY_KEYS.has(key)) {
      throw new Error(`data/overrides.json: "${entryId}" has unknown key "${key}" (expected one of ${[...OVERRIDE_ENTRY_KEYS].join(', ')})`);
    }
  }
}

/**
 * The effective sectionKind/spineAffinities for one entry: an override wins outright for
 * whichever of the two fields it sets; the other field (and a field no override sets) falls back
 * to `deriveDefault(effectiveSectionKind)` — computed from the *overridden* sectionKind, not the
 * table default, so overriding only sectionKind (the common case in data/overrides.json) still
 * gets a spineAffinities consistent with the corrected kind instead of the stale unclassified one.
 */
function resolveClassification(
  entryId: string,
  tableSectionKind: SectionKind,
  deriveDefaultSpineAffinities: (sectionKind: SectionKind) => SpineAffinities,
  overrides: Overrides,
): { sectionKind: SectionKind; spineAffinities: SpineAffinities; usedOverride: boolean } {
  const override = overrides[entryId];
  const sectionKind = override?.sectionKind ?? tableSectionKind;
  const spineAffinities = override?.spineAffinities ?? deriveDefaultSpineAffinities(sectionKind);
  return { sectionKind, spineAffinities, usedOverride: override !== undefined };
}

// ---------------------------------------------------------------------------------------------
// HyperUI blocks
// ---------------------------------------------------------------------------------------------

/**
 * A block's group (its id's first two path segments, e.g. "marketing/ctas") to the taxonomy
 * section id its blocks generically render as. Covers all 18 groups in the pinned manifest
 * (`node -e` over manifest.json confirms exactly these 18; a group manifest.json doesn't have is
 * an error below, not a silent skip).
 */
const HYPERUI_GROUP_SECTION_KIND: Record<string, SectionKind> = {
  'application/charts': 'stats-metrics',
  'application/details-list': 'specifications',
  'application/empty-states': 'unclassified',
  'application/filters': 'unclassified',
  'application/side-menu': 'navigation',
  'application/stats': 'stats-metrics',
  'application/tables': 'specifications',
  'application/tabs': 'navigation',
  'application/timelines': 'timeline-roadmap',
  'application/vertical-menu': 'navigation',
  'marketing/ctas': 'cta-band',
  'marketing/feature-grids': 'features',
  'marketing/footers': 'footer',
  'marketing/logo-clouds': 'logo-wall',
  'marketing/pricing': 'pricing',
  'marketing/sections': 'hero',
  'marketing/stats': 'stats-metrics',
  'marketing/testimonials': 'testimonials',
};

function humanise(label: string): string {
  return label
    .replace(/[-_/]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function hyperuiSpineAffinities(sectionKind: SectionKind): SpineAffinities {
  // Vendored blocks are generic, reusable page furniture, not tied to one business kind — 'any'
  // by default, matching the design doc's "a generic hero or CTA is any". An entry the group
  // table could not classify (sectionKind 'unclassified') carries the same uncertainty into its
  // spine affinity rather than a confident-looking 'any'.
  return sectionKind === 'unclassified' ? 'unclassified' : 'any';
}

/**
 * Every `insertableIds` entry must name a block the manifest actually vendors, or v1's insertable
 * set silently shrinks to whatever subset happens to match (down to zero) while `catalog.json`
 * still builds and `--check` still passes — the exact failure mode the delta audit's BLOCK #1
 * describes. Exported (and parameterized on `insertableIds`/`manifest` rather than reading
 * `INSERTABLE_V1` directly) so tests/catalog.test.ts can exercise the throw path with a synthetic
 * bogus id against the real manifest, instead of only asserting the real constant happens to match.
 */
export function checkInsertableIdsExist(insertableIds: readonly string[], manifest: HyperuiManifest): void {
  const blockIds = new Set(manifest.blocks.map((block) => block.id));
  for (const id of insertableIds) {
    if (!blockIds.has(id)) {
      throw new Error(`INSERTABLE_V1: "${id}" does not resolve to any block in the pinned HyperUI manifest (plugins/_official/shared/ui-kits/hyperui/manifest.json)`);
    }
  }
}

function buildHyperuiEntries(overrides: Overrides, usedOverrides: Set<string>): SectionCatalogEntry[] {
  const manifest = readJson<HyperuiManifest>(path.join(hyperuiRoot, 'manifest.json'));
  checkInsertableIdsExist(INSERTABLE_V1, manifest);
  const commit = manifest.upstream.commit.slice(0, 12);
  const entries: SectionCatalogEntry[] = [];

  for (const block of manifest.blocks) {
    const group = block.id.split('/').slice(0, 2).join('/');
    const tableSectionKind = HYPERUI_GROUP_SECTION_KIND[group];
    if (!tableSectionKind) throw new Error(`hyperui block "${block.id}": no HYPERUI_GROUP_SECTION_KIND entry for group "${group}"`);

    const filePath = path.join(hyperuiRoot, block.file);
    if (!existsSync(filePath)) throw new Error(`hyperui block "${block.id}": ${block.file} does not exist`);
    const sha256 = createHash('sha256').update(readFileSync(filePath)).digest('hex');

    const id = `hyperui:${block.id}`;
    const { sectionKind, spineAffinities, usedOverride } = resolveClassification(id, tableSectionKind, hyperuiSpineAffinities, overrides);
    if (usedOverride) usedOverrides.add(id);

    const insertable = INSERTABLE_V1.includes(block.id);
    entries.push({
      id,
      title: humanise(block.id),
      sourceKind: 'hyperui',
      sectionKind,
      sourceType: group,
      spineAffinities,
      rights: {
        license: 'MIT',
        decision: 'bundle',
        evidence: `HyperUI (${manifest.upstream.repo}@${commit}) — plugins/_official/shared/ui-kits/hyperui/LICENSE, UPSTREAM.json; see NOTICE`,
      },
      access: 'local',
      // v1 scope limit (design doc §1): only the three reviewed marketing blocks are insertable;
      // every other block is discoverable but needs phase B's adapter before it can render.
      availability: insertable ? 'insertable' : 'adapter-needed',
      preview: { kind: 'none' },
      // Phase B (Sol design §2) reviewed and adapted exactly the three `INSERTABLE_V1` blocks —
      // `plugins/_official/shared/agency-compiler/scripts/section-adapter-{ctas-1,feature-grids-1,
      // sections-1}.ts`, generated by `scripts/build-section-adapters.ts` at the repo root. Each
      // adapter's own `id` is `hyperui:<blockId>`, identical to this entry's `id`, so the two are
      // never allowed to drift apart; `missingInsertableAdapters` (src/validate.ts) is the gate.
      content: insertable ? { kind: 'vendored-block', blockId: block.id, sha256, adapterId: id } : { kind: 'vendored-block', blockId: block.id, sha256 },
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Family sections
// ---------------------------------------------------------------------------------------------

/**
 * `${family}:${type}` (the section's own `type` field in its reference.fixture.json) to a
 * taxonomy section id. A family/type pair this table has no entry for gets sectionKind
 * 'unclassified' and spineAffinities 'unclassified' rather than a forced guess; a handful of
 * those are then hand-corrected in data/overrides.json where the section's real content is clear
 * enough to name (e.g. emmpo's "career" quiz callout reads as a cta-band, not a generic feature).
 */
const FAMILY_SECTION_TYPE_KIND: Record<string, SectionKind> = {
  'app-shell:top-nav': 'navigation',
  'app-shell:side-nav': 'navigation',
  'app-shell:empty-state': 'unclassified',
  'app-shell:list-view': 'unclassified',
  'app-shell:detail-view': 'unclassified',
  'app-shell:settings': 'unclassified',

  'crm-dashboard:kpi-strip': 'stats-metrics',
  'crm-dashboard:pipeline-table': 'unclassified',
  'crm-dashboard:activity-feed': 'unclassified',
  'crm-dashboard:contact-card': 'unclassified',
  'crm-dashboard:filter-bar': 'unclassified',
  'crm-dashboard:bar-chart': 'stats-metrics',

  'emmpo:hero': 'hero',
  'emmpo:explore': 'features',
  'emmpo:discover': 'features',
  'emmpo:science': 'process-steps',
  'emmpo:person': 'team',
  'emmpo:talents': 'benefits',
  'emmpo:community': 'unclassified',
  'emmpo:footer': 'footer',
  'emmpo:courses': 'product-grid',

  'fervor:navigation': 'navigation',
  'fervor:hero': 'hero',
  'fervor:work': 'proof-gallery',
  'fervor:manifesto': 'manifesto-statement',
  'fervor:expertise1': 'services',
  'fervor:expertise2': 'services',
  'fervor:expertise3': 'services',
  'fervor:testimonial': 'testimonials',
  'fervor:contact': 'contact-form',

  'halcyon:navigation': 'navigation',
  'halcyon:hero': 'hero',
  'halcyon:collection': 'product-grid',
  'halcyon:events': 'unclassified',
  'halcyon:learn': 'services',
  'halcyon:visit': 'location-map-hours',
  'halcyon:membership': 'pricing',
  'halcyon:support': 'cta-band',
  'halcyon:footer': 'footer',

  'maben:rail-chrome': 'navigation',
  'maben:overlay-menu': 'navigation',
  'maben:statement-hero': 'hero',
  'maben:stepped-panel': 'process-steps',
  'maben:portfolio-carousel': 'proof-gallery',
  'maben:editorial-grid': 'proof-gallery',
  'maben:closing-chrome': 'footer',

  'maren:navigation': 'navigation',
  'maren:hero': 'hero',
  'maren:collection': 'product-grid',
  'maren:craft': 'about-story',
  'maren:materials': 'specifications',
  'maren:ordering': 'process-steps',
  'maren:reviews': 'testimonials',
  'maren:visit': 'location-map-hours',
  'maren:footer': 'footer',

  'marketing-site:hero': 'hero',
  'marketing-site:feature-grid': 'features',
  'marketing-site:testimonials': 'testimonials',
  'marketing-site:pricing': 'pricing',
  'marketing-site:cta': 'cta-band',
  'marketing-site:footer': 'footer',

  'nonprofit:header': 'navigation',
  'nonprofit:hero': 'hero',
  'nonprofit:mission': 'about-story',
  'nonprofit:programs': 'services',
  'nonprofit:impact': 'stats-metrics',
  'nonprofit:events': 'unclassified',
  'nonprofit:give': 'cta-band',
  'nonprofit:volunteer': 'cta-band',
  'nonprofit:footer': 'footer',

  'publication:masthead': 'navigation',
  'publication:lead-story': 'hero',
  'publication:topics': 'unclassified',
  'publication:latest': 'blog-articles',
  'publication:series': 'blog-articles',
  'publication:archive': 'blog-articles',
  'publication:authors': 'team',
  'publication:newsletter': 'newsletter-waitlist',
  'publication:membership': 'pricing',
  'publication:footer': 'footer',

  'watson:navigation': 'navigation',
  'watson:hero': 'hero',
  'watson:statement': 'manifesto-statement',
  'watson:about': 'about-story',
  'watson:footer': 'footer',

  'wrenfield:navigation': 'navigation',
  'wrenfield:hero': 'hero',
  'wrenfield:difference': 'benefits',
  'wrenfield:services': 'services',
  'wrenfield:process': 'process-steps',
  'wrenfield:featured': 'proof-gallery',
  'wrenfield:reviews': 'testimonials',
  'wrenfield:finalCta': 'cta-band',
  'wrenfield:footer': 'footer',

  'listings:header': 'navigation',
  'listings:search-hero': 'hero',
  'listings:categories': 'unclassified',
  'listings:filters': 'unclassified',
  'listings:results': 'product-grid',
  'listings:comparison': 'plan-comparison',
  'listings:featured': 'unclassified',
  'listings:reviews': 'testimonials',
  'listings:inquiry': 'contact-form',
  'listings:footer': 'footer',
};

function familySpineAffinities(sectionKind: SectionKind, spine: SpineCode): SpineAffinities {
  // Unlike a vendored HyperUI block, a family section is never insertable outside its own family
  // (rights.decision "same-family-only", availability "reference-only" — enforced by
  // src/validate.ts#sectionCatalogPolicyIssues). Giving a generic-looking kind like hero/cta-band
  // spineAffinities "any" here would let a spine-filtered picker (spine=PA&kind=hero) surface
  // every family's hero as a same-family-only entry it can never actually place — the affinity
  // field must stay scoped to the section's own spine, matching the rights decision it ships
  // with. src/validate.ts also refuses "any" for any sourceKind "family-section" entry, including
  // one set through data/overrides.json, as a second line of defense.
  if (sectionKind === 'unclassified') return 'unclassified';
  return [spine];
}

interface FixtureSection { id: string; type: string }
interface FamilyFixture { sections: Array<FixtureSection | null> }

function familyPackageDir(family: string): string {
  return path.join(repoRoot, `plugins/_official/examples/agency-${family}/compiler/scripts/families/${family}`);
}

function buildFamilySectionEntries(overrides: Overrides, usedOverrides: Set<string>): SectionCatalogEntry[] {
  const registry = readJson<FamilyRegistry>(familyRegistryPath);
  const entries: SectionCatalogEntry[] = [];

  for (const { family, spine } of registry.families) {
    const fixturePath = path.join(familyPackageDir(family), 'reference.fixture.json');
    if (!existsSync(fixturePath)) throw new Error(`family "${family}": no reference.fixture.json at ${fixturePath}`);
    const fixture = readJson<FamilyFixture>(fixturePath);

    for (const section of fixture.sections) {
      if (!section) continue; // an optional section the reference fixture leaves unset
      const key = `${family}:${section.type}`;
      const tableSectionKind = FAMILY_SECTION_TYPE_KIND[key] ?? 'unclassified';
      const id = `family-section:${family}:${section.id}`;
      const { sectionKind, spineAffinities, usedOverride } = resolveClassification(
        id, tableSectionKind, (kind) => familySpineAffinities(kind, spine), overrides,
      );
      if (usedOverride) usedOverrides.add(id);

      entries.push({
        id,
        title: `${humanise(family)} — ${humanise(section.type)}`,
        sourceKind: 'family-section',
        sectionKind,
        sourceType: section.type,
        spineAffinities,
        rights: {
          license: 'project-specific',
          decision: 'same-family-only',
          evidence: `plugins/_official/examples/agency-${family}/README.md#rights — private reconstruction, not commercial clearance; selectable only within the ${family} family (design doc §1, §2)`,
        },
        access: 'local',
        // Design doc §2: "Family sections remain selectable only through their own family's
        // current keep/drop controls." A section-catalog entry documents it for discovery; it is
        // never an insertable unit outside that family.
        availability: 'reference-only',
        preview: { kind: 'none' },
        content: { kind: 'family-section', family, sectionId: section.id },
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Cult UI Pro sections and pages
// ---------------------------------------------------------------------------------------------

/** The fields of a `packages/cult-ui-catalog/catalog.json` row this projection reads. */
export interface CultRow {
  id: string;
  name: string;
  title: string;
  description: string;
  original: { category: string };
  source: { snapshotId: string };
  assetKind: 'section' | 'page' | 'primitive' | 'app';
  taxonomy: { sectionKind: SectionKind };
  spineAffinities: SpineCode[];
  rights: { license: string; decision: string; evidence: string };
  conversion: { status: string };
  adapter: { id: string; version: string } | null;
  /** Set on a section the converter cut from a whole-page row: that page's id. */
  derivedFrom?: string;
}

export interface CultCatalogFile {
  schema: string;
  snapshot: { id: string };
  rows: CultRow[];
}

/**
 * Other companies' names that appear in Cult titles as style labels ("Marketing Pricing Vercel").
 * A display title never names them; each becomes a neutral series letter instead, so two variants
 * of one section kind stay distinguishable. The raw title survives in `content.sourceTitle`.
 * Longer phrases come first so "Apple Style" is consumed whole, not as "Apple" plus "Style".
 */
export const CULT_TITLE_BRANDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bapple[- ]style\b/gi, 'A'],
  [/\bapple\b/gi, 'A'],
  [/\bheerich\b/gi, 'H'],
  [/\bshadcn\b/gi, 'S'],
  [/\bvercel\b/gi, 'V'],
  [/\bvite\b/gi, 'VT'],
];

/**
 * The reviewed vocabulary of a Cult display title. A deny list of brands cannot prove a title is
 * brand-free, so the projection fails closed instead: once the known brands are replaced, every
 * remaining word must be on this list (numbers always are). A new Cult title with an unknown word
 * — a new brand or just a new style label — stops the build until a reviewer adds the word here
 * (a generic word) or to CULT_TITLE_BRANDS (another company's name).
 */
export const CULT_TITLE_WORDS: ReadonlySet<string> = new Set([
  'about', 'abstract', 'accordion', 'agent', 'ai', 'animated', 'background', 'banner', 'bento', 'block', 'blog',
  'calculator', 'capabilities', 'cases', 'changelog', 'circle', 'cloud', 'code', 'colorful', 'compact', 'comparison',
  'contact', 'core', 'cosmic', 'count', 'cta', 'dark', 'database', 'dither', 'dithering', 'download', 'faq', 'feature',
  'features', 'floating', 'focused', 'footer', 'gallery', 'globe', 'gradient', 'grid', 'guide', 'hero', 'hex',
  'horizontal', 'hover', 'how', 'hyperspace', 'image', 'immersive', 'input', 'integration', 'integrations',
  'interactive', 'it', 'large', 'layout', 'liquid', 'logo', 'marketing', 'menu', 'metal', 'minimal', 'model', 'modern',
  'moss', 'nav', 'navbar', 'navigation', 'neuro', 'noise', 'organic', 'page', 'painting', 'particles', 'pattern',
  'pricing', 'primary', 'process', 'proof', 'quote', 'radial', 'regal', 'ribbon', 'roadmap', 'roi', 'roll', 'saas',
  'scroll', 'section', 'series', 'settings', 'shader', 'sharp', 'showcase', 'simple', 'simplex', 'site', 'social',
  'stats', 'sticky', 'style', 'table', 'tabs', 'team', 'teams', 'testimonials', 'text', 'texture', 'use', 'vertical',
  'waitlist', 'warp', 'wave', 'waves', 'with', 'works',
]);

/** Words of a (brand-stripped) title that are neither numbers, series letters nor reviewed words. */
export function unreviewedTitleWords(title: string, series: readonly string[] = []): string[] {
  const letters = new Set(series.map((letter) => letter.toLowerCase()));
  return title
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0 && !/^\d+$/.test(word))
    .map((word) => word.toLowerCase())
    .filter((word) => !CULT_TITLE_WORDS.has(word) && !letters.has(word));
}

/**
 * "Marketing Pricing Vercel" → "Pricing (series V)"; "Marketing CTA — Heerich" → "CTA (series H)";
 * "Marketing Hero Simple" → "Hero Simple". The leading "Marketing" is dropped because every Cult
 * section is a marketing section (its category stays in `sourceType`). Every occurrence of a known
 * brand is replaced, and a title left with an unreviewed word throws (see CULT_TITLE_WORDS).
 */
export function cultDisplayTitle(rawTitle: string): string {
  let title = rawTitle;
  const series: string[] = [];
  for (const [pattern, letter] of CULT_TITLE_BRANDS) {
    const next = title.replace(pattern, ' ');
    if (next === title) continue;
    title = next;
    if (!series.includes(letter)) series.push(letter);
  }
  title = title
    .replace(/\s+[—–-]\s*(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^Marketing\s+(?=\S)/, '');
  if (title.length === 0) throw new Error(`cult title "${rawTitle}" has nothing left once brand names are removed`);
  const unknown = unreviewedTitleWords(title);
  if (unknown.length > 0) {
    throw new Error(`cult title "${rawTitle}" has unreviewed word(s) ${unknown.join(', ')}: add each to CULT_TITLE_WORDS (a generic word) or CULT_TITLE_BRANDS (a company name)`);
  }
  return series.length > 0 ? `${title} (series ${series.join(', ')})` : title;
}

/**
 * The adapter id of an insertable section row, or undefined. A row is insertable only when the
 * inventory marks it so, its adapter id is its own id, and the checked adapter file exists; a whole
 * page never is.
 */
function cultAdapterIdOf(row: CultRow, sectionKind: SectionKind): string | undefined {
  if ((row.conversion.status === 'insertable') !== (row.adapter !== null)) {
    throw new Error(`cult row "${row.id}": conversion status "${row.conversion.status}" disagrees with its adapter reference`);
  }
  if (row.adapter === null) return undefined;
  if (row.adapter.id !== row.id) throw new Error(`cult row "${row.id}": adapter id "${row.adapter.id}" is not the row id`);
  if (sectionKind === 'page-composition') throw new Error(`cult row "${row.id}": a whole page cannot be insertable`);
  const file = path.join(cultGeneratedDir, 'adapters', `${row.name}.ts`);
  if (!existsSync(file)) throw new Error(`cult row "${row.id}" is insertable but ${path.relative(repoRoot, file)} is missing`);
  return row.adapter.id;
}

export interface CultProjection {
  entries: SectionCatalogEntry[];
  /** Section/page rows left out, by reason — reported by the build instead of guessed into a kind. */
  skipped: Record<string, string[]>;
}

/**
 * One entry per Cult `section` or `page` row. A section row's kind is its closed taxonomy id; a
 * page row is always `page-composition`. A section row the inventory left `unclassified` is skipped
 * and counted rather than projected: the Cult importer found no taxonomy id for it, and inventing
 * one here would route a block on a guess. `primitive` and `app` rows are not sections and never
 * reach this catalog (they belong to a separate components listing).
 */
export function projectCultEntries(cult: CultCatalogFile): CultProjection {
  if (cult.schema !== 'cult-ui-catalog/1') throw new Error(`${path.relative(repoRoot, cultCatalogPath)}: unexpected schema "${cult.schema}"`);
  const entries: SectionCatalogEntry[] = [];
  const skipped: Record<string, string[]> = {};
  const skip = (reason: string, id: string): void => { (skipped[reason] ??= []).push(id); };

  for (const row of cult.rows) {
    if (row.assetKind !== 'section' && row.assetKind !== 'page') continue;
    if (row.source.snapshotId !== cult.snapshot.id) {
      throw new Error(`cult row "${row.id}": snapshot "${row.source.snapshotId}" is not the catalog snapshot "${cult.snapshot.id}"`);
    }
    // The entry's rights are the recorded Cult triple; a row the inventory labels otherwise is a
    // drift between the two packages, never silently relabelled.
    if (row.rights.license !== CULT_PRO_RIGHTS.license || row.rights.decision !== CULT_PRO_RIGHTS.decision || row.rights.evidence !== CULT_PRO_RIGHTS.evidence) {
      throw new Error(`cult row "${row.id}": rights ${JSON.stringify(row.rights)} are not the recorded Cult UI Pro rights`);
    }
    let sectionKind: SectionKind;
    if (row.assetKind === 'page') {
      sectionKind = 'page-composition';
    } else if (row.taxonomy.sectionKind === 'unclassified') {
      skip('section row with taxonomy sectionKind "unclassified"', row.id);
      continue;
    } else if (row.taxonomy.sectionKind === 'page-composition') {
      skip('section row classified as a whole page', row.id);
      continue;
    } else {
      sectionKind = row.taxonomy.sectionKind;
    }

    const adapterId = cultAdapterIdOf(row, sectionKind);
    entries.push({
      id: row.id,
      title: cultDisplayTitle(row.title),
      sourceKind: 'cult-pro',
      sectionKind,
      sourceType: row.original.category,
      // An empty list is the inventory's "no discriminating use-case intent" — unclassified here,
      // never widened to "any" (port ruling §4: a colour scheme alone does not imply a spine).
      spineAffinities: row.spineAffinities.length > 0 ? [...row.spineAffinities] : 'unclassified',
      rights: { ...CULT_PRO_RIGHTS },
      access: 'local',
      // Insertable only through a checked adapter (packages/cult-ui-catalog/generated/, gated by
      // that package's `check`); every other row is catalogued as needing one.
      availability: adapterId !== undefined ? 'insertable' : 'adapter-needed',
      preview: { kind: 'none' },
      content: {
        kind: 'cult-item',
        summary: row.description,
        sourceTitle: row.title,
        provenance: { cultId: row.id, snapshotId: cult.snapshot.id },
        ...(adapterId !== undefined ? { adapterId } : {}),
      },
    });
  }
  return { entries, skipped };
}

function buildCultEntries(): CultProjection {
  if (!existsSync(cultCatalogPath)) throw new Error(`no Cult inventory at ${cultCatalogPath}`);
  return projectCultEntries(readJson<CultCatalogFile>(cultCatalogPath));
}

// ---------------------------------------------------------------------------------------------
// Assemble, validate, write
// ---------------------------------------------------------------------------------------------

export function buildCatalog(): SectionCatalog {
  return buildCatalogWithReport().catalog;
}

/** The catalog plus what the Cult projection skipped (printed by the CLI, asserted by tests). */
export function buildCatalogWithReport(): { catalog: SectionCatalog; cultSkipped: Record<string, string[]> } {
  const overrides = readOverrides();
  const usedOverrides = new Set<string>();
  const cult = buildCultEntries();
  const entries = [
    ...buildHyperuiEntries(overrides, usedOverrides),
    ...buildFamilySectionEntries(overrides, usedOverrides),
    ...cult.entries,
  ];
  checkOverridesMatchEntries(overrides, usedOverrides);
  // Sorted by id rather than left in source-file order: buildHyperuiEntries walks
  // manifest.blocks and buildFamilySectionEntries walks registry.families / each family's
  // reference.fixture.json, none of which this script pins the order of. Without this sort,
  // reordering either upstream file (with no semantic change to any entry) would flip `--check`
  // — the id sort makes catalog.json's entry order a pure function of the entries themselves.
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { catalog: validateSectionCatalog({ schema: SECTION_CATALOG_SCHEMA, entries }), cultSkipped: cult.skipped };
}

/**
 * Every `data/overrides.json` key must match a generated entry id, or the file has silently gone
 * stale (renamed/removed source, typo'd id). Exported so tests/catalog.test.ts can exercise the
 * throw path directly with a synthetic mismatched override, instead of only asserting that the
 * real committed file happens to match (see F7 in the delta review this hardens against).
 */
export function checkOverridesMatchEntries(overrides: Overrides, usedOverrides: ReadonlySet<string>): void {
  for (const id of Object.keys(overrides)) {
    if (!usedOverrides.has(id)) throw new Error(`data/overrides.json: "${id}" does not match any generated entry`);
  }
}

// The exact key order `--check` and the writer both use for one entry, independent of whatever
// property insertion order a caller (in particular `JSON.parse` of a hand-edited catalog.json)
// happens to hand in. This is what makes "canonical serialization" a real, testable contract
// instead of an unenforced coincidence of this file's own object-literal order (delta audit #2:
// the old comment "a pure function of the entries themselves" was true only by accident).
const ENTRY_KEY_ORDER = [
  'id', 'title', 'sourceKind', 'sectionKind', 'sourceType', 'spineAffinities', 'rights', 'access',
  'availability', 'preview', 'content',
] as const satisfies readonly (keyof SectionCatalogEntry)[];
const RIGHTS_KEY_ORDER = ['license', 'decision', 'evidence'] as const;

function orderedKeys<T extends object>(value: T, order: readonly (keyof T)[]): T {
  const ordered = {} as T;
  for (const key of order) {
    if (value[key] !== undefined) ordered[key] = value[key];
  }
  return ordered;
}

/**
 * One entry with every object's keys in `ENTRY_KEY_ORDER`/`RIGHTS_KEY_ORDER` (`preview`/`content`
 * keep their own keys as-is — each is a `{ kind, ...fixed shape }` tagged union with no key that
 * could reorder). Array position (which entry comes before which) is untouched: canonicalizing key
 * order must not silently accept a shuffled *entries* array as equivalent to the sorted one
 * `buildCatalog` always produces — see `isCatalogStale` below.
 */
function canonicalEntry(entry: SectionCatalogEntry): SectionCatalogEntry {
  const ordered = orderedKeys(entry, ENTRY_KEY_ORDER);
  ordered.rights = orderedKeys(entry.rights, RIGHTS_KEY_ORDER);
  return ordered;
}

/** The canonical form of a whole catalog: `schema` then `entries`, each entry's keys ordered. */
export function canonicalizeCatalog(catalog: SectionCatalog): SectionCatalog {
  return { schema: catalog.schema, entries: catalog.entries.map(canonicalEntry) };
}

export function serialiseCatalog(catalog: SectionCatalog): string {
  return `${JSON.stringify(canonicalizeCatalog(catalog), null, 2)}\n`;
}

/**
 * True when `diskText` (the current contents of `catalog.json`) is not what `pnpm --filter
 * @mish/section-catalog catalog` would write for `built` — including when `diskText` is
 * unparsable, when an entry's fields were hand-edited into a different key order (canonicalized
 * away, so that alone is not "stale"), when any entry's content differs, or when the *entries
 * array itself* is shuffled into a different order than `built`'s sorted-by-id order (still
 * "stale": the generator never produces a shuffled array, so seeing one on disk means the file was
 * not regenerated after whatever produced that order). Exported so tests/catalog.test.ts can feed
 * a synthetic shuffled/mutated disk text without touching the real committed catalog.json.
 */
export function isCatalogStale(diskText: string, built: SectionCatalog): boolean {
  let diskCatalog: SectionCatalog;
  try {
    diskCatalog = JSON.parse(diskText) as SectionCatalog;
  } catch {
    return true;
  }
  return serialiseCatalog(diskCatalog) !== serialiseCatalog(built);
}

function cultReport(catalog: SectionCatalog, skipped: Record<string, string[]>): string {
  const kinds: Record<string, number> = {};
  for (const entry of catalog.entries) {
    if (entry.sourceKind === 'cult-pro') kinds[entry.sectionKind] = (kinds[entry.sectionKind] ?? 0) + 1;
  }
  const projected = Object.values(kinds).reduce((sum, count) => sum + count, 0);
  const skippedLines = Object.entries(skipped).map(([reason, ids]) => `\n  skipped ${ids.length}: ${reason} (${ids.join(', ')})`);
  return `build-catalog: ${projected} Cult entries (${Object.entries(kinds).sort().map(([kind, count]) => `${kind} ${count}`).join(', ')})${skippedLines.join('')}`;
}

function main(): void {
  const check = process.argv.includes('--check');
  const { catalog: built, cultSkipped } = buildCatalogWithReport();
  console.log(cultReport(built, cultSkipped));
  const text = serialiseCatalog(built);
  const current = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : '';
  if (check) {
    if (isCatalogStale(current, built)) {
      console.error('build-catalog: catalog.json is stale. Run `pnpm --filter @mish/section-catalog catalog` and commit the result.');
      process.exitCode = 1;
      return;
    }
    console.log('build-catalog: catalog.json is valid and up to date.');
    return;
  }
  if (current !== text) writeFileSync(catalogPath, text);
  console.log(`build-catalog: ${current === text ? 'already up to date' : 'wrote catalog.json'}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
