/**
 * app-shell family — executable recipe contract.
 *
 * Validates at the JSON boundary and returns only the fields the renderer understands. It
 * refuses: an unknown field anywhere, a wrong schema version or family, a non-positive or
 * non-integer revision, a missing or malformed section, a text slot carrying markup or a control
 * character, a text slot over its bound, a side-nav group other than index 2 or 3 carrying
 * `null`, and a wrong repeat count anywhere the contract does not allow it.
 */

import { isDroppedOptional } from '../../sections.ts';
import {
  APP_SHELL_OPTIONAL_SECTIONS,
  BRAND_SLOTS,
  DETAIL_PAIR_COUNT, DETAIL_PAIR_SLOTS, DETAIL_SECTION_ID, DETAIL_TEXT_SLOTS,
  EMPTY_SECTION_ID, EMPTY_SLOTS,
  FAMILY_ID,
  LIST_ROW_COUNT, LIST_ROW_SLOTS, LIST_SECTION_ID, LIST_TEXT_SLOTS,
  SCHEMA_VERSION,
  SETTINGS_COUNT, SETTINGS_SECTION_ID, SETTINGS_SLOTS,
  SIDENAV_GROUP_COUNT, SIDENAV_GROUP_HEADING_SLOT, SIDENAV_LINK_COUNT, SIDENAV_LINK_SLOT,
  SIDENAV_REQUIRED_GROUP_COUNT, SIDENAV_SECTION_ID,
  TOPNAV_LINK_COUNT, TOPNAV_LINK_SLOT, TOPNAV_SECTION_ID, TOPNAV_USER_SLOT,
  type TextSlot,
} from './slots.ts';
export { APP_SHELL_NULLABLE_ATOMS, APP_SHELL_OPTIONAL_SECTIONS } from './slots.ts';
export type { AppShellAtomKind, AppShellNullableSlot } from './slots.ts';

export type AppShellNavGroup = { heading: string; links: string[] };
export type AppShellListRow = { name: string; status: string; owner: string; updated: string };
export type AppShellDetailPair = { label: string; value: string };
export type AppShellSettingsSection = { heading: string; body: string };

export type AppShellRecipe = {
  schemaVersion: 2;
  family: 'app-shell';
  revision: number;
  brand: { name: string; descriptor: string };
  /** `sections[2]` (empty-state) is `null` when the whole section is dropped
   * (`APP_SHELL_OPTIONAL_SECTIONS`), unlike a nullable atom's repeat item, which nulls only one
   * item while the section itself stays. */
  sections: [
    { id: typeof TOPNAV_SECTION_ID; type: 'top-nav'; items: { links: string[]; user: string } },
    { id: typeof SIDENAV_SECTION_ID; type: 'side-nav'; items: Array<AppShellNavGroup | null> },
    ({ id: typeof EMPTY_SECTION_ID; type: 'empty-state'; text: { heading: string; body: string; cta: string } }) | null,
    { id: typeof LIST_SECTION_ID; type: 'list-view'; text: { heading: string }; items: AppShellListRow[] },
    { id: typeof DETAIL_SECTION_ID; type: 'detail-view'; text: { heading: string }; items: AppShellDetailPair[] },
    { id: typeof SETTINGS_SECTION_ID; type: 'settings'; items: Array<AppShellSettingsSection | null> },
  ];
};

const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]');
const MARKUP = /[<>]|&(?:[a-z][a-z0-9]{1,31}|#[0-9]{1,7}|#x[0-9a-f]{1,6});/i;

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
  const record = object(value, at);
  keys(record, slots.map((slot) => slot.name), at);
  const out: Record<string, string> = {};
  for (const slot of slots) {
    if (record[slot.name] === undefined) throw new Error(`${at}.${slot.name}: required text slot is missing`);
    out[slot.name] = plainText(record[slot.name], slot, `${at}.${slot.name}`);
  }
  return out;
}

function stringArray(value: unknown, count: number, slot: TextSlot, at: string): string[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error(`${at}: expected exactly ${count} items`);
  return value.map((raw, index) => plainText(raw, slot, `${at}[${index}]`));
}

function topnavSection(value: unknown, at: string): AppShellRecipe['sections'][0] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'items'], at);
  if (record.id !== TOPNAV_SECTION_ID) throw new Error(`${at}.id: expected "${TOPNAV_SECTION_ID}"`);
  if (record.type !== 'top-nav') throw new Error(`${at}.type: expected "top-nav"`);
  const items = object(record.items, `${at}.items`);
  keys(items, ['links', 'user'], `${at}.items`);
  const links = stringArray(items.links, TOPNAV_LINK_COUNT, TOPNAV_LINK_SLOT, `${at}.items.links`);
  if (items.user === undefined) throw new Error(`${at}.items.user: required text slot is missing`);
  const user = plainText(items.user, TOPNAV_USER_SLOT, `${at}.items.user`);
  return { id: TOPNAV_SECTION_ID, type: 'top-nav', items: { links, user } };
}

function navGroup(value: unknown, at: string, index: number): AppShellNavGroup | null {
  if (value === null) {
    if (index < SIDENAV_REQUIRED_GROUP_COUNT) throw new Error(`${at}: the first ${SIDENAV_REQUIRED_GROUP_COUNT} side-nav groups may not be null`);
    return null;
  }
  const record = object(value, at);
  keys(record, ['heading', 'links'], at);
  if (record.heading === undefined) throw new Error(`${at}.heading: required text slot is missing`);
  const heading = plainText(record.heading, SIDENAV_GROUP_HEADING_SLOT, `${at}.heading`);
  const links = stringArray(record.links, SIDENAV_LINK_COUNT, SIDENAV_LINK_SLOT, `${at}.links`);
  return { heading, links };
}

function sidenavSection(value: unknown, at: string): AppShellRecipe['sections'][1] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'items'], at);
  if (record.id !== SIDENAV_SECTION_ID) throw new Error(`${at}.id: expected "${SIDENAV_SECTION_ID}"`);
  if (record.type !== 'side-nav') throw new Error(`${at}.type: expected "side-nav"`);
  if (!Array.isArray(record.items) || record.items.length !== SIDENAV_GROUP_COUNT) throw new Error(`${at}.items: expected exactly ${SIDENAV_GROUP_COUNT} items`);
  const items = record.items.map((raw, index) => navGroup(raw, `${at}.items[${index}]`, index));
  return { id: SIDENAV_SECTION_ID, type: 'side-nav', items };
}

function emptySection(value: unknown, at: string): AppShellRecipe['sections'][2] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text'], at);
  if (record.id !== EMPTY_SECTION_ID) throw new Error(`${at}.id: expected "${EMPTY_SECTION_ID}"`);
  if (record.type !== 'empty-state') throw new Error(`${at}.type: expected "empty-state"`);
  const text = textGroup(record.text, EMPTY_SLOTS, `${at}.text`) as unknown as { heading: string; body: string; cta: string };
  return { id: EMPTY_SECTION_ID, type: 'empty-state', text };
}

function listRow(value: unknown, at: string): AppShellListRow {
  return textGroup(value, LIST_ROW_SLOTS, at) as unknown as AppShellListRow;
}

function listSection(value: unknown, at: string): AppShellRecipe['sections'][3] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text', 'items'], at);
  if (record.id !== LIST_SECTION_ID) throw new Error(`${at}.id: expected "${LIST_SECTION_ID}"`);
  if (record.type !== 'list-view') throw new Error(`${at}.type: expected "list-view"`);
  const text = textGroup(record.text, LIST_TEXT_SLOTS, `${at}.text`) as unknown as { heading: string };
  if (!Array.isArray(record.items) || record.items.length !== LIST_ROW_COUNT) throw new Error(`${at}.items: expected exactly ${LIST_ROW_COUNT} items`);
  const items = record.items.map((raw, index) => listRow(raw, `${at}.items[${index}]`));
  return { id: LIST_SECTION_ID, type: 'list-view', text, items };
}

function detailPair(value: unknown, at: string): AppShellDetailPair {
  return textGroup(value, DETAIL_PAIR_SLOTS, at) as unknown as AppShellDetailPair;
}

function detailSection(value: unknown, at: string): AppShellRecipe['sections'][4] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text', 'items'], at);
  if (record.id !== DETAIL_SECTION_ID) throw new Error(`${at}.id: expected "${DETAIL_SECTION_ID}"`);
  if (record.type !== 'detail-view') throw new Error(`${at}.type: expected "detail-view"`);
  const text = textGroup(record.text, DETAIL_TEXT_SLOTS, `${at}.text`) as unknown as { heading: string };
  if (!Array.isArray(record.items) || record.items.length !== DETAIL_PAIR_COUNT) throw new Error(`${at}.items: expected exactly ${DETAIL_PAIR_COUNT} items`);
  const items = record.items.map((raw, index) => detailPair(raw, `${at}.items[${index}]`));
  return { id: DETAIL_SECTION_ID, type: 'detail-view', text, items };
}

function settingsSection(value: unknown, at: string, index: number): AppShellSettingsSection | null {
  if (value === null) return null;
  return textGroup(value, SETTINGS_SLOTS, `${at}[${index}]`) as unknown as AppShellSettingsSection;
}

function settingsGroup(value: unknown, at: string): AppShellRecipe['sections'][5] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'items'], at);
  if (record.id !== SETTINGS_SECTION_ID) throw new Error(`${at}.id: expected "${SETTINGS_SECTION_ID}"`);
  if (record.type !== 'settings') throw new Error(`${at}.type: expected "settings"`);
  if (!Array.isArray(record.items) || record.items.length !== SETTINGS_COUNT) throw new Error(`${at}.items: expected exactly ${SETTINGS_COUNT} items`);
  const items = record.items.map((raw, index) => settingsSection(raw, `${at}.items`, index));
  return { id: SETTINGS_SECTION_ID, type: 'settings', items };
}

/** Validate an app-shell recipe. Throws an Error naming the offending field. */
export function parseAppShellRecipe(input: unknown): AppShellRecipe {
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
  const [rawTopnav, rawSidenav, rawEmpty, rawList, rawDetail, rawSettings] = root.sections;
  return {
    schemaVersion: SCHEMA_VERSION as 2,
    family: FAMILY_ID as 'app-shell',
    revision: root.revision,
    brand,
    sections: [
      topnavSection(rawTopnav, 'sections[0]'),
      sidenavSection(rawSidenav, 'sections[1]'),
      isDroppedOptional(rawEmpty, 'empty-state', APP_SHELL_OPTIONAL_SECTIONS) ? null : emptySection(rawEmpty, 'sections[2]'),
      listSection(rawList, 'sections[3]'),
      detailSection(rawDetail, 'sections[4]'),
      settingsGroup(rawSettings, 'sections[5]'),
    ],
  };
}
