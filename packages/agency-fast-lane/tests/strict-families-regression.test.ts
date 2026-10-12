/**
 * Strict verify for every bundled family package is unchanged by the verify-after play
 * (`verify-policy.ts`'s `after` mode, `run.ts`'s `verifyAfterPublish`): a strict run that turns up
 * a faithfulness flag still registers nothing at all — no project, no assets, no pages, no state
 * files — for all sixteen families this package ships today, byte-for-byte the same behaviour
 * `tests/run.test.ts`'s maben-only strict tests already pin.
 *
 * One fill per family is enough. There is no single field name every family's schema shares
 * (`watson`'s `brand.name` in particular carries its own strict glyph-set contract rule — see
 * `tests/watson-nullable.test.ts` — and is locked here exactly as `--lock brand.name` would), and
 * every family has at least one nullable contact/award atom (`businessEmail`, `phone`, and
 * similar — see e.g. `tests/watson-nullable.test.ts`'s `NULLABLE_ATOMS`) whose own format a
 * generic fake filler cannot satisfy either, so those are left at the reference fixture's own
 * already-valid text rather than replaced. Everything else with a generous character limit gets
 * the marker — the point here is the strict gate's own behaviour, not each family's render/
 * validation path, which has its own `render.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, nullablePathsOf } from '../src/spine.ts';
import { fakeJevChecker, fakeModel, type Filler } from './fixtures.ts';

const EXAMPLES = new URL('../../../plugins/_official/examples/', import.meta.url);

const FAMILIES = ['maben', 'watson', 'wrenfield', 'fervor', 'halcyon', 'maren', 'emmpo', 'marketing-site', 'app-shell', 'crm-dashboard', 'listings', 'publication', 'nonprofit', 'docs-hub', 'restaurant', 'community', 'storefront', 'practice', 'guide'] as const;

const BRIEF = 'Riverbend Dental, a family dental practice in Boise. Same-day crowns, sedation options, open Saturdays.';

/** Every nullable atom's own key name (`businessEmail`, `phone`, …), by walking the family's own
 * schema the way `watson-nullable.test.ts` does by hand for one family — a fake filler has no
 * business inventing a format-valid email or phone number, and the fixture's own value already is
 * one. Key name only (not the full path), since a Filler is told the key, not the absolute path. */
function nullableAtomKeys(pkg: Awaited<ReturnType<typeof loadFamilyPackage>>): Set<string> {
  const template = editableTemplate(structuredClone(pkg.fixture), undefined, new Set());
  if (template === undefined) return new Set();
  const nullable = nullablePathsOf(atomKindsFor(pkg.schema, template));
  return new Set([...nullable].map((path) => path.split('.').pop()!));
}

/** Marks every free-text slot with a generous limit; a nullable atom keeps the fixture's own
 * value, and a short, tightly-limited slot (a label) is left alone too, rather than risking
 * truncation eating the marker entirely. */
/** Required slots whose family contract checks a format (a price, an email, a phone number) the
 * generic marker cannot satisfy — the three page-kind families carry these as plain required
 * strings rather than nullable atoms. Kept at the fixture's own valid value, like a nullable atom. */
// 'label' is guide's own practical-facts row name: `contract.ts` hard-refuses anything but the
// fixed category name at that exact position (see `slots.ts`'s own doc), so a generic fabricated
// marker fails there the same way a malformed price or email would elsewhere; kept at the
// fixture's own already-valid value, like a nullable atom.
const FORMATTED_KEYS: ReadonlySet<string> = new Set(['price', 'email', 'phone', 'url', 'label']);

/**
 * The page-kind families' repeated items sit behind a `oneOf` (null or the array), which
 * `limitsFor` does not read through, so their slots reach the filler with no limit while the
 * family contract still enforces one (as low as 12 characters). A slot with no known limit there
 * gets a short unmarked label; the marker still lands on every slot with a generous known limit.
 */
const LIMITS_BEHIND_ONEOF: ReadonlySet<string> = new Set(['marketing-site', 'app-shell', 'crm-dashboard']);

function fabricateLongSlots(nullableKeys: Set<string>, family: string): Filler {
  return (key, value, _at, limit) => {
    const itemIndex = /items\[(\d+)\]/.exec(_at ?? '')?.[1];
    if (nullableKeys.has(key) || FORMATTED_KEYS.has(key)) return typeof value === 'string' ? value : null;
    if (limit === undefined && LIMITS_BEHIND_ONEOF.has(family)) return `New ${key}`.slice(0, 12);
    // The marker remains fabricated, while repeated rows stay semantically distinct.
    const base = `${itemIndex === undefined ? 'New' : `Row ${itemIndex} New`} ${key} for Riverbend Dental`;
    const marked = limit === undefined || limit > 60 ? `FABRICATED ${base}` : base;
    return typeof limit === 'number' ? marked.slice(0, limit) : marked;
  };
}

for (const family of FAMILIES) {
  test(`strict: ${family} registers nothing when a flag survives — no project, no assets, no pages, no state`, async () => {
    const pkg = await loadFamilyPackage(new URL(`agency-${family}/`, EXAMPLES).pathname, family);
    const model = fakeModel({ fill: fabricateLongSlots(nullableAtomKeys(pkg), family) });
    const verify = fakeJevChecker(['FABRICATED']);
    let created = false;
    const report = await runFastLane({
      pkg,
      brief: BRIEF,
      mode: 'sections',
      entry: `${family}-r1.html`,
      revision: 1,
      model,
      modelName: 'fake',
      verify,
      strict: true,
      // Watson's `brand.name` carries its own glyph-set contract rule a generic fake filler
      // cannot satisfy; locked exactly as `--lock brand.name` would. A no-op for the other nine
      // families, whose brand unit either has no `name` field the way watson's does at this same
      // relative path, or accepts it unlocked without issue either way.
      lockPaths: ['brand.name'],
      ensurePublisher: async () => {
        created = true;
        throw new Error(`${family}: ensurePublisher must never be called once the gate has failed`);
      },
    });

    assert.equal(created, false, `${family}: nothing was ever published`);
    assert.equal(report.projectId, undefined, `${family}: no project id on the report`);
    assert.equal(report.timings.registeredMs, undefined, `${family}: never registered`);
    assert.ok(report.strict, `${family}: strict verdict is reported`);
    assert.equal(report.strict!.passed, false, `${family}: the gate failed`);
    assert.ok(report.verify!.remaining.length > 0, `${family}: at least one flag is reported as remaining`);
  });
}
