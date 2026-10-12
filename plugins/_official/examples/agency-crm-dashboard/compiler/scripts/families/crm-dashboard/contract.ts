/**
 * crm-dashboard family — executable recipe contract.
 *
 * Validates at the JSON boundary and returns only the fields the renderer understands. It
 * refuses: an unknown field anywhere, a wrong schema version or family, a non-positive or
 * non-integer revision, a missing or malformed section, a text slot carrying markup or a control
 * character, a text slot over its bound, a KPI item other than index 2 or 3 carrying `null`, and
 * a chart bar value that is not a finite non-negative number.
 */

import { isDroppedOptional } from '../../sections.ts';
import {
  ACTIVITY_ITEM_SLOTS, ACTIVITY_COUNT, ACTIVITY_SECTION_ID,
  BRAND_SLOTS,
  CHART_SECTION_ID, CHART_TITLE_SLOT, CHART_UNIT_SLOT, CHART_VALUE_COUNT, CHART_VALUE_LABEL_SLOT,
  CONTACT_SECTION_ID, CONTACT_SLOTS,
  CRM_DASHBOARD_OPTIONAL_SECTIONS,
  FAMILY_ID,
  FILTERS_OWNER_COUNT, FILTERS_SECTION_ID, FILTERS_STAGE_COUNT, FILTER_OPTION_SLOT,
  KPI_COUNT, KPI_ITEM_SLOTS, KPI_REQUIRED_COUNT, KPI_SECTION_ID,
  PIPELINE_HEADING_SLOT, PIPELINE_ROW_COUNT, PIPELINE_ROW_SLOTS, PIPELINE_SECTION_ID,
  SCHEMA_VERSION,
  type TextSlot,
} from './slots.ts';
export { CRM_DASHBOARD_NULLABLE_ATOMS, CRM_DASHBOARD_OPTIONAL_SECTIONS } from './slots.ts';
export type { CrmDashboardAtomKind, CrmDashboardNullableSlot } from './slots.ts';

export type CrmKpiItem = { label: string; value: string; delta: string };
export type CrmPipelineRow = { company: string; owner: string; stage: string; value: string; nextStep: string };
export type CrmActivityItem = { when: string; who: string; what: string };
export type CrmContact = { name: string; role: string; company: string; email: string; phone: string; note: string };
export type CrmChartValue = { label: string; value: number };

export type CrmDashboardRecipe = {
  schemaVersion: 2;
  family: 'crm-dashboard';
  revision: number;
  brand: { name: string; descriptor: string };
  /** `sections[2]` (activity-feed) is `null` when the whole section is dropped
   * (`CRM_DASHBOARD_OPTIONAL_SECTIONS`), unlike `items: null` (a nullable atom: the section stub
   * stays, only its content is absent). */
  sections: [
    { id: typeof KPI_SECTION_ID; type: 'kpi-strip'; items: Array<CrmKpiItem | null> },
    { id: typeof PIPELINE_SECTION_ID; type: 'pipeline-table'; text: { heading: string }; items: CrmPipelineRow[] },
    ({ id: typeof ACTIVITY_SECTION_ID; type: 'activity-feed'; items: CrmActivityItem[] | null }) | null,
    { id: typeof CONTACT_SECTION_ID; type: 'contact-card'; text: CrmContact },
    { id: typeof FILTERS_SECTION_ID; type: 'filter-bar'; items: { owner: string[]; stage: string[] } },
    { id: typeof CHART_SECTION_ID; type: 'bar-chart'; text: { title: string; unit: string } | null; items: { values: CrmChartValue[] } | null },
  ];
};

const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]');
const MARKUP = /[<>]|&(?:[a-z][a-z0-9]{1,31}|#[0-9]{1,7}|#x[0-9a-f]{1,6});/i;
const EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/;
const PHONE = /^\+?[0-9 ()-]{5,30}$/;

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${at}: expected a plain object`);
  }
  return value as Record<string, unknown>;
}
function keys(record: Record<string, unknown>, allowed: string[], at: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${at}.${key}: unknown field`);
}

function plainText(value: unknown, slot: TextSlot, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at}: expected plain text`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${at}: expected non-empty plain text`);
  if (trimmed.length > slot.max) throw new Error(`${at}: at most ${slot.max} characters, received ${trimmed.length}`);
  if (CONTROL.test(trimmed)) throw new Error(`${at}: control characters are not allowed in a text slot`);
  if (MARKUP.test(trimmed)) throw new Error(`${at}: markup is not allowed in a text slot`);
  return trimmed;
}

function textGroup(value: unknown, slots: TextSlot[], at: string): Record<string, string> {
  const record = object(value, slots.map((slot) => slot.name), at);
  keys(record, slots.map((slot) => slot.name), at);
  const out: Record<string, string> = {};
  for (const slot of slots) {
    if (record[slot.name] === undefined) throw new Error(`${at}.${slot.name}: required text slot is missing`);
    out[slot.name] = plainText(record[slot.name], slot, `${at}.${slot.name}`);
  }
  return out;
}

function chartValue(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${at}: expected a finite number from 0 to 1000000`);
  }
  return value;
}

function kpiItem(value: unknown, at: string, index: number): CrmKpiItem | null {
  if (value === null) {
    if (index < KPI_REQUIRED_COUNT) throw new Error(`${at}: the first ${KPI_REQUIRED_COUNT} KPIs may not be null`);
    return null;
  }
  const record = object(value, at);
  keys(record, KPI_ITEM_SLOTS.map((slot) => slot.name), at);
  const item: Record<string, string> = {};
  for (const slot of KPI_ITEM_SLOTS) {
    if (record[slot.name] === undefined) throw new Error(`${at}.${slot.name}: required text slot is missing`);
    item[slot.name] = plainText(record[slot.name], slot, `${at}.${slot.name}`);
  }
  return item as CrmKpiItem;
}

function kpisSection(value: unknown, at: string): CrmDashboardRecipe['sections'][0] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'items'], at);
  if (record.id !== KPI_SECTION_ID) throw new Error(`${at}.id: expected "${KPI_SECTION_ID}"`);
  if (record.type !== 'kpi-strip') throw new Error(`${at}.type: expected "kpi-strip"`);
  if (!Array.isArray(record.items) || record.items.length !== KPI_COUNT) throw new Error(`${at}.items: expected exactly ${KPI_COUNT} items`);
  const items = record.items.map((raw, index) => kpiItem(raw, `${at}.items[${index}]`, index));
  return { id: KPI_SECTION_ID, type: 'kpi-strip', items };
}

function pipelineRow(value: unknown, at: string): CrmPipelineRow {
  return textGroup(value, PIPELINE_ROW_SLOTS, at) as unknown as CrmPipelineRow;
}

function pipelineSection(value: unknown, at: string): CrmDashboardRecipe['sections'][1] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text', 'items'], at);
  if (record.id !== PIPELINE_SECTION_ID) throw new Error(`${at}.id: expected "${PIPELINE_SECTION_ID}"`);
  if (record.type !== 'pipeline-table') throw new Error(`${at}.type: expected "pipeline-table"`);
  const text = textGroup(record.text, [PIPELINE_HEADING_SLOT], `${at}.text`);
  if (!Array.isArray(record.items) || record.items.length !== PIPELINE_ROW_COUNT) throw new Error(`${at}.items: expected exactly ${PIPELINE_ROW_COUNT} items`);
  const items = record.items.map((raw, index) => pipelineRow(raw, `${at}.items[${index}]`));
  return { id: PIPELINE_SECTION_ID, type: 'pipeline-table', text: { heading: text.heading! }, items };
}

function activityItem(value: unknown, at: string): CrmActivityItem {
  return textGroup(value, ACTIVITY_ITEM_SLOTS, at) as unknown as CrmActivityItem;
}

function activitySection(value: unknown, at: string): CrmDashboardRecipe['sections'][2] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'items'], at);
  if (record.id !== ACTIVITY_SECTION_ID) throw new Error(`${at}.id: expected "${ACTIVITY_SECTION_ID}"`);
  if (record.type !== 'activity-feed') throw new Error(`${at}.type: expected "activity-feed"`);
  if (record.items === null) return { id: ACTIVITY_SECTION_ID, type: 'activity-feed', items: null };
  if (!Array.isArray(record.items) || record.items.length !== ACTIVITY_COUNT) throw new Error(`${at}.items: expected exactly ${ACTIVITY_COUNT} items, or null`);
  const items = record.items.map((raw, index) => activityItem(raw, `${at}.items[${index}]`));
  return { id: ACTIVITY_SECTION_ID, type: 'activity-feed', items };
}

function contactSection(value: unknown, at: string): CrmDashboardRecipe['sections'][3] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text'], at);
  if (record.id !== CONTACT_SECTION_ID) throw new Error(`${at}.id: expected "${CONTACT_SECTION_ID}"`);
  if (record.type !== 'contact-card') throw new Error(`${at}.type: expected "contact-card"`);
  const text = textGroup(record.text, CONTACT_SLOTS, `${at}.text`) as unknown as CrmContact;
  if (!EMAIL.test(text.email)) throw new Error(`${at}.text.email: invalid email`);
  if (!PHONE.test(text.phone)) throw new Error(`${at}.text.phone: invalid telephone`);
  return { id: CONTACT_SECTION_ID, type: 'contact-card', text };
}

function optionList(value: unknown, count: number, at: string): string[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error(`${at}: expected exactly ${count} options`);
  return value.map((raw, index) => plainText(raw, FILTER_OPTION_SLOT, `${at}[${index}]`));
}

function filtersSection(value: unknown, at: string): CrmDashboardRecipe['sections'][4] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'items'], at);
  if (record.id !== FILTERS_SECTION_ID) throw new Error(`${at}.id: expected "${FILTERS_SECTION_ID}"`);
  if (record.type !== 'filter-bar') throw new Error(`${at}.type: expected "filter-bar"`);
  const items = object(record.items, `${at}.items`);
  keys(items, ['owner', 'stage'], `${at}.items`);
  const owner = optionList(items.owner, FILTERS_OWNER_COUNT, `${at}.items.owner`);
  const stage = optionList(items.stage, FILTERS_STAGE_COUNT, `${at}.items.stage`);
  return { id: FILTERS_SECTION_ID, type: 'filter-bar', items: { owner, stage } };
}

function chartSection(value: unknown, at: string): CrmDashboardRecipe['sections'][5] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text', 'items'], at);
  if (record.id !== CHART_SECTION_ID) throw new Error(`${at}.id: expected "${CHART_SECTION_ID}"`);
  if (record.type !== 'bar-chart') throw new Error(`${at}.type: expected "bar-chart"`);
  if (record.text === null && record.items === null) {
    return { id: CHART_SECTION_ID, type: 'bar-chart', text: null, items: null };
  }
  if (record.text === null || record.items === null) throw new Error(`${at}: text and items must both be null, or both present`);
  const text = textGroup(record.text, [CHART_TITLE_SLOT, CHART_UNIT_SLOT], `${at}.text`);
  const itemsRecord = object(record.items, `${at}.items`);
  keys(itemsRecord, ['values'], `${at}.items`);
  if (!Array.isArray(itemsRecord.values) || itemsRecord.values.length !== CHART_VALUE_COUNT) {
    throw new Error(`${at}.items.values: expected exactly ${CHART_VALUE_COUNT} items`);
  }
  const values = itemsRecord.values.map((raw, index) => {
    const where = `${at}.items.values[${index}]`;
    const entry = object(raw, where);
    keys(entry, ['label', 'value'], where);
    return { label: plainText(entry.label, CHART_VALUE_LABEL_SLOT, `${where}.label`), value: chartValue(entry.value, `${where}.value`) };
  });
  return { id: CHART_SECTION_ID, type: 'bar-chart', text: { title: text.title!, unit: text.unit! }, items: { values } };
}

/** Validate a crm-dashboard recipe. Throws an Error naming the offending field. */
export function parseCrmDashboardRecipe(input: unknown): CrmDashboardRecipe {
  const root = object(input, 'recipe');
  keys(root, ['schemaVersion', 'family', 'revision', 'brand', 'sections'], 'recipe');
  if (root.schemaVersion !== SCHEMA_VERSION) throw new Error(`recipe.schemaVersion: expected ${SCHEMA_VERSION}`);
  if (root.family !== FAMILY_ID) throw new Error(`recipe.family: expected "${FAMILY_ID}"`);
  if (typeof root.revision !== 'number' || !Number.isSafeInteger(root.revision) || root.revision < 1 || root.revision > 9999) {
    throw new Error('recipe.revision: expected a positive integer from 1 to 9999');
  }
  const brandRecord = object(root.brand, 'recipe.brand');
  const brand = textGroup(brandRecord, BRAND_SLOTS, 'recipe.brand') as unknown as { name: string; descriptor: string };
  if (!Array.isArray(root.sections) || root.sections.length !== 6) throw new Error('recipe.sections: expected exactly 6 sections');
  const [rawKpis, rawPipeline, rawActivity, rawContact, rawFilters, rawChart] = root.sections;
  return {
    schemaVersion: SCHEMA_VERSION as 2,
    family: FAMILY_ID as 'crm-dashboard',
    revision: root.revision,
    brand,
    sections: [
      kpisSection(rawKpis, 'sections[0]'),
      pipelineSection(rawPipeline, 'sections[1]'),
      isDroppedOptional(rawActivity, 'activity-feed', CRM_DASHBOARD_OPTIONAL_SECTIONS) ? null : activitySection(rawActivity, 'sections[2]'),
      contactSection(rawContact, 'sections[3]'),
      filtersSection(rawFilters, 'sections[4]'),
      chartSection(rawChart, 'sections[5]'),
    ],
  };
}
