/**
 * The hours-row gate (`x-verify: 'hours-label'` and `x-verify: 'hours-null'`, see `spine.ts`).
 * FAIL CLOSED, VERBATIM, MECHANICAL (PR #137 rulings after rounds 2 and 3).
 *
 * History. G8 final (restaurant x Cerebras on 1f9dd02242): a repair wrote "Weekdays / Weekend /
 * Closed" for a brief open Tuesday-Saturday, and every gate passed it. Three review rounds then
 * showed that any gate which interprets free-form schedules, or keeps part of a clause it could not
 * read, publishes false rows. So nothing here interprets a schedule, and any doubt empties the row
 * set (the page then shows no hours rather than wrong hours).
 *
 * The rule.
 * 1. Clauses. A sentence that STARTS with "Hours:", "Opening hours:" or "Open:" (any case) is an
 *    opening-hours clause, up to the end of that sentence. "a.m." / "p.m." never end a sentence. A
 *    clause is dropped when it may be cut short: its sentence ends in a one-letter or abbreviation
 *    word, or the next sentence starts in lower case or with a digit.
 * 2. Rows. The clause is split at "," and ";". A piece is a clean row only when it is exactly
 *    `<days> <status>` or `closed|shut <days>`: ONE day phrase as the brief writes it, and a status
 *    with no day word. If ANY non-empty piece is not a clean row, the WHOLE clause gives no rows
 *    ("Monday-Saturday 9am-5pm, but Thursday until 8pm" gives none, not the first half).
 * 3. Slots. A day label (`x-hours-value` names its value slot) must equal one row's days, and its
 *    value that SAME row's status. A combined slot must equal the row's exact text, or its days +
 *    ", " or " | " + its status. Equality folds ASCII case and whitespace runs only.
 * 4. Groups (`x-hours-group`: restaurant's table, practice's rows, halcyon's visit block and
 *    footer, wrenfield's hours). A group shows EVERY row of the clause in the brief's order, or
 *    none: a missing, extra, repeated or reordered row flags every shown row of the group.
 * 5. `x-verify: 'hours-null'` (halcyon's hero rail values): always null. The rail never shows hours;
 *    the visit block and footer do.
 *
 * Main's grounded-anywhere day rule stays as an extra condition (it can only ADD a flag), and
 * `run.ts` still runs the proper-noun gate on these slots. A value slot that is null drops its row
 * from the page, so its label is not checked here.
 */

import type { FaithfulnessSlot, FlaggedSlot } from './jev.ts';
import { porterStem } from './porter-stemmer.ts';

const FULL_ALT = 'mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|weekdays?|weekends?|daily|every\\s?day|holidays?';
const ABBREVIATION_ALT = 'thurs|thur|tues|mon|tue|wed|thu|fri|sat|sun';
/** One day word. Only an abbreviation may carry a period ("Mon."). */
const DAY_ALT = `(?:${FULL_ALT})\\b|(?:${ABBREVIATION_ALT})\\b\\.?`;
/** Separators inside one day phrase: a range ("-", "to", "through") or a list ("and", ","). */
const SEP_ALT = '\\s*(?:-|–|—|\\/|&|,\\s*and|,)\\s*|\\s+(?:to|through|thru|until|till|and|or)\\s+';
const DAY_PHRASE = new RegExp(`\\b(?:${DAY_ALT})(?:(?:${SEP_ALT})\\b(?:${DAY_ALT}))*`, 'gi');
/** A clause label at the very start of a sentence. */
const CLAUSE_LABEL = /^(?:opening hours|hours|open):\s*/i;
const CLOSING_WORD = /^(?:closed|shut)(?:\s+on)?$/i;
/** Words that may end in a period without ending the sentence: a clause ending on one of these may
 * be cut short, so it is dropped. */
const ABBREVIATED_END = /(?:^|\s)(?:[a-z]|[a-z]\.[a-z]|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|st|ave|rd|dr|mr|mrs|ms|no|approx|etc|incl|vs|e\.g|i\.e)$/i;

/** ASCII case and whitespace runs folded; nothing else. */
export function foldHours(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export type BriefHoursRow = { days: string; status: string; text: string };

/** Sentence spans of `text` ([start, end) with `end` at the mark). "a.m." / "p.m." end nothing. */
function sentences(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?](?=\s|$)/g)) {
    const at = match.index!;
    if (/\b[ap]\.m$/i.test(text.slice(Math.max(0, at - 4), at))) continue;
    out.push({ start, end: at });
    start = at + 1;
  }
  if (text.slice(start).trim()) out.push({ start, end: text.length });
  return out;
}

/** One clause piece as a clean row (module doc, rule 2), or null. */
function cleanRow(piece: string): BriefHoursRow | null {
  const phrases = [...piece.matchAll(DAY_PHRASE)];
  if (phrases.length !== 1) return null;
  const phrase = phrases[0]!;
  const days = phrase[0].trim();
  const before = piece.slice(0, phrase.index!).trim();
  const after = piece.slice(phrase.index! + phrase[0].length).trim();
  if (before === '' && after !== '') return { days, status: after, text: piece };
  if (CLOSING_WORD.test(before) && after === '') return { days, status: before, text: piece };
  return null;
}

/**
 * The rows of the brief's explicit opening-hours clauses (module doc, rules 1-2), verbatim, in
 * brief order. A clause with any unclean piece, or one that may be cut short, gives no rows.
 */
export function briefHoursClauseRows(brief: string): BriefHoursRow[] {
  const text = brief.replace(/\s+/g, ' ');
  const spans = sentences(text);
  const out: BriefHoursRow[] = [];
  spans.forEach((span, index) => {
    const sentence = text.slice(span.start, span.end).trim();
    const label = CLAUSE_LABEL.exec(sentence);
    if (!label) return;
    const body = sentence.slice(label[0].length);
    // Possibly cut short: an abbreviation-like last word, or a next sentence that starts in lower
    // case or with a digit (the "." was not a sentence end).
    const next = spans[index + 1] ? text.slice(spans[index + 1]!.start, spans[index + 1]!.end).trim() : '';
    if (ABBREVIATED_END.test(body.trim()) || /^[a-z0-9]/.test(next)) return;
    const pieces = body.split(/[,;]/).map((piece) => piece.trim()).filter((piece) => piece !== '');
    const rows = pieces.map(cleanRow);
    if (rows.length === 0 || rows.some((row) => row === null)) return;
    out.push(...(rows as BriefHoursRow[]));
  });
  return out;
}

/** The forms a combined slot may take for one row (module doc, rule 3), folded. */
function combinedForms(row: BriefHoursRow): Set<string> {
  return new Set([row.text, `${row.days}, ${row.status}`, `${row.days} | ${row.status}`].map(foldHours));
}

/**
 * G8 final on 857a46b982 (halcyon x cerebras VERIFY_FAILED, root cause): a live fill that reorders
 * a status-first brief row ("closed Monday and Tuesday") to days first, to match a column's other
 * day-first rows, recurringly wrote `<days> <status>` with a bare space — never the `<days>,
 * <status>` comma form `combinedForms` accepts for exactly that reorder — no matter how the prompt
 * or repair hint spelled the rule out (both were also fixed, see their own docblocks). A bare-space
 * day-first answer states the SAME days and the SAME status as the row it reordered; only its
 * punctuation is wrong. This inserts the missing comma, never touching a day, a status, or which
 * row a slot names, so `deterministicHoursLabelFlags` and Jev both then check the exact text this
 * returns — never a laxer rule and nothing this fails to normalize gets a second chance.
 *
 * Returns `text` unchanged when it already matches an accepted form, or when it does not look like
 * `<days> <status>` for exactly one brief row (nothing to safely correct).
 */
export function normalizeHoursRowSeparator(brief: string, text: string): string {
  const rows = briefHoursClauseRows(brief);
  if (rows.some((row) => combinedForms(row).has(foldHours(text)))) return text;
  const phrases = [...text.matchAll(DAY_PHRASE)];
  if (phrases.length !== 1) return text;
  const phrase = phrases[0]!;
  const before = text.slice(0, phrase.index!).trim();
  const after = text.slice(phrase.index! + phrase[0].length).trim();
  if (before !== '' || after === '') return text;
  const days = phrase[0];
  const match = rows.find((row) => foldHours(row.days) === foldHours(days) && foldHours(row.status) === foldHours(after));
  return match === undefined ? text : `${days}, ${after}`;
}

/**
 * The rule this gate had on main (1f9dd02242), kept as an extra condition that can only ADD a
 * flag: every day the label names must be a day the brief names somewhere, and a group word must
 * be grounded (the literal word, or: weekend = Saturday and Sunday named, weekday = all five
 * weekdays named, daily = all seven named; holiday only by the word).
 */
const OLD_DAY_TOKEN = /\b(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|weekday|weekend|daily|holiday)\b/gi;
const OLD_CANONICAL: Readonly<Record<string, string>> = {
  mon: 'mon', monday: 'mon', tue: 'tue', tues: 'tue', tuesday: 'tue', wed: 'wed', wednesday: 'wed',
  thu: 'thu', thur: 'thu', thurs: 'thu', thursday: 'thu', fri: 'fri', friday: 'fri', sat: 'sat', saturday: 'sat',
  sun: 'sun', sunday: 'sun', weekday: 'weekday', weekend: 'weekend', daily: 'daily', holiday: 'holiday',
};
function oldDayTokens(text: string): Set<string> {
  return new Set([...text.matchAll(OLD_DAY_TOKEN)].map((match) => OLD_CANONICAL[match[0].toLowerCase()]!));
}
function groundedAnywhere(brief: string, label: string): boolean {
  const briefDays = oldDayTokens(brief);
  // The same word tokens main's `allWordTokensOf` read: NFKC, typographic apostrophes folded.
  const words = [...brief.normalize('NFKC').replace(/(?<=\p{L})[‘’ʼ](?=\p{L})/gu, "'").matchAll(/[a-zA-Z][a-zA-Z']*/g)].map((match) => match[0].toLowerCase());
  const briefStems = new Set(words.map((word) => porterStem(word)));
  const literal = (word: string) => briefStems.has(porterStem(word));
  return [...oldDayTokens(label)].every((token) => {
    if (token === 'weekend') return literal(token) || (briefDays.has('sat') && briefDays.has('sun'));
    if (token === 'weekday') return literal(token) || ['mon', 'tue', 'wed', 'thu', 'fri'].every((day) => briefDays.has(day));
    if (token === 'daily') return literal(token) || ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].every((day) => briefDays.has(day));
    if (token === 'holiday') return literal(token);
    return briefDays.has(token);
  });
}

/**
 * Flags every hours-label slot that is not a verbatim copy of one brief hours row, and every shown
 * row of a group that does not show all rows in order (module doc, rules 3-4). `rowValuePaths`
 * maps a label to its value slot (`x-hours-value`); `valueAt` reads a path from the current recipe
 * (the value may be template chrome, absent from `slots`); `groups` lists each group's label paths
 * in page order (`x-hours-group`). A label with no value slot is a combined row.
 */
export function deterministicHoursLabelFlags(
  brief: string,
  slots: readonly FaithfulnessSlot[],
  hoursLabelPaths: ReadonlySet<string>,
  rowValuePaths: ReadonlyMap<string, string> = new Map(),
  valueAt: (path: string) => string | null | undefined = () => undefined,
  groups: ReadonlyMap<string, readonly string[]> = new Map(),
): FlaggedSlot[] {
  const rows = briefHoursClauseRows(brief);
  const slotText = new Map(slots.map((slot) => [slot.path, slot.text]));
  const read = (path: string) => {
    const value = valueAt(path);
    return value === undefined ? slotText.get(path) : value;
  };
  const flagged = new Set<string>();
  // The row index each SHOWN hours slot copies, or -1; a slot whose row is hidden is absent.
  const shownRow = new Map<string, number>();
  for (const slot of slots) {
    if (!hoursLabelPaths.has(slot.path)) continue;
    const label = foldHours(slot.text);
    let index: number;
    const valuePath = rowValuePaths.get(slot.path);
    if (valuePath !== undefined) {
      const value = read(valuePath);
      // A null value drops the whole row from the page (the renderer prints a row only when its
      // value is non-null); the label still faces every other gate.
      if (value === null) continue;
      const folded = foldHours(value ?? '');
      index = rows.findIndex((row) => foldHours(row.days) === label && foldHours(row.status) === folded);
    } else {
      index = rows.findIndex((row) => combinedForms(row).has(label));
    }
    shownRow.set(slot.path, index);
    if (index < 0 || !groundedAnywhere(brief, slot.text)) flagged.add(slot.path);
  }
  // Rule 4: a group shows every row, in order, or none.
  for (const members of groups.values()) {
    const shown = members.filter((path) => shownRow.has(path));
    if (shown.length === 0) continue;
    const inOrder = shown.length === rows.length && shown.every((path, index) => shownRow.get(path) === index);
    if (!inOrder) for (const path of shown) flagged.add(path);
  }
  return [...flagged].map((path) => ({ path, probability: 1 }));
}

/** Flags every `x-verify: 'hours-null'` slot that is not null (module doc, rule 5). A null value is
 * not in `slots`, so only a filled one flags. */
export function deterministicHoursNullFlags(slots: readonly FaithfulnessSlot[], hoursNullPaths: ReadonlySet<string>): FlaggedSlot[] {
  return slots.filter((slot) => hoursNullPaths.has(slot.path)).map((slot) => ({ path: slot.path, probability: 1 }));
}

/** The brief's hours rows as the prompt and the repair hint quote them: `"days" | "status"`. */
export function briefHoursRowsForHint(brief: string): string[] {
  return briefHoursClauseRows(brief).map((row) => `"${row.days}" | "${row.status}"`);
}
