/**
 * Deterministic classification of one index item: asset kind, section kind, taxonomy components
 * and style density. Rules follow the 2026-09-25 port ruling §4 and §6. reviewed-overrides.json
 * corrects individual rows after these rules run.
 */

import type { IndexItem } from './kit.ts';
import type { ComponentId, SectionKind, StyleDensity } from './taxonomy.ts';
import type { AssetKind } from './types.ts';

/** Categories whose items are application flows a static marketing build cannot promise. */
const APP_CATEGORIES = new Set([
  'ai', 'agent', 'auth', 'payments', 'forms', 'app-ui', 'app-ui-grid-list', 'featured',
]);

/** Categories that hold static-ish building blocks rather than sections. */
const PRIMITIVE_CATEGORIES = new Set(['expansion-packs']);

/** Item names that are application widgets (data flow, uploads, multi-step state). */
const APP_NAME = /(^|-)(kanban|composer|chat|agent|auth|login|signin|signup|payment|checkout|dropzone|upload|wizard|onboarding)(-|$)/;

/** Dependencies that need a server, a model provider or a data store at runtime. */
const APP_DEPENDENCY = /^(ai|@ai-sdk\/.*|@upstash\/.*|stripe|@stripe\/.*|resend|@polar-sh\/.*|redis|ioredis|openai)$/;

const SECTION_BY_CATEGORY: Record<string, SectionKind> = {
  'marketing-heroes': 'hero',
  'marketing-features': 'features',
  'marketing-bento': 'features',
  'marketing-cta': 'cta-band',
  'marketing-faq': 'faq',
  'marketing-integrations': 'integrations',
  'marketing-navigation': 'navigation',
  'marketing-team': 'team',
  'marketing-footer': 'footer',
  'marketing-roadmap': 'timeline-roadmap',
  'marketing-stats': 'stats-metrics',
  'marketing-blog': 'blog-articles',
  'marketing-about': 'about-story',
  'marketing-waitlist': 'newsletter-waitlist',
  'landing-page': 'page-composition',
};

function labelText(item: IndexItem): string {
  return [item.name, item.title, ...item.tags].join(' ').toLowerCase();
}

export function classifyAssetKind(item: IndexItem): AssetKind {
  if (item.category === 'landing-page') return 'page';
  if (APP_CATEGORIES.has(item.category)) return 'app';
  if (item.dependencies.some((d) => APP_DEPENDENCY.test(d))) return 'app';
  if (item.type === 'registry:block' && item.category.startsWith('marketing-')) return 'section';
  if (PRIMITIVE_CATEGORIES.has(item.category)) return 'primitive';
  if (item.type === 'registry:ui' || item.type === 'registry:component') {
    return APP_NAME.test(item.name) ? 'app' : 'primitive';
  }
  // An unknown block category is catalogued conservatively: it never enters the static planner.
  return 'app';
}

export function classifySectionKind(item: IndexItem, assetKind: AssetKind): SectionKind {
  if (assetKind !== 'section' && assetKind !== 'page') return 'unclassified';
  const text = labelText(item);
  switch (item.category) {
    case 'marketing-pricing':
      return /compar|compare/.test(text) ? 'plan-comparison' : 'pricing';
    case 'marketing-comparison':
      return /pricing|\bplans?\b|\btiers?\b/.test(text) ? 'plan-comparison' : 'specifications';
    case 'marketing-social-proof':
      if (/testimonial|quote/.test(text)) return 'testimonials';
      if (/rating|review|stars/.test(text)) return 'reviews-ratings';
      if (/logo/.test(text)) return 'logo-wall';
      return 'testimonials';
    default:
      return SECTION_BY_CATEGORY[item.category] ?? 'unclassified';
  }
}

const COMPONENT_EVIDENCE: ReadonlyArray<[ComponentId, RegExp]> = [
  ['bento-grid', /bento/],
  ['marquee-ticker', /marquee/],
  ['carousel-slider', /carousel|slider/],
  ['tabs', /\btabs?\b/],
  ['accordion', /accordion/],
  ['toggle-switch', /toggle|switch/],
  ['number-counter', /counter|number-flow/],
];

/**
 * Closed component ids evidenced by the item's own labels or dependencies. `sourceText` (the
 * fetched source, or '' while pending) adds evidence from imports such as an accordion primitive.
 */
export function classifyComponents(item: IndexItem, sourceText: string): ComponentId[] {
  const text = `${labelText(item)} ${item.dependencies.join(' ')}`;
  const found = new Set<ComponentId>();
  if (item.category === 'marketing-bento') found.add('bento-grid');
  for (const [id, pattern] of COMPONENT_EVIDENCE) if (pattern.test(text)) found.add(id);
  if (/components\/ui\/accordion|@radix-ui\/react-accordion/.test(sourceText)) found.add('accordion');
  if (/@number-flow\/react/.test(sourceText)) found.add('number-counter');
  return [...found].sort();
}

const DENSITY_BY_SPACING: Record<string, StyleDensity> = {
  compact: 'dense',
  default: 'balanced',
  large: 'airy',
};

/** Only density has direct evidence in the source style labels; other axes stay unset. */
export function classifyStyle(item: IndexItem): { density?: StyleDensity } {
  const spacing = item.style?.spacing;
  const density = typeof spacing === 'string' ? DENSITY_BY_SPACING[spacing] : undefined;
  return density ? { density } : {};
}
