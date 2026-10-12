/**
 * Closed classification ids. The lists mirror
 * `packages/agency-fast-lane/src/taxonomy/design-taxonomy.json` (sections, components, style
 * density) and `packages/agency-fast-lane/src/atlas/shape-atlas.json` (spine codes);
 * tests/taxonomy.test.ts reads those files and fails on drift.
 */

export const TAXONOMY_SECTION_IDS = [
  'navigation', 'hero', 'features', 'services', 'benefits', 'process-steps', 'proof-gallery',
  'product-grid', 'pricing', 'plan-comparison', 'testimonials', 'reviews-ratings',
  'stats-metrics', 'logo-wall', 'team', 'about-story', 'manifesto-statement', 'faq',
  'blog-articles', 'newsletter-waitlist', 'contact-form', 'booking-availability',
  'location-map-hours', 'cta-band', 'footer', 'timeline-roadmap', 'integrations',
  'specifications',
] as const;
export type TaxonomySectionId = (typeof TAXONOMY_SECTION_IDS)[number];

/** A whole landing page, or an item with no section role — the same extension section-catalog uses. */
export const SECTION_KINDS = [...TAXONOMY_SECTION_IDS, 'page-composition', 'unclassified'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const COMPONENT_IDS = [
  'sticky-nav', 'mega-menu', 'marquee-ticker', 'carousel-slider', 'before-after-slider', 'tabs',
  'accordion', 'card-grid', 'bento-grid', 'masonry', 'modal-dialog', 'custom-cursor',
  'video-background', '3d-canvas-webgl', 'particle-shader-field', 'number-counter',
  'filter-search', 'form', 'toggle-switch', 'scroll-progress', 'hotspots-tooltips',
  'floating-glass-panel', 'split-screen', 'hud-dock',
] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export const STYLE_DENSITIES = ['airy', 'balanced', 'dense'] as const;
export type StyleDensity = (typeof STYLE_DENSITIES)[number];

export const SPINE_CODES = ['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI'] as const;
export type SpineCode = (typeof SPINE_CODES)[number];
