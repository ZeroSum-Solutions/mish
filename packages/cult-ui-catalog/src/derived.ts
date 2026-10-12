/**
 * Derived rows: the insertable sections the kit converter cuts out of a whole-page item. A page's
 * registry item ships each of its sections as its own file (`…/components/sections/<section>.tsx`);
 * the converter converts each one as the block `<page>--<section>` (kit `scripts/convert.mjs`
 * `subBlocks`). Each becomes one catalog row:
 *
 *   id `cult:<page>--<section>`, name `<page>--<section>`, `derivedFrom: 'cult:<page>'`
 *
 * The id keeps the `cult:<name>` shape every other row has (`[a-z0-9-]` after `cult:`), because
 * the fast-lane registry (`CULT_ADAPTER_ID`), the section-catalog contract and schema, and the
 * overlay's `od-selected-*` section id all accept only that shape; `cult:<page>/sections/<x>`
 * would be refused by all three.
 *
 * A derived row shares its page's snapshot, source hashes and rights (the adapter's sourceSha256
 * covers the whole page item). It is not a registry item: the snapshot counts it in
 * `derivedRows`, never in `expectedItems`, so the registry-index invariant stays checkable.
 */

import { classifyComponents } from './classify.ts';
import { initialConversion } from './conversion.ts';
import { requirements, runtimeFeatures } from './features.ts';
import type { FetchedItem, IndexItem } from './kit.ts';
import type { SectionKind } from './taxonomy.ts';
import type { CultCatalogRow } from './types.ts';

/** The page file that holds one section; the capture is the section name. Mirrors the kit's `SECTION_RE`. */
export const PAGE_SECTION_FILE = /\/components\/sections\/([a-z0-9][a-z0-9-]*)\.tsx$/;

/** Section name → closed section kind. Exact names first; `sectionKindForName` falls back to word matches. */
const SECTION_KIND_BY_NAME: Readonly<Record<string, SectionKind>> = {
  hero: 'hero',
  navbar: 'navigation',
  navigation: 'navigation',
  features: 'features',
  'use-cases': 'features',
  'tabs-showcase': 'features',
  'how-it-works': 'process-steps',
  'social-proof': 'logo-wall',
  testimonials: 'testimonials',
  'primary-cta': 'cta-band',
  'banner-section': 'cta-band',
  faq: 'faq',
  integrations: 'integrations',
  pricing: 'pricing',
  'site-footer': 'footer',
  footer: 'footer',
};

const SECTION_KIND_BY_WORD: ReadonlyArray<readonly [RegExp, SectionKind]> = [
  [/\bhero\b/, 'hero'],
  [/\bnav(bar|igation)?\b/, 'navigation'],
  [/\bfaq\b/, 'faq'],
  [/\bcta\b/, 'cta-band'],
  [/\bfooter\b/, 'footer'],
  [/\bpricing\b/, 'pricing'],
  [/\btestimonials?\b/, 'testimonials'],
  [/\bfeatures?\b/, 'features'],
  [/\bintegrations?\b/, 'integrations'],
  [/\bteam\b/, 'team'],
  [/\bstats\b/, 'stats-metrics'],
];

/** The closed section kind a section name evidences; `unclassified` when it evidences none. */
export function sectionKindForName(section: string): SectionKind {
  const exact = SECTION_KIND_BY_NAME[section];
  if (exact) return exact;
  const words = section.replace(/-/g, ' ');
  return SECTION_KIND_BY_WORD.find(([pattern]) => pattern.test(words))?.[1] ?? 'unclassified';
}

/** "how-it-works" → "How it works"; "faq" / "cta" stay upper case. */
export function sectionTitle(section: string): string {
  const words = section.split('-').map((w) => (w === 'faq' || w === 'cta' ? w.toUpperCase() : w));
  const first = words[0] ?? '';
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

export function derivedName(page: string, section: string): string {
  return `${page}--${section}`;
}

/** The section names a fetched page item ships as their own files, sorted and unique. */
export function pageSections(fetched: FetchedItem): string[] {
  const names = fetched.files.map((f) => PAGE_SECTION_FILE.exec(f.path)?.[1]).filter((s): s is string => s !== undefined);
  return [...new Set(names)].sort();
}

/**
 * One derived row per section of a fetched page row. Classification that needs source text reads
 * only that section's own file; everything that identifies the source (snapshot, hashes, rights,
 * original labels) is the page's.
 */
export function buildDerivedRows(page: CultCatalogRow, item: IndexItem, fetched: FetchedItem): CultCatalogRow[] {
  if (page.assetKind !== 'page') return [];
  return pageSections(fetched).map((section) => {
    const name = derivedName(page.name, section);
    const text = fetched.files.filter((f) => PAGE_SECTION_FILE.exec(f.path)?.[1] === section).map((f) => f.content).join('\n');
    const features = runtimeFeatures({ ...item, dependencies: [], files: [], envCount: 0, externalServices: [] }, text);
    return {
      id: `cult:${name}`,
      name,
      title: `${sectionTitle(section)} (page: ${page.title})`,
      description: `The ${sectionTitle(section).toLowerCase()} section of the ${page.title} page, converted on its own.`,
      original: structuredClone(page.original),
      source: structuredClone(page.source),
      rights: { ...page.rights },
      assetKind: 'section',
      taxonomy: {
        sectionKind: sectionKindForName(section),
        components: classifyComponents({ ...item, name: section, title: sectionTitle(section), tags: [], category: 'landing-page-section', dependencies: [] }, text),
        style: { ...page.taxonomy.style },
      },
      spineAffinities: [...page.spineAffinities],
      dependencies: [...page.dependencies],
      runtimeFeatures: features,
      requirements: requirements(text),
      conversion: initialConversion('section', item.category, features, undefined),
      adapter: null,
      previewId: null,
      measuredBytes: { html: null, css: null, js: null },
      derivedFrom: page.id,
    };
  });
}
