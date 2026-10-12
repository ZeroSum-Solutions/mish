/** Shared test fixtures: bundled package paths and a fake model that fills templates offline. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModelCall } from '../src/deepseek.ts';
import { loadFamilyPackage, type FamilyPackage } from '../src/family.ts';
import type { FaithfulnessChecker, FaithfulnessSlot } from '../src/jev.ts';
import { ANCHOR_KEY, isObject, type Json, type JsonObject } from '../src/spine.ts';
import { clipWholeWords } from '../src/text-clip.ts';
import { HOURS_LABEL_PLACEHOLDER, HOURS_ROW_PLACEHOLDER } from '../src/prompt.ts';

const EXAMPLES = path.resolve(import.meta.dirname, 'fixtures');
export const TEST_SITE_DIR = path.join(EXAMPLES, 'ownedsite');
export const TEST_EDITORIAL_DIR = path.join(EXAMPLES, 'ownededitorial');
export const TEST_CONTRACTOR_DIR = path.join(EXAMPLES, 'ownedcontractor');
export const TEST_INSTITUTION_DIR = path.join(EXAMPLES, 'ownedinstitution');

export const loadTestSite = (): Promise<FamilyPackage> => loadFamilyPackage(TEST_SITE_DIR, 'ownedsite');

export async function readJson(file: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(file, 'utf8')) as Json;
  if (!isObject(value)) throw new Error(`${file}: expected an object`);
  return value;
}

/** Reads the JSON block that follows a heading in a fast-lane prompt. */
export function promptBlock(prompt: string, heading: 'LIMITS' | 'TEMPLATE'): Json {
  const start = prompt.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`prompt has no ${heading} block`);
  const body = prompt.slice(start + heading.length + 2);
  const end = ['\n\nTEMPLATE\n', '\n\nYOUR PREVIOUS ANSWER WAS REJECTED\n'].map((marker) => body.indexOf(marker)).filter((index) => index >= 0);
  return JSON.parse(end.length > 0 ? body.slice(0, Math.min(...end)) : body) as Json;
}

/** Returning null stands for a model that answered a nullable slot with the JSON literal null. */
export type Filler = (key: string, value: string, at: string, limit?: number) => string | null;

export const defaultFill: Filler = (key, _value, _at, limit) => {
  // g6-r3b-opus55 audit (NOTE N-b, jev.ts's `isClippedPrefix` removed — whole-word matching only):
  // the old raw `.slice(0, limit)` could cut mid-word through "Riverbend" ("New menuLabel for
  // Riverb" at limit 24), and with the brief-word-prefix exemption gone, that byte-budget clip now
  // fails `deterministicProperNounFlags` — but no REAL model fill ever goes through a raw slice in
  // production; `section-overlay.ts`'s own fill path already uses `clipWholeWords`
  // (`src/text-clip.ts`) to cut at a whole-word boundary, never mid-word, for exactly this reason.
  // The old `.slice()` here was simulating a WORSE-than-realistic model, one production code
  // cannot actually produce; using the same whole-word clip the real pipeline uses is the accurate
  // simulation, not a loosening.
  const text = `New ${key} for Riverbend Dental`;
  return typeof limit === 'number' ? (clipWholeWords(text, limit) ?? 'New') : text;
};

/** Fills every string in a template except anchors, honouring the limits object. */
export function fillTemplate(template: Json, limits: Json | undefined, fill: Filler = defaultFill, key = '', at = ''): Json {
  if (typeof template === 'string') {
    if (key === ANCHOR_KEY) return template;
    // An hours placeholder left in place is a refused answer (run.ts, PR #137). A fake model that
    // echoes TEMPLATE answers a plain day there instead ("Monday", or "Monday, 9am-5pm" for a
    // combined row): a real fill writes days, and the hours gate still checks them.
    const shown = template === HOURS_ROW_PLACEHOLDER ? 'Monday, 9am-5pm' : template === HOURS_LABEL_PLACEHOLDER ? 'Monday' : template;
    return fill(key, shown, at, typeof limits === 'number' ? limits : undefined);
  }
  if (Array.isArray(template)) {
    return template.map((item, index) => fillTemplate(item, Array.isArray(limits) ? limits[index] : undefined, fill, key, `${at}[${index}]`));
  }
  if (isObject(template)) {
    const out: JsonObject = {};
    for (const [childKey, child] of Object.entries(template)) {
      out[childKey] = fillTemplate(child, isObject(limits) ? limits[childKey] : undefined, fill, childKey, at ? `${at}.${childKey}` : childKey);
    }
    return out;
  }
  return template;
}

export type FakeModelOptions = {
  chunk?: number;
  fill?: Filler;
  /** Overrides the answer to a first (non-repair) prompt; return undefined to use the default fill. */
  firstAnswer?: (template: Json, limits: Json | undefined) => Json | undefined;
  /** Rewrites the raw text of a first (non-repair) answer, for malformed-output cases. */
  rawFirstAnswer?: (text: string, template: Json) => string;
};

export function fakeModel(options: FakeModelOptions = {}): ModelCall & { prompts: string[] } {
  const prompts: string[] = [];
  const call = (async ({ user, onDelta }) => {
    prompts.push(user);
    const template = promptBlock(user, 'TEMPLATE');
    const limits = promptBlock(user, 'LIMITS');
    const repairing = user.includes('\nYOUR PREVIOUS ANSWER WAS REJECTED\n');
    const answer = (repairing ? undefined : options.firstAnswer?.(template, limits)) ?? fillTemplate(template, limits, options.fill);
    const text = repairing || !options.rawFirstAnswer ? JSON.stringify(answer) : options.rawFirstAnswer(JSON.stringify(answer), template);
    const size = options.chunk ?? 7;
    for (let index = 0; index < text.length; index += size) {
      onDelta?.(text.slice(index, index + size));
      // A real stream yields between network chunks; give the save queue the same chance.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { text, usage: { input: 100, output: 50, cachedRead: 20 }, firstTokenMs: 1, ms: 2, retries: 0 };
  }) as ModelCall & { prompts: string[] };
  call.prompts = prompts;
  return call;
}

/**
 * Flags any slot whose text contains one of `markers` — a stand-in for a real faithfulness call.
 * `slotCounts` records the number of slots `checkFaithfulness` was asked about on each call, in
 * order, so a test can assert how many slots an incremental (locked-paths-aware) run actually
 * sent to Jev, not just how many times it was called.
 */
export function fakeJevChecker(markers: string[] = ['FABRICATED']): FaithfulnessChecker & { calls: number; slotCounts: number[] } {
  const checker = {
    calls: 0,
    slotCounts: [] as number[],
    async checkFaithfulness({ slots }: { slots: FaithfulnessSlot[] }) {
      checker.calls += 1;
      checker.slotCounts.push(slots.length);
      const flagged = slots.filter((slot) => markers.some((marker) => slot.text.includes(marker))).map((slot) => ({ path: slot.path, probability: 0.95 }));
      return { flagged, ms: 1, calls: 1 };
    },
  };
  return checker;
}
