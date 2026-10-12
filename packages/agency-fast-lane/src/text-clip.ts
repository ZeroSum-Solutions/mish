/**
 * Whole-word text budgets for the section fill (`section-overlay.ts`'s `fillSectionAdapter`).
 *
 * Two halves of one rule — visible copy never ends in a fragment of a word:
 *
 * - `promptLimit` / `wordBudget`: what the fill prompt tells the model per slot. The limit shown
 *   is below the adapter's hard maximum (models count loosely), and the word budget turns it into
 *   a unit a model keeps to more reliably than a character count.
 * - `clipWholeWords`: the last resort when an answer still runs over. It keeps the longest run of
 *   complete sentences that fits, else the longest run of whole words, and drops the partial word
 *   or sentence that follows. It never cuts inside a word: when not even the first word fits, it
 *   returns `undefined` and the caller decides (omit a nullable slot, or refuse the fill).
 *
 * A "word" is a run of non-whitespace characters, so `All‑in‑One` or `QuickBooks,` is one word:
 * the cut happens only at whitespace. Pure functions; no I/O.
 */

import { completionOf, isKnownWord } from './lexicon.ts';

/** Characters of whitespace, as the cut sees them. */
const SPACE = /\s/u;

/** A sentence ends at `.`, `!`, `?` or `…`, optionally followed by a closing quote or bracket. */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;

/** Trailing punctuation that reads as unfinished once the rest of the phrase is gone. */
const DANGLING_PUNCTUATION = /[\s,;:·•|/\\([{“‘"'«&+–—-]+$/u;

/**
 * Words that cannot end a clipped phrase: a phrase that stops on one of them reads as cut off
 * ("Invoices, time tracking and"). Lower-case comparison; only ever removed from the END.
 */
const DANGLING_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'to', 'for', 'with', 'without', 'from', 'in',
  'on', 'at', 'by', 'as', 'into', 'onto', 'via', 'per', 'your', 'our', 'their', 'its', 'my', 'that',
  'which', 'who', 'while', 'so', 'than', 'then', 'plus', 'vs', 'is', 'are', 'be', '&', '+',
]);

/** Below this, a limit gets no headroom: a 7-character label has none to give. */
const SMALL_LIMIT = 12;

/** The character limit the fill prompt shows for a slot whose hard maximum is `max`. */
export function promptLimit(max: number): number {
  if (max <= SMALL_LIMIT) return max;
  return Math.max(SMALL_LIMIT, Math.floor(max * 0.85));
}

/** About how many words fit in `limit` characters (six per word, space included), at least one. */
export function wordBudget(limit: number): number {
  return Math.max(1, Math.floor((limit + 1) / 6));
}

function stripDangling(words: string[]): string[] {
  const out = [...words];
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    const trimmed = last.replace(DANGLING_PUNCTUATION, '');
    if (trimmed.length === 0) { out.pop(); continue; }
    if (DANGLING_WORDS.has(trimmed.toLowerCase())) { out.pop(); continue; }
    out[out.length - 1] = trimmed;
    break;
  }
  return out;
}

/**
 * `value` cut to at most `limit` characters without splitting a word, or `undefined` when no whole
 * word fits. A value already within the limit comes back unchanged (trimmed). Prefers the longest
 * run of complete sentences that fits and keeps at least 40% of the limit; otherwise the longest
 * run of whole words, with trailing connectors and dangling punctuation removed. A result with no
 * letter or digit left (a lone `©`) counts as nothing fitting.
 */
export function clipWholeWords(value: string, limit: number): string | undefined {
  const text = value.trim();
  if (text.length <= limit) return text;
  if (limit <= 0) return undefined;
  const words = text.split(/\s+/u);
  // Longest whole-word prefix that fits: each word plus one joining space.
  const kept: string[] = [];
  let length = 0;
  for (const word of words) {
    const next = kept.length === 0 ? word.length : length + 1 + word.length;
    if (next > limit) break;
    kept.push(word);
    length = next;
  }
  if (kept.length === 0) return undefined;
  // Complete sentences first, when they keep enough of the budget to say something.
  for (let end = kept.length; end > 0; end -= 1) {
    if (SENTENCE_END.test(kept[end - 1]!)) {
      const sentences = kept.slice(0, end).join(' ');
      if (sentences.length >= limit * 0.4) return sentences;
      break;
    }
  }
  const phrase = stripDangling(kept).join(' ');
  // A lone symbol ("©", "—") is not copy: no letter or digit left means nothing fits.
  return /[\p{L}\p{N}]/u.test(phrase) ? phrase : undefined;
}

/** True when `clipped` is `source` cut only at whitespace: every word is a whole word of
 * `source`, in order, except that the last may have lost trailing punctuation. For tests and the
 * live proof's own check. */
export function isWholeWordPrefix(source: string, clipped: string): boolean {
  const from = source.trim().split(/\s+/u);
  const to = clipped.trim().split(/\s+/u).filter((word) => word.length > 0);
  if (to.length === 0 || to.length > from.length) return false;
  return to.every((word, index) => {
    const original = from[index]!;
    if (word === original) return true;
    return index === to.length - 1 && original.startsWith(word) && !SPACE.test(original) && original.slice(word.length).replace(DANGLING_PUNCTUATION, '').length === 0;
  });
}

/**
 * Capitalised words that open a sentence without naming anything. A brief's own opening word
 * ("Ledgerline is bookkeeping software…") is usually the business name, so a sentence-opening
 * capitalised word of five or more letters counts as a name unless it is one of these.
 */
const COMMON_OPENERS = new Set([
  'about', 'after', 'again', 'along', 'also', 'although', 'among', 'another', 'around', 'because', 'before', 'being',
  'below', 'besides', 'between', 'build', 'check', 'clients', 'create', 'customers', 'design', 'during', 'each',
  'either', 'every', 'everything', 'first', 'focus', 'following', 'from', 'further', 'given', 'having', 'here',
  'however', 'include', 'including', 'instead', 'keep', 'later', 'little', 'major', 'maybe', 'mention', 'might',
  'moreover', 'most', 'never', 'next', 'nothing', 'often', 'other', 'others', 'otherwise', 'people', 'perhaps',
  'please', 'pricing', 'rather', 'since', 'still', 'their', 'there', 'therefore', 'these', 'thing', 'things', 'think',
  'third', 'those', 'though', 'three', 'through', 'today', 'together', 'under', 'unless', 'until', 'using', 'visitors',
  'wants', 'welcome', 'what', 'whatever', 'when', 'where', 'whether', 'which', 'while', 'within', 'without', 'would',
  'write', 'young', 'your', 'yours',
]);


/**
 * The names a brief uses: CamelCase tokens (`QuickBooks`), capitalised words of five or more
 * letters inside a sentence (`Stripe`), and a capitalised word of five or more letters that opens
 * the brief or a sentence (`Ledgerline is…`, `Tools: Stripe`) unless it is a common opener.
 */
export function briefNames(brief: string): string[] {
  const names = new Set<string>();
  for (const match of brief.matchAll(/[A-Za-z][A-Za-z'’]*/gu)) {
    const word = match[0];
    const before = brief.slice(0, match.index).trimEnd();
    const sentenceStart = before.length === 0 || /[.!?:]$/u.test(before);
    const camel = /^[A-Z][a-z]+[A-Z]/u.test(word);
    const capitalised = /^[A-Z][a-z]{4,}$/u.test(word);
    if (camel || (capitalised && (!sentenceStart || !COMMON_OPENERS.has(word.toLowerCase())))) names.add(word);
  }
  return [...names];
}

/**
 * Words of `value` that are a brief name cut short (`Quick` for `QuickBooks`, `Ledger` for
 * `Ledgerline`): a whole word of three or more letters that a name starts with, is shorter than
 * it, and is not itself a word of the brief. Each comes back with the name it cuts.
 */
export function cutNames(value: string, names: readonly string[], briefWords: ReadonlySet<string>): Array<{ word: string; name: string }> {
  const found: Array<{ word: string; name: string }> = [];
  for (const match of value.matchAll(/[A-Za-z][A-Za-z'’]*/gu)) {
    const word = match[0];
    if (word.length < 3 || briefWords.has(word.toLowerCase())) continue;
    const number = NUMBER_CUTS[word.toLowerCase()];
    if (number) { found.push({ word, name: number }); continue; }
    const lower = word.toLowerCase();
    // An inflection is not a cut: "Connect" for "Connects", "Invoice" for "Invoicing".
    const name = names.find((candidate) => candidate.length > word.length && candidate.toLowerCase().startsWith(lower)
      && !INFLECTIONS.test(candidate.toLowerCase().slice(lower.length)));
    if (name) found.push({ word, name });
  }
  return found;
}

/** What a word may add to its stem without being a different word. */
const INFLECTIONS = /^(?:s|es|ed|d|ing|er|ers|ly|'s|’s)$/u;

/**
 * Word endings that make a longer word of a whole one ("invoice" + "s", "track" + "ing"), so a
 * token that is such a stem is a word in its own right, not a fragment. Deliberately narrow: "es",
 * "d", "y", "ies" and "ation" are left out because they would pass real cuts ("invoic" + "es",
 * "neede" + "d", "compan" + "y", "autom" + "ation").
 */
const STEM_ENDINGS = /^(?:s|'s|’s|ed|ing|ings|er|ers|ly|ment|ments|ness|less|ful|able)$/u;

/**
 * Short, common whole words that are also the start of longer words a brief may use ("pay" for
 * "payroll", "book" for "bookkeeping", "free" for "freelancers"). The fast lane ships no
 * dictionary, so these are named; a token outside this list, the brief's own words and the stems
 * above is judged by the prefix rule alone.
 */
const COMMON_WORDS = new Set([
  'about', 'account', 'act', 'add', 'age', 'all', 'and', 'any', 'app', 'apps', 'are', 'art', 'ask', 'auto', 'back', 'bad', 'bank', 'bar',
  'base', 'best', 'big', 'bill', 'blog', 'book', 'both', 'box', 'but', 'buy', 'call', 'can', 'car', 'card', 'care', 'case', 'cash', 'chat',
  'check', 'city', 'class', 'clean', 'clear', 'click', 'close', 'club', 'code', 'come', 'con', 'cost', 'data', 'date', 'day', 'days', 'deal',
  'demo', 'desk', 'did', 'dig', 'do', 'doc', 'docs', 'down', 'each', 'ear', 'earn', 'easy', 'edit', 'end', 'even', 'ever', 'every', 'eye',
  'fact', 'fair', 'far', 'fast', 'fee', 'feed', 'few', 'file', 'fill', 'find', 'fine', 'fire', 'firm', 'first', 'fit', 'fix', 'flow', 'for',
  'form', 'free', 'fresh', 'from', 'full', 'fun', 'fund', 'gain', 'get', 'gift', 'give', 'go', 'good', 'got', 'grow', 'had', 'hand', 'hard',
  'has', 'have', 'head', 'hear', 'help', 'her', 'here', 'high', 'him', 'his', 'hold', 'home', 'hour', 'how', 'idea', 'import', 'in', 'inbox',
  'into', 'its', 'job', 'lab', 'labs', 'join', 'just', 'keep', 'key', 'kind', 'know', 'land', 'last', 'late', 'lead', 'learn', 'less', 'let', 'life', 'light',
  'like', 'line', 'link', 'list', 'live', 'load', 'log', 'long', 'look', 'lot', 'love', 'low', 'made', 'mail', 'main', 'make', 'man', 'many',
  'map', 'mark', 'market', 'may', 'meet', 'men', 'mind', 'miss', 'mode', 'more', 'most', 'move', 'much', 'must', 'name', 'near', 'need',
  'net', 'new', 'news', 'next', 'no', 'not', 'note', 'now', 'off', 'office', 'old', 'on', 'once', 'one', 'only', 'open', 'order', 'our',
  'out', 'over', 'own', 'page', 'paid', 'part', 'pass', 'past', 'pay', 'per', 'pick', 'place', 'plan', 'play', 'plus', 'point', 'post',
  'price', 'print', 'pro', 'put', 'quick', 'rate', 'read', 'real', 'rest', 'right', 'road', 'room', 'run', 'safe', 'sale', 'same', 'save',
  'say', 'sea', 'see', 'seem', 'self', 'sell', 'send', 'set', 'share', 'ship', 'shop', 'short', 'show', 'side', 'sign', 'simple', 'site',
  'size', 'small', 'smart', 'so', 'soft', 'some', 'soon', 'sort', 'sound', 'spend', 'stand', 'star', 'start', 'state', 'stay', 'step',
  'still', 'stock', 'stop', 'store', 'sun', 'sure', 'take', 'talk', 'task', 'tax', 'team', 'tell', 'ten', 'term', 'test', 'text', 'than',
  'that', 'the', 'them', 'then', 'there', 'they', 'thing', 'this', 'time', 'tip', 'to', 'too', 'tool', 'top', 'total', 'touch', 'track',
  'trade', 'trial', 'true', 'trust', 'try', 'turn', 'two', 'type', 'under', 'up', 'us', 'use', 'user', 'view', 'wait', 'want', 'war',
  'was', 'watch', 'way', 'we', 'web', 'week', 'well', 'went', 'what', 'when', 'where', 'who', 'why', 'will', 'win', 'with', 'word', 'work',
  'world', 'year', 'yes', 'yet', 'you', 'your', 'zero',
]);

/**
 * Tokens of `value` that look self-truncated: a run of three or more letters that is a strict
 * prefix of a longer word in `targets` (the brief's words and the fill's own other words) and is
 * not itself a word we know — not a brief word, not a common word, and not a stem of the longer
 * word ("invoice" of "invoices"). "invoi" for "invoices", "neede" for "needed", "QuickBook" for
 * "QuickBooks". Case-insensitive; each finding names the word it cuts.
 */
export function wordFragments(value: string, knownWords: ReadonlySet<string>, targets: ReadonlySet<string>): Array<{ word: string; of: string }> {
  const found: Array<{ word: string; of: string }> = [];
  for (const match of value.matchAll(/[A-Za-z]+/gu)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (lower.length < 3 || knownWords.has(lower) || COMMON_WORDS.has(lower) || isKnownWord(lower, knownWords)) continue;
    let of: string | undefined;
    for (const target of targets) {
      if (target.length > lower.length && target.startsWith(lower) && !STEM_ENDINGS.test(target.slice(lower.length))) { of = target; break; }
    }
    if (of) found.push({ word, of });
  }
  return found;
}

/**
 * The lexical completion gate (Sol review round 3): tokens of `value` that no dictionary knows and
 * that start a longer list word — "Welcom" for "welcome" when the brief and the fill never use
 * "welcome". A token is uncertain when it is not in the bundled word list (`lexicon.ts`), not a
 * brief word, not a plain inflection of either, and not an acronym (all capitals, "API", "CSV");
 * an uncertain token that is a strict prefix of a list word is reported as a cut of that word.
 * Other uncertain tokens stay allowed: brand-like coinages ("Ledgerline") exist.
 */
export function lexicalCuts(value: string, briefWords: ReadonlySet<string>): Array<{ word: string; of: string }> {
  const found: Array<{ word: string; of: string }> = [];
  for (const match of value.matchAll(/[A-Za-z]+/gu)) {
    const word = match[0];
    if (word.length < 3 || /^[A-Z]+$/u.test(word)) continue;
    const lower = word.toLowerCase();
    if (isKnownWord(lower, briefWords)) continue;
    const of = completionOf(lower);
    if (of) found.push({ word, of });
  }
  return found;
}

/** Cut forms of number words that are not a prefix of them, or are common enough to name. */
const NUMBER_CUTS: Readonly<Record<string, string>> = {
  tri: 'Three', thr: 'Three', thre: 'Three', fou: 'Four', fiv: 'Five', sev: 'Seven', eig: 'Eight', nin: 'Nine',
};

/** Number and ordinal words a short step label tends to be cut from ("Fou" for "Four"). */
export const NUMBER_WORDS: readonly string[] = [
  'Three', 'Four', 'Five', 'Seven', 'Eight', 'Nine', 'Eleven', 'Twelve',
  'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth',
];

/** Limits at or under this are "tiny": a step marker or badge, where models abbreviate to fit. */
export const TINY_LIMIT = 4;

/** Whole words a tiny slot may hold although the brief does not use them. */
const TINY_WORDS = new Set(['one', 'two', 'six', 'ten', 'yes', 'no', 'new', 'all', 'faq', 'now', 'go', 'pro', 'top', 'hot', 'why', 'how', 'who', 'you']);

/**
 * Whether `value` may stand in a slot limited to `max` characters. Above `TINY_LIMIT` always; in
 * a tiny slot only a numeral ("01"), a word the brief itself uses, or a short common word — the
 * code has no dictionary, so anything else ("Inv", "Rpt") is treated as an abbreviation.
 */
export function tinyValueStands(value: string, max: number, briefWords: ReadonlySet<string>): boolean {
  if (max > TINY_LIMIT) return true;
  const text = value.trim();
  if (/^\d+$/u.test(text)) return true;
  return text.split(/\s+/u).every((word) => {
    const bare = word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    return bare.length === 0 || briefWords.has(bare) || TINY_WORDS.has(bare);
  });
}
