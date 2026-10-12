/**
 * Types of catalog.json and of a normalized MotionSites entry. schema/section-catalog.schema.json
 * is the authority; these mirror it (see src/validate.ts, which validates against that schema
 * plus the policy rules a schema cannot express).
 *
 * This is the *build-time* / server-side home of the shape. The public DTO a web or CLI client
 * parses is `packages/contracts/src/api/section-catalog.ts`, which mirrors this file structurally
 * (see that file's header for why it does not import this package).
 */

export const SECTION_CATALOG_SCHEMA = 'section-catalog/1';

/**
 * `packages/agency-fast-lane/src/taxonomy/design-taxonomy.json`'s `sections[].id` list, kept in
 * sync by `tests/section-kind.test.ts` (which reads that file directly and fails on drift).
 */
export type TaxonomySectionId =
  | 'navigation' | 'hero' | 'features' | 'services' | 'benefits' | 'process-steps' | 'proof-gallery'
  | 'product-grid' | 'pricing' | 'plan-comparison' | 'testimonials' | 'reviews-ratings'
  | 'stats-metrics' | 'logo-wall' | 'team' | 'about-story' | 'manifesto-statement' | 'faq'
  | 'blog-articles' | 'newsletter-waitlist' | 'contact-form' | 'booking-availability'
  | 'location-map-hours' | 'cta-band' | 'footer' | 'timeline-roadmap' | 'integrations'
  | 'specifications';

/** A whole landing-page prompt (MotionSites), or a section whose content resists classification. */
export type SectionKind = TaxonomySectionId | 'page-composition' | 'unclassified';

/** `packages/agency-fast-lane/src/atlas/shape-atlas.json`'s nine spine codes. */
export type SpineCode = 'TL' | 'PA' | 'CO' | 'SM' | 'CS' | 'LM' | 'BA' | 'TU' | 'MI';

/** Every spine (no preference), or too unclear to say — never a default `'MI'` guess. */
export type SpineAffinities = SpineCode[] | 'any' | 'unclassified';

/**
 * `'local-corpus'` is owner-authored content bundled with the daemon (see `src/local-corpus.ts`)
 * — distinct from `'motionsites-prompt'` (third-party, federated at request time, never bundled).
 * A `local-corpus` entry's own text lives outside `catalog.json` (fetched on demand the same way a
 * `motionsites-prompt` is), but unlike a `motionsites-prompt` it ships with the daemon rather than
 * being fetched live, because the daemon owns the rights to it (see the `local-corpus` branch of
 * `sectionCatalogPolicyIssues` in `src/validate.ts` for the rights invariants this implies).
 */
/*
 * `'cult-pro'` is a Cult UI Pro section or page, projected from the canonical inventory in
 * `packages/cult-ui-catalog/catalog.json` (metadata only; the licensed source stays in the private
 * source kit). It is catalogued but never insertable until a reviewed adapter exists for it.
 */
export type SourceKind = 'hyperui' | 'motionsites-prompt' | 'family-section' | 'local-corpus' | 'cult-pro';
/** `'licensed'`: a purchased commercial licence (Cult UI Pro only — see `CULT_PRO_RIGHTS`). */
export type RightsLicense = 'MIT' | 'proprietary' | 'project-specific' | 'licensed';
export type RightsDecision = 'bundle' | 'metadata-only' | 'same-family-only';
export type AccessLevel = 'local' | 'free-account' | 'paid-account';
export type Availability = 'insertable' | 'reference-only' | 'adapter-needed';

export interface SectionRights {
  license: RightsLicense;
  decision: RightsDecision;
  /** A citable reason: a LICENSE/NOTICE path, a README section, or a rights-status note. */
  evidence: string;
}

export type SectionPreview =
  | { kind: 'local'; artifactId: string }
  | { kind: 'external-link'; url: string }
  | { kind: 'none' };

export type SectionContent =
  | { kind: 'vendored-block'; blockId: string; adapterId?: string; sha256: string }
  | { kind: 'motion-prompt'; remoteId: string; url: string }
  | { kind: 'family-section'; family: string; sectionId: string }
  /**
   * An owner-authored `local-corpus` entry. Deliberately shaped unlike `motion-prompt`: there is
   * no `url` because this content has no external deep link (it never came from motionsites.ai),
   * and forcing an https:// URL here (the `motion-prompt` schema branch requires one) would mean
   * inventing one. `corpusId` is the id the daemon's local-corpus loader looks the row up by —
   * see `src/local-corpus.ts`.
   */
  | { kind: 'local-prompt'; corpusId: string }
  /**
   * A `cult-pro` entry: selection metadata only, never source content. `summary` is the Cult
   * description; `sourceTitle` is Cult's raw title, kept for audit and never displayed (the entry's
   * `title` is the display form, with other companies' names removed). `provenance` points back at
   * the canonical inventory row and the pinned source snapshot it came from. `adapterId` is set
   * only on an insertable entry: the checked adapter in `packages/cult-ui-catalog/generated/`,
   * always equal to the entry id.
   */
  | { kind: 'cult-item'; summary: string; sourceTitle: string; provenance: CultProvenance; adapterId?: string };

export interface CultProvenance {
  /** The canonical inventory row id, `cult:<name>` (equal to the entry's own `id`). */
  cultId: string;
  /** `packages/cult-ui-catalog/catalog.json`'s `snapshot.id`, e.g. `cult-ui-pro@6b9560102fcd5ae5`. */
  snapshotId: string;
}

/** The only rights a `cult-pro` entry may carry, and the only entries that may say `licensed`. */
export const CULT_PRO_RIGHTS: Readonly<SectionRights> = {
  license: 'licensed',
  decision: 'bundle',
  evidence: 'docs/legal/cult-ui-pro-rights.md',
};

export interface SectionCatalogEntry {
  id: string;
  title: string;
  sourceKind: SourceKind;
  sectionKind: SectionKind;
  /** The original provider label (a HyperUI block group, a family section type, a MotionSites category), kept for audit. Not a section kind. */
  sourceType?: string;
  spineAffinities: SpineAffinities;
  rights: SectionRights;
  access: AccessLevel;
  availability: Availability;
  preview: SectionPreview;
  content: SectionContent;
}

export interface SectionCatalog {
  schema: typeof SECTION_CATALOG_SCHEMA;
  entries: SectionCatalogEntry[];
}

/**
 * HyperUI block ids (not catalog entry ids) marked `availability: 'insertable'` in v1 — the hook
 * phase B reads to know which three entries it must give an `adapterId` (see
 * `src/validate.ts#missingInsertableAdapters`, the rule phase B's own gate calls once it lands
 * adapters; it is not part of this package's own `catalogIssues`, since these three ship without
 * an adapterId in phase A).
 */
export const INSERTABLE_V1: readonly string[] = [
  'marketing/sections/1',
  'marketing/feature-grids/1',
  'marketing/ctas/1',
];
