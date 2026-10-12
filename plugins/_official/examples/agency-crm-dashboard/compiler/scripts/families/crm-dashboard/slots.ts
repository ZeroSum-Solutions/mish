/**
 * crm-dashboard family — the finite section and slot registry.
 *
 * The page kind is a fixed composition of six vendored HyperUI application blocks
 * (`application/stats/1`, `tables/1`, `timelines/1`, `details-list/1`, `filters/1`, `charts/2`;
 * see `plugins/_official/shared/ui-kits/hyperui/`), the same "typed slots over a fixed layout"
 * shape the seven Agency Site families use. Only controlled, named slots are exported here;
 * executable rendering stays in `render.ts` and a recipe never carries markup or CSS.
 *
 * No asset system: the six source blocks carry no images once vendored (Task 1 strips every
 * `<img>`), so this family has no `AssetSlot`/`DESTINATIONS` roster the way maben and watson do.
 *
 * Slot budget: the six sections carry 60 to 80 editable text slots between them (see the
 * per-section comments below). `BRAND_SLOTS` are two more reconcilable slots ON TOP of that
 * section budget — `render.ts` gives `brand.name`/`brand.descriptor` their own hidden
 * `data-od-id="brand--name"`/`"brand--descriptor"` elements, the same `sr-only` pattern maben
 * uses for its own brand fields, so a canvas edit to either is findable again. A fully populated
 * reference fixture therefore renders 62 to 82 slots in total; `render.test.ts` checks the exact
 * count against the fixture's own content.
 */

export const FAMILY_ID = 'crm-dashboard';
export const SCHEMA_VERSION = 2;

export type TextSlot = { name: string; max: number };

/** Brand fields a recipe may carry. Both are plain text; there is no wordmark asset. Both are
 * reconcilable slots (`brand--name`, `brand--descriptor`) on top of the six sections' 60–80. */
export const BRAND_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'descriptor', max: 200 },
];

/** `crm-dashboard-kpis` — a strip of exactly four KPI cards (`application/stats/1`). The first
 * two are required; the third and fourth are secondary KPIs a brief may not state (see
 * CRM_DASHBOARD_NULLABLE_ATOMS). */
export const KPI_SECTION_ID = 'crm-dashboard-kpis';
export const KPI_COUNT = 4;
export const KPI_REQUIRED_COUNT = 2;
export const KPI_ITEM_SLOTS: TextSlot[] = [
  { name: 'label', max: 40 },
  { name: 'value', max: 24 },
  { name: 'delta', max: 24 },
];

/** `crm-dashboard-pipeline` — one heading plus exactly five pipeline rows
 * (`application/tables/1`). */
export const PIPELINE_SECTION_ID = 'crm-dashboard-pipeline';
export const PIPELINE_ROW_COUNT = 5;
export const PIPELINE_HEADING_SLOT: TextSlot = { name: 'heading', max: 60 };
export const PIPELINE_ROW_SLOTS: TextSlot[] = [
  { name: 'company', max: 60 },
  { name: 'owner', max: 40 },
  { name: 'stage', max: 24 },
  { name: 'value', max: 24 },
  { name: 'nextStep', max: 80 },
];

/** `crm-dashboard-activity` — exactly six activity items when present
 * (`application/timelines/1`); the whole feed is a nullable atom. */
export const ACTIVITY_SECTION_ID = 'crm-dashboard-activity';
export const ACTIVITY_COUNT = 6;
export const ACTIVITY_ITEM_SLOTS: TextSlot[] = [
  { name: 'when', max: 24 },
  { name: 'who', max: 40 },
  { name: 'what', max: 140 },
];

/** `crm-dashboard-contact` — one contact card (`application/details-list/1`). */
export const CONTACT_SECTION_ID = 'crm-dashboard-contact';
export const CONTACT_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'role', max: 60 },
  { name: 'company', max: 60 },
  { name: 'email', max: 80 },
  { name: 'phone', max: 32 },
  { name: 'note', max: 200 },
];

/** `crm-dashboard-filters` — two fixed option groups (`application/filters/1`): four owner
 * options, five stage options. The group headings ("Owner", "Stage") are fixed chrome, not
 * recipe text, the way maben's structural labels are. */
export const FILTERS_SECTION_ID = 'crm-dashboard-filters';
export const FILTERS_OWNER_COUNT = 4;
export const FILTERS_STAGE_COUNT = 5;
export const FILTER_OPTION_SLOT: TextSlot = { name: 'option', max: 32 };

/** `crm-dashboard-chart` — one inline SVG bar chart from exactly eight values
 * (`application/charts/2`, rendered as bars instead of the source's canvas). The whole chart is
 * a nullable atom. `unit` is a required, validated recipe field that is rendered but is not its
 * own reconcilable text slot (kept the family inside the 60–80 slot budget); `title` and each
 * bar's `label` are. */
export const CHART_SECTION_ID = 'crm-dashboard-chart';
export const CHART_VALUE_COUNT = 8;
export const CHART_TITLE_SLOT: TextSlot = { name: 'title', max: 60 };
export const CHART_UNIT_SLOT: TextSlot = { name: 'unit', max: 12 };
export const CHART_VALUE_LABEL_SLOT: TextSlot = { name: 'label', max: 20 };

export const SECTION_ORDER = [
  KPI_SECTION_ID,
  PIPELINE_SECTION_ID,
  ACTIVITY_SECTION_ID,
  CONTACT_SECTION_ID,
  FILTERS_SECTION_ID,
  CHART_SECTION_ID,
] as const;
export type CrmDashboardSectionId = (typeof SECTION_ORDER)[number];

/**
 * The three nullable atoms of this family, the CRM-dashboard-specific counterpart of
 * MABEN_NULLABLE_ATOMS / WATSON_NULLABLE_ATOMS: a fact a brief may legitimately not state, where
 * `render.ts` drops the whole fragment (a KPI card, the activity feed, the chart) rather than
 * emitting an empty one. Unlike the other two families' nullable atoms, which are single text
 * slots that carry `null`, `kpiSecondary` nulls a whole repeat item (`sections[0].items[2]` or
 * `[3]`) and `activity`/`chart` null a whole section's content group — the kind names record
 * that shape, not a text-slot name.
 */
export const CRM_DASHBOARD_NULLABLE_ATOMS = {
  kpiSecondary: 'kpi-item',
  activity: 'activity-feed',
  chart: 'chart',
} as const;
export type CrmDashboardNullableSlot = keyof typeof CRM_DASHBOARD_NULLABLE_ATOMS;
export type CrmDashboardAtomKind = (typeof CRM_DASHBOARD_NULLABLE_ATOMS)[CrmDashboardNullableSlot];

/**
 * Section types a client brief may give nothing for at all. Unlike the nullable atoms above
 * (which null a section's own content but keep its `id`/`type` stub in the recipe), a section
 * type in this set may drop its whole slot in `sections` to `null` (see `../../sections.ts`): no
 * element, no `data-od-id`, no asset request. The activity feed is the one candidate — a brief
 * for a brand-new pipeline often has no real named people or events to show yet.
 */
export const CRM_DASHBOARD_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(['activity-feed']);

/**
 * Illustrative sample-data slots, by section id: the slot names `recipe.schema.json` marks
 * `"x-mock": true`. They carry example figures and people, not claims about the client, so the fast lane's
 * faithfulness gate skips them — which is only honest because `render.ts` shows every section
 * that holds one under the visible caption below (`data-od-mock="sample-data"`). `render.test.ts` checks this list
 * against the schema marks, so the two cannot drift.
 */
export const CRM_DASHBOARD_MOCK_SLOTS: Readonly<Record<CrmDashboardSectionId, readonly string[]>> = {
  [KPI_SECTION_ID]: ['value', 'delta'],
  [PIPELINE_SECTION_ID]: ['company', 'owner', 'stage', 'value', 'nextStep'],
  [ACTIVITY_SECTION_ID]: ['when', 'who', 'what'],
  [CONTACT_SECTION_ID]: ['name', 'role', 'company', 'email', 'phone', 'note'],
  [FILTERS_SECTION_ID]: ['owner'],
  [CHART_SECTION_ID]: ['label'],
};

/** The visible caption on every section that shows sample data. Family copy, not a locale string:
 * the rendered page is static HTML. */
export const SAMPLE_DATA_CAPTION = 'Sample data';
