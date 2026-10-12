/**
 * app-shell family — the finite section and slot registry.
 *
 * The page kind is a fixed composition of six vendored HyperUI application blocks
 * (`application/side-menu/1`, `vertical-menu/1`, `empty-states/1`, `tables/2`,
 * `details-list/2`, `tabs/1`; see `plugins/_official/shared/ui-kits/hyperui/`), the same "typed
 * slots over a fixed layout" shape crm-dashboard and the seven Agency Site families use. Only
 * controlled, named slots are exported here; executable rendering stays in `render.ts` and a
 * recipe never carries markup or CSS.
 *
 * No asset system: the six source blocks carry no images once vendored (Task 1 strips every
 * `<img>`), so this family has no `AssetSlot`/`DESTINATIONS` roster the way maben and watson do.
 *
 * Slot budget: the six sections carry 64 editable text slots between them, every nullable atom
 * present (see the per-section comments below). `BRAND_SLOTS` are two more reconcilable slots ON
 * TOP of that section budget — the crm-dashboard convention. A fully populated reference fixture
 * therefore renders 66 slots in total; `render.test.ts` checks the exact count against the
 * fixture's own content.
 */

export const FAMILY_ID = 'app-shell';
export const SCHEMA_VERSION = 2;

export type TextSlot = { name: string; max: number };

/** Brand fields a recipe may carry. Both are plain text; there is no wordmark asset. */
export const BRAND_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'descriptor', max: 200 },
];

/** `app-shell-topnav` — one top nav, styled as a horizontal bar
 * (`application/vertical-menu/1`): exactly four links plus one user label. */
export const TOPNAV_SECTION_ID = 'app-shell-topnav';
export const TOPNAV_LINK_COUNT = 4;
export const TOPNAV_LINK_SLOT: TextSlot = { name: 'link', max: 24 };
export const TOPNAV_USER_SLOT: TextSlot = { name: 'user', max: 40 };

/** `app-shell-sidenav` — exactly four nav groups (`application/side-menu/1`): a heading plus
 * exactly three links each. Groups 3 and 4 (index 2 and 3) are nullable atoms: a whole group
 * drops, not an empty one. */
export const SIDENAV_SECTION_ID = 'app-shell-sidenav';
export const SIDENAV_GROUP_COUNT = 4;
export const SIDENAV_REQUIRED_GROUP_COUNT = 2;
export const SIDENAV_LINK_COUNT = 3;
export const SIDENAV_GROUP_HEADING_SLOT: TextSlot = { name: 'heading', max: 24 };
export const SIDENAV_LINK_SLOT: TextSlot = { name: 'link', max: 24 };

/** `app-shell-empty` — one empty state (`application/empty-states/1`). Required. */
export const EMPTY_SECTION_ID = 'app-shell-empty';
export const EMPTY_SLOTS: TextSlot[] = [
  { name: 'heading', max: 60 },
  { name: 'body', max: 160 },
  { name: 'cta', max: 32 },
];

/** `app-shell-list` — one heading plus exactly five rows (`application/tables/2`). */
export const LIST_SECTION_ID = 'app-shell-list';
export const LIST_ROW_COUNT = 5;
export const LIST_TEXT_SLOTS: TextSlot[] = [{ name: 'heading', max: 60 }];
export const LIST_ROW_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'status', max: 16 },
  { name: 'owner', max: 40 },
  { name: 'updated', max: 24 },
];

/** `app-shell-detail` — one heading plus exactly five label/value pairs
 * (`application/details-list/2`). */
export const DETAIL_SECTION_ID = 'app-shell-detail';
export const DETAIL_PAIR_COUNT = 5;
export const DETAIL_TEXT_SLOTS: TextSlot[] = [{ name: 'heading', max: 60 }];
export const DETAIL_PAIR_SLOTS: TextSlot[] = [
  { name: 'label', max: 32 },
  { name: 'value', max: 80 },
];

/** `app-shell-settings` — exactly three settings sections, rendered as a static tab strip
 * (`application/tabs/1`, first tab shown selected, no script). Every section is independently
 * a nullable atom: a whole section drops, not an empty one. */
export const SETTINGS_SECTION_ID = 'app-shell-settings';
export const SETTINGS_COUNT = 3;
export const SETTINGS_SLOTS: TextSlot[] = [
  { name: 'heading', max: 40 },
  { name: 'body', max: 160 },
];

export const SECTION_ORDER = [
  TOPNAV_SECTION_ID,
  SIDENAV_SECTION_ID,
  EMPTY_SECTION_ID,
  LIST_SECTION_ID,
  DETAIL_SECTION_ID,
  SETTINGS_SECTION_ID,
] as const;
export type AppShellSectionId = (typeof SECTION_ORDER)[number];

/**
 * The two nullable atoms of this family, the app-shell-specific counterpart of
 * CRM_DASHBOARD_NULLABLE_ATOMS: a fact a brief may legitimately not state, where `render.ts`
 * drops the whole fragment (a side-nav group, a settings section) rather than emitting an empty
 * one. Both null a whole repeat item, the same shape as crm-dashboard's `kpiSecondary`.
 */
export const APP_SHELL_NULLABLE_ATOMS = {
  sideNavGroup: 'nav-group',
  settingsSection: 'settings-section',
} as const;
export type AppShellNullableSlot = keyof typeof APP_SHELL_NULLABLE_ATOMS;
export type AppShellAtomKind = (typeof APP_SHELL_NULLABLE_ATOMS)[AppShellNullableSlot];

/**
 * Section types a client brief may give nothing for at all. Unlike the nullable atoms above
 * (which null one repeat item but keep the section itself), a section type in this set may drop
 * its whole slot in `sections` to `null` (see `../../sections.ts`): no element, no `data-od-id`,
 * no asset request. The empty state is the one candidate — a shell that already has real rows to
 * show in `app-shell-list` may have no need for a "nothing here yet" state at all.
 */
export const APP_SHELL_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(['empty-state']);

/**
 * Illustrative sample-data slots, by section id: the slot names `recipe.schema.json` marks
 * `"x-mock": true`. They carry example records (including the detail view's record name) and the example signed-in user, not claims about the client, so the fast lane's
 * faithfulness gate skips them — which is only honest because `render.ts` shows every section
 * that holds one under the visible caption below (`data-od-mock="sample-data"`). `render.test.ts` checks this list
 * against the schema marks, so the two cannot drift.
 */
export const APP_SHELL_MOCK_SLOTS: Readonly<Partial<Record<AppShellSectionId, readonly string[]>>> = {
  [TOPNAV_SECTION_ID]: ['user'],
  [LIST_SECTION_ID]: ['name', 'status', 'owner', 'updated'],
  // The detail heading names the sample record the detail view shows (a list row's name), so it
  // is sample data too, under the same caption as the values.
  [DETAIL_SECTION_ID]: ['heading', 'value'],
};

/** The visible caption on every section that shows sample data. Family copy, not a locale string:
 * the rendered page is static HTML. */
export const SAMPLE_DATA_CAPTION = 'Sample data';
