/**
 * Normalize the daemon's owner-authored local prompt corpus into `SectionCatalogEntry` rows
 * (design doc addendum, phase C coordination note 2026-09-24: "local-corpus" source).
 *
 * Background: `~/projects/prompt-catalog` holds 435 rows harvested from
 * MotionSites (`origin !== 'zerosum'`, `original_text` = the scraped prompt body) plus 32 rows
 * ZeroSum authored from scratch (`origin: 'zerosum'`, `our_text` = the owned prompt). Only the
 * second kind is ever safe to ship — the harvested rows have no redistribution license (see
 * `motionsites.ts`'s rights evidence) and a same-content rewrite of scraped text does not clear
 * that; as of the 2026-09-24 export none of the 435 harvested rows even has an `our_text` value,
 * so today this module's real input is exactly the 32 zerosum rows.
 *
 * This module enforces that boundary in code, not just in the data it happens to be given today:
 *   - `original_text` on a row is an automatic, unconditional reject — even a zerosum row. A
 *     future export carrying that key at all means the upstream schema changed in a way this
 *     importer has not been re-reviewed against, so it fails closed rather than trusting a row
 *     shape it has not seen.
 *   - `origin !== 'zerosum'` is an automatic, unconditional reject, full stop — there is no
 *     `status: 'approved'` + `our_text` carve-out. An earlier version of this module accepted a
 *     non-zerosum row once a human had signed off a specific rewrite of its scraped text; the
 *     2026-09-24 audit against the design doc (§4: "a same-content rewrite of scraped text does
 *     not clear that... A purchase does not authorize vendoring") found that carve-out was a
 *     rights-laundering path in waiting — a future export with `origin: 'motionsites-harvest',
 *     status: 'approved', our_text: <rewrite of scraped text>` would have shipped under the same
 *     "owner-authored, not derived from any third-party source" evidence string this module
 *     attaches to genuinely owner-authored rows. There is no reviewed-rewrite path back in; a
 *     future individually-approved rewrite needs its own module with its own rights evidence, not
 *     a flag on this one.
 *
 *     The one documented exception to "a purchase does not authorize vendoring" is Cult UI Pro:
 *     the owner recorded a dated licence decision (2026-09-25) covering bundling and derivative
 *     use, in docs/legal/cult-ui-pro-rights.md. That exception is specific to that source and its
 *     own package (packages/cult-ui-catalog); it does not relax this module's rules or apply to
 *     any other source.
 *   - `origin === 'zerosum'` additionally requires a reviewed status (`'rewritten'` or
 *     `'approved'`, matching the real export) and non-empty `our_text` — a zerosum row still in
 *     `'raw'`/`'draft'` is not shipped either.
 *
 * Per the 2026-08-16 owner decision on record in prompt-catalog: the zerosum kits are archived
 * from routing (a design-index/route picker must never auto-select one), tagged
 * `sourceType: 'zerosum-kit'`, and `availability: 'reference-only'` — they may appear in the
 * catalog and be chosen *explicitly* as a `designReference`, the same as a `motionsites-prompt`.
 */

import type {
  AccessLevel,
  RightsDecision,
  RightsLicense,
  SectionCatalogEntry,
  SectionKind,
  SectionRights,
  SpineAffinities,
  SpineCode,
} from './types.ts';

/** One row of the local corpus export (prompt-catalog's shippable-fields schema). */
export interface LocalCorpusRow {
  id: string;
  our_title: string | null;
  title: string;
  category: string | null;
  type: string | null;
  kind: string | null;
  slot: string | null;
  use_case: string | null;
  niche: string | null;
  vertical: string | null;
  action: string | null;
  motion_level: string | null;
  requires_motion_review: number | boolean | null;
  risk_reasons: string | null;
  image_preview_url: string | null;
  video_preview_url: string | null;
  source_url: string | null;
  origin: string;
  status: string;
  our_text: string | null;
  /**
   * Never present in a valid row — see the module doc. Typed as `unknown` (not omitted) so a row
   * that carries it still round-trips through `JSON.parse` and `refuseIfCarriesOriginalText` sees
   * it, instead of a strict object type silently stripping an unexpected key before the check
   * runs.
   */
  original_text?: unknown;
}

export interface LocalCorpusImportIssue {
  /** The row's `id` when it parsed as an object with one, else its index in the input array. */
  row: string | number;
  reason: string;
}

export interface LocalCorpusImportResult {
  entries: SectionCatalogEntry[];
  /** Every row skipped, and why — for the importer script's own report and for tests. Never
   * includes `our_text` or any other row field: the reason names the failing rule only. */
  skipped: LocalCorpusImportIssue[];
}

const REVIEWED_STATUSES_FOR_ZEROSUM: ReadonlySet<string> = new Set(['rewritten', 'approved']);

/**
 * `slot` → `SectionCatalogEntry.sectionKind`, per the 2026-09-24 coordination note. `'gallery'`
 * and `'cta'` are mapped for forward compatibility (the real 32-row export uses neither today) —
 * `'gallery'` is not itself a valid taxonomy id (see `TaxonomySectionId` in ./types.ts), so it
 * maps to the closest real one, `'proof-gallery'`.
 */
const SLOT_TO_SECTION_KIND: Record<string, SectionKind> = {
  hero: 'hero',
  features: 'features',
  testimonials: 'testimonials',
  footer: 'footer',
  cta: 'cta-band',
  contact: 'cta-band',
  faq: 'faq',
  team: 'team',
  gallery: 'proof-gallery',
  proof: 'stats-metrics',
  services: 'features',
  form: 'cta-band',
  booking: 'cta-band',
  'full-page': 'page-composition',
  component: 'unclassified',
};

/**
 * `use_case` (checked first) or `vertical` (fallback) → spine, per the coordination note. A row
 * whose `action` is `'book'` and whose use_case/vertical did not already resolve is treated as
 * BA ("action book→BA" in the note) — the only mapping keyed off `action` rather than
 * use_case/vertical, since none of the plain use_case/vertical strings named a booking spine on
 * their own. A value with no entry here is `'unclassified'`, never a guessed spine.
 */
const USE_CASE_TO_SPINE: Record<string, SpineCode> = {
  'local-presence': 'TL',
  'trust-booking': 'TL',
  'saas-product': 'PA',
  commerce: 'CO',
  'editorial-media': 'CS',
  education: 'LM',
  'app-ui': 'TU',
  nonprofit: 'MI',
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function classifySectionKind(slot: string | null): SectionKind {
  if (!slot) return 'unclassified';
  return SLOT_TO_SECTION_KIND[slot.trim().toLowerCase()] ?? 'unclassified';
}

function classifySpine(useCase: string | null, vertical: string | null, action: string | null): SpineAffinities {
  const fromUseCase = useCase ? USE_CASE_TO_SPINE[useCase.trim().toLowerCase()] : undefined;
  if (fromUseCase) return [fromUseCase];
  const fromVertical = vertical ? USE_CASE_TO_SPINE[vertical.trim().toLowerCase()] : undefined;
  if (fromVertical) return [fromVertical];
  if (action && action.trim().toLowerCase() === 'book') return ['BA'];
  return 'unclassified';
}

const LOCAL_CORPUS_ACCESS: AccessLevel = 'local';

/**
 * Reject reason for one row, or `null` when it passes every rule in the module doc. Checked in a
 * fixed order so a row failing multiple rules always reports the same (first) reason.
 */
function rejectReason(row: LocalCorpusRow): string | null {
  if ('original_text' in row) return 'row carries an original_text key — refused unconditionally';
  if (!isNonEmptyString(row.id)) return 'missing id';
  if (!isNonEmptyString(row.title) && !isNonEmptyString(row.our_title)) return 'missing title and our_title';
  if (!isNonEmptyString(row.origin)) return 'missing origin';
  if (!isNonEmptyString(row.status)) return 'missing status';
  if (!isNonEmptyString(row.our_text)) return 'missing or empty our_text';

  // No carve-out: a non-zerosum origin is refused unconditionally, regardless of status or
  // our_text — see the module doc for why an "approved rewrite" exception is a rights-laundering
  // path, not a safety valve.
  if (row.origin !== 'zerosum') {
    return `non-zerosum origin ("${row.origin}") is refused unconditionally — no rewrite/approval carve-out`;
  }
  if (!REVIEWED_STATUSES_FOR_ZEROSUM.has(row.status)) {
    return `zerosum row has status "${row.status}", not one of ${[...REVIEWED_STATUSES_FOR_ZEROSUM].join('/')}`;
  }
  return null;
}

/**
 * Rights evidence for one entry — specific to the row that produced it, not a shared constant.
 * Every accepted row has already passed `rejectReason`, so `row.origin` is always `"zerosum"`
 * here; the evidence still names the corpus id, origin, and status explicitly (rather than a
 * fixed string) so a future reviewer can tell, per entry, exactly which row and which reviewed
 * status this attestation is standing on.
 */
function buildLocalCorpusRightsEvidence(row: LocalCorpusRow): string {
  return (
    `Local-corpus entry "${row.id}" (origin: "${row.origin}", status: "${row.status}") is `
    + 'owner-authored content (ZeroSum), not derived from or a rewrite of any MotionSites or '
    + 'other third-party text — verified to carry no `original_text` field and a non-empty '
    + '`our_text`. Owner decision on record (prompt-catalog, 2026-08-16): shippable as bundled, '
    + 'project-specific content, archived from automated routing — see '
    + 'apps/daemon/src/motionsites/local-corpus.ts.'
  );
}

function buildLocalCorpusRights(row: LocalCorpusRow): SectionRights {
  return {
    license: 'project-specific' as RightsLicense,
    decision: 'bundle' as RightsDecision,
    evidence: buildLocalCorpusRightsEvidence(row),
  };
}

function toEntry(row: LocalCorpusRow): SectionCatalogEntry {
  return {
    id: `zerosum-kit:${row.id}`,
    title: (row.our_title && row.our_title.trim()) || row.title,
    sourceKind: 'local-corpus',
    sectionKind: classifySectionKind(row.slot),
    sourceType: 'zerosum-kit',
    spineAffinities: classifySpine(row.use_case, row.vertical, row.action),
    rights: buildLocalCorpusRights(row),
    access: LOCAL_CORPUS_ACCESS,
    availability: 'reference-only',
    preview: { kind: 'none' },
    content: { kind: 'local-prompt', corpusId: row.id },
  };
}

/**
 * Validate + normalize a parsed local-corpus export. Never throws on a bad row — it is skipped
 * and named in `skipped` — because one malformed row in a hand-curated export should not sink the
 * whole catalog merge; the importer script (and its tests) treat any `skipped` entries as a
 * signal to fix the export, not a reason to keep serving a smaller catalog forever.
 */
export function importLocalCorpus(rows: readonly LocalCorpusRow[]): LocalCorpusImportResult {
  const entries: SectionCatalogEntry[] = [];
  const skipped: LocalCorpusImportIssue[] = [];
  rows.forEach((row, index) => {
    const reason = rejectReason(row);
    const rowLabel: string | number = isNonEmptyString((row as { id?: unknown }).id) ? (row as { id: string }).id : index;
    if (reason) {
      skipped.push({ row: rowLabel, reason });
      return;
    }
    entries.push(toEntry(row));
  });
  return { entries, skipped };
}

/**
 * Look up one row's `our_text` by its corpus id (the `content.corpusId` a `local-corpus` catalog
 * entry carries) — the local-corpus analogue of `get_prompt`. Returns `null` rather than throwing
 * when the id is absent or the row does not pass `rejectReason` (e.g. the export changed under
 * it), so a caller treats "no design reference available" as a normal, handleable outcome instead
 * of a crash. The caller (apps/daemon/src/motionsites/design-reference.ts) is responsible for
 * keeping the returned text in memory only — this function does not log or persist it either.
 */
export function resolveLocalCorpusText(rows: readonly LocalCorpusRow[], corpusId: string): string | null {
  const row = rows.find((candidate) => candidate.id === corpusId);
  if (!row || rejectReason(row) !== null) return null;
  return row.our_text;
}
