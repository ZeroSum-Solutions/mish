/**
 * The one prompt the fast lane uses. The model receives the client brief, a text-only template
 * cut from the spine, a limits object of the same shape, and — where the family marks slots
 * nullable — an atom-kinds object naming the values it may answer with null instead of a fact
 * the brief does not state — and, where the family marks slots as illustrative sample data, a
 * sample object naming them. It returns the template filled. It never asks the model to supply a
 * fact the brief lacks: an unstated fact is null or neutral wording, never an invented value. A
 * SAMPLE value is not a fact: the page shows it under a fixed sample-data caption, so the model
 * writes an example there instead of leaving it empty. A value that is neither a fact nor a
 * sample (a heading, a label, a blurb) is never left empty either: it gets neutral wording.
 */

import { briefHoursRowsQuote } from './repair-hints.ts';
import type { Json } from './spine.ts';

export const SYSTEM_PROMPT =
  'You write website copy into a fixed JSON template for one client. Reply with exactly one JSON object and nothing else: no prose, no Markdown fences.';

/**
 * The fill prompt's rule for claim-bearing sentences (see `buildUserPrompt`). The word list is the
 * plain-language face of `jev.ts`'s `COMMERCIAL_STEM_WORDS`, number-word, distance and award
 * signals: a sentence with any of them must reuse the brief's own words.
 */
export const CLAIM_SENTENCE_RULE = '- Every sentence that states a number, count, percentage, price, date, time, distance, rating or award, or uses a sales word (free, price, cost, order, ship, delivery, return, refund, stock, sale, discount, gift, warranty, available, limited), is checked word for word against the brief after you answer. Write such a sentence with the brief\'s OWN words: copy the brief\'s sentence, or a shorter run of its words, and never paraphrase, summarize or swap in a synonym. If a value cannot say it in the brief\'s words, leave that number or sales word out of the value.';

/** What TEMPLATE shows in an hours-label slot instead of the reference page's own day label. No
 * day word, so a model that copies it is flagged; it appears in no eval brief. */
export const HOURS_LABEL_PLACEHOLDER = 'Days as in the brief';
/** The same, for a COMBINED hours slot that holds the days AND their hours ("Monday-Friday,
 * 7am-5pm"). PR #137 round 1: a days-only placeholder there made the model drop the hours and the
 * "closed", and publish "Monday-Tuesday" under an "Open" heading. */
export const HOURS_ROW_PLACEHOLDER = 'Days and hours as in the brief';
/** Whether `text` is (or still contains) one of the hours placeholders: a fill that leaves one in
 * place is refused as a failed answer in every verify mode, and never published. */
export function isHoursPlaceholder(text: string): boolean {
  const folded = text.toLowerCase();
  return folded.includes(HOURS_LABEL_PLACEHOLDER.toLowerCase()) || folded.includes(HOURS_ROW_PLACEHOLDER.toLowerCase());
}

/**
 * The fill rule for hours-row day labels (see `PromptInput.hoursLabels`).
 *
 * G8 final on 857a46b982 (halcyon x cerebras VERIFY_FAILED, root cause): "or its days, then \", \",
 * then its hours" read as a free-standing reorder option, with no comma requirement stated for it
 * — the model recurringly filled that gap with a bare space instead, which
 * `deterministicHoursLabelFlags` accepts only when it happens to equal the row's own word order
 * (true for a day-first brief row, false for halcyon's status-first close-days row). The rule now
 * says explicitly that the comma is required, only for that one reordering case, and that a bare
 * space there still fails.
 */
export const HOURS_LABEL_RULE = '- HOURS LABELS has the same shape as TEMPLATE and names the hours slots. Each hours row passes ONLY as an exact copy, character for character, of ONE row of the brief\'s opening-hours clause (quoted below): "hours-label" is a day label, copy that row\'s days, and its value slot copies the same row\'s hours; "hours-row" is a combined row, copy the row exactly as the brief writes it, in the brief\'s own word order (days first or status first, whichever the brief uses). The one exception: showing the days before the status when the brief\'s own row states the status first — then a comma must follow the days ("<days>, <status>"); a bare space there still fails. Rows that belong together (a table, a block, a footer list) show EVERY row of the clause, in the brief\'s order, each once, or none of them (return null for their values, where NULLABLE names them). "hours-null" is always null. TEMPLATE shows a placeholder in hours slots: never leave it. Never abbreviate, group, reword, merge or split days or hours.';

export type PromptInput = {
  brief: string;
  template: Json;
  limits?: Json;
  /** Slots that accept null, with the kind of fact each holds. Same shape as `limits`. */
  nullable?: Json;
  /** Illustrative sample-data slots (`x-mock`), marked `"sample"`. Same shape as `limits`. */
  sample?: Json;
  /**
   * Repeatable arrays that may hold fewer items than TEMPLATE shows, with the fewest real items
   * each one needs — named at the array's own position (its number, not its leaves). Same shape
   * convention as `nullable`'s group kind. Undefined: no array here is variable, and TEMPLATE's
   * own length is the only length the model may return, exactly as before this field existed.
   */
  arrayMinima?: Json;
  /**
   * Slots a family marks `x-verify: 'traceable'` (a real, short fact — a credential, an insurance
   * plan name, an hours value — never a whole descriptive paragraph), named `"traceable"`. Same
   * shape convention as `nullable`. These are checked deterministically after the fill: every word
   * of the value must trace to the brief's own vocabulary. Without this block the model has no way
   * to know which slots face that stricter bar, and reaches for its own paraphrase the same way it
   * would for ordinary free prose — a round-2 Grok audit found exactly that: a provider's
   * `credential` came back as "Provides exams, vaccinations, and minor sick visits for dogs and
   * cats" (a paraphrase of the SERVICES list, not the brief's own "DVM") and flagged as
   * untraceable. Naming these slots and asking for the brief's own words closes the gap at its
   * root, in the prompt, rather than by widening what the deterministic check accepts.
   */
  traceable?: Json;
  /**
   * Dedicated date slots a family marks `x-verify: 'exact-date'`, named `"exact-date"` (G8 dry run,
   * halcyon's event dates). Checked afterward by whole-value equality to a date the brief writes
   * (`exact-date.ts`), so the model is told to copy the brief's own date exactly, or return null.
   */
  exactDates?: Json;
  /**
   * Hours-row day labels a family marks `x-verify: 'hours-label'`, named `"hours-label"` (G8 final).
   * Checked afterward: the label's days must be exactly the days the brief gives for that row's
   * hours (`hours-label.ts`). TEMPLATE shows `HOURS_LABEL_PLACEHOLDER` there, never the reference
   * page's own labels: restaurant x Cerebras copied the reference "Tue-Thu" / "Fri-Sat" /
   * "Sun-Mon" every time, and its repair then grouped days into "Weekdays" / "Weekend".
   */
  hoursLabels?: Json;
  scope: string;
  /**
   * One line per slot naming its character limit and word budget (`text.title: at most 38
   * characters, about 6 words`). Rendered as a BUDGETS block before LIMITS, with a rule that says
   * an over-long value loses its ending. Omitted: no block, the prompt reads as before.
   */
  budgets?: string[];
  rejected?: { answer: string; error: string };
};

export function buildUserPrompt(input: PromptInput): string {
  const parts = [
    'CLIENT BRIEF',
    input.brief.trim(),
    '',
    'TASK',
    `${input.scope}. Return the TEMPLATE as a JSON object with the same keys and the same nesting${input.arrayMinima === undefined ? ', and the same array lengths' : ' (an array named in ARRAY MINIMA below may be shorter, see RULES)'}. Replace every string value with copy written for this client. Values under "id" must stay exactly as given.`,
    '',
    'RULES',
    '- Plain text only: no HTML tags, no Markdown, no entities such as &amp;, no line breaks inside a value.',
    '- LIMITS has the same shape as TEMPLATE. Each number is the maximum number of characters for that value. Stay within every limit. Short is better than long.',
    '- Alt texts describe what the image should show for this client.',
    `- Facts come only from the brief. Numbers, dates, times, prices, amounts, counts, contact details, names and quotes may appear only when the brief states them${input.sample === undefined ? '' : ' (SAMPLE values excepted, see below)'}. Where the brief gives none, never invent one: ${input.nullable === undefined ? '' : 'return null if NULLABLE names the value, otherwise '}write neutral wording that states no such fact (for example "Get in touch for details" or "Contact us for dates").`,
    // G8 dry run: every sentence carrying a claim signal is traced word for word against the brief
    // (`jev.ts`'s `deterministicSentenceClaimFlags`, unconditional for every family since G6). A
    // model that paraphrases such a sentence ("Admission covers 34% of annual costs; the rest
    // comes from donors") fails that trace even when the fact is right; telling it so here, in
    // the fill prompt, is the fix at the root — never a wider gate.
    CLAIM_SENTENCE_RULE,
    '- A brief that asks for a fact without giving it does not state it. "Show testimonials", "say how many families face eviction" or "give the next start date" states no quote, no number and no date: never write one to answer the request. The same holds for offers, discounts, prices, deadlines, results and statistics.',
    '- Copy a number, date, time, price, phone number or hours row in the SAME form the brief itself uses (its own digits, its own "8am" or "8:00 AM" style, its own separators). Reformatting a stated fact into a different notation (adding a colon, minutes, a leading zero, or changing "-" to "to") reads as a changed fact, not the same one, even when it means the same thing.',
    `- A value that is not a fact (a heading, a label, a blurb, a button text) is never empty${input.nullable === undefined ? '' : ' and never null'}: write short neutral wording grounded in the brief.`,
    '- Never mention the previous client and never write that a value is a placeholder.',
    '- Do not add or remove keys.',
    ...(input.sample === undefined ? [] : [
      '- SAMPLE has the same shape as TEMPLATE and names the values that are illustrative sample data. The page shows them under a fixed caption that says they are samples, so they are never read as facts about this client. Fill every SAMPLE value with a short, realistic example that suits this client: example figures, prices, names and dates are allowed there. Never return null or an empty string for a SAMPLE value.',
    ]),
    ...(input.budgets === undefined ? [] : [
      '- BUDGETS lists every value with its character limit and word budget. Count the characters of each value before you answer. When a value would run over, write a shorter complete phrase: fewer words or a shorter synonym. Write every word and every name in full: never shorten, abbreviate or cut a word or a product name to make it fit (not "Quick" for "QuickBooks", not "Fin" for "Finance", not "Tri" or "Thr" for "Three"). If a word or name does not fit, leave it out and use other words; a value NULLABLE names is null when no whole word fits. A value over its limit is cut at a word boundary and loses its ending.',
    ]),
    ...(input.nullable === undefined ? [] : [
      '- NULLABLE has the same shape as TEMPLATE and names the values that may be null, with the kind of fact each one holds. Return null for a fact the brief does not state; never invent phone numbers, emails, addresses, hours, awards, dates, legal names or social handles. Write the JSON literal null, not the text "null" and not an empty string. Every value NULLABLE does not name must stay a non-empty string.',
    ]),
    ...(input.traceable === undefined ? [] : [
      '- TRACEABLE has the same shape as TEMPLATE and names short, real-fact values (a credential, a plan name, an hours value) that are checked word-for-word against the brief afterward. Write these using the brief\'s OWN words and phrasing as closely as you can — do not paraphrase, summarize, or substitute a synonym, and never describe what the fact means instead of stating it. If the brief gives only a short fact ("DVM"), write exactly that short fact, not a fuller sentence about what it implies.',
    ]),
    ...(input.exactDates === undefined ? [] : [
      '- EXACT DATES has the same shape as TEMPLATE and names date values that are checked for exact equality against a date the brief writes. Copy the brief\'s own date for that item character for character, in the brief\'s own form ("Tue 14 Mar" stays "Tue 14 Mar": never "Tuesday 14 March", never add or drop a year, a weekday or a period). Put the date only there: keep dates out of every other value. Return null when NULLABLE names the value and the brief gives no date for that item.',
    ]),
    ...(input.hoursLabels === undefined ? [] : [HOURS_LABEL_RULE, `  ${briefHoursRowsQuote(input.brief)}`]),
    ...(input.arrayMinima === undefined ? [] : [
      '- For arrays named in ARRAY MINIMA, use the shortest list that covers the distinct items supplied by the brief and meets the stated minimum. Do not pad to TEMPLATE\'s length with generic filler or repeated records. A short complete list is better than a full repetitive list. Every retained fact still follows all fact, name and quote rules above.',
      '- ARRAY MINIMA has the same shape as TEMPLATE and names, at the position of each repeatable array, the fewest items you may return there. An array holds only as many items as the brief actually gives you real, distinct facts for: never invent one, split one real fact into several entries, generalize a single detail into a pattern, or repeat the SAME person, product or fact twice under different wording to reach a higher count. Cut extra items from the END of the array down to (never below) its own minimum; a minimum of 0 means the array may be empty, which drops its whole section when the section is optional. Every array NOT named in ARRAY MINIMA has no minimum at all: keep the exact length TEMPLATE shows for those.',
    ]),
    '',
    ...(input.sample === undefined ? [] : [
      'SAMPLE',
      JSON.stringify(input.sample, null, 1),
      '',
    ]),
    ...(input.nullable === undefined ? [] : [
      'NULLABLE',
      JSON.stringify(input.nullable, null, 1),
      '',
    ]),
    ...(input.traceable === undefined ? [] : [
      'TRACEABLE',
      JSON.stringify(input.traceable, null, 1),
      '',
    ]),
    ...(input.exactDates === undefined ? [] : [
      'EXACT DATES',
      JSON.stringify(input.exactDates, null, 1),
      '',
    ]),
    ...(input.hoursLabels === undefined ? [] : [
      'HOURS LABELS',
      JSON.stringify(input.hoursLabels, null, 1),
      '',
    ]),
    ...(input.arrayMinima === undefined ? [] : [
      'ARRAY MINIMA',
      JSON.stringify(input.arrayMinima, null, 1),
      '',
    ]),
    ...(input.budgets === undefined ? [] : [
      'BUDGETS',
      ...input.budgets,
      '',
    ]),
    'LIMITS',
    JSON.stringify(input.limits ?? {}, null, 1),
    '',
    'TEMPLATE',
    JSON.stringify(input.template, null, 1),
  ];
  if (input.rejected) {
    parts.push(
      '',
      'YOUR PREVIOUS ANSWER WAS REJECTED',
      input.rejected.answer.trim(),
      '',
      'VALIDATION ERROR',
      withFixHint(input.rejected.error.trim()),
      '',
      'Return the corrected complete JSON object.',
    );
  }
  return parts.join('\n');
}

/**
 * A compiler format refusal for a contact atom ("jobsEmail: invalid email", "phone: invalid
 * telephone", "expected an email address") with the fix spelled out: a model that copied the
 * atom out of a sentence usually kept the sentence's closing period, and the bare rule does not
 * tell it so. Any other message, one that already says "Fix:", and one that already mentions null
 * ("expected an email address or null") is returned unchanged.
 */
export function withFixHint(error: string): string {
  // Already carries a fix, or already offers null (whose advice the hint would repeat or
  // contradict): left as it is.
  if (/\bFix:/.test(error) || /\bnull\b/i.test(error)) return error;
  if (/invalid email|expected an email address/i.test(error)) {
    return `${error}. Fix: remove trailing punctuation (a closing period, comma or bracket) and surrounding quotes, and write only the address, such as name@example.com; use null if the slot is nullable and the brief states no email.`;
  }
  if (/invalid telephone|expected a phone number/i.test(error)) {
    return `${error}. Fix: remove trailing punctuation (a closing period, comma or bracket) and any words, and write only the number as the brief states it; use null if the slot is nullable and the brief states no phone number.`;
  }
  return error;
}
