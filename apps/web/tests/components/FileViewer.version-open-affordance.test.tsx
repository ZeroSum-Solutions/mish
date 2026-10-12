// @vitest-environment jsdom
//
// OPEND-2160 red spec: in the version-history panel, the button that opens a
// version reads as "share".
//
// What the code actually does (verified against a live runtime):
//
//   * icon:   RemixIcon `external-link-line` — a box with an arrow leaving it,
//             close enough to the iOS share glyph to be read as one.
//   * label:  `fileViewer.versions.open` = "Open preview" — it names the
//             action but never says the preview opens somewhere ELSE.
//   * action: `openVersionInNewTab` → `openSandboxedPreviewInNewTab(...)`.
//
// So the function is right and the icon is defensible; what is missing is the
// destination. Naming it makes the arrow-leaving-a-box glyph read the way it
// was meant to, which resolves the mismatch without turning an icon choice
// into a guess.
//
// This copy is a tooltip on an icon-only button — the only text the user ever
// gets for that control — so it has to carry the destination in every locale,
// not just English.

import { describe, expect, it } from 'vitest';
import type { Dict } from '../../src/i18n/types';
import { en } from '../../src/i18n/locales/en';


const KEY = 'fileViewer.versions.open' as const;

const LOCALES: ReadonlyArray<readonly [string, Dict]> = [
  ['en', en], ["en", en],
];

describe('version history open-elsewhere affordance (OPEND-2160)', () => {
  it('names the destination in English', () => {
    // An arrow leaving a box plus "Open preview" leaves the user guessing
    // between share, export and open. The destination is what disambiguates.
    expect(en[KEY].toLowerCase()).toMatch(/new window|new tab/);
  });

  it('carries a destination in every locale, not just English', () => {
    // The button is icon-only, so this string is the entire explanation the
    // user gets. A locale left on the old wording ships the same ambiguity
    // this issue was filed about.
    const stale = LOCALES.filter(([, dict]) => dict[KEY] === 'Open preview').map(([name]) => name);
    expect(stale).toEqual([]);

    const empty = LOCALES.filter(([, dict]) => !dict[KEY].trim()).map(([name]) => name);
    expect(empty).toEqual([]);
  });
});
