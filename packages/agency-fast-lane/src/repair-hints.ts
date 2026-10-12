/**
 * Repair guidance for a flagged slot (G8 dry run). The old repair instruction asked the model to
 * "delete, null or neutrally reword" a flagged value and named nothing else; for a claim-bearing
 * sentence a neutral reword is just another untraced paraphrase, so the repair round flagged
 * again and did not converge in two rounds (maren, maben, nonprofit, storefront). This names what
 * the gate actually wants instead: the exact words the brief does not contain, and the brief's own
 * sentence(s) closest to the flagged value, to copy from.
 *
 * Guidance only. Nothing here decides whether a slot passes; the next check still runs every gate
 * on the repaired value exactly as before.
 */

import { briefHoursRowsForHint } from './hours-label.ts';
import { claimTraceGaps } from './jev.ts';

const MAX_QUOTED_SENTENCES = 2;
const MAX_QUOTED_CHARS = 280;

/** Lowercase letter runs of four or more letters: enough to rank brief sentences by overlap. */
function overlapWordsOf(text: string): Set<string> {
  return new Set([...text.normalize('NFKC').toLowerCase().matchAll(/[a-z][a-z'’]{3,}/g)].map((match) => match[0].replace(/’/g, "'")));
}

/** The brief split into sentences: paragraphs on a blank line (a hard-wrapped line break inside a
 * paragraph is only a space), then a sentence mark followed by a space. Each is trimmed and capped
 * at `MAX_QUOTED_CHARS`. */
function briefSentencesOf(brief: string): string[] {
  return brief
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
    .map((sentence) => (sentence.length > MAX_QUOTED_CHARS ? `${sentence.slice(0, MAX_QUOTED_CHARS).replace(/\s+\S*$/, '')} …` : sentence));
}

/** The brief sentences sharing the most words with `text`, best first; none when nothing overlaps. */
export function nearestBriefSentences(brief: string, text: string, count = MAX_QUOTED_SENTENCES): string[] {
  const words = overlapWordsOf(text);
  if (words.size === 0) return [];
  return briefSentencesOf(brief)
    .map((sentence, index) => ({ sentence, index, score: [...overlapWordsOf(sentence)].filter((word) => words.has(word)).length }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, count)
    .map((entry) => entry.sentence);
}

/**
 * One flagged slot's repair hint: which claim sentence fails and the words in it the brief does
 * not contain (from the gate's own per-word rule), then the brief's closest sentence(s). Empty
 * when there is nothing specific to say.
 */
export function claimRepairHint(brief: string, text: string): string {
  const parts: string[] = [];
  for (const gap of claimTraceGaps(brief, text)) {
    const because = gap.signals.length > 0 ? ` (because of: ${gap.signals.join(', ')})` : '';
    parts.push(`The sentence "${gap.sentence}" states a claim${because}, so every word in it must be a word of the brief; the words not in the brief are: ${gap.missing.join(', ')}. Either use only the brief's words, or drop ${gap.signals.length > 0 ? `the claim words (${gap.signals.join(', ')})` : 'the claim'} so the value states no claim.`);
  }
  const nearest = nearestBriefSentences(brief, text);
  if (nearest.length > 0) parts.push(`The brief's own words for this: ${nearest.map((sentence) => `"${sentence}"`).join(' / ')}.`);
  return parts.join(' ');
}

/**
 * `text` without its claim sentences the brief does not support (the same trace the sentence gate
 * runs), whitespace tidied; an empty string when every sentence fails. Used for the TEMPLATE a
 * faithfulness repair shows the model: G8 dry run (maren x Cerebras), a model told its repaired
 * value was flagged again fell back to the TEMPLATE's own example for the slot — the reference
 * page's copy, which states a fact this brief does not — and the build ended flagged. A repair
 * prompt now shows only the part of that example the brief supports.
 */
export function withoutUntracedClaims(brief: string, text: string): string {
  let out = text;
  for (const gap of claimTraceGaps(brief, text)) out = out.replace(gap.sentence, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/** The brief's hours rows, quoted verbatim for the model to copy, or a note that there are none. */
export function briefHoursRowsQuote(brief: string): string {
  const rows = briefHoursRowsForHint(brief);
  return rows.length > 0
    ? `The brief's opening-hours rows, as "days" | "hours": ${rows.join('; ')}.`
    : 'The brief has no "Hours:" clause, so no hours row can be shown: return null for every hours value NULLABLE names.';
}

/**
 * The repair hint for a flagged hours slot (PR #137 round-2 ruling: fail closed, verbatim). It
 * quotes the brief's hours rows for the model to copy character for character, and says what else
 * passes: null.
 *
 * G8 final on 857a46b982 (halcyon x cerebras VERIFY_FAILED, root cause): this hint used to say a
 * combined row is "the days, A SPACE, then the hours" — true only when the brief's own row is
 * already day-first (true for most rows, so the bug hid). The one row a bundled brief states
 * status first ("closed Monday and Tuesday", halcyon's footer close-days row, shown in a day-first
 * "Open" column) was consistently repaired back to a bare-space day-first reorder
 * ("Monday and Tuesday closed") — a real, mechanical miss of the comma `deterministicHoursLabelFlags`
 * requires for a REORDERED row, not a Jev judgment call: the group rule (every row of a column
 * shows or none) then flagged the whole column, including its three already-correct siblings. The
 * hint now spells out the exact-copy case (any word order, the brief's own) and the one narrow case
 * that needs a comma (a day-first display of a status-first brief row), and says explicitly that a
 * bare space is never enough for that reorder.
 */
export function hoursLabelRepairHint(brief: string): string {
  return `This is an hours row. It passes only as an exact copy of ONE row of the brief's hours clause: the day label is that row's days and its value is that same row's hours, character for character. A combined row must copy its brief row's own word order exactly (days first or status first, whichever the brief itself uses) UNLESS you show the days before the status and the brief's own row states the status first — then insert a comma right after the days ("<days>, <status>"); a bare space there is not enough and still fails. ${briefHoursRowsQuote(brief)} When no row fits this slot, return null for its value (or for the slot) where NULLABLE names it. Never abbreviate, group, reword or combine days, and never change the hours.`;
}

/** The repair hint for a filled `x-verify: 'hours-null'` slot: it is always null. */
export function hoursNullRepairHint(): string {
  return 'This slot never shows hours (the page states hours only in its hours rows): return null for it.';
}
