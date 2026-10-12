// The selectable section catalog — HyperUI blocks, the agency families' own sections, the Cult UI
// Pro section/page projection (insertable only through a checked adapter), and federated MotionSites prompt
// metadata, behind one rights-labeled entry shape.
//
// These types mirror @open-design/section-catalog's `SectionCatalogEntry` (packages/section-catalog/src/types.ts)
// structurally, so contracts stays free of a workspace dependency on that package — the same
// pattern genui-catalog.ts uses for @open-design/genui-catalog. A daemon route that serves the
// catalog (phase D) checks the two agree with a typed assignment, which fails to compile if
// section-catalog's literal drifts from this file's shape.
//
// `parseSectionCatalogResponse` is the runtime counterpart: it validates an untrusted `unknown`
// (e.g. a `fetch().json()` result) against this same shape at the web/CLI boundary, where a
// daemon route's compile-time agreement does not reach. It enforces the same rights/availability
// policy `sectionCatalogPolicyIssues` (packages/section-catalog/src/validate.ts) enforces at build
// time — not shape alone — because this parser, not the build script, is what actually stands
// between an untrusted daemon response and the client (delta audit #3).

/** packages/agency-fast-lane/src/taxonomy/design-taxonomy.json's `sections[].id` list. */
export type SectionCatalogTaxonomySectionId =
  | 'navigation' | 'hero' | 'features' | 'services' | 'benefits' | 'process-steps' | 'proof-gallery'
  | 'product-grid' | 'pricing' | 'plan-comparison' | 'testimonials' | 'reviews-ratings'
  | 'stats-metrics' | 'logo-wall' | 'team' | 'about-story' | 'manifesto-statement' | 'faq'
  | 'blog-articles' | 'newsletter-waitlist' | 'contact-form' | 'booking-availability'
  | 'location-map-hours' | 'cta-band' | 'footer' | 'timeline-roadmap' | 'integrations'
  | 'specifications';

/** A whole landing-page prompt (MotionSites), or a section whose content resists classification. */
export type SectionCatalogSectionKind = SectionCatalogTaxonomySectionId | 'page-composition' | 'unclassified';

/** packages/agency-fast-lane/src/atlas/shape-atlas.json's nine spine codes. */
export type SectionCatalogSpineCode = 'TL' | 'PA' | 'CO' | 'SM' | 'CS' | 'LM' | 'BA' | 'TU' | 'MI';

/** Every spine (no preference), or too unclear to say — never a default single-spine guess. */
export type SectionCatalogSpineAffinities = SectionCatalogSpineCode[] | 'any' | 'unclassified';

export type SectionCatalogSourceKind = 'hyperui' | 'motionsites-prompt' | 'family-section' | 'local-corpus' | 'cult-pro';
/** `'licensed'` is reserved for `cult-pro` entries (the recorded Cult UI Pro licence). */
export type SectionCatalogRightsLicense = 'MIT' | 'proprietary' | 'project-specific' | 'licensed';
export type SectionCatalogRightsDecision = 'bundle' | 'metadata-only' | 'same-family-only';
export type SectionCatalogAccess = 'local' | 'free-account' | 'paid-account';
export type SectionCatalogAvailability = 'insertable' | 'reference-only' | 'adapter-needed';

export interface SectionCatalogRights {
  license: SectionCatalogRightsLicense;
  decision: SectionCatalogRightsDecision;
  evidence: string;
}

export type SectionCatalogPreview =
  | { kind: 'local'; artifactId: string }
  | { kind: 'external-link'; url: string }
  | { kind: 'none' };

export type SectionCatalogContent =
  | { kind: 'vendored-block'; blockId: string; adapterId?: string; sha256: string }
  | { kind: 'motion-prompt'; remoteId: string; url: string }
  | { kind: 'family-section'; family: string; sectionId: string }
  | { kind: 'local-prompt'; corpusId: string }
  /** A `cult-pro` entry: `summary` is the Cult description, `sourceTitle` Cult's raw title (audit
   * only — display `title`), `provenance` the canonical inventory row and pinned source snapshot.
   * `adapterId` (equal to the entry id) is present exactly when the entry is insertable. */
  | { kind: 'cult-item'; summary: string; sourceTitle: string; provenance: SectionCatalogCultProvenance; adapterId?: string };

export interface SectionCatalogCultProvenance {
  /** `cult:<name>`, equal to the entry's own `id`. */
  cultId: string;
  /** e.g. `cult-ui-pro@6b9560102fcd5ae5`. */
  snapshotId: string;
}

/** The only rights a `cult-pro` entry may carry (docs/legal/cult-ui-pro-rights.md). */
export const SECTION_CATALOG_CULT_PRO_RIGHTS: Readonly<SectionCatalogRights> = {
  license: 'licensed',
  decision: 'bundle',
  evidence: 'docs/legal/cult-ui-pro-rights.md',
};

export interface SectionCatalogEntry {
  /**
   * The catalog key a build names (`sectionSelection.entryId`) and the web picker keys on. A
   * `cult-pro` entry served by the daemon (`GET /api/sections`) carries its brand-free public id
   * `cult:<slug>` here, and so do its `provenance.cultId` and `adapterId`. The internal inventory
   * id (`cult:<name>`, which can name the provider a style came from) is not served: the daemon
   * maps the public id back wherever it accepts an entry, and builds report and publish the
   * public id (docs/architecture.md).
   */
  id: string;
  title: string;
  sourceKind: SectionCatalogSourceKind;
  sectionKind: SectionCatalogSectionKind;
  /** The original provider label (a HyperUI block group, a family section type, a MotionSites category). Not a section kind. */
  sourceType?: string;
  spineAffinities: SectionCatalogSpineAffinities;
  rights: SectionCatalogRights;
  access: SectionCatalogAccess;
  availability: SectionCatalogAvailability;
  preview: SectionCatalogPreview;
  content: SectionCatalogContent;
}

export interface SectionCatalogManifest {
  schema: 'section-catalog/1';
  entries: SectionCatalogEntry[];
}

export interface SectionCatalogResponse {
  catalog: SectionCatalogManifest;
}

const TAXONOMY_SECTION_IDS: ReadonlySet<string> = new Set<SectionCatalogTaxonomySectionId>([
  'navigation', 'hero', 'features', 'services', 'benefits', 'process-steps', 'proof-gallery',
  'product-grid', 'pricing', 'plan-comparison', 'testimonials', 'reviews-ratings', 'stats-metrics',
  'logo-wall', 'team', 'about-story', 'manifesto-statement', 'faq', 'blog-articles',
  'newsletter-waitlist', 'contact-form', 'booking-availability', 'location-map-hours', 'cta-band',
  'footer', 'timeline-roadmap', 'integrations', 'specifications',
]);
const SECTION_KINDS: ReadonlySet<string> = new Set<SectionCatalogSectionKind>([
  ...TAXONOMY_SECTION_IDS, 'page-composition', 'unclassified',
] as SectionCatalogSectionKind[]);
const SPINE_CODES: ReadonlySet<string> = new Set<SectionCatalogSpineCode>(['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI']);
const SOURCE_KINDS: ReadonlySet<string> = new Set<SectionCatalogSourceKind>(['hyperui', 'motionsites-prompt', 'family-section', 'local-corpus', 'cult-pro']);
const RIGHTS_LICENSES: ReadonlySet<string> = new Set<SectionCatalogRightsLicense>(['MIT', 'proprietary', 'project-specific', 'licensed']);
const RIGHTS_DECISIONS: ReadonlySet<string> = new Set<SectionCatalogRightsDecision>(['bundle', 'metadata-only', 'same-family-only']);
const ACCESS_LEVELS: ReadonlySet<string> = new Set<SectionCatalogAccess>(['local', 'free-account', 'paid-account']);
const AVAILABILITIES: ReadonlySet<string> = new Set<SectionCatalogAvailability>(['insertable', 'reference-only', 'adapter-needed']);
const PREVIEW_KINDS: ReadonlySet<string> = new Set(['local', 'external-link', 'none']);
const CONTENT_KINDS: ReadonlySet<string> = new Set(['vendored-block', 'motion-prompt', 'family-section', 'local-prompt', 'cult-item']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
// Mirrors schema/section-catalog.schema.json's `preview`/`content` `url` pattern and `content`
// `family` pattern respectively. This parser is the untrusted-input boundary (see the module
// header); it must reject anything the schema would, not merely check the field is *a* string —
// a `javascript:` preview/content URL or a `family: '../../etc'` traversal segment both pass a
// bare `typeof === 'string'` check but must not reach a caller as a validated DTO (delta audit #4/#5).
const HTTPS_URL_PATTERN = /^https:\/\//;
const FAMILY_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
// Mirror the schema's `cult-item` provenance patterns.
const CULT_ID_PATTERN = /^cult:[a-z0-9][a-z0-9-]*$/;
const CULT_SNAPSHOT_PATTERN = /^cult-ui-pro@[a-f0-9]{16}$/;

/** Every key of `value` must be one `allowed` names, mirroring the schema's `additionalProperties: false`. */
function assertNoExtraKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not a known property`);
  }
}

function parseSpineAffinities(value: unknown, path: string): SectionCatalogSpineAffinities {
  if (value === 'any' || value === 'unclassified') return value;
  if (Array.isArray(value) && value.length > 0 && value.every((code) => typeof code === 'string' && SPINE_CODES.has(code))) {
    return value as SectionCatalogSpineCode[];
  }
  throw new Error(`${path} must be "any", "unclassified", or a non-empty array of spine codes`);
}

function parseRights(value: unknown, path: string): SectionCatalogRights {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  assertNoExtraKeys(value, ['license', 'decision', 'evidence'], path);
  if (!RIGHTS_LICENSES.has(value.license as string)) throw new Error(`${path}.license is invalid`);
  if (!RIGHTS_DECISIONS.has(value.decision as string)) throw new Error(`${path}.decision is invalid`);
  if (typeof value.evidence !== 'string' || value.evidence.length < 1) {
    throw new Error(`${path}.evidence must be a non-empty string`);
  }
  return value as unknown as SectionCatalogRights;
}

function parsePreview(value: unknown, path: string): SectionCatalogPreview {
  if (!isPlainObject(value) || !PREVIEW_KINDS.has(value.kind as string)) throw new Error(`${path}.kind is invalid`);
  if (value.kind === 'local') {
    assertNoExtraKeys(value, ['kind', 'artifactId'], path);
    if (typeof value.artifactId !== 'string') throw new Error(`${path}.artifactId must be a string`);
  }
  if (value.kind === 'external-link') {
    assertNoExtraKeys(value, ['kind', 'url'], path);
    if (typeof value.url !== 'string' || !HTTPS_URL_PATTERN.test(value.url)) {
      throw new Error(`${path}.url must be an "https://" URL`);
    }
  }
  if (value.kind === 'none') assertNoExtraKeys(value, ['kind'], path);
  return value as unknown as SectionCatalogPreview;
}

function parseContent(value: unknown, path: string): SectionCatalogContent {
  if (!isPlainObject(value) || !CONTENT_KINDS.has(value.kind as string)) throw new Error(`${path}.kind is invalid`);
  if (value.kind === 'vendored-block') {
    assertNoExtraKeys(value, ['kind', 'blockId', 'adapterId', 'sha256'], path);
    if (typeof value.blockId !== 'string') throw new Error(`${path}.blockId must be a string`);
    if (value.adapterId !== undefined && typeof value.adapterId !== 'string') throw new Error(`${path}.adapterId must be a string`);
    if (typeof value.sha256 !== 'string' || !SHA256_HEX_PATTERN.test(value.sha256)) {
      throw new Error(`${path}.sha256 must be a 64-character lowercase hex string`);
    }
  }
  if (value.kind === 'motion-prompt') {
    assertNoExtraKeys(value, ['kind', 'remoteId', 'url'], path);
    if (typeof value.remoteId !== 'string') throw new Error(`${path}.remoteId must be a string`);
    if (typeof value.url !== 'string' || !HTTPS_URL_PATTERN.test(value.url)) {
      throw new Error(`${path}.url must be an "https://" URL`);
    }
  }
  if (value.kind === 'family-section') {
    assertNoExtraKeys(value, ['kind', 'family', 'sectionId'], path);
    if (typeof value.family !== 'string' || !FAMILY_ID_PATTERN.test(value.family)) {
      throw new Error(`${path}.family must match ${FAMILY_ID_PATTERN}`);
    }
    if (typeof value.sectionId !== 'string') throw new Error(`${path}.sectionId must be a string`);
  }
  if (value.kind === 'local-prompt') {
    assertNoExtraKeys(value, ['kind', 'corpusId'], path);
    if (typeof value.corpusId !== 'string') throw new Error(`${path}.corpusId must be a string`);
  }
  if (value.kind === 'cult-item') {
    assertNoExtraKeys(value, ['kind', 'summary', 'sourceTitle', 'provenance', 'adapterId'], path);
    if (value.adapterId !== undefined && (typeof value.adapterId !== 'string' || !CULT_ID_PATTERN.test(value.adapterId))) {
      throw new Error(`${path}.adapterId must match ${CULT_ID_PATTERN}`);
    }
    for (const field of ['summary', 'sourceTitle'] as const) {
      if (typeof value[field] !== 'string' || (value[field] as string).length < 1) {
        throw new Error(`${path}.${field} must be a non-empty string`);
      }
    }
    const provenance = value.provenance;
    if (!isPlainObject(provenance)) throw new Error(`${path}.provenance must be an object`);
    assertNoExtraKeys(provenance, ['cultId', 'snapshotId'], `${path}.provenance`);
    if (typeof provenance.cultId !== 'string' || !CULT_ID_PATTERN.test(provenance.cultId)) {
      throw new Error(`${path}.provenance.cultId must match ${CULT_ID_PATTERN}`);
    }
    if (typeof provenance.snapshotId !== 'string' || !CULT_SNAPSHOT_PATTERN.test(provenance.snapshotId)) {
      throw new Error(`${path}.provenance.snapshotId must match ${CULT_SNAPSHOT_PATTERN}`);
    }
  }
  return value as unknown as SectionCatalogContent;
}

/**
 * The invariants `sectionCatalogPolicyIssues` (`packages/section-catalog/src/validate.ts`) enforces
 * at build time, mirrored here so this parser — the actual web/CLI trust boundary, per its own
 * module header — enforces them too instead of only checking shape. Without this, a
 * schema-conformant but policy-violating response (e.g. `sourceKind: 'motionsites-prompt'` with
 * `rights.decision: 'bundle'`) passes `parseSectionCatalogResponse` even though it violates the
 * rights invariants the whole boundary exists to protect (delta audit #3). Called once per entry,
 * after every individual field above has already validated its own shape.
 */
function assertEntryPolicy(entry: SectionCatalogEntry, path: string): void {
  if (entry.sourceKind === 'hyperui' && entry.content.kind !== 'vendored-block') {
    throw new Error(`${path}: sourceKind "hyperui" requires content.kind "vendored-block", got "${entry.content.kind}"`);
  }
  if (entry.sourceKind === 'motionsites-prompt') {
    if (entry.content.kind !== 'motion-prompt') {
      throw new Error(`${path}: sourceKind "motionsites-prompt" requires content.kind "motion-prompt", got "${entry.content.kind}"`);
    }
    if (entry.rights.decision !== 'metadata-only') {
      throw new Error(`${path}: sourceKind "motionsites-prompt" requires rights.decision "metadata-only"`);
    }
    if (entry.rights.license !== 'proprietary') {
      throw new Error(`${path}: sourceKind "motionsites-prompt" requires rights.license "proprietary"`);
    }
    if (entry.preview.kind !== 'external-link') {
      throw new Error(`${path}: sourceKind "motionsites-prompt" requires preview.kind "external-link" (never a locally hosted copy of the source's preview)`);
    }
    if (entry.access !== 'free-account' && entry.access !== 'paid-account') {
      throw new Error(`${path}: sourceKind "motionsites-prompt" requires access "free-account" or "paid-account", got "${entry.access}"`);
    }
  }
  if (entry.sourceKind === 'family-section') {
    if (entry.content.kind !== 'family-section') {
      throw new Error(`${path}: sourceKind "family-section" requires content.kind "family-section", got "${entry.content.kind}"`);
    }
    if (entry.rights.decision !== 'same-family-only') {
      throw new Error(`${path}: sourceKind "family-section" requires rights.decision "same-family-only"`);
    }
    if (entry.availability !== 'reference-only') {
      throw new Error(`${path}: sourceKind "family-section" requires availability "reference-only"`);
    }
    if (entry.spineAffinities === 'any') {
      throw new Error(`${path}: sourceKind "family-section" may not carry spineAffinities "any" (same-family-only is never a cross-family candidate)`);
    }
  }
  if (entry.sourceKind === 'local-corpus') {
    if (entry.content.kind !== 'local-prompt') {
      throw new Error(`${path}: sourceKind "local-corpus" requires content.kind "local-prompt", got "${entry.content.kind}"`);
    }
    if (entry.rights.decision !== 'bundle' || entry.rights.license !== 'project-specific') {
      throw new Error(`${path}: sourceKind "local-corpus" requires rights.license "project-specific" and rights.decision "bundle"`);
    }
    if (entry.access !== 'local') {
      throw new Error(`${path}: sourceKind "local-corpus" requires access "local", got "${entry.access}"`);
    }
    if (entry.availability !== 'reference-only') {
      throw new Error(`${path}: sourceKind "local-corpus" requires availability "reference-only"`);
    }
  }
  if (entry.sourceKind === 'cult-pro') {
    if (entry.content.kind !== 'cult-item') {
      throw new Error(`${path}: sourceKind "cult-pro" requires content.kind "cult-item", got "${entry.content.kind}"`);
    }
    const rights = SECTION_CATALOG_CULT_PRO_RIGHTS;
    if (entry.rights.license !== rights.license || entry.rights.decision !== rights.decision || entry.rights.evidence !== rights.evidence) {
      throw new Error(`${path}: sourceKind "cult-pro" requires rights ${JSON.stringify(rights)}`);
    }
    if (entry.access !== 'local') {
      throw new Error(`${path}: sourceKind "cult-pro" requires access "local", got "${entry.access}"`);
    }
    if (entry.content.provenance.cultId !== entry.id) {
      throw new Error(`${path}: content.provenance.cultId "${entry.content.provenance.cultId}" must equal the entry id "${entry.id}"`);
    }
    const adapterId = entry.content.adapterId;
    if (adapterId !== undefined && adapterId !== entry.id) {
      throw new Error(`${path}: content.adapterId "${adapterId}" must equal the entry id "${entry.id}"`);
    }
    if ((adapterId !== undefined) !== (entry.availability === 'insertable')) {
      throw new Error(`${path}: a cult-pro entry is "insertable" exactly when content.adapterId names its checked adapter`);
    }
    if (entry.availability === 'insertable' && entry.sectionKind === 'page-composition') {
      throw new Error(`${path}: a whole Cult page is never insertable as one section`);
    }
  } else if (entry.rights.license === 'licensed') {
    throw new Error(`${path}: rights.license "licensed" is reserved for sourceKind "cult-pro"`);
  }
  if (entry.content.kind === 'cult-item' && entry.sourceKind !== 'cult-pro') {
    throw new Error(`${path}: content.kind "cult-item" requires sourceKind "cult-pro", got "${entry.sourceKind}"`);
  }
  // Same rule as the server: a whole landing page is a MotionSites prompt, a local-corpus
  // "full-page" row, or a Cult UI Pro page — never a HyperUI block or a family section.
  if (
    entry.sectionKind === 'page-composition'
    && entry.sourceKind !== 'motionsites-prompt'
    && entry.sourceKind !== 'local-corpus'
    && entry.sourceKind !== 'cult-pro'
  ) {
    throw new Error(`${path}: sectionKind "page-composition" only describes a whole landing page (MotionSites, local-corpus, or Cult UI Pro), not a "${entry.sourceKind}" entry`);
  }
  if (entry.availability === 'insertable' && entry.content.kind !== 'vendored-block' && entry.content.kind !== 'cult-item') {
    throw new Error(`${path}: availability "insertable" requires content.kind "vendored-block" or "cult-item"`);
  }
}

/**
 * Validate an `unknown` value (typically a `fetch().json()` result) as a `SectionCatalogResponse`.
 *
 * Throws an `Error` whose message names the first failing path (e.g.
 * `catalog.entries[3].sectionKind`) rather than returning `null`/`undefined`, so a caller cannot
 * accidentally treat a malformed 200 as an empty catalog.
 */
export function parseSectionCatalogResponse(value: unknown): SectionCatalogResponse {
  if (!isPlainObject(value)) throw new Error('section catalog response must be an object');
  const catalog = value.catalog;
  if (!isPlainObject(catalog)) throw new Error('catalog must be an object');
  assertNoExtraKeys(catalog, ['schema', 'entries'], 'catalog');
  if (catalog.schema !== 'section-catalog/1') throw new Error('catalog.schema must be "section-catalog/1"');
  if (!Array.isArray(catalog.entries)) throw new Error('catalog.entries must be an array');

  const ENTRY_KEYS = ['id', 'title', 'sourceKind', 'sectionKind', 'sourceType', 'spineAffinities', 'rights', 'access', 'availability', 'preview', 'content'];
  catalog.entries.forEach((rawEntry: unknown, index: number) => {
    const path = `catalog.entries[${index}]`;
    if (!isPlainObject(rawEntry)) throw new Error(`${path} must be an object`);
    assertNoExtraKeys(rawEntry, ENTRY_KEYS, path);

    for (const field of ['id', 'title'] as const) {
      if (typeof rawEntry[field] !== 'string') throw new Error(`${path}.${field} must be a string`);
    }
    if (!SOURCE_KINDS.has(rawEntry.sourceKind as string)) throw new Error(`${path}.sourceKind is invalid`);
    if (!SECTION_KINDS.has(rawEntry.sectionKind as string)) throw new Error(`${path}.sectionKind is invalid`);
    if (rawEntry.sourceType !== undefined && typeof rawEntry.sourceType !== 'string') {
      throw new Error(`${path}.sourceType must be a string`);
    }
    parseSpineAffinities(rawEntry.spineAffinities, `${path}.spineAffinities`);
    parseRights(rawEntry.rights, `${path}.rights`);
    if (!ACCESS_LEVELS.has(rawEntry.access as string)) throw new Error(`${path}.access is invalid`);
    if (!AVAILABILITIES.has(rawEntry.availability as string)) throw new Error(`${path}.availability is invalid`);
    parsePreview(rawEntry.preview, `${path}.preview`);
    parseContent(rawEntry.content, `${path}.content`);
    assertEntryPolicy(rawEntry as unknown as SectionCatalogEntry, path);
  });

  return value as unknown as SectionCatalogResponse;
}

/** One of the five built-in design directions (`@open-design/agency-fast-lane/section-overlay`'s
 * `listDesignDirections`), narrowed to what a section picker offers as a choice — never the full
 * palette/font/mood spec, which stays that package's own runtime detail. */
export interface SectionCatalogDirectionOption {
  id: string;
  label: string;
}

/**
 * `GET /api/sections`' success body (phase D, `sol-design.md` §5 row D): the merged catalog
 * (`packages/section-catalog`'s local manifest plus the MotionSites bridge's own local-corpus +
 * federated merge, filtered by `?spine=`/`?kind=` when given) alongside the five design
 * directions a `sectionSelection.directionId` may name, so a picker never needs a second fetch to
 * populate its direction choice.
 */
export interface SectionsListResponse {
  catalog: SectionCatalogManifest;
  directions: SectionCatalogDirectionOption[];
  /** Present only when the federated half of the catalog degraded because the MotionSites MCP
   * endpoint itself failed — see `MotionSitesCatalogResponse.upstream` (./motionsites.js) for the
   * exact same field, reused here rather than re-declared. */
  upstream?: {
    code: 'MOTIONSITES_UPSTREAM_UNAVAILABLE';
    message: string;
  };
}

/** `GET /api/sections/:id`'s success body. */
export interface SectionEntryResponse {
  entry: SectionCatalogEntry;
}
