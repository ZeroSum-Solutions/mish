/**
 * Every bundled family can build a page from a brief that states none of the facts its template
 * has room for. The fake model answers every slot the family marks nullable with `null` (what the
 * fill prompt now asks for when the brief is silent), and every optional section is dropped up
 * front. The run must then validate and render, report each dropped section by id, keep the
 * nulled slots away from the faithfulness gate, and leave none of the reference client's facts in
 * the page. Each family's own `render.test.ts` ("omits unsupported facts") pins the markup side.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelCall } from '../src/deepseek.ts';
import { loadFamilyPackage } from '../src/family.ts';
import type { FaithfulnessChecker } from '../src/jev.ts';
import { runFastLane } from '../src/run.ts';
import { optionalSectionsOf } from '../src/sections.ts';
import { getAtPath, isObject, type Json, type JsonObject } from '../src/spine.ts';
import { fillTemplate, promptBlock, type Filler } from './fixtures.ts';

const EXAMPLES = new URL('../../../plugins/_official/examples/', import.meta.url);
const FAMILIES = ['marketing-site', 'app-shell', 'crm-dashboard', 'listings', 'publication', 'nonprofit', 'storefront', 'practice'] as const;
const BRIEF = 'Riverbend Dental, a family dental practice in Boise.';
/**
 * practice's `providers` section is required and never droppable (`min: 1`, per slots.ts's own
 * doc: "a clinical or appointment practice earns trust through who treats the visitor"), and its
 * `name` field is `x-atom: 'person-name'` — a fact this deterministic gate never lets a filler
 * invent. A brief this bare about who treats you is not a realistic practice brief (every real
 * one names at least its own practitioner), so this override names one, the same way TestEditorial's
 * `lockPaths: ['brand.name']` below carries a family-specific format requirement the shared BRIEF
 * cannot satisfy generically.
 */
const BRIEF_OVERRIDES: Readonly<Record<string, string>> = {
  practice: 'Riverbend Dental, a family dental practice in Boise, run by Dr. Maria Chen.',
};
const REAL_PROVIDER_NAME = 'Dr. Maria Chen';
/**
 * practice's `services.title`/`services.body` and `providers.credential` are `x-verify:
 * 'traceable'` (see `slots.ts`'s own `FieldSpec` doc) — a required row with no legal way to shrink
 * below `min: 1` still must, deterministically, trace every one of its stemmed content words to
 * the brief. The generic `Riverbend ${key}` filler below satisfies that everywhere else (its own
 * words never need to trace, since no other family marks these particular fields this way), but
 * for `practice` it would fabricate a word ("title", "body", "credential") the brief never states
 * — so these three traceable slots get neutral text built ONLY from `BRIEF_OVERRIDES.practice`'s
 * own words instead, the same honest-fallback discipline `practice-attribution-gate.test.ts`'s
 * `fillWith` already applies to `destination`/`price`/`address`.
 */
// Short enough to clear even the smallest of these three fields' own soft limit (`title`'s 60
// characters, shrunk 15% by `softLimits`) without a mid-word cut that would break its own
// tracing (a truncated "Ch" no longer stems to the brief's own "Chen").
// Distinct brief-grounded records let this test reach the unsupported-facts gate.
const TRACEABLE_NEUTRAL_TEXT = ['Family dental practice in Boise', 'Dental practice in Boise', 'Family dental practice'] as const;

/** Required slots whose contract checks a format a generic filler cannot write; kept as given. */
const FORMATTED_KEYS: ReadonlySet<string> = new Set(['price', 'email', 'phone']);

function makeNeutralFill(family: string): Filler {
  return (key, value, _at, limit) => {
    const itemIndex = Number(/items\[(\d+)\]/.exec(_at ?? '')?.[1] ?? 0);
    if (FORMATTED_KEYS.has(key)) return value;
    // A person-name slot cannot honestly be filled with generic fabricated text (see
    // `BRIEF_OVERRIDES`'s doc) — write the one real name `BRIEF_OVERRIDES[family]` names instead.
    if (family === 'practice' && key === 'name') return REAL_PROVIDER_NAME;
    if (family === 'practice' && (key === 'title' || key === 'body' || key === 'credential')) {
      return typeof limit === 'number' ? TRACEABLE_NEUTRAL_TEXT[itemIndex]!.slice(0, limit) : TRACEABLE_NEUTRAL_TEXT[itemIndex]!;
    }
    // g6-r3-opus55 audit (FIX F2 — "top" added to SUPERLATIVE_CLAIM_WORDS): a hyphenated schema
    // key can spell an ordinary English word once split on its hyphens ("main-title-top" tokenizes
    // to "main"/"title"/"top"), and "top" is now a real claim signal. This filler text is a test
    // fixture artifact, not real content, so the key is joined WITHOUT its hyphens (one nonsense
    // token, "maintitletop") to avoid an incidental collision with a signal word — never by
    // narrowing the signal itself, per this round's own rule not to tune a new signal to keep a
    // count low.
    const text = `Riverbend ${key.replace(/[-_]/g, '')}`;
    return typeof limit === 'number' ? text.slice(0, limit) : text.slice(0, 12);
  };
}

/** The NULLABLE block of a fill prompt, when it has one. The next block after NULLABLE is
 * ARRAY MINIMA when the family has one, else BUDGETS or LIMITS directly — found generically
 * rather than assuming which one immediately follows. */
function nullableBlock(prompt: string): Json | undefined {
  const start = prompt.indexOf('\nNULLABLE\n');
  if (start < 0) return undefined;
  const body = prompt.slice(start + '\nNULLABLE\n'.length);
  const ends = ['\n\nTRACEABLE\n', '\n\nEXACT DATES\n', '\n\nHOURS LABELS\n', '\n\nARRAY MINIMA\n', '\n\nBUDGETS\n', '\n\nLIMITS\n'].map((marker) => body.indexOf(marker)).filter((index) => index >= 0);
  return JSON.parse(body.slice(0, Math.min(...ends))) as Json;
}

/** `answer` with `null` wherever `nullable` names a kind: the model answering "the brief is silent". */
function nullWhereNullable(answer: Json, nullable: Json | undefined): Json {
  if (typeof nullable === 'string') return null;
  if (Array.isArray(answer) && Array.isArray(nullable)) return answer.map((item, index) => nullWhereNullable(item, nullable[index]));
  if (isObject(answer) && isObject(nullable)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(answer)) out[key] = nullWhereNullable(child, nullable[key]);
    return out;
  }
  return answer;
}

function silentBriefModel(family: string): ModelCall {
  return (async ({ user }) => {
    const answer = nullWhereNullable(fillTemplate(promptBlock(user, 'TEMPLATE'), promptBlock(user, 'LIMITS'), makeNeutralFill(family)), nullableBlock(user));
    const text = JSON.stringify(answer);
    return { text, usage: { input: 1, output: 1, cachedRead: 0 }, firstTokenMs: 1, ms: 1, retries: 0 };
  }) as ModelCall;
}

const segments = (label: string): Array<string | number> =>
  [...label.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Every string leaf under `value`. */
function strings(value: Json | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => strings(item));
  if (isObject(value)) return Object.values(value).flatMap((item) => strings(item));
  return [];
}

for (const family of FAMILIES) {
  test(`${family}: omits unsupported facts — nulled slots and dropped sections leave nothing behind`, async () => {
    const pkg = await loadFamilyPackage(new URL(`agency-${family}/`, EXAMPLES).pathname, family);
    const optional = optionalSectionsOf(pkg.schema, pkg.fixture).map((section) => section.id);
    assert.ok(optional.length > 0, `${family}: at least one optional section`);
    const checked: string[] = [];
    const verify: FaithfulnessChecker = {
      async checkFaithfulness({ slots }) {
        checked.push(...slots.map((slot) => slot.path));
        return { flagged: [], ms: 1, calls: 1 };
      },
    };
    const brief = BRIEF_OVERRIDES[family] ?? BRIEF;
    const report = await runFastLane({
      pkg, brief, mode: 'sections', entry: `${family}-r1.html`, revision: 1,
      model: silentBriefModel(family), modelName: 'fake', verify, strict: true,
      // TestEditorial's brand name has its own glyph rule a generic filler cannot meet (see
      // strict-families-regression.test.ts); it is not a fact slot either way.
      lockPaths: ['brand.name'],
      dropSections: optional,
    });

    assert.deepEqual([...(report.droppedSections ?? [])].sort(), [...optional].sort(), `${family}: every dropped section is reported by id`);
    for (const id of optional) assert.equal(report.html.includes(`id="${id}"`), false, `${family}: dropped section ${id} renders nothing`);
    assert.deepEqual(report.missing, [], `${family}: no required slot came back empty`);
    assert.equal(report.strict?.passed, true, `${family}: the strict gate passes`);

    // Model-written text only: a locked field (`destinations`, `assets`, …) keeps its reference
    // value in the recipe, which is why no renderer may turn one into a link (checked below).
    const recipeText = new Set(strings(report.recipe));
    for (const path of report.nulled) {
      assert.equal(getAtPath(report.recipe, segments(path)), null, `${family}: ${path} is null in the recipe`);
      assert.ok(!checked.some((slot) => slot === path || slot.startsWith(`${path}.`) || slot.startsWith(`${path}[`)), `${family}: nulled ${path} never reaches the gate`);
      for (const fact of strings(getAtPath(pkg.fixture, segments(path)))) {
        if (fact.trim().length < 6 || recipeText.has(fact)) continue;
        assert.equal(report.html.includes(escapeHtml(fact)), false, `${family}: the reference fact at ${path} ("${fact}") is not on the page`);
      }
    }

    // No link the brief did not supply: a no-facts page carries no call/mail/text link and no
    // external link, and no link target from the reference client's fixture survives anywhere
    // (the locked `destinations` still hold them in the recipe; the renderer must not use them).
    const hrefs = [...report.html.matchAll(/\shref="([^"]*)"/g)].map((match) => match[1]!);
    for (const href of hrefs) {
      assert.ok(!/^(?:mailto|tel|sms):/i.test(href), `${family}: no call/mail/text link without a brief-supplied contact fact (${href})`);
      assert.ok(isAllowedStaticHref(href), `${family}: href "${href}" is not an allow-listed static template link`);
    }
    for (const target of referenceLinkTargets(pkg.fixture as Json)) {
      assert.equal(report.html.includes(escapeHtml(target)), false, `${family}: the reference link target "${target}" is not on the page`);
    }
  });
}

/** Every link-looking string in a reference fixture: a scheme URL, a protocol-relative URL or a `www.` host. */
function referenceLinkTargets(fixture: Json): string[] {
  return [...new Set(strings(fixture).map((value) => value.trim()).filter((value) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|www\.)/i.test(value)))];
}

/**
 * The static template links a no-facts page may keep. Anything else — `mailto:`/`tel:`/`sms:`, an
 * `http(s)://` or protocol-relative URL, or any other scheme — must come from a filled fact, and a
 * no-facts brief fills none.
 * - `#…` in-page anchors (section ids, the skip link, the ownedlearning/ownededitorial demo routes, and the `#`
 *   placeholder the tailwind families use for CTAs): they leave the page for nowhere.
 * - `assets/…` and other scheme-less relative paths: the family's own resolved asset files (the
 *   hero preload `<link href>`), never a reference-client destination.
 */
function isAllowedStaticHref(href: string): boolean {
  if (href.startsWith('#')) return true;
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
}
