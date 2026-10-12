/**
 * The classic Porter stemming algorithm (M.F. Porter, "An algorithm for suffix stripping",
 * Program, 1980) — a well-known, independently verifiable suffix-stripping algorithm, not a
 * hand-rolled heuristic. `jev.ts`'s `deterministicQuoteFlags` uses it (via `porterStem`) to
 * compare a review quote's words against a brief's own words: an earlier ad-hoc stemmer here
 * blindly stripped "-ing"/"-ed" and always accepted the result as a match, which meant "staring"/
 * "stared" both collapsed to "star" — the SAME string a genuine star-rating claim token normalizes
 * to — so a quote's rating claim could false-pass just because some unrelated word in the brief
 * happened to share that stripped prefix. Porter's algorithm applies real linguistic rules
 * (consonant-vowel measure, cvc/double-consonant checks, staged suffix rules) rather than a single
 * blind strip, which is far less prone to that kind of coincidental collision — but it can still
 * happen for short, orthographically similar words, which is exactly why `jev.ts` ALSO keeps a
 * hard-coded commercial-word denylist requiring an exact (non-stemmed) match for words like
 * "stock" and "star" specifically: a well-known general-purpose stemmer plus a small list of
 * always-exact commercial terms closes the bug class more completely than either alone.
 *
 * This is a direct, compact port of the published algorithm — every step below corresponds to the
 * paper's own step numbering (1a, 1b, 1c, 2, 3, 4, 5a, 5b). Verified against the paper's own
 * worked examples in `tests/porter-stemmer.test.ts`.
 */

const VOWEL = /[aeiou]/;

/** True when the character at `index` is a consonant — 'y' counts as a consonant only when the
 * preceding character is a vowel (the paper's own rule: "y" is a vowel when a consonant precedes
 * it in the stem, i.e. "toy", "syzygy"). */
function isConsonant(word: string, index: number): boolean {
  const ch = word[index]!;
  if (VOWEL.test(ch)) return false;
  if (ch !== 'y') return true;
  return index === 0 || !isConsonant(word, index - 1);
}

/** The paper's "measure" m: the number of consonant-vowel sequences following the initial
 * (possibly empty) consonant sequence, i.e. [C](VC){m}[V]. */
function measure(word: string): number {
  let m = 0;
  let i = 0;
  const n = word.length;
  while (i < n && isConsonant(word, i)) i++;
  while (i < n) {
    while (i < n && !isConsonant(word, i)) i++;
    if (i >= n) break;
    while (i < n && isConsonant(word, i)) i++;
    m++;
  }
  return m;
}

function containsVowel(word: string): boolean {
  for (let i = 0; i < word.length; i++) if (!isConsonant(word, i)) return true;
  return false;
}

/** Ends in a double consonant (e.g. "-tt", "-ss"). */
function endsWithDoubleConsonant(word: string): boolean {
  const n = word.length;
  if (n < 2) return false;
  return word[n - 1] === word[n - 2] && isConsonant(word, n - 1);
}

/** Ends consonant-vowel-consonant, where the final consonant is not w, x or y (the paper's own
 * exception, e.g. "-wil", "-hop" qualify; "-ow", "-wx", "-wy" do not). */
function endsCVC(word: string): boolean {
  const n = word.length;
  if (n < 3) return false;
  const last = word[n - 1]!;
  return isConsonant(word, n - 3) && !isConsonant(word, n - 2) && isConsonant(word, n - 1) && !['w', 'x', 'y'].includes(last);
}

function replaceSuffix(word: string, suffix: string, replacement: string): string {
  return word.slice(0, word.length - suffix.length) + replacement;
}

/** Applies the first matching {suffix, condition, replacement} rule, where `condition` receives
 * the STEM (word with the suffix removed) and must return true for the rule to fire. Rules are
 * tried longest-suffix-first within each call, matching the paper's own tie-breaking. */
function applyRules(word: string, rules: Array<[string, (stem: string) => boolean, string]>): string {
  for (const [suffix, condition, replacement] of rules) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, word.length - suffix.length);
      if (condition(stem)) return stem + replacement;
      return word;
    }
  }
  return word;
}

function step1a(word: string): string {
  if (word.endsWith('sses')) return replaceSuffix(word, 'sses', 'ss');
  if (word.endsWith('ies')) return replaceSuffix(word, 'ies', 'i');
  if (word.endsWith('ss')) return word;
  if (word.endsWith('s') && !word.endsWith('us') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function step1b(word: string): string {
  let stem: string;
  let fired = false;
  if (word.endsWith('eed')) {
    stem = word.slice(0, -3);
    return measure(stem) > 0 ? `${stem}ee` : word;
  }
  if (word.endsWith('ed') && containsVowel(word.slice(0, -2))) { stem = word.slice(0, -2); fired = true; }
  else if (word.endsWith('ing') && containsVowel(word.slice(0, -3))) { stem = word.slice(0, -3); fired = true; }
  else return word;
  if (!fired) return word;
  if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) return `${stem}e`;
  if (endsWithDoubleConsonant(stem) && !/[lsz]$/.test(stem)) return stem.slice(0, -1);
  if (measure(stem) === 1 && endsCVC(stem)) return `${stem}e`;
  return stem;
}

function step1c(word: string): string {
  if (word.endsWith('y') && containsVowel(word.slice(0, -1))) return `${word.slice(0, -1)}i`;
  return word;
}

const STEP2_RULES: Array<[string, (stem: string) => boolean, string]> = [
  ['ational', (s) => measure(s) > 0, 'ate'], ['tional', (s) => measure(s) > 0, 'tion'],
  ['enci', (s) => measure(s) > 0, 'ence'], ['anci', (s) => measure(s) > 0, 'ance'],
  ['izer', (s) => measure(s) > 0, 'ize'], ['abli', (s) => measure(s) > 0, 'able'],
  ['alli', (s) => measure(s) > 0, 'al'], ['entli', (s) => measure(s) > 0, 'ent'],
  ['eli', (s) => measure(s) > 0, 'e'], ['ousli', (s) => measure(s) > 0, 'ous'],
  ['ization', (s) => measure(s) > 0, 'ize'], ['ation', (s) => measure(s) > 0, 'ate'],
  ['ator', (s) => measure(s) > 0, 'ate'], ['alism', (s) => measure(s) > 0, 'al'],
  ['iveness', (s) => measure(s) > 0, 'ive'], ['fulness', (s) => measure(s) > 0, 'ful'],
  ['ousness', (s) => measure(s) > 0, 'ous'], ['aliti', (s) => measure(s) > 0, 'al'],
  ['iviti', (s) => measure(s) > 0, 'ive'], ['biliti', (s) => measure(s) > 0, 'ble'],
];

const STEP3_RULES: Array<[string, (stem: string) => boolean, string]> = [
  ['icate', (s) => measure(s) > 0, 'ic'], ['ative', (s) => measure(s) > 0, ''],
  ['alize', (s) => measure(s) > 0, 'al'], ['iciti', (s) => measure(s) > 0, 'ic'],
  ['ical', (s) => measure(s) > 0, 'ic'], ['ful', (s) => measure(s) > 0, ''],
  ['ness', (s) => measure(s) > 0, ''],
];

const STEP4_RULES: Array<[string, (stem: string) => boolean, string]> = [
  ['al', (s) => measure(s) > 1, ''], ['ance', (s) => measure(s) > 1, ''], ['ence', (s) => measure(s) > 1, ''],
  ['er', (s) => measure(s) > 1, ''], ['ic', (s) => measure(s) > 1, ''], ['able', (s) => measure(s) > 1, ''],
  ['ible', (s) => measure(s) > 1, ''], ['ant', (s) => measure(s) > 1, ''], ['ement', (s) => measure(s) > 1, ''],
  ['ment', (s) => measure(s) > 1, ''], ['ent', (s) => measure(s) > 1, ''],
  ['ion', (s) => measure(s) > 1 && (s.endsWith('s') || s.endsWith('t')), ''],
  ['ou', (s) => measure(s) > 1, ''], ['ism', (s) => measure(s) > 1, ''], ['ate', (s) => measure(s) > 1, ''],
  ['iti', (s) => measure(s) > 1, ''], ['ous', (s) => measure(s) > 1, ''], ['ive', (s) => measure(s) > 1, ''],
  ['ize', (s) => measure(s) > 1, ''],
];

function step5a(word: string): string {
  if (!word.endsWith('e')) return word;
  const stem = word.slice(0, -1);
  if (measure(stem) > 1) return stem;
  if (measure(stem) === 1 && !endsCVC(stem)) return stem;
  return word;
}

function step5b(word: string): string {
  if (measure(word) > 1 && endsWithDoubleConsonant(word) && word.endsWith('l')) return word.slice(0, -1);
  return word;
}

/** The full Porter stem of one lowercase alphabetic word. Words of 2 letters or fewer are
 * returned unchanged (the paper's own algorithm is undefined/unstable below that length, and
 * there is nothing meaningful left to strip). */
export function porterStem(input: string): string {
  const word = input.toLowerCase();
  if (word.length <= 2) return word;
  let w = step1a(word);
  w = step1b(w);
  w = step1c(w);
  w = applyRules(w, STEP2_RULES);
  w = applyRules(w, STEP3_RULES);
  w = applyRules(w, STEP4_RULES);
  w = step5a(w);
  w = step5b(w);
  return w;
}
