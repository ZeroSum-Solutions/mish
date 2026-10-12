/**
 * Normalize a MotionSites MCP `list_prompts`/`search_prompts` result into `SectionCatalogEntry`
 * rows the daemon merges into a catalog response at request time (design doc §1, §4 — federated
 * metadata, never baked into catalog.json).
 *
 * Input shape is the real `list_prompts`/`search_prompts` MCP tool result (verified live against
 * the tool, metadata only — see tests/motionsites.test.ts and its fixture for the exact fields):
 *   { results: [{ id, title, category, kind, access, preview_url, url }], upgrade_cta? }
 *
 * What this module never does, per the design doc's rights-clean path (§1, §4):
 *   - never calls `get_prompt` (the prompt body) — a build only fetches that on demand, later,
 *     outside this module, when the signed-in user starts a build from a chosen entry;
 *   - never reads or forwards `preview_url` — MotionSites' own hosted preview image. Bundling or
 *     proxying it would be exactly the "do not proxy or bundle its preview images" the design doc
 *     forbids, so `SectionPreview` (see src/types.ts) has no image field at all: only a link to
 *     the source (`external-link`), never a locally hosted copy;
 *   - never persists a prompt body, only `id` + a deep link, matching "keep prompt bodies out of
 *     the catalog JSON, project, build history, debug traces, browser storage, or logs."
 */

import type { AccessLevel, SectionCatalogEntry, SectionKind, SpineAffinities, SpineCode } from './types.ts';

export interface MotionSitesPromptResult {
  id: string;
  title: string;
  category: string;
  kind: 'website' | 'app';
  access: 'free' | 'premium';
  /** MotionSites' own hosted preview image URL. Deliberately not read into SectionCatalogEntry. */
  preview_url?: string;
  /** The deep link back to the source prompt on motionsites.ai — the only preview surface used. */
  url: string;
}

export interface MotionSitesListPromptsResponse {
  results: MotionSitesPromptResult[];
  upgrade_cta?: string;
}

/**
 * The rights.evidence string every normalized MotionSites entry carries. Dated and citable rather
 * than asserted inline, so a later change to motionsites.ai's site can be checked against exactly
 * what was verified and when, instead of a claim baked silently into every entry:
 *   - `/terms`, `/license`, `/pricing` all 404 on motionsites.ai, confirmed both by direct fetch
 *     and by extracting the SPA's full client-side route table from its JS bundle (no
 *     terms/privacy/license/tos/eula route exists anywhere); the only rights statement on the
 *     site is its footer, "© Motionsites AI 2026. All rights reserved." — no explicit grant of
 *     redistribution or resale rights for any prompt, template, or section.
 *   - Source: {@link https://motionsites.ai/mcp} (its own MCP tool instructions) and
 *     {@link https://motionsites.ai/unlimited} (its plans/pricing page), probed 2026-09-24; full
 *     methodology and raw fetches are in the MotionSites vendoring research inventory (an internal
 *     research artifact, not part of this repository) §E "Content delivery, downloads, and terms"
 *     and §F "Vendoring verdict".
 * See also docs/legal/LICENSE-COMPLIANCE.md, the repo's own distribution policy for this source.
 */
const MOTIONSITES_RIGHTS_EVIDENCE =
  'motionsites.ai/terms, /license and /pricing all 404 (confirmed 2026-09-24, incl. the SPA\'s '
  + 'full client-side route table); the only rights statement on the site is its footer, '
  + '"All rights reserved" — no redistribution grant for any prompt or template. Metadata only, '
  + 'from list_prompts/search_prompts; no prompt body fetched or stored. See motionsites.ai/mcp, '
  + 'motionsites.ai/unlimited, and the MotionSites inventory §E/§F (docs/legal/LICENSE-COMPLIANCE.md).';

/**
 * MotionSites `category` values that name a UI-kind section (design doc §1: "Map hero, features,
 * pricing, faq, footer, testimonials, and cta-band directly."), matched case-insensitively. A
 * "Landing Page"/"Landing" category is a whole-page prompt, not a section —
 * `sectionKind: 'page-composition'`, per the design doc's explicit distinction.
 */
const SECTION_KIND_CATEGORIES: Record<string, SectionKind> = {
  hero: 'hero',
  'hero section': 'hero',
  features: 'features',
  cta: 'cta-band',
  footer: 'footer',
  testimonials: 'testimonials',
  faq: 'faq',
  pricing: 'pricing',
  about: 'about-story',
  blog: 'blog-articles',
  stats: 'stats-metrics',
  form: 'contact-form',
  'landing page': 'page-composition',
  landing: 'page-composition',
  // Present in the inventory's section-kind breakdown but not a section a client page would
  // insert as-is (an app screen kind / a generic component), so they stay unclassified rather
  // than a forced fit.
  dashboard: 'unclassified',
  carousel: 'unclassified',
  mobile: 'unclassified',
  'social-media': 'unclassified',
  '404': 'unclassified',
};

/**
 * MotionSites `category` values that name an industry/use case rather than a section kind,
 * mapped to a Mishh Mashh spine through **this repo's own** shape-atlas.json/family-registry.json
 * legend — not the inventory's proposed map, which the design doc calls out as reversed for SaaS
 * and Agency (design doc §1: "Here SaaS is generally PA, an agency seeking leads is TL"). Kept
 * short and confident on purpose: a category this table has no entry for is `'unclassified'`,
 * never a guessed spine, and never a default `'MI'` — MI means mission impact specifically, not
 * "none of the above." Every mapping below is cited against a specific
 * `shape-atlas.json#archetypes[].keywords`/`closestTransfers` entry or a `family-registry.json`
 * family; a category the atlas does not clearly cover (e.g. "fitness", which appears in neither
 * file) is left out rather than guessed, so `classify()` falls through to `'unclassified'`.
 */
const SPINE_CATEGORIES: Record<string, SpineCode> = {
  saas: 'PA', // shape-atlas.json archetypes PA.01 "Self-serve SaaS", keywords include "saas"
  agency: 'TL', // shape-atlas.json archetypes TL.05 "Agency, consultancy, or studio", keywords include "agency"
  creative: 'TL', // TL.05 keywords include "creative"; family-registry.json fervor (TL) summary: "creative studio or agency"
  portfolio: 'TL', // TL.06 "Personal expert or portfolio", keywords include "portfolio"
  ecommerce: 'CO', // shape-atlas.json archetypes CO.01 "Ecommerce retailer", keywords include "ecommerce"
  fashion: 'CO', // family-registry.json maren (CO) — maker/atelier commerce; no closer CO archetype names "fashion" directly
  'real estate': 'SM', // shape-atlas.json archetypes SM.03 "Real estate", keywords include "real", "estate"
  // healthcare/medical: shape-atlas.json archetypes TL.01 "Local appointment business"
  // (closestTransfers includes "Healthcare") and TL.02 "Healthcare or aesthetic practice"
  // (keywords include "healthcare", "medical") — both TL, not BA (BA is "Reservation" /
  // "Booking attendance", e.g. museums and venues per family-registry.json halcyon).
  healthcare: 'TL',
  medical: 'TL',
  education: 'LM', // shape-atlas.json archetypes LM.01 "Course or cohort" and LM.02 "School or university", keywords include "education"
  nonprofit: 'MI', // shape-atlas.json archetypes MI.01 "Nonprofit or charity", keywords include "nonprofit"
  charity: 'MI', // MI.01 keywords include "charity"
};

function classify(category: string): { sectionKind: SectionKind; spineAffinities: SpineAffinities } {
  const key = category.trim().toLowerCase();
  const sectionKind = SECTION_KIND_CATEGORIES[key];
  if (sectionKind) {
    // A generic hero or CTA fits any spine (design doc §1); an unclassified UI-kind category
    // carries the same uncertainty into its spine affinity. A bare 'landing page'/'landing'
    // category names a whole-page prompt (sectionKind 'page-composition'), not a generic UI kind —
    // unlike a hero or CTA, a landing page is not "any spine, confidently." This MCP result's only
    // signal is the single `category` string, so a 'landing page'/'landing' value carries no
    // industry/vertical to derive a spine from (that only comes through SPINE_CATEGORIES below,
    // reached when `category` itself names an industry instead of a UI kind); 'any' here would be a
    // confident-looking "fits every spine" for something that fits none specifically, so it stays
    // 'unclassified' rather than a forced guess (delta audit #9).
    const spineAffinities: SpineAffinities = sectionKind === 'unclassified' || sectionKind === 'page-composition'
      ? 'unclassified'
      : 'any';
    return { sectionKind, spineAffinities };
  }
  const spine = SPINE_CATEGORIES[key];
  if (spine) return { sectionKind: 'page-composition', spineAffinities: [spine] };
  return { sectionKind: 'unclassified', spineAffinities: 'unclassified' };
}

function normalizeAccess(access: MotionSitesPromptResult['access']): AccessLevel {
  return access === 'free' ? 'free-account' : 'paid-account';
}

/** Normalize one `list_prompts`/`search_prompts` row to a SectionCatalogEntry. */
export function normalizeMotionSitesPrompt(result: MotionSitesPromptResult): SectionCatalogEntry {
  const { sectionKind, spineAffinities } = classify(result.category);
  return {
    id: `motionsites-prompt:${result.id}`,
    title: result.title,
    sourceKind: 'motionsites-prompt',
    sectionKind,
    sourceType: result.category,
    spineAffinities,
    rights: {
      license: 'proprietary',
      decision: 'metadata-only',
      evidence: MOTIONSITES_RIGHTS_EVIDENCE,
    },
    access: normalizeAccess(result.access),
    availability: 'reference-only',
    preview: { kind: 'external-link', url: result.url },
    content: { kind: 'motion-prompt', remoteId: result.id, url: result.url },
  };
}

/** Normalize a whole `list_prompts`/`search_prompts` response. */
export function normalizeMotionSitesPrompts(response: MotionSitesListPromptsResponse): SectionCatalogEntry[] {
  return response.results.map(normalizeMotionSitesPrompt);
}
