/**
 * The bundled English word list (ESDB/SCOWL size 50, US; `src/wordlist/`), for the composed fill's
 * lexical completion gate (`section-overlay.ts`, Sol review round 3): a token the list does not know,
 * that the brief does not use, and that is the start of a list word ("Welcom" for "welcome"), reads
 * as a word the model cut to fit.
 *
 * Loaded lazily and once per process: gunzip + split + sort check, about 10 ms (measured in
 * `tests/lexicon.test.ts`). Data travels as code, so the daemon prebundle carries it.
 */

import { gunzipSync } from 'node:zlib';
import { SCOWL_EN_US_50_GZIP_BASE64 } from './wordlist/scowl-en-us-50.ts';

let sorted: string[] | undefined;
let known: Set<string> | undefined;

function load(): { sorted: string[]; known: Set<string> } {
  if (!sorted || !known) {
    sorted = gunzipSync(Buffer.from(SCOWL_EN_US_50_GZIP_BASE64, 'base64')).toString('utf8').split('\n');
    known = new Set(sorted);
  }
  return { sorted, known };
}

/** Whether the list holds `word` exactly (lowercase). */
export function inWordList(word: string): boolean {
  return load().known.has(word);
}

/** Stems a plain inflection of `word` may come from ("invoices" -> "invoice", "tracking" -> "track"). */
export function stemsOf(word: string): string[] {
  const out: string[] = [];
  const add = (stem: string) => { if (stem.length >= 2) out.push(stem); };
  const endings: Array<[string, string[]]> = [
    ["'s", ['']], ['’s', ['']], ['ies', ['y']], ['ied', ['y']], ['es', ['', 'e']], ['s', ['']],
    ['ing', ['', 'e']], ['ed', ['', 'e']], ['ers', ['', 'e']], ['er', ['', 'e']], ['est', ['', 'e']], ['ly', ['', 'le']],
  ];
  for (const [ending, repl] of endings) {
    if (!word.endsWith(ending)) continue;
    const base = word.slice(0, -ending.length);
    for (const tail of repl) add(base + tail);
    // A doubled consonant before -ing/-ed/-er ("planning" -> "plan").
    if (/(ing|ed|er|ers|est)$/.test(ending) && /([b-df-hj-np-tv-z])\1$/.test(base)) add(base.slice(0, -1));
  }
  return out;
}

/** Whether `word` (lowercase) is a list word or a plain inflection of one or of a `extra` word. */
export function isKnownWord(word: string, extra: ReadonlySet<string> = new Set()): boolean {
  if (extra.has(word) || inWordList(word)) return true;
  return stemsOf(word).some((stem) => extra.has(stem) || inWordList(stem));
}

/** The first list word that `prefix` (lowercase) is a strict prefix of, or `undefined`. */
export function completionOf(prefix: string): string | undefined {
  const list = load().sorted;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid]! <= prefix) low = mid + 1; else high = mid;
  }
  const next = list[low];
  return next !== undefined && next.length > prefix.length && next.startsWith(prefix) ? next : undefined;
}
