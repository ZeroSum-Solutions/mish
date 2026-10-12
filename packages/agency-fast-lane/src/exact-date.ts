/**
 * The deterministic check for an `x-verify: 'exact-date'` slot (`spine.ts`'s `exactDatePathsFor`):
 * a dedicated date slot — halcyon's event dates — whose value must be a WHOLE date expression the
 * brief itself writes. Fail-closed by design (PR #136 round 3; rounds 1-2 patched a brief-side
 * date regex edge by edge and each round found a new edge):
 *
 * 1. The value must itself be one date: an optional weekday, a day and a month in either order,
 *    an optional year (`VALUE_DATE_RE`, ASCII only). Anything else flags.
 * 2. Every occurrence of the value in the brief is found, folding ONLY ASCII letter case and runs
 *    of ASCII whitespace. No NFKC, no Unicode case folding: a fullwidth "Ｔｈｕ", a circled "②" or
 *    a U+FEFF inside the value never matches.
 * 3. An occurrence counts only when BOTH edges pass an ALLOWLIST (PR #136 round 4, after Opus
 *    found that rounds 1-3's list of forbidden connectors always missed one: tilde, arrow,
 *    fullwidth hyphen, "plus", "or", a bracketed or apostrophe year). Right edge
 *    (`rightEdgeAllowed`), after skipping whitespace, Unicode spaces/separators and format chars:
 *    only (a) the end of the text, (b) sentence punctuation or a closing bracket/quote not followed
 *    by a year or date, or (c) a time or dash-joined time range that itself ends at (a) or (b).
 *    Anything else — any word ("onwards", "or"), any connector, an opening bracket, a number —
 *    rejects. Left edge (`leftEdgeAllowed`): nothing may touch the value, and the clause before it
 *    (back to the previous sentence end) may hold no digit, time, weekday or month; ordinary words
 *    ("Late opening on") may precede a date.
 * 4. A time is a colon form ("17:00") or an am/pm form ("7pm", "7 p.m."); a dotted number
 *    ("10.11") is never a time. "Thu 2 Oct, 17:00-21:00;" and "Thu 2 Oct. 7pm start." pass
 *    "Thu 2 Oct"; "Sat 4 Oct 10:00 – Sun 5 Oct" and "Workshops 2 Oct 7pm, 9 Oct 7pm" do not.
 * 5. A month period is part of the value only inside it ("Oct. 2, 2025"); a value never ends in a
 *    period, so "Opening Thu 2 Oct." licenses "Thu 2 Oct" and never "Thu 2 Oct.".
 *
 * This replaces, for these slots only, the prose word-trace, which can never pass a verbatim
 * abbreviated date (page-side calendar expansion, g6-sol-r11); those slots skip only the two prose
 * checks, and Jev and the claim-number check still see them.
 *
 * Qualifier loss (Sol ruling 6): "Opening Thu 2 Oct, TBC" licenses "Thu 2 Oct" — the rest of the
 * clause holds no date or numeral, so the allowlist accepts it. That drops the brief's uncertainty,
 * not part of the date; Jev sees the brief and the slot and judges that change.
 *
 * Known limit (PR #136 round 1, Opus F2; Sol ruling 3 reviewed this path and named no change): a
 * whole date the brief writes passes in ANY event's date slot, whichever event the brief gives it
 * to. Which event a fact belongs to is checked by no deterministic gate in this package — the
 * prose trace is a bag of words — and stays with Jev. On main these abbreviated dates always
 * flagged and were repaired to null; a wrong-event date can now publish only if Jev misses it.
 * Also (Opus round-2 N1): a brief phrase that merely looks like a date ("Hall 2 may be closed")
 * can license the value "2 may"; the prose trace on main passes that value too, and Jev sees it.
 */

import type { FaithfulnessSlot, FlaggedSlot } from './jev.ts';

const WEEKDAY = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY = '(?:[0-3]?[0-9](?:st|nd|rd|th)?)';
const YEAR = '(?:[0-9]{4})';

/** The whole canonical value: one date and nothing else. A month period belongs to the value only
 * inside it ("Oct. 2"); a value never ends in a period (a sentence period is not part of a month). */
const VALUE_DATE_RE = new RegExp(`^(?:${WEEKDAY}\\.?,? )?(?:${DAY} ${MONTH}|${MONTH}\\.? ${DAY})(?:,? ${YEAR})?$`);

/** Characters that continue a token when they touch the value directly. */
const TOUCHING_RE = /[\p{L}\p{N}\p{M}\p{Cf}]/u;
/** Anything an edge check may skip over: whitespace, Unicode spaces/separators, format chars. */
const GAP_RE = /[\s\p{Z}\p{Cf}]/u;
/** A time: a colon form ("17:00", "7:30pm") or an am/pm form ("7pm", "7.30pm", "7 p.m."). A bare
 * dotted number ("10.11") is never a time: it may be a date. */
const TIME = '(?:[0-9]{1,2}:[0-9]{2}(?:[\\s\\p{Z}]?(?:am|pm|a\\.m\\.|p\\.m\\.))?|[0-9]{1,2}(?:[.:][0-9]{2})?[\\s\\p{Z}]?(?:am|pm|a\\.m\\.|p\\.m\\.))(?![\\p{L}\\p{N}])';
/** A time or a time range joined by a dash only ("17:00-21:00", "10am–6pm"). */
const TIME_RANGE = `${TIME}(?:[\\s\\p{Z}]*[-\\u2013\\u2014][\\s\\p{Z}]*${TIME})?`;
const TIME_RANGE_AT_RE = new RegExp(TIME_RANGE, 'uy');
const TIME_RANGE_ALL_RE = new RegExp(TIME_RANGE, 'gu');
/** Anything date-like inside a clause: a numeral in ANY script (\p{N}: ASCII, fullwidth "２０２５",
 * Persian "۲۰۲۵", Arabic-Indic "٢٠٢٥", circled "②", …), a weekday or a month word (Sol ruling 6).
 * The brief-side patterns that RECOGNIZE something as harmless (`TIME`) stay ASCII on purpose: a
 * non-ASCII time is not recognized, so it counts as a numeral here and rejects (fail-closed). The
 * VALUE patterns (`DAY`, `YEAR`, `VALUE_DATE_RE`) stay ASCII too: a value in any other digits flags. */
const DATE_TOKEN_RE = new RegExp(`\\p{N}|(?<![\\p{L}])(?:${WEEKDAY}|${MONTH})(?![\\p{L}])`, 'u');
const DATE_TOKEN_AT_RE = new RegExp(`\\p{N}|(?:${WEEKDAY}|${MONTH})(?![\\p{L}])`, 'uy');
/** Sentence ends: a clause scan stops here. A blank line ends a clause too. */
const STRONG_END_RE = /[.;!?]|\n[ \t]*\n/u;
const STRONG = new Set(['.', ';', '!', '?']);
/** Clause punctuation and closing brackets/quotes that may follow a date on its right. */
const WEAK = new Set([',', ':', ')', ']', '}', '"', "'", '”', '’', '»']);

function skipGap(text: string, at: number): number {
  let i = at;
  while (i < text.length && GAP_RE.test(text[i]!)) i += 1;
  return i;
}

/** `text` with every time and time range replaced by "0" — still a date token for the left scan,
 * and its own periods ("p.m.") no longer end a clause. */
function timesMarked(text: string): string {
  return text.replace(TIME_RANGE_ALL_RE, '0');
}

/**
 * The ALLOWLIST right edge (PR #136 round 4, Opus r3 B1/B2, Sol ruling 5). After the gap, the
 * occurrence counts only when the next thing is:
 *   (a) the end of the text; or
 *   (b) sentence punctuation or a closing bracket/quote that is not followed by a year or date —
 *       after a sentence end (. ; ! ?) the next token must not be a digit, weekday or month unless
 *       it is a time; after a comma, colon or closing bracket/quote the rest of the clause (to the
 *       next sentence end), with its times removed, must hold no digit, weekday or month; or
 *   (c) a time or time range ("17:00-21:00", "10am–6pm") that itself ends at (a) or (b).
 * Anything else — a word, a connector of any kind, an opening bracket, another date — rejects.
 */
function rightEdgeAllowed(text: string, end: number): boolean {
  if (end < text.length && TOUCHING_RE.test(text[end]!)) return false;
  let i = skipGap(text, end);
  if (i >= text.length) return true;
  TIME_RANGE_AT_RE.lastIndex = i;
  const time = TIME_RANGE_AT_RE.exec(text);
  if (time) {
    const after = i + time[0].length;
    if (after < text.length && TOUCHING_RE.test(text[after]!)) return false;
    i = skipGap(text, after);
    if (i >= text.length) return true;
  }
  const char = text[i]!;
  if (STRONG.has(char)) {
    let j = i + 1;
    while (j < text.length && (STRONG.has(text[j]!) || WEAK.has(text[j]!) || GAP_RE.test(text[j]!))) j += 1;
    if (j >= text.length) return true;
    TIME_RANGE_AT_RE.lastIndex = j;
    if (TIME_RANGE_AT_RE.test(text)) return true;
    DATE_TOKEN_AT_RE.lastIndex = j;
    return !DATE_TOKEN_AT_RE.test(text);
  }
  if (WEAK.has(char)) {
    // Times removed (they may follow a date in its own clause); every other digit still counts.
    const rest = text.slice(i + 1).replace(TIME_RANGE_ALL_RE, ' ');
    const clause = rest.split(STRONG_END_RE)[0] ?? '';
    return !DATE_TOKEN_RE.test(clause);
  }
  return false;
}

/**
 * The left edge, mirrored: nothing may touch the value, and the clause before it (back to the
 * previous sentence end or blank line, times counted as date tokens) must hold no digit, weekday
 * or month — so "Sat 4 Oct 10am to Sun 5 Oct", "Thu 2 Oct plus Fri 3 Oct", "7pm, Thu 2 Oct" and
 * "2~4 Oct" all reject for the later date. Ordinary words ("Late opening on") may precede a date.
 */
function leftEdgeAllowed(text: string, start: number): boolean {
  if (start === 0) return true;
  if (TOUCHING_RE.test(text[start - 1]!)) return false;
  const before = timesMarked(text.slice(0, start));
  const parts = before.split(STRONG_END_RE);
  return !DATE_TOKEN_RE.test(parts[parts.length - 1] ?? '');
}

const ASCII_UPPER_RE = /[A-Z]/g;
const ASCII_WS_RUN_RE = /[ \t\n\r\f\v]+/g;

/** ASCII letters lowercased and ASCII whitespace runs collapsed to one space; nothing else. */
function canonical(text: string): string {
  return text.replace(ASCII_UPPER_RE, (letter) => letter.toLowerCase()).replace(ASCII_WS_RUN_RE, ' ').replace(/^ | $/g, '');
}

/** A pattern matching `value` (already canonical) in the ASCII-lowercased brief: each space may be
 * any run of ASCII whitespace; every other character must be itself. */
function occurrencePattern(value: string): RegExp {
  const escaped = value.split(' ').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\t\\n\\r\\f\\v]+');
  return new RegExp(escaped, 'g');
}

/** Whether `value` is a whole date expression the brief writes (see the module doc). */
export function isWholeBriefDate(brief: string, value: string): boolean {
  const wanted = canonical(value);
  if (!VALUE_DATE_RE.test(wanted)) return false;
  const text = brief.replace(ASCII_UPPER_RE, (letter) => letter.toLowerCase());
  const pattern = occurrencePattern(wanted);
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (leftEdgeAllowed(text, start) && rightEdgeAllowed(text, end)) return true;
    pattern.lastIndex = start + 1;
  }
  return false;
}

/** Flags every `paths` slot whose value is not a whole date expression the brief writes. */
export function deterministicExactDateFlags(brief: string, slots: readonly FaithfulnessSlot[], paths: ReadonlySet<string>): FlaggedSlot[] {
  if (paths.size === 0) return [];
  return slots.filter((slot) => paths.has(slot.path) && !isWholeBriefDate(brief, slot.text)).map((slot) => ({ path: slot.path, probability: 1 }));
}
