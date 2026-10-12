/**
 * Jev (TypeSafe System One) faithfulness gate for the fast lane's post-fill VERIFY step.
 *
 * One Noul question per changed text slot, asking whether the slot states a concrete fact the
 * client brief does not contain — the check `jev/faithfulness-check.mjs` proved live against a
 * real fast-lane build (WASOTO): 11/40 slots flagged at 0.93-0.98 confidence in ~420 ms, every
 * one hand-verified as a fabrication (an invented phone number, two emails, a street address, an
 * award caption — none in the brief). Adapted from `docs.typesafe.ai/cookbooks/citation_check.md`'s
 * Choice `supports/contradicts/says_nothing` pattern, collapsed to Noul since there is no citation
 * span to locate — the whole brief is the source. See `jev/JEV-DECISION-STEP.md` for the full
 * design and measured numbers, and the `typesafe-ai` skill for question-design guidance.
 *
 * `POST https://api.typesafe.ai/v1/systemone`: `state` carries the brief plus one `text_N` per
 * slot; `questions` carries one `noul` question per slot, all evaluated in parallel in one
 * request (the fan-out pattern `docs.typesafe.ai/patterns/fan-out.md` recommends). Requests are
 * batched to stay under the docs' per-request context ceilings (64,000 tokens for `state` plus
 * all `questions` combined; 32,000 tokens for `state` plus the single longest question) — token
 * counts are estimated at ~4 characters/token, with headroom under both ceilings, since the API
 * gives no tokenizer.
 *
 * A non-2xx response is a real API or request-shape error and throws a sanitized
 * `jevErrorMessage(status)` (e.g. `jev 500 upstream error`) — never the response body, which is
 * arbitrary third-party content this package must not repeat into a thrown error, a report, or
 * the console; see `jevErrorMessage`'s own docblock. A network failure or timeout cannot be
 * diagnosed here, so this checker reports it back as `skipped` instead of throwing — this file
 * has no opinion on whether that should block a build. What a `skipped` (or a remaining flagged
 * slot) does next is the caller's policy, set by `--verify-mode` (`src/verify-policy.ts`) and
 * enforced in `run.ts`'s `strictPassed`: `advisory` mode still publishes past it, printing it
 * loudly instead of blocking; `strict` mode (the CLI's default) fails closed on it exactly like an
 * unresolved flag, so a flaky Jev call does fail a strict build.
 *
 * Only text travels to Jev: never an asset id, a destination key, or the `id` anchor spine.ts
 * keeps for section matching. Callers pass `{path, text}` pairs already cut to those slots;
 * `collectFaithfulnessSlots` below does that cut for a filled recipe, mirroring spine.ts's
 * `LOCKED_KEYS`/`ANCHOR_KEY` exclusions exactly as the prototype's own `collectSlots` did.
 */

import { ANCHOR_KEY, LOCKED_KEYS, editableTemplate, isObject, mockPathsFor, type ContactKind, type Json, type JsonObject } from './spine.ts';
import { porterStem } from './porter-stemmer.ts';
import { isKnownWord, stemsOf } from './lexicon.ts';

/**
 * A deterministic supplement to the LLM faithfulness judge, for slots a family schema marks
 * `x-atom: 'person-name'` (`spine.ts`'s `personNamePathsFor`) — a reviewer, a testimonial's
 * author, an attributed quote. Jev is a probabilistic classifier: a plausible-sounding invented
 * name can read as faithful prose the same way a real one does, and a live storefront build
 * proved exactly that (two review names Jev's own check passed at 0 flagged, neither present in
 * the brief). A person's name is unlike most facts in being cheaply, exactly checkable — it
 * either appears in the brief's own text or it does not — so this never depends on Jev at all:
 * every `person-name` slot is checked here, always, in addition to whatever the LLM judge says.
 *
 * Match rule: the name's own WORD TOKENS (letters only, case-folded) must appear as a contiguous,
 * in-order run of WHOLE brief words — never a raw substring search. A fourth audit pass found the
 * previous substring rule (`haystack.includes(name)`) let short invented names hide inside
 * unrelated longer brief words: "Ed" is a substring of "expected"/"undyed", "Al" of "small"/
 * "seasonal", "Pat" of "patterns" — none of those are the brief naming a reviewer, but the old
 * rule passed all three. Tokenizing both sides and requiring whole-word equality closes this: "Ed"
 * (one word token, `["ed"]`) can never match inside "expected" (one word token, `["expected"]"`),
 * since `"expected" !== "ed"`. "Priya Raman" still matches a brief containing that exact phrase,
 * since its two word tokens ("priya", "raman") appear consecutively, in order, as their own words.
 */
export function deterministicAttributionFlags(brief: string, slots: readonly FaithfulnessSlot[], personNamePaths: ReadonlySet<string>): FlaggedSlot[] {
  const briefWords = allWordTokensOf(brief);
  const out: FlaggedSlot[] = [];
  for (const slot of slots) {
    if (!personNamePaths.has(slot.path)) continue;
    const nameWords = allWordTokensOf(slot.text);
    if (nameWords.length === 0) continue;
    if (!containsWordSequence(briefWords, nameWords)) out.push({ path: slot.path, probability: 1 });
  }
  return out;
}

/** Whether `needle` (a short list of lowercase word tokens, in order) occurs contiguously,
 * word-for-word, anywhere inside `haystack`. */
function containsWordSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, i) => haystack[start + i] === word)) return true;
  }
  return false;
}

/**
 * A deterministic supplement to the LLM faithfulness judge for slots `spine.ts`'s
 * `contactPathsFor` marks a contact atom (`email`, `phone` or `url`, from `x-atom` or a key ending
 * `email`/`phone`): a supplied buy link, address or phone number is a fact exactly like a
 * person's name or a quote, and the same reason `deterministicAttributionFlags` never trusts Jev
 * alone with a name applies here — a plausible-looking invented `mailto:`, `https://` link or
 * phone number reads as faithful prose the same way a real one does.
 *
 * A round-10 audit pass (storefront-r6-grok.md FIX 5) found neither `dishonestLinks` (which only
 * asks whether an `<a href>` resolves to SOMETHING real — an anchor, a real scheme — never whether
 * that destination is the BRIEF'S OWN) nor any claim/commercial-word check ever required a contact
 * atom's own value to occur in the brief at all, so an invented shop URL or email address (see
 * `reference.fixture.json`'s own `shop@tallowrow.example`, note 6 below) published whenever Jev
 * missed it. `NUMBER_RE`/`NOT_WORD_GLUED_AFTER` also excludes a hyphenated phone like
 * "503-555-0199" from `claimTokensOf` entirely on purpose (it looks exactly like a SKU or a
 * generated slug there, per that function's own docblock) — a phone number is never a bare
 * numeric claim, so it needs this dedicated check, not a `NUMBER_RE` fix.
 *
 * A round-11 audit pass (storefront-r7-grok.md BLOCK 2) found that first version's own checks were
 * still substring-shaped and just as exploitable: `brief.replace(/\D/g, '')` glued EVERY digit in
 * the whole brief into one string (rich.txt's street "1420" and ZIP "97202" concatenate into
 * "142097202"; its four prices and "15oz" concatenate into "2481681325"), so a page phone whose
 * digits merely APPEAR somewhere in that combined string — never a real phone the brief stated —
 * passed; a genuine phone's own trailing digits ("555-0199" out of "503-555-0199") passed the same
 * way. `briefLower.includes(value)` had the matching bug for email/URL: `hello@tallowrow.example`
 * accepted the fabricated `o@tallowrow.example` (a substring), and a buy URL missing its whole
 * path (`https://shop.tallowrow.example`) was accepted because it is a PROPER PREFIX of the
 * brief's real `https://shop.tallowrow.example/autumn`.
 *
 * Fixed with EQUALITY, not `includes`, against properly bounded candidates:
 * - `phoneDigitCandidatesOf` extracts each phone-SHAPED run from the brief — digits plus the
 *   separators one phone number uses internally (parens, hyphens, plain spaces) — stopping at any
 *   letter, currency symbol, comma, period or line break, so two unrelated numbers can never merge
 *   into one candidate the way whole-brief concatenation did. A phone must equal one candidate's
 *   digits exactly; "555-0199" is never itself a candidate when the brief only ever writes
 *   "503-555-0199" as one run, so it no longer passes as a coincidental suffix.
 * - `briefTokensOf` splits the brief into whitespace-bounded tokens, each trimmed of trailing
 *   sentence punctuation. An email or URL must equal a whole token, case-insensitively — never a
 *   substring of one — closing the `hello@`/`o@` hole. A URL is also accepted when it equals a
 *   brief URL token with only a trailing-slash difference (`urlEqualModuloTrailingSlash`); it must
 *   never merely be a PREFIX of a longer brief URL token, closing the `shop.tallowrow.example`
 *   (missing `/autumn`) hole.
 */
/** A phone-shaped run in the brief: digits plus the separators one phone number uses internally
 * (parens, hyphens, a plain space or tab) — deliberately NOT `,`/`.`/`\n` or any letter/currency
 * symbol, so two unrelated numbers separated by ordinary prose, a decimal point, a price symbol or
 * a sentence boundary can never merge into one candidate. See this section's own docblock (BLOCK
 * 2) for the whole-brief concatenation bug this closes. */
const PHONE_CANDIDATE_RE = /[\d()\- \t]+/g;

function phoneDigitCandidatesOf(brief: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const match of brief.matchAll(PHONE_CANDIDATE_RE)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length > 0) out.add(digits);
  }
  return out;
}

/** Every whitespace-bounded token in `text`, trimmed of trailing sentence punctuation and closing
 * brackets/quotes — the unit an email or URL must equal WHOLE, never a substring of. */
const TRAILING_TOKEN_PUNCT_RE = /[.,;:!?)\]}'"”’]+$/;
function tokensOf(text: string): string[] {
  return [...text.matchAll(/\S+/g)].map((match) => match[0].replace(TRAILING_TOKEN_PUNCT_RE, ''));
}

/** `value` and `token` are the same URL, or differ only by ONE trailing slash — never merely a
 * prefix relationship, which is the specific hole a round-11 audit pass named (a buy URL missing
 * its path must not pass just because it starts the same way a longer brief URL does). */
function urlEqualModuloTrailingSlash(value: string, token: string): boolean {
  const withoutSlash = (text: string) => (text.endsWith('/') ? text.slice(0, -1) : text);
  return withoutSlash(value) === withoutSlash(token);
}

export function deterministicContactFlags(brief: string, slots: readonly FaithfulnessSlot[], contactPaths: ReadonlyMap<string, ContactKind>): FlaggedSlot[] {
  const phoneCandidates = phoneDigitCandidatesOf(brief);
  const briefTokensLower = tokensOf(brief).map((token) => token.toLowerCase());
  const out: FlaggedSlot[] = [];
  for (const slot of slots) {
    const kind = contactPaths.get(slot.path);
    if (!kind) continue;
    const value = slot.text.trim();
    if (!value) continue;
    let supported: boolean;
    if (kind === 'phone') {
      const digits = value.replace(/\D/g, '');
      supported = digits.length > 0 && phoneCandidates.has(digits);
    } else if (kind === 'url') {
      const lower = value.toLowerCase();
      supported = briefTokensLower.some((token) => urlEqualModuloTrailingSlash(lower, token));
    } else {
      supported = briefTokensLower.includes(value.toLowerCase());
    }
    if (!supported) out.push({ path: slot.path, probability: 1 });
  }
  return out;
}

/**
 * A deterministic supplement to the LLM faithfulness judge for slots a family schema marks
 * `x-verify: 'quote'` (`spine.ts`'s `quotePathsFor`): a testimonial or review quote must trace
 * back to the brief's own words and facts, not be a plausible-sounding paraphrase the model
 * invented, and never carry an unstated commercial claim (a price, a stock line, a shipping
 * promise, a star rating) tacked onto an otherwise-traced sentence.
 *
 * This is deliberately NOT a percentage-coverage scorer (an earlier version of this function was,
 * twice, and both times a live-shaped audit found a way to launder invented content past it — a
 * fixed word-count floor a short real run could "bless" an arbitrarily long invented tail with,
 * then a cursor-arithmetic bug in its replacement that credited unmatched lead-in words as
 * "covered" and could double-count a real run). A percentage bar is fundamentally gameable: it
 * always leaves some slack a genuinely different fact can hide inside. This checks every token
 * individually instead, with no numeric budget to exploit:
 *
 * 1. CLAIM tokens — a currency amount ($248, €12.50), a standalone number (including a percent or
 *    a bare digit sequence), or a run of star/rating glyphs (★☆⭐✩) — are extracted from the quote
 *    with `claimTokensOf` and each one must appear, normalized, among the brief's OWN claim
 *    tokens (`claimTokensOf(brief)`, not a raw substring search, which would let "$5" false-match
 *    inside a brief's "$150"). A star rating decomposes into "N" (a claim token, checked here) and
 *    the word "star(s)" (a content word, checked below) — no special multi-word pattern is needed.
 * 2. Every remaining CONTENT word (letters only, via `contentWordsOf`) that is not in the small
 *    closed `STOPWORDS` list must appear, under `stemVariants`' light plural/-ed/-ing/-'s
 *    normalization, among the brief's own content words. A word missing from the brief is
 *    evidence of a fact — a claim, a product, a promise — the brief never stated, wherever in the
 *    quote it sits and however short the added phrase is; there is no coverage percentage that
 *    ever makes that acceptable.
 *
 * A quote with no CLAIM token missing from the brief and no CONTENT word missing from the brief
 * passes; anything else is flagged at probability 1. A light paraphrase of the brief's own words
 * passes cleanly (see the "fixture's genuine paraphrased quotes" and "realistic paraphrase" tests
 * in jev.test.ts) because paraphrase keeps the same underlying words; an added fact never does.
 *
 * CLAIM tokens and stemming were each independently re-audited and found to still have real holes
 * (this file's history has two prior rounds of percentage-scorer fixes before this token-based
 * design, and one further round on the token design itself); every fix below is documented at the
 * specific piece of code it fixes, not just here, so a future reader can find the reasoning next
 * to the code it explains.
 */
const WORD_TOKEN_RE = /[a-zA-Z][a-zA-Z']*/g;

/**
 * G8 dry run (live Cerebras builds, halcyon-c3 and maren-c1): gpt-oss-120b often writes a
 * typographic apostrophe ("We\u2019re", "don\u2019t"). NFKC does not fold U+2019, and
 * `WORD_TOKEN_RE` joins only the ASCII `'`, so "We\u2019re" split into "we" + "re" and the stray
 * "re"/"t" could never trace — while the same sentence with an ASCII apostrophe passed. U+2018,
 * U+2019 and U+02BC between two letters are the same in-word apostrophe as `'`: this folds them
 * to `'` on BOTH sides (brief and page) before any word-level check. It is a format equivalence,
 * not a loosening: the folded word must still match the brief's own word exactly as before. Only
 * an apostrophe BETWEEN two letters is folded — a curly quote that opens or closes a quotation
 * ("\u2018Slow Light\u2019") stays punctuation, so the quoted word tokenizes exactly as it did.
 */
const TYPOGRAPHIC_APOSTROPHE_RE = /(?<=\p{L})[\u2018\u2019\u02BC](?=\p{L})/gu;

/** `text` NFKC-normalized with every in-word typographic apostrophe folded to `'` — the one
 * normalizer every word-level check below reads through (see `TYPOGRAPHIC_APOSTROPHE_RE`). */
function normalizeForWords(text: string): string {
  return text.normalize('NFKC').replace(TYPOGRAPHIC_APOSTROPHE_RE, "'");
}

/** Every word token (letters and internal apostrophes only) in `text`, NFKC-normalized and
 * lowercased, in order — the shared tokenizer every word-level check below builds on. */
function allWordTokensOf(text: string): string[] {
  return [...normalizeForWords(text).matchAll(WORD_TOKEN_RE)].map((match) => match[0].toLowerCase());
}

/** Punctuation that ends a clause for `wordsWithClauseOf` — a comma, semicolon, colon, sentence-
 * ending mark, or dash — so two words on opposite sides of one are never treated as adjacent for
 * `commercialOccurrencesOf`'s modifier-pairing window. See that function's own docblock. */
const CLAUSE_BREAK_RE = /[.,;:!?—–]/;

/** Every word token, as `allWordTokensOf`, paired with a `clause` index that increments once per
 * `CLAUSE_BREAK_RE` character between it and the previous token — used only by
 * `commercialOccurrencesOf` to keep a modifier word from pairing with a commercial word across an
 * unrelated clause (see that function's own docblock for the false-positive this closes: "…while
 * stock lasts, no preorder needed" has "stock" and "no" within the plain token-distance window,
 * but a comma and an unrelated noun phrase sit between them). */
function wordsWithClauseOf(text: string): Array<{ readonly word: string; readonly clause: number }> {
  const normalized = normalizeForWords(text);
  const out: Array<{ word: string; clause: number }> = [];
  let clause = 0;
  let cursor = 0;
  for (const match of normalized.matchAll(WORD_TOKEN_RE)) {
    if (CLAUSE_BREAK_RE.test(normalized.slice(cursor, match.index))) clause += 1;
    out.push({ word: match[0].toLowerCase(), clause });
    cursor = match.index + match[0].length;
  }
  return out;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'it', 'its', 'i', 'my', 'we', 'our', 'us', 'you', 'your',
  'to', 'of', 'in', 'on', 'for', 'with', 'is', 'was', 'were', 'are', 'be', 'been', 'being',
  'so', 'that', 'this', 'these', 'those', 'very', 'really', 'just', 'too', 'also', 'still',
  'not', 'no', 'yes', 'as', 'at', 'by', 'from', 'into', 'onto', 'over', 'under', 'than', 'then',
  'more', 'most', 'much', 'many', 'some', 'any', 'all', 'both', 'each', 'every', 'other', 'such',
  'again', 'once', 'here', 'there', 'when', 'where', 'why', 'what', 'which', 'who', 'whom', 'whose',
  'if', 'because', 'while', 'although', 'though', 'until', 'unless', 'since', 'after', 'before',
  'during', 'without', 'within', 'about', 'above', 'below', 'between', 'through', 'up', 'down',
  // 'off' was here and was removed: a fourth audit pass found it let "15% off" pass unchecked
  // (with "off" filtered as a stopword and "15%"/"15" colliding with an unrelated brief number —
  // see claimTokensOf's own fix). It is short and rare enough to always check, unconditionally.
  'out', 'his', 'her', 'him', 'he', 'she', 'they', 'them', 'their', 'have', 'has', 'had',
  // Contracted forms of the same connective/pronoun words above — a contraction is not a new
  // fact, so it gets the same free pass its expanded form already has.
  "it's", "that's", "there's", "here's", "what's", "who's", "let's",
  "i'm", "you're", "we're", "they're", "i've", "you've", "we've", "they've",
  "i'll", "you'll", "we'll", "they'll", "don't", "doesn't", "didn't",
  "isn't", "aren't", "wasn't", "weren't", "can't", "won't", "wouldn't", "couldn't", "shouldn't",
]);

/**
 * `not`/`no`/`out`/`on` stay ordinary stopwords in general (dropping them from a legitimate
 * paraphrase's connective words is exactly what the whole STOPWORDS list exists to allow), but a
 * fourth audit pass found that being ALWAYS invisible let them flip a commercial claim's polarity
 * for free: brief "while stock lasts" (in stock) vs quote "Out of stock." — only the shared word
 * "stock" survives tokenizing either way, so the two opposite claims tokenize identically and the
 * check cannot tell them apart. `polarityRescuedIndices` (below) re-admits one of these words as a
 * checked content word specifically when it sits within two words of a `COMMERCIAL_DENYLIST_WORDS`
 * term (skipping over minor connective glue like "of" in "out of stock") — so "out" in "out of
 * stock" must itself appear in the brief, which it does not when the brief only ever says
 * "in stock", correctly flagging the polarity flip. "on" is included for the same reason against
 * "Shipping is on us." (free shipping) vs a brief that never mentions shipping cost at all.
 *
 * A FIFTH audit pass (round 9, storefront-r5-grok.md NOTE) found the window of 2 was itself too
 * narrow for a genuine, common stock phrase: "No longer in stock." tokenizes as
 * `no(0) longer(1) in(2) stock(3)` — "no" sits THREE positions from "stock", one past the old
 * window, so it was never rescued and "stock" alone (present in a brief that only ever says
 * "in stock") let the polarity flip pass silently, the exact failure mode this mechanism exists
 * to close. Widened to 3 so "no"/"longer"/"in"/"stock" (distance 3) is caught without widening far
 * enough to start rescuing unrelated "not"/"no"/"out"/"on" occurrences several clauses away from
 * an actual commercial word.
 */
const POLARITY_WORDS: ReadonlySet<string> = new Set(['not', 'no', 'out', 'on']);
const POLARITY_RESCUE_WINDOW = 3;

/**
 * Commercial words a general-purpose stemmer cannot be trusted with. A THIRD audit pass found that
 * Porter's own genuine linguistic stem for "stocking" is "stock" — correct English morphology, not
 * a stemmer bug — so a brief mentioning a knit "stocking" would otherwise make a review's
 * unsupported "In stock." false-pass on stem equality alone. Any content word whose Porter stem
 * lands on one of these roots is therefore matched EXACTLY (case-folded, unstemmed) against the
 * brief's own raw words instead of by stem — closing the collision class for every word that stems
 * here, not just the specific examples an audit happened to try. Kept deliberately small: this is
 * a denylist for words that are financially/materially loaded enough that a coincidental stem
 * collision is not an acceptable risk, not a general precision improvement.
 *
 * `sold` and `available` were added by a FIFTH audit pass (round 9): "Sold out." and
 * "Available now." carry no OTHER denylist word at all (no "stock", no "ship") and no
 * `POLARITY_WORDS` term either, so both stock claims were entirely invisible to this gate before —
 * not a polarity miss, a straight absence. Both stay unstemmed like every other entry here, for
 * the same collision reason ("sold" already has no risky stem neighbor, but consistency with the
 * rest of this list keeps the exact-match rule uniform rather than case-by-case).
 */
export const COMMERCIAL_DENYLIST_WORDS: readonly string[] = [
  'stock', 'star', 'stars', 'ship', 'shipping', 'free', 'sale', 'sales', 'discount', 'discounted',
  'warranty', 'warranties', 'guarantee', 'guaranteed', 'rated', 'rating', 'ratings', 'review',
  'reviews', 'reviewed', 'sold', 'available',
];
const COMMERCIAL_DENYLIST_STEMS: ReadonlySet<string> = new Set(COMMERCIAL_DENYLIST_WORDS.map(porterStem));

/**
 * Every CLAIM token in `text`: a currency amount (prefix OR postfix symbol, or a word-form code
 * like USD/EUR; full thousands-grouping; decimals), a bare currency symbol with no amount, a
 * standalone number or percent, or a rating mark (a run of star/asterisk glyphs, an "N/5" form, or
 * an "N star(s)"/"N-star" phrase). `text` is NFKC-normalized FIRST, so fullwidth digits and
 * currency symbols (e.g. "１２４８", "＄") fold to their ASCII forms before any of this runs — a
 * third audit pass found the previous version matched fullwidth amounts with ZERO claim tokens,
 * so a fullwidth price sailed through unchecked.
 *
 * This scans in two passes rather than one giant alternation regex: RATING spans are found first
 * and their character ranges are excluded from the amount/currency scan, so "5 stars" is always
 * ONE rating claim token, never also a separate bare-number claim token for the "5" — decomposing
 * it would let the "5" be satisfied by an unrelated number elsewhere in the brief (a price, a
 * pocket count) instead of requiring the rating phrase itself to appear.
 *
 * Amount tokens are built by finding every NUMBER span, then checking the characters immediately
 * before and after it (across up to one space) for a currency symbol or word code, and merging
 * them into ONE token when found. This fixes the specific bug a third audit pass found: the
 * previous regex matched a currency symbol and a plain number as two SEPARATE alternatives with no
 * merge step, so "$1,499" tokenized as "$1" (currency + the first digit run before the comma broke
 * the match) PLUS a separate bare "499" — meaning a quote claiming just "$1" would find "$1" sitting
 * in the brief's own claim-token set even though the brief actually said $1,499, a completely
 * different amount. The NUMBER pattern itself now spans a full thousands-grouped figure
 * (comma/space/apostrophe groups of 3, OR dot-groups with a comma decimal) as one match, and the
 * merge step means a digit group is a claim token in exactly the currency context it actually
 * appeared in — a bare "15" from a brief's "15oz" fabric weight can no longer silently satisfy a
 * quote's invented "15" postfix-currency price, because the postfix-currency merge only fires when
 * a real currency symbol/word sits immediately next to the number, and "15oz" has none.
 *
 * A FOURTH audit pass found three more holes, all fixed here:
 * (1) `15%` had no distinct percent token — it tokenized as the same bare `num:15` a brief's
 *     unrelated "15oz" fabric weight also produces, so "15% off." false-passed. Percent amounts
 *     are now their own `pct:` token, scanned (like ratings) before the generic number pass.
 * (2) European decimal-comma amounts collided with thousands-comma amounts: `normalizeAmountDigits`
 *     used to delete every comma outright unless the value was already dot-grouped, so `€12,50`
 *     and `€1,250` both normalized to the same `amt:€1250` — roughly a 100x price error. It now
 *     recognizes a SINGLE trailing comma followed by 1-2 digits as a decimal point.
 * (3) The thousands-separator class was missing NBSP/narrow-NBSP/thin-space (NFKC does not fold
 *     these to a plain space) and could not span Indian-style mixed 2-and-3-digit grouping
 *     (`₹1,49,999`), so both fragmented into a short leading amount plus a leftover bare number —
 *     a quote could then match just the short leading piece. Those whitespace variants are now
 *     normalized to an ASCII space before scanning, and an explicit Indian-grouping alternative
 *     captures the full span as one number.
 * (4) The rating pattern had no left boundary robust to decimals: it could start matching mid-
 *     number, so "4.5 stars" matched only "5 stars" and silently dropped the "4.". It also had no
 *     "N out of M"/"N of M" form at all, so "5 out of 5" tokenized as a bare `num:5`, satisfiable
 *     by any unrelated "5" in the brief (a pocket count, a price). The rating patterns now require
 *     a decimal-aware number (never a mid-decimal digit run) and include "N out of M"/"N of M".
 *
 * `NUMBER_RE`/`PERCENT_RE` (not `RATING_RE`, which already anchors on a required literal suffix
 * like "star"/"of"/"/" that a stray word never has) also require the number to stand as its OWN
 * token: not immediately glued to a letter OR a hyphen on either side. Wiring
 * `deterministicClaimFlags` broadly across every faithfulness slot (a family-agnostic fourth-round
 * change) surfaced this directly, in two shapes: a schema field literally named `line1` produced
 * filler text like "New line1 for ...", where the "1" inside "line1" was extracted as its own bare
 * `num:1` claim token; a DIFFERENT family's own hyphenated generic field names (`main-title-elem-2`,
 * `footer-form-caption-3`) produced the same problem one hyphen away — the "2"/"3" is glued to the
 * identifier by a hyphen rather than directly to a letter, so a letter-only boundary guard alone
 * still let it through. Neither is a real quantity, price, or fact: a digit run stuck to
 * surrounding letters OR joined by a hyphen to a letter-led identifier (a field name, a SKU-like
 * "B2B", a generated slug) is part of a compound identifier, never a freestanding numeric claim,
 * so both are excluded from `NUMBER_RE`/`PERCENT_RE` matching entirely.
 *
 * A FIFTH audit pass found a number the brief already uses for something else (rich.txt's "15oz"
 * fabric weight, tokenizing as bare `num:15`) could bless an entirely different, invented claim
 * once an English UNIT WORD was attached instead of a symbol: `PERCENT_RE` only matched a literal
 * `%`, and the currency merge only recognized ISO codes (`USD`, `EUR`, …), so "15 percent off" and
 * "15 dollars" both fell through to the SAME bare `num:15` the brief's fabric weight already
 * satisfies — an entirely fabricated discount or price ($15 instead of the brief's real $248)
 * published clean. Worse, the existing repair instruction ("keep the same number, change the
 * wording") meant a flagged `$15` rewritten as `15 dollars` during repair would pass the recheck
 * and ship — the live exploit path. `PERCENT_WORD_RE` and `CURRENCY_UNIT_WORD_RE` (below) treat a
 * number followed by a spelled-out percent or currency word as its own distinct claim token,
 * scanned in the same claims-first pass as `%` and currency symbols/codes, so the SAME real-world
 * amount can no longer be worded around the check that would have caught it as `$15`/`15%`.
 */
const NOT_WORD_GLUED_BEFORE = '(?<![a-zA-Z\\d.-])';
const NOT_WORD_GLUED_AFTER = '(?![a-zA-Z-])';
/** Glyph runs only ("★★★★★", "****"). The "N/M" and "N (out) of M" fraction forms move to
 * `RATING_FRACTION_RE` (below `NUMBER_WORD_ALT`, since a round-11 audit pass gave them a number-
 * WORD sibling too — see that regex's own docblock); the digit-or-word "N star(s)" form stays on
 * `STAR_COUNT_RE` (below), a round-10 audit fix for that one form specifically. */
const RATING_GLYPH_RE = /[★☆⭐✩*]{2,}/g;

/**
 * A SIXTH audit pass (round 10, storefront-r6-grok.md BLOCK 2) found "fifteen percent off" and
 * "five stars" were still invisible: `PERCENT_WORD_RE` and `RATING_RE`'s star form both required
 * an ACTUAL DIGIT before the unit word, so a spelled-out number produced no `pct:`/`rating:` token
 * at all — and, since "percent"/"stars" are not `COMMERCIAL_DENYLIST_WORDS` entries either, no
 * other gate saw them. The exploit is the same shape round 9 closed for currency ("$15" reworded
 * as "15 dollars" during repair): a flagged "15%" reworded as "fifteen percent off" would pass the
 * recheck.
 *
 * `NUMBER_WORDS`/`numberWordValueOf` spell out one through ninety-nine plus "X hundred" (one
 * through one hundred, per the audit), "half" (0.5) and "a dozen"/"dozen" (12) — the exact range
 * named. `NUMBER_WORD_ALT` is their combined regex alternation, used by both `PERCENT_ANY_RE` and
 * `STAR_COUNT_RE` below so a digit form and its spelled-out sibling ("15%"/"fifteen percent",
 * "5 stars"/"five stars") normalize to the SAME canonical token, keyed by numeric VALUE rather
 * than by literal matched text — the two forms are the same claim and must satisfy each other
 * exactly as two digit spellings of the same amount already do (round 4's "15%" vs "15.0%"). A
 * bare number word used for anything else (a count, an ordinary quantity — "two sewists") is left
 * completely alone: these two regexes only fire immediately next to "%"/"percent"/"per cent"/
 * "pct" or "star(s)", never in isolation, so an unrelated spelled-out count can never surface as a
 * bare `num:` claim token the way a digit count already correctly does not (nothing here changes
 * `NUMBER_RE`, which still only matches actual digits).
 */
const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9],
  ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15], ['sixteen', 16], ['seventeen', 17],
  ['eighteen', 18], ['nineteen', 19], ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50], ['sixty', 60], ['seventy', 70],
  ['eighty', 80], ['ninety', 90],
]);
const ONES_ALT = [...NUMBER_WORDS.keys()].filter((word) => NUMBER_WORDS.get(word)! < 20).join('|');
const TENS_ALT = [...NUMBER_WORDS.keys()].filter((word) => NUMBER_WORDS.get(word)! >= 20).join('|');
/** A spelled-out number phrase, one through one hundred, plus "half" and "a dozen"/"dozen". */
const NUMBER_WORD_ALT = `(?:(?:${ONES_ALT})\\s+hundred(?:\\s+and)?(?:\\s+(?:(?:${TENS_ALT})(?:[\\s-](?:${ONES_ALT}))?|${ONES_ALT}))?|(?:${TENS_ALT})(?:[\\s-](?:${ONES_ALT}))?|${ONES_ALT}|half|a\\s+dozen|dozen)`;

/** Parses a `NUMBER_WORD_ALT` match (case-insensitive) into its numeric value, or `undefined` if
 * somehow unparseable (should not happen given the regex only matches recognized phrases). */
function numberWordValueOf(phrase: string): number | undefined {
  const words = phrase.toLowerCase().trim().split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return undefined;
  if (words[0] === 'half') return 0.5;
  if (words[0] === 'dozen' || (words[0] === 'a' && words[1] === 'dozen')) return 12;
  if (words[0] === 'zero') return 0;
  let value = 0;
  let i = 0;
  if (NUMBER_WORDS.get(words[i]!) && words[i + 1] === 'hundred') {
    value += NUMBER_WORDS.get(words[i]!)! * 100;
    i += 2;
    if (words[i] === 'and') i += 1;
  }
  if (i < words.length) {
    const tens = NUMBER_WORDS.get(words[i]!);
    if (tens !== undefined && tens >= 20) {
      value += tens;
      i += 1;
      if (i < words.length) {
        const ones = NUMBER_WORDS.get(words[i]!);
        if (ones !== undefined && ones > 0 && ones < 10) { value += ones; i += 1; }
      }
    } else if (tens !== undefined) {
      value += tens;
      i += 1;
    }
  }
  return value > 0 ? value : undefined;
}

// `\b` sits INSIDE each word-ending alternative (`percent\b`, `per\s+cent\b`, `pct\b`), never
// after the whole group: `%` is a non-word character, so a shared trailing `\b` after `%` would
// need a word/non-word transition that a "%" followed by a space or another symbol never has,
// silently matching nothing at all — the bug this exact shape produced on its first pass.
//
// The optional trailing `(?:\s+off\b)?` is a round-11 audit pass fix (storefront-r7-grok.md
// BLOCK 4): "100% off" (a discount) and "100% cotton" (a material composition) both tokenized as
// the bare `pct:100`, so a brief stating only the material composition licensed an invented
// discount of the SAME percentage. When "off" immediately follows the percent, it is captured as
// PART of the match, and `claimTokensOf` (below) folds it into a DISTINCT token ("pct:100 off"
// vs. bare "pct:100") — a percent used for something else can no longer satisfy a percent
// discount of the same number, and vice versa.
const PERCENT_ANY_RE = new RegExp(`${NOT_WORD_GLUED_BEFORE}(?:\\d+(?:\\.\\d+)?|${NUMBER_WORD_ALT})\\s*(?:%|percent\\b|per\\s+cent\\b|pct\\b)(?:\\s+off\\b)?`, 'gi');
/** "5 stars"/"5-star"/"five stars" — the one round-10 `RATING_RE` form that pass gave a number-
 * word sibling (see `NUMBER_WORDS`'s own docblock); the fraction shapes ("N/M", "N (out) of M")
 * are `RATING_FRACTION_RE`, below. */
const STAR_COUNT_RE = new RegExp(`(?<![\\d.])\\b(?:\\d+(?:\\.\\d+)?|${NUMBER_WORD_ALT})[\\s-]?stars?\\b`, 'gi');
/**
 * A bare spelled-out number phrase, anywhere in the text — used ONLY to merge with an adjacent
 * currency symbol/word into one `amt:` token, the same way a bare digit `NUMBER_RE` match already
 * does (below, in `claimTokensOf`). A round-11 audit pass (storefront-r7-grok.md BLOCK 4) found
 * "fifteen dollars" never merged with `CURRENCY_UNIT_WORD_RE` at all — that merge only ever ran
 * over `NUMBER_RE`'s DIGIT hits — so the only token it produced was a bare `cur:DOLLARS`, and a
 * brief that merely mentions dollars as a currency (with no matching amount) accepted an
 * invented spelled-out price the digit form "15 dollars" already correctly catches. A match here
 * that is NOT adjacent to a currency symbol/word is dropped entirely, never falling back to a
 * bare `num:` token — an ordinary spelled-out count ("two sewists") must stay invisible to the
 * claim gate exactly as round 10's own fix intended; see `claimTokensOf`'s merge loop for where
 * that guard lives.
 */
const NUMBER_WORD_STANDALONE_RE = new RegExp(`${NOT_WORD_GLUED_BEFORE}\\b${NUMBER_WORD_ALT}\\b`, 'gi');
/**
 * A round-11 audit pass (storefront-r7-grok.md BLOCK 1) found "Five out of five" produced NO
 * claim token at all: the old `RATING_RE` fraction alternative required an actual digit on both
 * sides, "five" is not a `COMMERCIAL_DENYLIST_WORDS` term, and no `NUMBER_RE` bare-number token
 * exists for a spelled-out word either — the exact number-word gap round 10 closed for percent
 * and star counts, left open for the "N/M" and "N (out) of M" fraction forms. Digit OR spelled-
 * out (`NUMBER_WORD_ALT`) on EITHER side of `/` or `(out )?of`, canonicalized by
 * `ratingFractionValueOf` (below) to `rating:<numerator>/<denominator>` regardless of which side
 * used which form — a live Cerebras/DeepSeek build could otherwise launder a flagged digit
 * "5 out of 5" into "Five out of five" and pass the recheck, the same repair-laundering shape
 * round 9/10 closed for currency and percent.
 */
const RATING_FRACTION_RE = new RegExp(`(?<![\\d.])\\b(?:\\d+(?:\\.\\d+)?|${NUMBER_WORD_ALT})\\s*(?:\\/|(?:out\\s+)?of)\\s*(?:\\d+(?:\\.\\d+)?|${NUMBER_WORD_ALT})\\b`, 'gi');
/** The leading number (digit or spelled-out) of a `PERCENT_ANY_RE`/`STAR_COUNT_RE` match, as a
 * canonical string — "15" for "15%"/"fifteen percent", "4.5" for "4.5 stars" — so both forms
 * produce the identical `pct:`/`rating:` token this section's docblock describes. */
function leadingNumberValueOf(match: string): string {
  const digitMatch = match.match(/^\d+(?:\.\d+)?/);
  if (digitMatch) return digitMatch[0];
  const wordMatch = match.match(new RegExp(`^${NUMBER_WORD_ALT}`, 'i'));
  const value = wordMatch ? numberWordValueOf(wordMatch[0]) : undefined;
  return value === undefined ? match.trim().toLowerCase() : String(value);
}
/** Canonicalizes a `RATING_FRACTION_RE` match ("5/5", "5 out of 5", "Five out of five",
 * "5 of five") to `<numerator>/<denominator>`, both sides run through `leadingNumberValueOf` —
 * see that regex's own docblock for why a digit and a spelled-out side must produce the same
 * token. */
function ratingFractionValueOf(match: string): string {
  const [numerator, denominator] = match.split(/\s*(?:\/|(?:out\s+)?of)\s*/i);
  return `${leadingNumberValueOf(numerator ?? '')}/${leadingNumberValueOf(denominator ?? '')}`;
}
/** Spelled-out currency UNIT words (as opposed to `CURRENCY_WORD_RE`'s ISO codes) that merge with
 * an adjacent number into one `amt:` token exactly the way a `$`/`€` symbol does — see this
 * section's docblock (fifth audit pass) for the "15 dollars" hole this closes. Deliberately kept
 * to unambiguous, dedicated currency-unit words: no bare "cent(s)" (a common non-currency use, and
 * already redundant with "dollar(s)"/other units for the currencies this repo prices in). */
const CURRENCY_UNIT_WORD_RE = /\b(?:dollars?|bucks?|cents?|euros?|pounds?(?:\s+sterling)?|quid|yen|won|rupees?)\b/gi;
// NBSP (U+00A0), narrow NBSP (U+202F) and thin space (U+2009) are valid thousands separators in
// real prices but NFKC does not fold them to an ASCII space — `claimTokensOf` replaces them before
// this pattern runs. The ASCII apostrophe joins the existing curly one as a group mark.
const NUMBER_RE = new RegExp(
  `${NOT_WORD_GLUED_BEFORE}(?:\\d{1,3}(?:,\\d{2})+,\\d{3}(?:\\.\\d+)?|\\d{1,3}(?:[,’' ]\\d{3})+(?:\\.\\d+)?|\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?)${NOT_WORD_GLUED_AFTER}`,
  'g',
);
const CURRENCY_SYMBOL_RE = /[$€£¥₩₹]/g;
const CURRENCY_WORD_RE = /\b(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|KRW)\b/gi;
const THOUSANDS_WHITESPACE_RE = /[   ]/g;
/**
 * A clock time with its am/pm glued straight onto the digits ("6am", "6:00pm") — a round-4 Grok
 * audit (guide-r2) found this was entirely invisible to `claimTokensOf`: `NOT_WORD_GLUED_AFTER`
 * (this file's own docblock above) exists to exclude a digit run glued to a LETTER-LED identifier
 * ("15oz", "B2B") from `NUMBER_RE` on purpose, but "6am" fell into that same exclusion by
 * accident — the "6" in "6am" produced no claim token at all, so an invented "5am" traced
 * identically to the brief's real "6am" on every gate that reads claim tokens (this one and the
 * word-trace check both). Matched and claimed BEFORE `NUMBER_RE` runs, so the digit is never
 * double-counted as generic glued noise. Space-separated ("6 am") and a colon-minute form
 * ("6:00am") both match; the am/pm marker's own period is optional ("6a.m.").
 */
const CLOCK_TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\.?\b/gi;

function normalizeAmountDigits(raw: string): string {
  // Dot-thousands + comma-decimal (e.g. "1.499,99"): dots are thousands, a trailing comma-and-1-2-
  // digits is the decimal point.
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(raw)) return raw.replace(/\./g, '').replace(',', '.');
  // Comma-thousands in clean groups of exactly 3, optional dot-decimal (e.g. "1,499.99"): strip
  // the commas, keep the dot.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) return raw.replace(/,/g, '');
  // A SINGLE comma followed by exactly 1-2 digits (e.g. "12,50"): the comma IS a decimal point,
  // the European convention — never deleted outright, or "€12,50" and "€1,250" would collide.
  if (/^\d+,\d{1,2}$/.test(raw)) return raw.replace(',', '.');
  // Everything else (Indian-style mixed grouping, space/’/'-thousands, or anything the specific
  // patterns above didn't recognize): a genuine trailing decimal is exactly 1-2 digits after a
  // final separator with nothing following it; keep that, strip every other separator character.
  const decimalMatch = raw.match(/[.,](\d{1,2})$/);
  const integerPart = decimalMatch ? raw.slice(0, raw.length - decimalMatch[0].length) : raw;
  const cleanInteger = integerPart.replace(/\D/g, '');
  return decimalMatch ? `${cleanInteger}.${decimalMatch[1]}` : cleanInteger;
}

function claimTokensOf(rawText: string): string[] {
  const text = rawText.normalize('NFKC').replace(THOUSANDS_WHITESPACE_RE, ' ');
  const tokens: string[] = [];
  const claimedSpans: Array<[number, number]> = [];
  const claim = (start: number, end: number, token: string) => { claimedSpans.push([start, end]); tokens.push(token); };
  // Claimed FIRST (see `CLOCK_TIME_RE`'s own docblock): a glued "6am" would otherwise never reach
  // `NUMBER_RE` at all, so claiming it here is additive, never a span `NUMBER_RE` would have taken.
  for (const match of text.matchAll(CLOCK_TIME_RE)) {
    const hour = match[1];
    const minute = match[2] ?? '00';
    claim(match.index, match.index + match[0].length, `time:${hour}:${minute}${match[3]!.toLowerCase()}m`);
  }
  for (const match of text.matchAll(RATING_GLYPH_RE)) claim(match.index, match.index + match[0].length, `rating:${match[0].toLowerCase()}`);
  // "5/5"/"5 out of 5"/"Five out of five"/"5 of five" — canonicalized to `<numerator>/<denominator>`
  // via `ratingFractionValueOf`, so a digit form and any spelled-out sibling produce the SAME
  // `rating:` token; see `RATING_FRACTION_RE`'s own docblock (round-11 audit pass, BLOCK 1).
  for (const match of text.matchAll(RATING_FRACTION_RE)) claim(match.index, match.index + match[0].length, `rating:${ratingFractionValueOf(match[0])}`);
  // "5 stars"/"5-star"/"five stars" — canonicalized to numeric VALUE (`leadingNumberValueOf`), so
  // a digit form and its spelled-out sibling produce the SAME `rating:` token; see `STAR_COUNT_RE`'s
  // own docblock (sixth audit pass).
  for (const match of text.matchAll(STAR_COUNT_RE)) claim(match.index, match.index + match[0].length, `rating:${leadingNumberValueOf(match[0])} star`);
  // "15%"/"15 percent"/"15 per cent"/"15pct"/"fifteen percent" — canonicalized to numeric VALUE, so
  // every spelling of the SAME percent claim produces one `pct:` token; see `PERCENT_ANY_RE`'s own
  // docblock (fifth audit pass for the digit-word split, sixth for the number-word form).
  for (const match of text.matchAll(PERCENT_ANY_RE)) {
    // A trailing "off" (see `PERCENT_ANY_RE`'s own docblock, BLOCK 4) makes this a DIFFERENT
    // claim from the bare percent — "100% off" and "100% cotton" must never satisfy each other.
    const off = /\boff\b/i.test(match[0]) ? ' off' : '';
    claim(match.index, match.index + match[0].length, `pct:${leadingNumberValueOf(match[0])}${off}`);
  }
  const overlapsClaimed = (start: number, end: number) => claimedSpans.some(([s, e]) => start < e && end > s);

  const numbers = [...text.matchAll(NUMBER_RE)].filter((m) => !overlapsClaimed(m.index, m.index + m[0].length));
  const currencySymbols = [...text.matchAll(CURRENCY_SYMBOL_RE)].filter((m) => !overlapsClaimed(m.index, m.index + m[0].length));
  // ISO codes (`USD`) AND spelled-out unit words (`dollars`) both merge with an adjacent number
  // into one `amt:` token below — see `CURRENCY_UNIT_WORD_RE`'s docblock (fifth audit pass) for
  // why a spelled-out unit needs the exact same treatment an ISO code already got.
  const currencyWords = [...text.matchAll(CURRENCY_WORD_RE), ...text.matchAll(CURRENCY_UNIT_WORD_RE)].filter((m) => !overlapsClaimed(m.index, m.index + m[0].length));
  // A currency symbol/word's start index, once merged into an amount token below, is added here
  // so the bare-currency pass further down does not ALSO emit it as its own separate token.
  const usedCurrencyStarts = new Set<number>();
  for (const num of numbers) {
    const start = num.index;
    const end = start + num[0].length;
    const beforeMatch = [...currencySymbols, ...currencyWords].find((c) => !usedCurrencyStarts.has(c.index) && c.index + c[0].length <= start && /^\s*$/.test(text.slice(c.index + c[0].length, start)) && start - (c.index + c[0].length) <= 1);
    const afterMatch = !beforeMatch
      ? [...currencySymbols, ...currencyWords].find((c) => !usedCurrencyStarts.has(c.index) && c.index >= end && /^\s*$/.test(text.slice(end, c.index)) && c.index - end <= 1)
      : undefined;
    const digits = normalizeAmountDigits(num[0]);
    if (beforeMatch) {
      usedCurrencyStarts.add(beforeMatch.index);
      tokens.push(`amt:${beforeMatch[0].toUpperCase()}${digits}`);
    } else if (afterMatch) {
      usedCurrencyStarts.add(afterMatch.index);
      tokens.push(`amt:${afterMatch[0].toUpperCase()}${digits}`);
    } else {
      tokens.push(`num:${digits}`);
    }
  }
  // "fifteen dollars" — see `NUMBER_WORD_STANDALONE_RE`'s own docblock (BLOCK 4). Only emits a
  // token when a currency symbol/word is actually adjacent; an unrelated spelled-out count
  // ("two sewists") produces nothing here, deliberately never falling back to a bare `num:`.
  const numberWords = [...text.matchAll(NUMBER_WORD_STANDALONE_RE)].filter((m) => !overlapsClaimed(m.index, m.index + m[0].length));
  for (const num of numberWords) {
    const start = num.index;
    const end = start + num[0].length;
    const beforeMatch = [...currencySymbols, ...currencyWords].find((c) => !usedCurrencyStarts.has(c.index) && c.index + c[0].length <= start && /^\s*$/.test(text.slice(c.index + c[0].length, start)) && start - (c.index + c[0].length) <= 1);
    const afterMatch = !beforeMatch
      ? [...currencySymbols, ...currencyWords].find((c) => !usedCurrencyStarts.has(c.index) && c.index >= end && /^\s*$/.test(text.slice(end, c.index)) && c.index - end <= 1)
      : undefined;
    const currencyMatch = beforeMatch ?? afterMatch;
    if (!currencyMatch) continue; // an ordinary spelled-out count elsewhere in prose; not a claim.
    const value = numberWordValueOf(num[0]);
    if (value === undefined) continue;
    usedCurrencyStarts.add(currencyMatch.index);
    tokens.push(`amt:${currencyMatch[0].toUpperCase()}${value}`);
  }
  for (const c of [...currencySymbols, ...currencyWords]) {
    if (!usedCurrencyStarts.has(c.index)) tokens.push(`cur:${c[0].toUpperCase()}`);
  }
  return tokens;
}

/**
 * The Porter stem of `word`, EXCEPT when that stem lands in `COMMERCIAL_DENYLIST_STEMS` — in that
 * case the word's own exact lowercased form is returned instead, so two words that both happen to
 * stem to a denylisted root (e.g. "stocking" and "stock") are compared literally, not by their
 * shared stem. See `COMMERCIAL_DENYLIST_WORDS`'s docblock for why.
 */
function comparableForm(word: string): string {
  const stem = porterStem(word);
  return COMMERCIAL_DENYLIST_STEMS.has(stem) ? word.toLowerCase() : stem;
}

function isCommercialWord(word: string): boolean {
  return COMMERCIAL_DENYLIST_STEMS.has(porterStem(word));
}

/** Indices into `words` (a full, unfiltered token list) of every `POLARITY_WORDS` occurrence that
 * sits within `POLARITY_RESCUE_WINDOW` positions of a commercial-denylist word — see
 * `POLARITY_WORDS`'s own docblock for why these need rescuing from the ordinary stopword filter
 * specifically near a commercial term, and not everywhere. */
function polarityRescuedIndices(words: readonly string[]): ReadonlySet<number> {
  const rescued = new Set<number>();
  words.forEach((word, i) => {
    if (!POLARITY_WORDS.has(word)) return;
    for (let d = 1; d <= POLARITY_RESCUE_WINDOW; d++) {
      if ((words[i - d] && isCommercialWord(words[i - d]!)) || (words[i + d] && isCommercialWord(words[i + d]!))) { rescued.add(i); return; }
    }
  });
  return rescued;
}

/** Every CONTENT word (letters only) in `text`, lowercased, with `STOPWORDS` removed — the words
 * whose presence in the brief actually carries a fact, per this section's docblock — EXCEPT a
 * `POLARITY_WORDS` occurrence next to a commercial term is never dropped, per that set's own
 * docblock (dropping "out" in "out of stock" would make it indistinguishable from "in stock"). */
function contentWordsOf(text: string): string[] {
  const words = allWordTokensOf(text);
  const rescued = polarityRescuedIndices(words);
  return words.filter((word, i) => !STOPWORDS.has(word) || rescued.has(i));
}

/**
 * A round-9 re-audit (storefront-r6-grok.md BLOCK 1) found the polarity mechanism above was still
 * a BAG OF WORDS: it asked only whether "stock" and, separately, a rescued "out"/"no" each occur
 * SOMEWHERE in the brief — never whether they sit on the SAME claim. Against a brief that happens
 * to contain both words for unrelated reasons (`rich.txt`'s "while stock lasts" and "no preorder
 * needed"), every one of these passed clean with Jev returning no flags: "No longer in stock."
 * (the widened window rescues "no", but nothing checks it is "no" NEXT TO "stock" in the brief,
 * only that "no" occurs at all); "Back in stock." ("back" is not even a polarity word, so any
 * brief mentioning "stock" at all licenses it); "Orders ship on us." (a free-shipping claim
 * spelled with the brief's own verb "ship" plus the brief's own "on"). The REVERSE flip passes
 * too: a brief that only ever says "out of stock" still licenses a page that says "in stock.",
 * because "in" was never a polarity word, so the page's own "out" is simply never looked for.
 *
 * `COMMERCIAL_MODIFIER_WORDS` adds `'back'` to `POLARITY_WORDS` for this gate specifically (not
 * for `polarityRescuedIndices`/`contentWordsOf`, which a quote's full word-tracing check still
 * uses unchanged — a quote already requires every content word, "back" included, to trace to the
 * brief on its own terms). `commercialOccurrencesOf` finds, for each `COMMERCIAL_DENYLIST_WORDS`
 * occurrence, the nearest modifier within `POLARITY_RESCUE_WINDOW` and pairs them into one SPAN
 * (the token range from whichever of the two comes first through whichever comes second, in the
 * text's own order — "no longer in stock", "back in stock", "ship on" for "ship on us"; the
 * commercial word alone when no modifier is close enough — "stock", "free"). `deterministicCommercialWordFlags`
 * (below) requires that EXACT span, as a contiguous word sequence, to occur in the brief — not
 * just its two ends separately — which closes every BLOCK-1 example: none of "no longer in
 * stock", "back in stock" or "ship on" is a literal run of brief words in a brief that never
 * states them, however freely its OWN words for "no"/"back"/"stock"/"ship"/"on" are scattered
 * elsewhere. The reverse flip closes the same way from the brief's side: when the PAGE'S own
 * occurrence carries no nearby modifier (a bare "stock" claim), the brief must show that SAME
 * word with no modifier nearby at least once too — a brief whose only occurrences of "stock" all
 * carry "out"/"no" beside them never licenses a bare, unmodified claim on the page, because there
 * is no bare occurrence to point to.
 */
const COMMERCIAL_MODIFIER_WORDS: ReadonlySet<string> = new Set([...POLARITY_WORDS, 'back']);

/** One `COMMERCIAL_DENYLIST_WORDS` occurrence in a `wordsWithClauseOf` token array, paired with
 * the nearest `COMMERCIAL_MODIFIER_WORDS` token within `POLARITY_RESCUE_WINDOW` positions either
 * side AND in the SAME clause (whichever distance is smaller; `undefined` when none is close
 * enough or every candidate sits in a different clause). See `COMMERCIAL_MODIFIER_WORDS`'s own
 * docblock for why a paired occurrence becomes a SPAN rather than two independently-checked words,
 * and `wordsWithClauseOf`'s for why the clause match is required — a round-9 re-audit's own fix
 * (this function) at first paired rich.txt's "…stock lasts, no preorder…" across the comma,
 * treating the brief's own bare "stock" as modified and false-flagging an unrelated genuine "while
 * stock lasts" echo elsewhere on the same page. */
type CommercialOccurrence = { readonly word: string; readonly wordIndex: number; readonly modifierIndex?: number };

function commercialOccurrencesOf(words: ReadonlyArray<{ readonly word: string; readonly clause: number }>): CommercialOccurrence[] {
  const out: CommercialOccurrence[] = [];
  words.forEach((entry, i) => {
    if (!isCommercialWord(entry.word)) return;
    let modifierIndex: number | undefined;
    for (let d = 1; d <= POLARITY_RESCUE_WINDOW && modifierIndex === undefined; d++) {
      for (const j of [i - d, i + d]) {
        // A round-11 audit pass (storefront-r7-grok.md BLOCK 3) found "free" and "shipping" were
        // each checked as independently-bare commercial words, never paired: neither is a
        // `COMMERCIAL_MODIFIER_WORDS` term, so "feel free to email us" (bare "free") plus
        // "shipping takes three business days" (bare "shipping") elsewhere in the SAME brief
        // licensed a page's unrelated "Free shipping" — an invented discount the brief never
        // actually states, laundered through two independently-true bare words. A pairing
        // partner is now ANY other `COMMERCIAL_DENYLIST_WORDS` term too, not just a modifier —
        // "free" pairs with the nearer of a modifier or another commercial word — closing the
        // exact fix the audit itself named: "require the span between two commercial words
        // inside one clause, the same way 'ship on' is already required as a span."
        if (j >= 0 && j < words.length && words[j]!.clause === entry.clause && (COMMERCIAL_MODIFIER_WORDS.has(words[j]!.word) || isCommercialWord(words[j]!.word))) { modifierIndex = j; break; }
      }
    }
    out.push({ word: entry.word, wordIndex: i, modifierIndex });
  });
  return out;
}

/** The contiguous token span (inclusive of both ends) an occurrence with a modifier covers —
 * "no longer in stock" for `no(0) longer(1) in(2) stock(3)`'s `{wordIndex: 3, modifierIndex: 0}`. */
function spanOf(words: ReadonlyArray<{ readonly word: string }>, occurrence: CommercialOccurrence): string[] {
  if (occurrence.modifierIndex === undefined) return [occurrence.word];
  const start = Math.min(occurrence.wordIndex, occurrence.modifierIndex);
  const end = Math.max(occurrence.wordIndex, occurrence.modifierIndex);
  return words.slice(start, end + 1).map((entry) => entry.word);
}

/**
 * The CLAIM-token half of `deterministicQuoteFlags` alone (currency amounts, standalone numbers/
 * percents, star/rating marks — see that function's docblock) — every claim token in `slots` must
 * appear among the brief's own, or the slot is flagged. Unlike the full quote check, this does NOT
 * require every content word to trace to the brief: it is meant for GENERAL free-text prose (a
 * hero body, a product description, a footer tagline), which is legitimately paraphrased marketing
 * copy rather than a customer quote expected to echo the brief's own wording closely — applying
 * the full word-tracing check there produces false positives on ordinary paraphrase (see
 * `storefront-family.test.ts`'s fixture-drift-prevention tests for the worked proof). Claim
 * tokens are different: a genuinely new price, percentage or rating appearing in prose is always
 * suspicious regardless of how the surrounding sentence is worded, so checking claims-only stays
 * safe to run broadly across a whole page's prose without constraining how it is phrased.
 */
export function deterministicClaimFlags(brief: string, slots: readonly FaithfulnessSlot[], paths: ReadonlySet<string>): FlaggedSlot[] {
  const briefClaimTokens = new Set(claimTokensOf(brief.normalize('NFKC')));
  const out: FlaggedSlot[] = [];
  for (const slot of slots) {
    if (!paths.has(slot.path)) continue;
    if (claimTokensOf(slot.text).some((token) => !briefClaimTokens.has(token))) out.push({ path: slot.path, probability: 1 });
  }
  return out;
}

/**
 * The COMMERCIAL-WORD half of the same gate, on the same broadly-safe terms `deterministicClaimFlags`
 * is: every `COMMERCIAL_DENYLIST_WORDS` occurrence in `slots` must trace back to the SAME SPAN
 * (see `COMMERCIAL_MODIFIER_WORDS`'s docblock — a round-9 re-audit found the previous bag-of-words
 * version let the brief's own scattered "stock"/"no"/"out"/"on" bless an unrelated, opposite-
 * polarity page claim) among the brief's own words — every ordinary descriptive word is ignored,
 * so this stays safe to run across general prose (a price line, a hero, a shipping paragraph)
 * without requiring word-for-word tracing the way a review quote's full check does. A fourth audit
 * pass found these commercial claims reaching a live page entirely unchecked outside review
 * quotes — a price, shipping or stock/rating claim in the hero, description or shipping-returns
 * copy had no deterministic check on it at all.
 */
export function deterministicCommercialWordFlags(brief: string, slots: readonly FaithfulnessSlot[], paths: ReadonlySet<string>): FlaggedSlot[] {
  const briefClauseWords = wordsWithClauseOf(brief);
  const briefWords = briefClauseWords.map((entry) => entry.word);
  const briefOccurrences = commercialOccurrencesOf(briefClauseWords);
  // Every commercial word the brief itself states with NO modifier nearby (a bare, unmodified
  // claim) — a page occurrence with no modifier of its own may point only at one of these, not
  // merely at the word's existence somewhere in the brief (see the reverse-flip case above).
  const briefBareWords = new Set(briefOccurrences.filter((occ) => occ.modifierIndex === undefined).map((occ) => occ.word));
  const out: FlaggedSlot[] = [];
  for (const slot of slots) {
    if (!paths.has(slot.path)) continue;
    const words = wordsWithClauseOf(slot.text);
    const unsupported = commercialOccurrencesOf(words).some((occ) => (
      occ.modifierIndex === undefined ? !briefBareWords.has(occ.word) : !containsWordSequence(briefWords, spanOf(words, occ))
    ));
    if (unsupported) out.push({ path: slot.path, probability: 1 });
  }
  return out;
}

export function deterministicQuoteFlags(brief: string, slots: readonly FaithfulnessSlot[], quotePaths: ReadonlySet<string>): FlaggedSlot[] {
  const normalizedBrief = brief.normalize('NFKC');
  const briefClaimTokens = new Set(claimTokensOf(normalizedBrief));
  // Every content word of the brief's own, unfiltered by STOPWORDS (a quote's content word is
  // always checked against every word the brief actually uses, stopword or not — filtering only
  // decides which of the QUOTE's own words are worth checking at all).
  const briefComparableForms = new Set<string>();
  const briefRawWords = new Set(allWordTokensOf(normalizedBrief));
  for (const word of briefRawWords) briefComparableForms.add(comparableForm(word));

  const out: FlaggedSlot[] = [];
  for (const slot of slots) {
    if (!quotePaths.has(slot.path)) continue;
    const claimTokens = claimTokensOf(slot.text);
    const contentWords = contentWordsOf(slot.text);
    const unsupportedClaim = claimTokens.some((token) => !briefClaimTokens.has(token));
    const unsupportedWord = contentWords.some((word) => !briefComparableForms.has(comparableForm(word)) && !briefRawWords.has(word));
    // A quote carrying no CLAIM token and no CONTENT word (a run of otherwise-unrecognized glyphs,
    // stray punctuation, or an empty/whitespace-only slot) must not pass by default just because
    // there was nothing to check — verbatim brief presence is required instead. A third audit
    // pass named this explicitly: "symbol-only quotes must flag unless verbatim-present in brief."
    const symbolOnly = claimTokens.length === 0 && contentWords.length === 0;
    const symbolOnlyUnverified = symbolOnly && slot.text.trim().length > 0 && !normalizedBrief.includes(slot.text.normalize('NFKC').trim());
    if (unsupportedClaim || unsupportedWord || symbolOnlyUnverified) out.push({ path: slot.path, probability: 1 });
  }
  return out;
}

/**
 * A small, closed stopword list for `deterministicTraceableFlags` and
 * `deterministicSentenceClaimFlags` — deliberately not the same `STOPWORDS` set
 * `contentWordsOf`/`deterministicQuoteFlags` use (that list is tuned for a QUOTE's paraphrase
 * tolerance, including contractions this list has no need for). A `x-verify: 'traceable'` row (a
 * practical-fact row, a gallery label, a place card, a descriptor) or a claim-bearing SENTENCE is
 * short, plain prose, not conversational paraphrase, so it needs only the ordinary function words
 * and insubstantial emphasis adverbs every sentence carries — "just"/"only"/"now" around a real,
 * correctly-stated price ("Just $248.") add no fact of their own and must not be treated as one.
 * A round-11 audit pass found the ORIGINAL, narrower version of this list (without the emphasis
 * adverbs on the second line) false-flagged exactly that case.
 */
const TRACEABLE_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'for', 'with', 'to', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'at', 'by',
  'from',
  'just', 'only', 'now', 'still', 'already', 'right', 'very', 'really', 'so', 'too', 'also', 'here',
  'today', 'currently', 'simply', 'truly', 'actually',
  // g6-r3-opus55 audit (BLOCK B2): a round-5 addition put "about" and the universal pronoun forms
  // ("everyone"/"anyone"/"everybody"/"anybody") here, reasoning they were pure hedges/pronouns
  // with no content of their own. The audit proved that wrong with a live counter-example: a
  // brief restricting attendance ("Open to members on Thursdays.") against a page reading "Open
  // to everyone on Thursdays." is an invented WIDENING of who is admitted, and stemmed "about"
  // absorbs a real distance/duration discrepancy too ("Walk takes two hours" vs a page reading
  // "About an hour from the station" is an invented shortening, not a hedge on the same fact).
  // Both words DO carry content that can change what is claimed — REMOVED, per this file's own
  // standing rule (this list's own header comment, and `run.ts`'s "never loosen a shared list to
  // clear a fixture") — never re-add them without a case that proves the word can never change a
  // claim's scope, not just that it usually doesn't.
  // `practice`'s own insurance/services/credential traceable rows (round-1 live-build audit,
  // TL.01/TL.02) found ordinary first- and second-person pronouns and two prepositions missing
  // entirely — a paraphrase this deterministic check must accept ("Our front desk verifies your
  // benefits", "Delta Dental, Cigna and MetLife are among the plans we accept") false-flagged on
  // "our"/"your"/"we"/"among" alone, none of which state a fact of their own the way a name,
  // number or noun does. A round-2 audit (goal watcher) found the FIRST version of this addition
  // went much further than that: it also added every quantifier (all/every/most/any/each/some/
  // many/other/others) and several content verbs (offers/provides/includes/gives and their
  // inflections) — words that DO carry meaning a brief can state or omit ("free shipping on
  // every order" is a materially different, wider claim than "free shipping on orders over $50",
  // and a quantifier stopword let that widening through unflagged). Those are removed; only pure
  // function words with no content of their own — pronouns and prepositions — are added here.
  'we', 'our', 'us', 'you', 'your', 'they', 'their', 'i', 'my', 'me',
  'among', 'between',
  // Round 4 (guide, live Cerebras build on the sparse Lowmoor Crossing brief): a gallery label
  // naming a real, brief-stated landmark and its own brief-stated location — "Stone bridge over
  // Lowmoor Beck", both "stone", "bridge" and "Lowmoor Beck" straight from the brief's own words
  // — false-flagged on "over" alone, a pure spatial preposition with no fact of its own, the same
  // category `among`/`between` were added for above. Confirmed empirically this is the ONLY word
  // failing to trace in that exact sentence (see `jev.test.ts`'s own test for this fixture-derived
  // case). "across" is added alongside it: the same live build's own repair rounds independently
  // reached for it too ("Stone bridge across Lowmoor Beck"), and it fails to trace for the
  // identical reason.
  'over', 'across',
  // Round-4 Grok audit (guide-r2): contractions of the same pronouns/copula already exempted
  // above ("we"/"you"/"they" + "is"/"are"/"will") are pure function words too, with no content of
  // their own — a live-fixture finding (practice's insurance detail: brief "before billing", a
  // faithful paraphrase "before you're billed") false-flagged on the contraction alone.
  "you're", "we're", "it's", "they're", "we'll", "you'll",
  // "across" stays an unconditional stopword (a round-4 live guide build's own repair rounds
  // independently reached for it, "Stone bridge across Lowmoor Beck", for the identical spatial
  // reason "over" was added). "over" is REMOVED from this flat set as of the round-4 Grok audit
  // (guide-r2): a round-4 Grok audit found the SAME word hides a comparative/threshold sense
  // ("returned over thirty days" against a brief that only ever says "within thirty days" would
  // silently pass, since "over" was dropped before the trace and the number still matched). "over"
  // is now checked CONTEXTUALLY by `traceableContentWordsOf` below — a stopword only when it is
  // NOT immediately followed by a number, a number word, or a duration/distance unit, so the
  // spatial case ("Stone bridge over Lowmoor Beck") still passes exactly as before, while the
  // threshold case still requires "over" itself to trace.
  'across',
]);
/** The threshold sense of "over" ("over thirty days", "over 2 hours", "over a mile") that must
 * stay a traced word — see `TRACEABLE_STOPWORDS`'s own docblock for the false-negative this
 * guards against. Reuses the same tens/number-word vocabulary `NUMBER_WORD_SIGNAL_WORDS` and
 * `DISTANCE_STEM_WORDS` already declare below, so a new signal word added there also sharpens
 * this check for free. */
const OVER_THRESHOLD_AFTER_RE = new RegExp(
  `^(?:\\d|a\\b|an\\b|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|${TENS_ALT}|dozen|dozens|couple|few|several|hundred|half|twice|minute|minutes|hour|hours|day|days|week|weeks|mile|miles|km|kilomet)`,
  'i',
);
/**
 * g6-sol-r11 audit (arbiter ruling on g6-r3b-opus55's BLOCK-2 fix): the round-10 "date context"
 * gate (canonicalize on EITHER side when a digit sits within ~12 characters) was itself unsafe —
 * Sol's own counterexample, brief "Sun deck: 4 seats. Open Saturday at 4pm." against page "Open
 * Saturday and Sunday at 4pm.", has "Sun" sitting right next to the digit "4" in "Sun deck: 4
 * seats" for a completely unrelated reason (a deck that seats four, not a date), so the gate
 * promoted it to "Sunday" anyway and manufactured Sunday hours the brief never states (main flags
 * this 1/1; the date-context version scored 0/0). There is no reliable proximity heuristic that
 * distinguishes a genuine date ("Thu 2 Oct") from an unrelated digit that merely happens to sit
 * near an ordinary word — so brief-side promotion is removed AGAIN, this time with no date-context
 * exception: PAGE-SIDE ONLY, unconditionally, same as `UNIT_ABBREVIATION_CANONICAL`/
 * `ABBREVIATION_EXPANSIONS` below. A page abbreviation may still match a brief's own full day or
 * month name ("Mon–Fri" on the page against "Monday-Friday" in the brief) — never the reverse. The
 * round-10 real-fixture regression this was trying to fix (halcyon/wrenfield writing the SAME
 * abbreviation, "Thu 2 Oct", on both sides) is an ACCEPTED residual now (see the ledger's Round 11
 * section) rather than a second unsafe heuristic.
 */
const CALENDAR_CANONICAL: ReadonlyMap<string, string> = new Map([
  ['mon', 'monday'], ['tue', 'tuesday'], ['tues', 'tuesday'], ['wed', 'wednesday'],
  ['thu', 'thursday'], ['thur', 'thursday'], ['thurs', 'thursday'], ['fri', 'friday'],
  ['sat', 'saturday'], ['sun', 'sunday'],
  ['jan', 'january'], ['feb', 'february'], ['mar', 'march'], ['apr', 'april'], ['jun', 'june'],
  ['jul', 'july'], ['aug', 'august'], ['sep', 'september'], ['sept', 'september'], ['oct', 'october'],
  ['nov', 'november'], ['dec', 'december'],
]);

/**
 * Live-build finding (G8 Cerebras replay, wrenfield's own "step1Body": brief "a free 60-90 minute
 * walkthrough", a model paraphrase reaching for "60-90 min"/"60-90 mins" reads as a routine unit
 * abbreviation, not an invented duration) and the fixture-audit finding ("6 hrs" against a brief's
 * own "6 hours"): a small, closed DURATION unit-abbreviation table. Page-side only (see
 * `CALENDAR_CANONICAL`'s own doc for why — the identical two-way-promotion risk applies here: an
 * unrelated brief word must never be silently promoted into a duration unit).
 */
const UNIT_ABBREVIATION_CANONICAL: ReadonlyMap<string, string> = new Map([
  ['hr', 'hour'], ['hrs', 'hours'], ['min', 'minute'], ['mins', 'minutes'],
]);

/**
 * A single abbreviated word standing for SEVERAL real words, every one of which must itself trace
 * — unlike `CALENDAR_CANONICAL`/`UNIT_ABBREVIATION_CANONICAL` (one word for one word), this maps
 * one word to a whole phrase. Fixture-audit finding (wrenfield's own license badge, "Licensed GC"
 * against a brief that only ever spells out "a general contractor"): "GC" is standard trade
 * shorthand for "general contractor", not an invented credential — expanding it here, rather than
 * exempting it, means a brief that never mentions being a contractor AT ALL still correctly fails
 * this trace. Page-side only, for the same two-way-promotion reason `CALENDAR_CANONICAL`'s own
 * doc gives: an unrelated brief use of "GC" (a different family, a different acronym) must never
 * silently manufacture "general"/"contractor" as brief-supported words.
 */
const ABBREVIATION_EXPANSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['gc', ['general', 'contractor']],
]);

/** Every content word of `text` a `deterministicTraceableFlags`/`deterministicSentenceClaimFlags`
 * slot must trace — the same `TRACEABLE_STOPWORDS` filter as before, except "over" is filtered
 * out (kept as a stopword) only when it is NOT a numeric/duration threshold (see
 * `OVER_THRESHOLD_AFTER_RE`'s own doc). g6-r3b-opus55 audit: the existential-"there" exemption
 * (BLOCK-1) and the percent-suffix drop (FIX F-a) are BOTH removed — see their own removal notes
 * at this function's call sites. `canonicalizePage` (default `false`) gates
 * `CALENDAR_CANONICAL`/`UNIT_ABBREVIATION_CANONICAL`/`ABBREVIATION_EXPANSIONS`: only the PAGE side
 * of a trace ever canonicalizes an abbreviation into its full word(s); the brief side is always
 * read as its own literal words (see those constants' own docs for the two-way-promotion risk
 * this closes). Uses `WORD_TOKEN_RE` directly (not `allWordTokensOf`) so each match's own
 * surrounding context can be inspected — `allWordTokensOf` discards match positions entirely. */
function traceableContentWordsOf(text: string, canonicalizePage: boolean = false): string[] {
  return traceableWordMatchesOf(normalizeForWords(text)).flatMap(({ word }) => (canonicalizePage ? canonicalFormsOf(word) : [word]));
}

/** Every content word `traceableContentWordsOf` keeps, un-canonicalized, read from
 * `normalized` (already `normalizeForWords`-normalized) — the one filter both the brief side and
 * the page side of a trace read. */
function traceableWordMatchesOf(normalized: string): Array<{ word: string }> {
  const out: Array<{ word: string }> = [];
  for (const match of normalized.matchAll(WORD_TOKEN_RE)) {
    const word = match[0].toLowerCase();
    const at = match.index ?? 0;
    if (word === 'over') {
      const after = normalized.slice(at + match[0].length).trimStart();
      if (OVER_THRESHOLD_AFTER_RE.test(after)) { out.push({ word }); continue; }
      continue; // spatial/ordinary "over": stays a stopword, same as before this fix.
    }
    if (TRACEABLE_STOPWORDS.has(word)) continue;
    out.push({ word });
  }
  return out;
}

/** The page-side canonical form(s) of one word: an `ABBREVIATION_EXPANSIONS` phrase, a
 * `CALENDAR_CANONICAL`/`UNIT_ABBREVIATION_CANONICAL` full word, or the word itself. */
function canonicalFormsOf(word: string): readonly string[] {
  const expansion = ABBREVIATION_EXPANSIONS.get(word);
  if (expansion) return expansion;
  return [CALENDAR_CANONICAL.get(word) ?? UNIT_ABBREVIATION_CANONICAL.get(word) ?? word];
}

/** The page words of `text` that do not trace to the brief — the one per-word rule
 * `deterministicTraceableFlags` and `deterministicSentenceClaimFlags` share. Page-side
 * canonicalization (`canonicalFormsOf`) is unconditional, exactly as g6-sol-r11 ruled: two G8
 * dry-run attempts to accept a verbatim brief date as written (a neighbour-pair rule, then a
 * whole-span rule) were both ruled unsafe by Sol (g8fix-jev-sol-ruling.md, -ruling2.md) — a
 * date or "number unit" copied from one brief fact can be attached to another. Verbatim dates live
 * in `x-verify: 'exact-date'` slots instead (`exact-date.ts`). */
function untracedPageWordsOf(text: string, briefStems: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const { word } of traceableWordMatchesOf(normalizeForWords(text))) {
    for (const form of canonicalFormsOf(word)) if (!briefStems.has(porterStem(form))) out.push(form);
  }
  return out;
}

/**
 * g6-r3b-opus55 audit (FIX F-a): "percent"/"pct" is no longer dropped from the page side at all
 * (the old `PERCENT_BEFORE_RE` unconditional-drop let ANY number's percent suffix pass regardless
 * of which underlying fact it was attached to — main never had this exemption and a spelled-out
 * "percent" simply had to appear literally in the brief, same as any other word). Instead, the
 * brief's own word set gains the literal word "percent" whenever the brief text contains a `%`
 * character anywhere — a narrow, symmetric FORMAT equivalence ("%" the symbol and "percent" the
 * word are the same unit), not a scope-widening exemption: the NUMBER itself is untouched and
 * still needs `deterministicClaimFlags`'s own claim-token check to agree, exactly as before this
 * fix.
 */
function briefWordsWithPercentEquivalence(brief: string): string[] {
  const words = traceableContentWordsOf(brief);
  if (/%/.test(brief)) words.push('percent');
  return words;
}

/**
 * A deterministic supplement to the LLM faithfulness judge for slots `spine.ts`'s
 * `traceablePathsFor` marks `x-verify: 'traceable'` (a round-10 audit pass, item 7; round-11 item
 * A widened its adoption to storefront's own price/shipping/stock/product-detail rows — a new
 * SHARED marker for `guide` and any other family to adopt on practical-fact rows, gallery labels,
 * place cards and descriptors, not just this repo's storefront family). Deliberately positioned
 * between `deterministicQuoteFlags` (every content word AND a verbatim run required) and Jev
 * alone (probabilistic, known to miss a plausible-sounding invented detail): every stemmed
 * content word of the slot — filtered only by the small `TRACEABLE_STOPWORDS` list above, not the
 * full `STOPWORDS` set — must appear, among the brief's own stemmed content words. No verbatim
 * contiguous run is required (unlike a quote), and no claim token is checked here on its own (a
 * traceable row's own numbers are already covered, family-wide, by `deterministicClaimFlags`,
 * which this function does not duplicate).
 *
 * Stemmed with PLAIN `porterStem`, never `comparableForm` — a round-11 audit pass (storefront-
 * r7-grok.md FIX) found `comparableForm`'s `COMMERCIAL_DENYLIST_STEMS` override (which forces
 * `ship`/`shipping`/`review`/`reviews` etc. to compare EXACTLY, unstemmed, specifically to close a
 * different collision — see `COMMERCIAL_DENYLIST_WORDS`'s own docblock) false-flagged a perfectly
 * faithful paraphrase on a `traceable` slot: a brief that says "ships within three business days"
 * does not exact-match a page that says "shipping within three business days", even though both
 * stem to "ship" under ordinary English morphology. `deterministicCommercialWordFlags`'s own
 * denylist-collision risk (a knit "stocking" licensing an unrelated "in stock" claim) does not
 * apply here: this function requires EVERY content word to trace, not just a denylist word's own
 * presence, so a coincidental stem collision on one word is not enough to pass a slot whose other
 * words do not also trace.
 *
 * This function only FLAGS; it does not decide what happens next. Whether a flagged row is then
 * dropped (when the family marks it nullable) or rewritten in neutral wording (when it is
 * required) is the SAME repair policy `FAITHFULNESS_RULE` (`run.ts`) already applies to every
 * other deterministic flag — no new drop-vs-flag branching is needed here.
 */
export function deterministicTraceableFlags(brief: string, slots: readonly FaithfulnessSlot[], traceablePaths: ReadonlySet<string>): FlaggedSlot[] {
  const briefStems = new Set(briefWordsWithPercentEquivalence(brief).map((word) => porterStem(word)));
  const out: FlaggedSlot[] = [];
  for (const slot of slots) {
    if (!traceablePaths.has(slot.path)) continue;
    // No content word at all: nothing here asserts a fact, and `untracedPageWordsOf` finds none.
    if (untracedPageWordsOf(slot.text, briefStems).length > 0) out.push({ path: slot.path, probability: 1 });
  }
  return out;
}

/**
 * The hours-row day-label gate lives in `hours-label.ts` (G8 final: it now requires the label's day
 * SET to equal the day set the brief states for that row, not just day words found somewhere in
 * the brief). Re-exported here so every caller keeps importing the deterministic gates from one place.
 */
export { deterministicHoursLabelFlags } from './hours-label.ts';

const DESTINATION_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digitsOf = (text: string): string => text.replace(/\D/g, '');

/** Every `http(s)://…` run in `text`, stopping at whitespace or an enclosing bracket/quote. */
const URL_TOKEN = /https?:\/\/[^\s<>()"'“”]+/gi;
/** Every `local@domain.tld`-shaped run in `text` (the same shape `DESTINATION_EMAIL` requires). */
const EMAIL_TOKEN = /[^\s<>()"'@]+@[^\s<>()"'@]+\.[^\s<>()"'@]+/g;
/** A run of 7+ digits with only phone-number punctuation between them, an optional leading `+`. */
const PHONE_TOKEN = /\+?\(?[0-9][0-9 ().-]{5,}[0-9]/g;
/**
 * `raw`, with trailing sentence punctuation removed: a URL or email at the end of a clause reads
 * `…/appointments.` or `…willowcreekdental.example.` in ordinary prose, and the regex that finds
 * it has no way to know the final `.`, `,`, `;`, `:`, `!`, or `?` belongs to the SENTENCE, not the
 * address — greedily keeping it produced a real false negative here (a genuine `frontdesk@
 * willowcreekdental.example` sentence-final email failed to trace to its own brief because the
 * extracted token was `…example.`, one character too many).
 */
function stripTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, '');
}

/** Every `[start, end)` span `re` matches in `text`. */
function matchSpans(text: string, re: RegExp): Array<[number, number]> {
  return [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);
}
/** Whether `[start, end)` overlaps any span in `spans`. */
function overlapsAny(start: number, end: number, spans: ReadonlyArray<readonly [number, number]>): boolean {
  return spans.some(([s, e]) => start < e && end > s);
}

/**
 * `raw` (a `http(s)://…` string) normalized for equality: scheme and host lowercased, a trailing
 * `/` on the path dropped — so `https://Acme.com/Book/` and `https://acme.com/Book` compare
 * equal, but `https://acme.com/book` and `https://booking.acme.com/book` (a different host) do
 * not, and `https://acme.com/book` and `https://acme.com/appointments` (a different path) do not.
 * `null` when `raw` does not parse as a URL at all (never treated as a match for anything).
 */
function normalizedUrlToken(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * Whether two phone numbers' digit strings name the same number: exactly equal, or equal once a
 * single leading `1` (a US/Canada country code) is stripped from whichever side has it — so
 * `5035550142` and `15035550142` match, but nothing looser (a truncated or transposed number
 * never matches just because it shares a run of digits with a longer one).
 */
function phonesEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === b.length + 1 && a.startsWith('1') && a.slice(1) === b) return true;
  if (b.length === a.length + 1 && b.startsWith('1') && b.slice(1) === a) return true;
  return false;
}

/**
 * A deterministic supplement to the LLM faithfulness judge for slots a family schema marks
 * `x-verify: 'destination'` (`spine.ts`'s `destinationPathsFor`): a book/contact destination the
 * page turns into a live `tel:`/`mailto:`/`https:` link must be an EXACT URL, email, or phone
 * that appears in the brief. Added for `practice`, which distinguishes this from `deterministic
 * ContactFlags`'s ordinary `email`/`phone`/`url` atom kinds because a `practice` destination is
 * marked `x-atom: 'destination'` (a fourth, family-specific kind `contactPathsFor`'s
 * `ContactKind` union never carries), so `deterministicContactFlags` never reaches it even though
 * it is exactly as fabricable as any other contact atom — a plausible-looking but invented
 * destination (a booking URL, a phone number) is exactly as cheap for a model to fabricate and
 * exactly as costly to ship: a visitor who clicks or calls it reaches nothing real. Checked by
 * TOKEN EQUALITY, never substring `includes`, the same discipline `deterministicContactFlags`
 * documents at length for the same reason: an earlier substring-based version accepted
 * `555-0142` because `5035550142` contains `5550142`, and `https://willowcreekdental.example/
 * appointments` because the brief's own URL contains that string as a substring — both
 * truncations that are NOT the real number/URL the brief gives. Every URL, email, and phone-shaped
 * token in the brief is extracted and normalized once (`URL_TOKEN`/`EMAIL_TOKEN`/`PHONE_TOKEN`); a
 * destination must equal one of them exactly (a URL by `normalizedUrlToken`, an email case-
 * insensitively, a phone by `phonesEqual`'s digits, which allows only a leading country-code `1`
 * to differ). Classified by shape in the SAME order `render.ts`'s `bookHref` uses — an
 * `http(s)://` scheme checked before an `@` — since a URL can legitimately carry an `@` in its
 * path, query or userinfo and must never be treated as an email on that account alone.
 * `PHONE_TOKEN` never harvests a digit run that sits INSIDE a URL or email span: `https://
 * booking.example/visit/15035550199` names no phone at all, but the path segment reads exactly
 * like one, leading-`1` allowance included, and a naive scan of the whole brief text would accept
 * `5035550199` as a real phone number for it. Contract-level format validation (`contract.ts`'s
 * `field()`) already guarantees the text is a well-formed one of the three before this ever runs.
 */
export function deterministicDestinationFlags(brief: string, slots: readonly FaithfulnessSlot[], destinationPaths: ReadonlySet<string>): FlaggedSlot[] {
  const briefUrls = new Set([...brief.matchAll(URL_TOKEN)].map((m) => normalizedUrlToken(stripTrailingPunctuation(m[0]))).filter((v): v is string => v !== null));
  const briefEmails = new Set([...brief.matchAll(EMAIL_TOKEN)].map((m) => stripTrailingPunctuation(m[0]).toLowerCase()));
  // A phone-shaped run of digits INSIDE a URL or email span (a path segment, a query value) is
  // not a phone number the brief gave — e.g. `https://booking.example/visit/15035550199` names
  // no phone at all, but the bare digit run reads exactly like one, `1` leading-country-code
  // allowance included. Spans already claimed by a URL or email are excluded before phones are
  // even harvested.
  const nonPhoneSpans = [...matchSpans(brief, URL_TOKEN), ...matchSpans(brief, EMAIL_TOKEN)];
  const briefPhones = [...brief.matchAll(PHONE_TOKEN)]
    .filter((m) => !overlapsAny(m.index!, m.index! + m[0].length, nonPhoneSpans))
    .map((m) => digitsOf(m[0]))
    .filter((d) => d.length >= 7);
  const out: FlaggedSlot[] = [];
  for (const slot of slots) {
    if (!destinationPaths.has(slot.path)) continue;
    const value = slot.text.trim();
    if (!value) continue;
    // URL first, exactly matching bookHref's own classification order (see this function's doc).
    if (/^https?:\/\//i.test(value)) {
      const normalized = normalizedUrlToken(value);
      if (normalized === null || !briefUrls.has(normalized)) out.push({ path: slot.path, probability: 1 });
      continue;
    }
    if (DESTINATION_EMAIL.test(value)) {
      if (!briefEmails.has(value.toLowerCase())) out.push({ path: slot.path, probability: 1 });
      continue;
    }
    const digits = digitsOf(value);
    if (!briefPhones.some((briefPhone) => phonesEqual(briefPhone, digits))) out.push({ path: slot.path, probability: 1 });
  }
  return out;
}

/**
 * A round-11 audit pass (storefront-r7-grok.md — "stop adding phrasings one at a time") replaced
 * the open-vocabulary approach the earlier rounds kept extending (each round finding one more
 * unlisted commercial word or number-word shape) with a STRUCTURAL one: split every free-prose
 * slot into sentences, and require FULL word-tracing — the same standard `deterministicTraceableFlags`
 * already holds a `'traceable'`-marked slot to — for any sentence that carries a commercial or
 * numeric SIGNAL at all. A sentence with no such signal stays ordinary free prose, exactly as
 * before (no tracing required); this is deliberately not a blanket word-list add, because the
 * SIGNAL detection (a digit, a number word, a currency/percent/star mark, or a stem from
 * `COMMERCIAL_STEM_LEXICON`) is a closed, structural test, not another word the audit happened to
 * name — "Half off" and "complimentary delivery" (residual open-word gaps a prior round's NOTE
 * named) are caught the same way "Free shipping" is: neither needs its own denylist entry, only a
 * sentence containing a lexicon stem ("off" stems from "off"; "complimentary"/"deliver" both have
 * lexicon entries) to trip the claim-bearing test, and then trace, exactly like every other
 * commercial sentence.
 */
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9"'“])|\n+/;

/** Splits `text` into sentences on a sentence-ending mark followed by whitespace and a capital
 * letter, digit or open quote — or on a blank line. A CTA with no punctuation at all ("Buy now")
 * is its own one sentence, same as any run of text with no sentence break in it. */
function splitSentences(text: string): string[] {
  return text.split(SENTENCE_SPLIT_RE).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

/**
 * Number words that trigger the claim-bearing test ON THEIR OWN, with no adjacent commercial unit
 * needed. Originally deliberately NOT "one" through "nineteen": those small counting words are
 * near-ubiquitous in ordinary descriptive prose ("one small Portland workshop", "two sewists
 * cutting patterns") that has nothing to do with a price, discount or rating; treating every one
 * of them as a claim signal reintroduced exactly the false-positive class round 10's own BLOCK 2
 * fix explicitly avoided for bare digit counts ("an ordinary spelled-out count elsewhere in prose
 * is never treated as a bare numeric claim" — see `NUMBER_WORD_STANDALONE_RE`'s own docblock).
 * Every audit-named example that round closed ("fifteen dollars", "Half off") already produces a
 * claim SIGNAL through `claimTokensOf` itself (the currency-word merge, the percent/rating
 * canonicalization) without needing "fifteen" or any other 1-19 word to double as an independent
 * trigger.
 *
 * A later round (guide's `places-to-see`, "Four must-see spots, a short walk from the harbor")
 * found the gap this left: a NON-commercial COUNT claim ("Four must-see spots") carries no
 * currency/percent/rating context at all, so it produced no claim signal whatsoever and a strict
 * build could publish an invented count of places uncaught. "two" through "twelve" — the range a
 * guide/travel-style count claim realistically uses — are added here despite the original
 * rationale, WITH the false-positive risk that rationale warned about now managed the way any
 * shared-lexicon change must be: every `SENTENCE_CLAIM_FAMILIES` family's own committed reference
 * fixture is swept for a false flag against this exact addition (see
 * `packages/agency-fast-lane/tests/guide-sentence-claims.test.ts` and the family fixture
 * faithfulness tests) before landing. "one" stays excluded: no fixture or live-build finding has
 * shown it produces an invented-count false NEGATIVE the way "four" did, and "one" is by far the
 * most common ordinary-prose counting word ("a one-page site", "one small workshop"), so
 * including it purely to be thorough — with no concrete finding requiring it — would reopen
 * exactly the false-positive class this whole exclusion exists to avoid. "thirteen" through
 * "nineteen" stay excluded for the same reason: no finding has named them, and `TENS_ALT`
 * (twenty and up) already covers the "rarer in ordinary prose" tier the original design kept.
 * "dozen", "couple", "few" and "several" are added alongside the numbers: each is a genuine
 * COUNT claim in ordinary usage ("a couple of shops", "several places to see") with no numeral at
 * all, the same gap "four" closed for spelled-out numbers.
 *
 * "double" is deliberately left OUT despite an earlier audit naming it: the reference fixture's
 * own "double-stitched seams" (an ordinary construction descriptor, not a multiplier claim)
 * false-flagged under it, and "double" alone with no OTHER commercial signal in the same sentence
 * (a genuine "double the warranty" always also carries a `COMMERCIAL_STEM_LEXICON` word) is a
 * vanishingly rare, degenerate case not worth that cost.
 */
const NUMBER_WORD_SIGNAL_WORDS: ReadonlySet<string> = new Set([
  ...TENS_ALT.split('|'), 'hundred', 'half', 'twice',
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  // 'dozens' (round-4 Grok audit, guide-r2): this Set is exact-match, not stemmed, so the plural
  // needs its own literal entry — 'dozen' alone did not also catch 'dozens of boats'.
  'dozen', 'dozens', 'couple', 'few', 'several',
]);

/**
 * Distance/proximity/duration stems a claim-bearing sentence may trip on — the DISTANCE analogue
 * of `COMMERCIAL_STEM_LEXICON` below, added for the same guide finding as the number-word
 * extension above: "a short walk from the harbor" states a proximity FACT with no number and no
 * commercial word at all, so it produced no claim signal whatsoever before this addition, and an
 * invented "within a short walk" or "a 10-minute drive" could publish uncaught even once the
 * number-word gap above was closed (a plain "walk to the green" carries no number to catch).
 * `kilomet`/`kilometr` covers both the American ("kilometer") and British/Commonwealth
 * ("kilometre") spellings, which stem differently under Porter's algorithm.
 *
 * `close`, `walk`, `short`, `quick`, `step`, `block` and `nearby` are deliberately left OUT of
 * this bare-stem list and checked only as PHRASES below (`CLOSE_TO_PROXIMITY_RE`,
 * `SHORT_QUICK_DISTANCE_RE`, `WALK_DIRECTION_RE`, `STEPS_OR_BLOCKS_AWAY_RE`, `NEARBY_PROXIMITY_RE`)
 * — a round-4 false-positive sweep over storefront/practice/guide's own committed fixtures AND a
 * live guide build found each one collides with an ordinary, non-distance sense far more often
 * than it names a proximity claim in free descriptive prose: `close` the VERB ("close the door",
 * "close for the season"), `walk` the idiom ("walks you through every option"), `short`/`quick` as
 * generic intensifiers with no distance noun at all ("a short health history", "a quick
 * question"), `step`/`block` as a literal field label ("Step 1", "Step 2" — practice's own
 * process-step items) rather than a walking distance, and `nearby` as a generic locational
 * modifier with no specific place named ("run by nearby farms", "nearby farms selling seasonal
 * produce" — a live guide sparse-brief build, not a fixture, false-flagged exactly this shape and
 * exhausted its repair budget over it). `near` alone is kept as a bare stem: no finding has shown
 * it collides this way ("near the future" is comparatively rare in place-descriptive prose, unlike
 * "nearby" as a bare locational adjective). Only the PHRASE shape ("close to <place>", "a
 * short/quick walk/drive/ride", "walk/drive/ride to/from <place>", "steps/blocks from/away",
 * "nearby the <place>"/"is/are/sits/stands nearby") actually asserts a distance fact, so each is
 * its own narrow regex rather than a bare stem — see `packages/agency-fast-lane/tests/guide-
 * sentence-claims.test.ts` for the false positives this narrowing exists to avoid.
 */
// Round-4 Grok audit (guide-r2): 'hike' and 'stroll' are added as bare stems (the same low-
// collision-risk tier as 'drive'/'ride' — a walking-distance verb with no common unrelated sense
// in place-descriptive prose, unlike 'walk' itself, which stays phrase-scoped for the idiom
// reason `WALK_DIRECTION_RE`'s own history already documents).
const DISTANCE_STEM_WORDS: readonly string[] = [
  'drive', 'ride', 'minute', 'hour', 'mile', 'km', 'kilometer', 'kilometre', 'near', 'away', 'hike', 'stroll',
];
const DISTANCE_STEM_LEXICON: ReadonlySet<string> = new Set(DISTANCE_STEM_WORDS.map((word) => porterStem(word)));
/** Distance signals that are multi-word PHRASES rather than bare stems — see
 * `DISTANCE_STEM_WORDS`'s own docblock for why each bare word alone is too broad. `trail` is
 * deliberately NOT a bare stem or its own phrase (round-4 Grok audit named it, but it is this
 * family's own committed place-name component — "Tide Pool Trail" — and would collide with a
 * proper noun far more often than it names a distance fact; "within walking distance" already
 * covers the shape the audit's own example needed). */
const CLOSE_TO_PROXIMITY_RE = /\bclose\s+to\b/i;
// Round-4 Grok audit: "a short breakwater walk" and "a short, easy walk" were not caught — the
// original pattern required `short`/`quick` to sit IMMEDIATELY before the distance noun. Up to
// two intervening words (with an optional comma) are now allowed between them.
const SHORT_QUICK_DISTANCE_RE = /\b(?:short|quick),?(?:\s+\w+){0,2}\s+(?:walk|drive|ride|distance|trip|way|hike|stroll)\b/i;
const WALK_DIRECTION_RE = /\b(?:walk|walks|walking|drive|drives|driving|ride|rides|riding)\s+(?:to|from)\b/i;
const STEPS_OR_BLOCKS_AWAY_RE = /\b(?:steps?|blocks?)\s+(?:from|away)\b/i;
const NEARBY_PROXIMITY_RE = /\bnearby\s+the\b|\b(?:is|are|sits|stands|located)\s+nearby\b/i;
// Round-4 Grok audit: "within walking distance of the dock" and "within reach" state a proximity
// fact with none of the other phrase shapes above (no short/quick, no to/from, no steps/blocks).
const WALKING_DISTANCE_RE = /\bwalking\s+distance\b/i;
const WITHIN_REACH_RE = /\bwithin\s+reach\b/i;
const DISTANCE_PHRASE_PATTERNS: readonly RegExp[] = [
  CLOSE_TO_PROXIMITY_RE, SHORT_QUICK_DISTANCE_RE, WALK_DIRECTION_RE, STEPS_OR_BLOCKS_AWAY_RE, NEARBY_PROXIMITY_RE,
  WALKING_DISTANCE_RE, WITHIN_REACH_RE,
];

/**
 * The commercial STEM lexicon a claim-bearing sentence may trip on (a round-11 audit pass, item
 * B) — computed by running `porterStem` over a representative WORD FORM list rather than hand-
 * writing stems, so a form the stemmer treats irregularly ("deliver" -> "deliv", "delivery" ->
 * "deliveri" — two DIFFERENT stems for the same family) is covered by including both forms here,
 * rather than by guessing the stemmer's own output.
 */
const COMMERCIAL_STEM_WORDS: readonly string[] = [
  'free', 'off', 'ship', 'shipping', 'ships', 'shipped', 'deliver', 'delivery', 'delivered',
  'stock', 'sold', 'sale', 'sales', 'save', 'saving', 'savings', 'discount', 'discounted', 'deal',
  'deals', 'return', 'returns', 'refund', 'refunds', 'warranty', 'warranties', 'guarantee',
  'guaranteed', 'rate', 'rated', 'rating', 'ratings', 'review', 'reviews', 'reviewed', 'star',
  'stars', 'complimentary', 'available', 'avail', 'order', 'ordering', 'orders', 'price', 'priced',
  'pricing', 'prices', 'cost', 'costs', 'per', 'extra', 'bonus', 'bonuses', 'gift', 'gifts', 'promo',
  'promotion', 'promotions', 'coupon', 'coupons', 'limit', 'limited', 'limits',
];
const COMMERCIAL_STEM_LEXICON: ReadonlySet<string> = new Set(COMMERCIAL_STEM_WORDS.map((word) => porterStem(word)));

/**
 * Award/credential words — a claim signal `isClaimBearingSentence` checks prose against (below).
 * Also consumed by `template-chrome.ts`'s `isClaimBearingHeading` for headings through g6-sol-r11;
 * that consumer was removed in g6-sol-r12 (see template-chrome.ts's own module docblock), but the
 * export stays public since this sentence check still needs it.
 */
export const CERTIFICATION_AWARD_WORDS: readonly string[] = [
  'certified', 'certification', 'certificate', 'award', 'awarded', 'winning', 'winner', 'accredited',
  'licensed', 'licence', 'license', 'approved', 'endorsed', 'recommended', 'starred',
];
const CERTIFICATION_AWARD_STEM_LEXICON: ReadonlySet<string> = new Set(CERTIFICATION_AWARD_WORDS.map((word) => porterStem(word)));

/**
 * g6-r3-opus55 audit (FIX F2): superlative words ("best", "top", "voted", "recognized",
 * "trusted", "leading", "most") used as a claim of standing rather than a plain quantifier — the
 * sentence signal for "Voted best remodeler in Raleigh.", "Nationally recognized for kitchen
 * design." and "The most trusted remodeler in Raleigh." (none of which carry a digit, currency,
 * percent, star mark or `COMMERCIAL_STEM_WORDS` term, so `isClaimBearingSentence` returned false
 * for every one of them before this fix, on EVERY family now that the sentence gate runs
 * unconditionally). Deliberately liberal: marking a sentence claim-bearing that is already fully
 * brief-supported costs nothing (it still traces, so no flag) — the risk direction here is a
 * MISSED claim, not a spurious one, so this list does not need the same narrow scoping
 * `TRACEABLE_STOPWORDS`/quantifier removals were about (which govern whether a WORD must trace,
 * not whether a sentence is even examined).
 */
export const SUPERLATIVE_CLAIM_WORDS: ReadonlySet<string> = new Set([
  'best', 'top', 'voted', 'recognized', 'recognised', 'trusted', 'leading', 'most',
]);

/** Whether `sentence` carries any commercial or numeric SIGNAL — see this section's own docblock
 * for what "signal" means and why a sentence with none of these stays ordinary free prose.
 * `claimTokensOf(sentence).length > 0` alone already covers "a digit" (with the SAME glued-
 * identifier guard `NUMBER_RE`/`PERCENT_ANY_RE` use, so a schema field's own digit — "body4",
 * "line1" — is never mistaken for a claim signal, exactly as it is never mistaken for a claim
 * TOKEN), "a currency, percent or star symbol" and "a currency, percent or star WORD" (a bare
 * "dollars"/"percent"/"star" with no adjacent number still produces a `cur:`/bare token via
 * `claimTokensOf`'s own final bare-currency pass) — so only the two signals `claimTokensOf` does
 * NOT itself recognize (a spelled-out number word by itself, and a commercial-stem word) are
 * checked separately below. A g6-r3-opus55 audit pass (FIX F2) added a third and fourth: an
 * award/credential word (`CERTIFICATION_AWARD_WORDS`) and a superlative-of-standing word
 * (`SUPERLATIVE_CLAIM_WORDS`) — this sentence check had neither before, so "Award-winning remodels
 * across Raleigh." and "The most trusted remodeler in Raleigh." sailed through unchecked on every
 * family. */
function isClaimBearingSentence(sentence: string): boolean {
  if (claimTokensOf(sentence).length > 0) return true;
  if (DISTANCE_PHRASE_PATTERNS.some((re) => re.test(sentence))) return true;
  const words = allWordTokensOf(sentence);
  return words.some((word) => (
    NUMBER_WORD_SIGNAL_WORDS.has(word) || COMMERCIAL_STEM_LEXICON.has(porterStem(word))
    || DISTANCE_STEM_LEXICON.has(porterStem(word)) || CERTIFICATION_AWARD_STEM_LEXICON.has(porterStem(word))
    || SUPERLATIVE_CLAIM_WORDS.has(word)
  ));
}

/** Repair guidance only (see `claimTraceGaps`): the words and marks in `sentence` that make
 * `isClaimBearingSentence` true — a digit run, a currency/percent/star mark, or a signal word
 * (number, commercial, distance, award or superlative). Reads the same lists; decides nothing. */
function claimSignalsOf(sentence: string): string[] {
  const out: string[] = [];
  for (const match of normalizeForWords(sentence).matchAll(/\d[\d,.:]*|[$€£¥₩₹%★☆⭐✩]/gu)) out.push(match[0]);
  for (const word of allWordTokensOf(sentence)) {
    if (NUMBER_WORD_SIGNAL_WORDS.has(word) || COMMERCIAL_STEM_LEXICON.has(porterStem(word)) || DISTANCE_STEM_LEXICON.has(porterStem(word))
      || CERTIFICATION_AWARD_STEM_LEXICON.has(porterStem(word)) || SUPERLATIVE_CLAIM_WORDS.has(word)) out.push(word);
  }
  return [...new Set(out)];
}

/**
 * Every claim-bearing sentence (`isClaimBearingSentence`) of a slot marked in `paths` must be
 * FULLY traceable — every stemmed content word (the same `TRACEABLE_STOPWORDS` filter and plain
 * `porterStem` `deterministicTraceableFlags` uses) present among the brief's own stemmed content
 * words. A non-claim sentence is never checked at all: this is deliberately NOT a whole-slot
 * traceability requirement (unlike `x-verify: 'traceable'`), because a free-prose slot (a hero, a
 * description, a CTA) is legitimately paraphrased marketing copy for everything else it says —
 * only the sentence that actually asserts a commercial or numeric fact needs to trace.
 */
export function deterministicSentenceClaimFlags(brief: string, slots: readonly FaithfulnessSlot[], paths: ReadonlySet<string>): FlaggedSlot[] {
  const briefStems = new Set(briefWordsWithPercentEquivalence(brief).map((word) => porterStem(word)));
  // Round-4 Grok audit (guide-r2): a differing GLUED CLOCK TIME ("5am" vs the brief's own "6am")
  // between the sentence and the brief must also fail the trace, not only a differing WORD — "5am"
  // tokenizes to the bare word "am" under `allWordTokensOf` (letters only, the digit is
  // invisible), so it traced identically to "6am" on this word-only check even after
  // `claimTokensOf` itself learned to see the difference (see `CLOCK_TIME_RE`'s own doc).
  // Deliberately scoped to `time:` tokens only, not every claim-token kind: a bare ordinal like
  // "Step 1"/"Step 2" (a fixed process-step LABEL, not a brief-stated fact — every `checkSlots`
  // path is checked here, chrome included, since this function has no label/chrome exemption of
  // its own) produces a `num:` token with nothing in the brief to match, and widening this
  // comparison to every claim-token kind turned that ordinary UI numbering into a false positive.
  const briefClockTimes = new Set(claimTokensOf(brief).filter((token) => token.startsWith('time:')));
  const out: FlaggedSlot[] = [];
  for (const slot of slots) {
    if (!paths.has(slot.path)) continue;
    const unsupported = splitSentences(slot.text).some((sentence) => sentenceClaimGapOf(sentence, briefStems, briefClockTimes) !== undefined);
    if (unsupported) out.push({ path: slot.path, probability: 1 });
  }
  return out;
}

/** Why one sentence fails `deterministicSentenceClaimFlags`, or `undefined` when it passes (not
 * claim-bearing, or claim-bearing and fully traced): the page words and clock times it states that
 * the brief does not. */
function sentenceClaimGapOf(sentence: string, briefStems: ReadonlySet<string>, briefClockTimes: ReadonlySet<string>): string[] | undefined {
  if (!isClaimBearingSentence(sentence)) return undefined;
  const missing = [
    ...untracedPageWordsOf(sentence, briefStems),
    ...claimTokensOf(sentence).filter((token) => token.startsWith('time:') && !briefClockTimes.has(token)).map((token) => token.slice('time:'.length)),
  ];
  return missing.length > 0 ? missing : undefined;
}

/**
 * Repair guidance only — never a gate. For a slot `deterministicSentenceClaimFlags` (or, with
 * `wholeSlot`, `deterministicTraceableFlags`) would flag, the sentence(s) that fail and the words
 * in each that the brief does not contain, so a repair prompt can name exactly what to change
 * (G8 dry run: a repair told only "reword neutrally" rewrote a claim sentence into another
 * untraced paraphrase, twice, and never converged). Reads the SAME per-word rule the gates use
 * (`untracedPageWordsOf`), so a value rewritten to clear this list clears the gate too. Empty when
 * the deterministic trace finds nothing (a flag Jev raised alone).
 */
export function claimTraceGaps(brief: string, text: string, wholeSlot: boolean = false): Array<{ sentence: string; missing: string[]; signals: string[] }> {
  const briefStems = new Set(briefWordsWithPercentEquivalence(brief).map((word) => porterStem(word)));
  if (wholeSlot) {
    const missing = untracedPageWordsOf(text, briefStems);
    return missing.length > 0 ? [{ sentence: text.trim(), missing: [...new Set(missing)], signals: [] }] : [];
  }
  const briefClockTimes = new Set(claimTokensOf(brief).filter((token) => token.startsWith('time:')));
  const out: Array<{ sentence: string; missing: string[]; signals: string[] }> = [];
  for (const sentence of splitSentences(text)) {
    const missing = sentenceClaimGapOf(sentence, briefStems, briefClockTimes);
    if (missing) out.push({ sentence, missing: [...new Set(missing)], signals: claimSignalsOf(sentence) });
  }
  return out;
}

/**
 * G6 (claim and name honesty in every family): a run of one or more capitalized words joined by
 * nothing but an internal space or hyphen, and an optional trailing possessive — the candidate
 * PROPER-NOUN PHRASE `deterministicProperNounFlags` checks as one unit ("Tallow Row",
 * "O'Brien's", "Well-Made"). A `-` inside the run stays a phrase boundary the same way a space
 * does ("Bank of America" breaks at the lowercase "of" into "Bank" and "America", each checked on
 * its own — an acceptable degradation, not a false negative risk: either half failing to trace on
 * its own is still a real flag). Matching stops at the first lowercase word, so this never reaches
 * past a genuine phrase boundary into unrelated later capitalization in the same sentence. A
 * leading `(?<![a-zA-Z0-9])` requires the run's own first capital to sit at a WORD boundary —
 * never immediately after another letter OR digit — so a camelCase field name accidentally reused
 * as prose in a fixture ("brandMarkAlt", "block1Title") never reads its own internal capital
 * ("M", "A", "T") as a fresh candidate name; ordinary English prose has no letter or digit
 * directly before a capital that starts a new word either, so this costs no real coverage.
 *
 * Audit finding B3 (g6-r1-gemini, BLOCK): each word's own `(?:['’][A-Za-z]+)?` group allows an
 * INTERNAL apostrophe ("O'Brien", "D'Angelo", "O'Connor") as part of that one word, not just a
 * trailing possessive — the previous version only recognized a possessive `'s` at a word's end,
 * so "O'Brien" itself split into two separate candidates ("O" and "Brien"), and "Brien" alone,
 * with no brief or dictionary standing on its own, false-flagged a real, brief-stated name. The
 * trailing `(?:['’]s)?` after the whole run still covers a possessive on the LAST word
 * ("O'Brien's", "Tallow Row's").
 *
 * g6-r3b-opus55 audit (NOTE N-c): the original pattern used ASCII `[A-Z]`/`[A-Za-z]` only, so a
 * name whose initial letter is an accented or non-Latin uppercase character ("Ólafur", "Éowyn")
 * was never even a CANDIDATE at all — invisible to this check entirely, not merely exempted.
 * `\p{Lu}` (Unicode "uppercase letter") and `\p{L}` (any Unicode letter), with the `u` flag,
 * make the run Unicode-aware: an accented capital now starts a candidate, and an accented letter
 * anywhere in the run is still part of it.
 */
const PROPER_NOUN_RUN_RE = /(?<![\p{L}0-9])\p{Lu}\p{L}*(?:['’]\p{L}+)?(?:[ -]\p{Lu}\p{L}*(?:['’]\p{L}+)?)*(?:['’]s)?/gu;

/** Strips a trailing possessive ('s or ’s) off one word of a `PROPER_NOUN_RUN_RE` match — the
 * possessive marks GRAMMAR, not the name itself, and must not stop "Tallow Row's" from comparing
 * equal to a brief that only ever writes "Tallow Row". */
function stripPossessive(word: string): string {
  return word.replace(/['’]s$/i, '');
}

/**
 * A deterministic supplement to the LLM faithfulness judge, closing the gap `deterministicClaimFlags`/
 * `deterministicSentenceClaimFlags` leave open: those check NUMBERS and commercial/claim
 * SENTENCES, never an invented NAME with no number in it at all ("Chef Arden Voss", "the Larkspur
 * Room", "Nimbus Analytics") — a plausible-sounding capitalized name Jev alone is known to miss
 * (the same failure mode `deterministicAttributionFlags`/`deterministicQuoteFlags` already guard
 * against for a REVIEWER name or a QUOTE specifically; this is the general, family-agnostic form
 * for ordinary free prose). Every capitalized-word run (`PROPER_NOUN_RUN_RE`) in a checked slot's
 * text is a candidate; a slot flags when at least one candidate fails to trace.
 *
 * Sentence-initial capitalization is never itself evidence of a name (ordinary English capitalizes
 * a sentence's first word regardless): only a run that starts at the sentence's own first
 * character has its FIRST word dropped before checking — a later word in that same leading run
 * ("New York is great" -> "New" is sentence-initial and dropped, "York" is still checked) is not
 * itself sentence-initial and stays a candidate.
 *
 * A candidate PASSES when either (a) its whole word sequence occurs, contiguously and in order,
 * as the brief's own words (`containsWordSequence` — the same whole-phrase test
 * `deterministicAttributionFlags` uses for a person's name), so a real, brief-stated two-word name
 * is never split and double-penalized; or (b) EVERY one of its individual words is either a brief
 * word on its own or a known English word (`isKnownWord`, the same bundled ESDB/SCOWL wordlist
 * `lexicon.ts` already uses for the composed fill's lexical-completion gate) — the case an
 * ordinary sentence capitalizes for STYLE, not to name something ("Shop New Arrivals Today": every
 * word is common English, not a claimed name). A candidate that clears neither test is a name (or
 * acronym) with no support in the brief and no standing as an ordinary word, and the slot flags.
 *
 * Deliberately does NOT consult `TRACEABLE_STOPWORDS` or any other shared list: per the family
 * design brief's "Shared gate rule" (after two past drifts), the only two escape hatches for a
 * false positive here are the brief itself and the bundled dictionary — never a widened shared
 * list. A family-specific false positive is fixed in that family's OWN contract (an `x-label`
 * chrome marker, a nullable atom, an `x-verify` marker moving the slot to its own dedicated,
 * narrower check — see `run.ts`'s call site for the marker-path exclusions already in place).
 */
/**
 * A Unicode-aware word tokenizer, scoped to this function only: `allWordTokensOf`'s own
 * `WORD_TOKEN_RE` is ASCII (`[a-zA-Z]`) — fine for every other shared check, but it would strip
 * the accent off a brief's own "Ólafur" (tokenizing to "lafur"), which no longer matches
 * `PROPER_NOUN_RUN_RE`'s now-Unicode-aware candidate "Ólafur" (g6-r3b-opus55 audit NOTE N-c).
 * Kept local rather than widening the shared `WORD_TOKEN_RE` (used by several OTHER checks this
 * round did not audit for Unicode-width side effects).
 */
const UNICODE_WORD_TOKEN_RE = /\p{L}[\p{L}']*/gu;
function unicodeWordTokensOf(text: string): string[] {
  return [...text.matchAll(UNICODE_WORD_TOKEN_RE)].map((match) => match[0].toLowerCase());
}

export function deterministicProperNounFlags(brief: string, slots: readonly FaithfulnessSlot[], paths: ReadonlySet<string>): FlaggedSlot[] {
  const normalizedBrief = normalizeForWords(brief);
  const briefWords = unicodeWordTokensOf(normalizedBrief);
  // Every brief word PLUS its own plain-inflection stems ("Saturdays" -> also "saturday") — the
  // same tolerance `isKnownWord`/`lexicon.ts` already give the dictionary side of this check, so
  // a candidate that merely differs from the brief's own word by an ordinary plural/verb ending
  // ("Saturday" on the page against the brief's own "open Saturdays") is not a false positive of
  // this check's own making. This is NOT a shared-list widening (`FAMILY-BRIEF.md`'s "Shared gate
  // rule"): it reuses the SAME plain-inflection tolerance `isKnownWord` already applies to the
  // dictionary side, applied here to the BRIEF side instead of a new escape hatch.
  //
  // g6-r3b-opus55 audit (NOTE N-a): `CALENDAR_WORDS` (day/month names, unconditionally treated as
  // "known" regardless of the brief) was removed from this set — it let ANY brief pass "June" (a
  // genuinely common person's first name, not only a month) as automatically known, the audit's
  // own "Ask for June at the counter." example. A day/month word must now clear the SAME bar
  // every other candidate does: a real brief word, or `isKnownWord`'s ordinary dictionary check
  // (which already recognizes every calendar word as an everyday English word on its own).
  const briefWordSet = new Set(briefWords);
  for (const word of briefWords) for (const stem of stemsOf(word)) briefWordSet.add(stem);
  // g6-r3b-opus55 audit (NOTE N-b): the prior brief-word-PREFIX exemption ("a token that is
  // itself the start of a longer brief word") is removed entirely — whole-word matching only.
  // Audit finding F5 (g6-r1-gemini) already narrowed a GLOBAL dictionary-prefix version of this
  // (any dictionary word, not just a brief word) because "Dan" clip-matched "dance" regardless of
  // the brief; the audit's own N-b finding showed the BRIEF-scoped version still has the same
  // shape of flaw one level up — "Ask for Rob…" clip-matches the brief's "Robertson" even when
  // "Rob" is an entirely different, invented person the brief never names, because prefix
  // matching cannot tell a genuine byte-budget clip of "Robertson" apart from an unrelated short
  // name that happens to share its first three letters. A byte-budget-clipped word is a SEPARATE,
  // already-handled failure mode (its own dedicated check and repair path) and this function no
  // longer double-guesses it — only an exact brief word (or its plain-inflection stem, via
  // `briefWordSet` above) counts as known now.
  // A standard trade/industry abbreviation ("GC" for "general contractor") whose every expanded
  // word is itself brief-supported — the same `ABBREVIATION_EXPANSIONS` table
  // `traceableContentWordsOf` uses for the sentence-claim/traceable word-trace path, applied here
  // so the SAME live finding (wrenfield's own "Licensed GC") is fixed on both checks at once, not
  // just one of the two.
  // Audit finding B1 (g6-r1-gemini, BLOCK): the dictionary fallback here (`isKnownWord`, which
  // also checks the ESDB wordlist) let "GC" pass on ANY brief, since "general" and "contractor"
  // are both ordinary dictionary words — an art gallery's or a bakery's brief would license an
  // invented "licensed GC" claim just as easily as wrenfield's own. An abbreviation expansion
  // must be BRIEF-supported, the same bar every other candidate word in this function clears; the
  // dictionary is never a substitute for that.
  const isKnownAbbreviation = (word: string): boolean => {
    const expansion = ABBREVIATION_EXPANSIONS.get(word);
    return expansion !== undefined && expansion.every((expanded) => briefWordSet.has(expanded));
  };
  const out: FlaggedSlot[] = [];
  for (const slot of slots) {
    if (!paths.has(slot.path)) continue;
    let unsupported = false;
    for (const sentence of splitSentences(slot.text)) {
      if (unsupported) break;
      const normalizedSentence = normalizeForWords(sentence);
      for (const match of normalizedSentence.matchAll(PROPER_NOUN_RUN_RE)) {
        let run = match[0];
        if ((match.index ?? 0) === 0) {
          const words = run.split(/[ -]/);
          // Audit finding F6 (g6-r1-gemini, FIX): ordinary English capitalizes a sentence's first
          // word regardless of whether it names anything — but that is only true when the word
          // itself is an ordinary word. Unconditionally dropping it let a single-word invented
          // name at a sentence's start ("Zendesk powers our bakery.") — or an invented name
          // immediately before a real dictionary word ("Zendesk Software powers...") — evade
          // entirely. The first word is dropped ONLY when it is itself already known (a brief
          // word, a dictionary word, a brief-word clip, or a known abbreviation); an unrecognized
          // sentence-initial word stays in the run and is checked exactly like any other word.
          const firstWordLower = stripPossessive(words[0]!).toLowerCase();
          const firstWordKnown = isKnownWord(firstWordLower, briefWordSet) || isKnownAbbreviation(firstWordLower);
          if (firstWordKnown) {
            words.shift();
            if (words.length === 0) continue; // the whole run was one sentence-initial, known word.
            run = words.join(' ');
          }
        }
        const runWordsLower = run.split(/[ -]/).map((word) => stripPossessive(word).toLowerCase());
        if (runWordsLower.length === 0) continue;
        if (containsWordSequence(briefWords, runWordsLower)) continue;
        const allKnown = runWordsLower.every((word) => isKnownWord(word, briefWordSet) || isKnownAbbreviation(word));
        if (!allKnown) { unsupported = true; break; }
      }
    }
    if (unsupported) out.push({ path: slot.path, probability: 1 });
  }
  return out;
}

/** `context`: an optional, fixed, structured note handed to Jev alongside this slot's own
 * question — see `noulQuestion`'s own docblock for why and when `run.ts` sets it. */
export type FaithfulnessSlot = { path: string; text: string; context?: string };
export type FlaggedSlot = { path: string; probability: number };

/**
 * Merges two flagged-slot lists by path, keeping the HIGHER probability whenever both lists flag
 * the same path — used by `run.ts`'s `makeCheckOnce` to fold the deterministic
 * `deterministicAttributionFlags`/`deterministicQuoteFlags` results into whatever Jev itself
 * returned. A deterministic check always reports probability `1`; a naive "Jev already has this
 * path, skip it" merge would keep Jev's own (possibly lower) score for a path both sides agree is
 * unfaithful, which could leave an invented name or quote under a probability-based repair cutoff
 * even though the deterministic check is certain about it. Order is not preserved; callers that
 * care about it should sort the result themselves.
 */
export function mergeFlagsByMaxProbability(a: readonly FlaggedSlot[], b: readonly FlaggedSlot[]): FlaggedSlot[] {
  const byPath = new Map<string, FlaggedSlot>();
  for (const flag of a) byPath.set(flag.path, flag);
  for (const flag of b) {
    const existing = byPath.get(flag.path);
    if (!existing || flag.probability > existing.probability) byPath.set(flag.path, flag);
  }
  return [...byPath.values()];
}

export type FaithfulnessCheckResult = {
  flagged: FlaggedSlot[];
  ms: number;
  calls: number;
  usage?: { input_tokens: number; output_tokens: number };
  /** Set instead of throwing when the request could not be diagnosed (network failure, timeout),
   * or when a later batch fails after earlier batches already succeeded — either way `flagged`
   * still carries whatever was verified before the failure. */
  skipped?: string;
  /** Paths of slots too large to check even alone with the brief (over `MAX_STATE_TOKENS` or
   * `MAX_REQUEST_TOKENS`). Excluded from every batch rather than sent to a near-certain 422;
   * distinct from `skipped`, since the rest of the check still completed normally. */
  oversized?: string[];
};

export type FaithfulnessChecker = {
  checkFaithfulness: (input: { brief: string; slots: FaithfulnessSlot[] }) => Promise<FaithfulnessCheckResult>;
};

export type JevCheckerOptions = {
  apiKey: string | (() => Promise<string>);
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  /** Probability at or above which a slot counts as flagged. Default 0.85. */
  threshold?: number;
  endpoint?: string;
  /** Cancels a check in flight. Combined with this checker's own timeout, never replacing it, so
   * a cancelled build stops waiting on Jev at once instead of sitting out the remaining timeout. */
  signal?: AbortSignal;
};

const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_THRESHOLD = 0.85;

// A live G8 build matrix run (repo pre-1dc67a1135, community x deepseek) hit exactly one Jev
// request that ran the full `DEFAULT_TIMEOUT_MS` and never answered — no product bug, just the
// upstream call being slow once — and `strict` fails closed on ANY skip (`composeBlocks`'s and
// `run.ts`'s own `passed = verify.skipped === undefined && ...`), by design: a check that did not
// complete must never let an unverified page publish. Retrying a TRANSIENT failure (a network
// error, a timeout, a 429, or a 5xx) before giving up as `skipped` fixes that at the root — it
// makes the check itself more reliable — without touching what "passed" means or loosening the
// gate a skip still fails closed on. A non-2xx that is not one of these (401, 403, 404, a generic
// 4xx `jevErrorMessage` calls "request failed") is never transient and is not retried.
const JEV_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const JEV_RETRY_DELAYS_MS = [400, 1200];
function jevRetryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A bounded, sanitized message for a non-2xx Jev (TypeSafe) response: the HTTP status plus a
 * fixed phrase, never the response body and never a header. The upstream body is arbitrary
 * content from a third-party service — an error page, a stack trace, a proxy's HTML — and this
 * package throws, reports, or prints this message in places a caller cannot fully control (a
 * thrown `Error`, `verify.skipped`, a written `--report` file, the CLI's console output), so none
 * of them may ever carry it. Shared by this file's own `createJevChecker` and `route.ts`'s
 * `createJevRouter`, the two callers that turn a Jev response into a message.
 */
export function jevErrorMessage(status: number): string {
  const phrase = status === 401 || status === 403 ? 'unauthorized'
    : status === 404 ? 'not found'
    : status === 429 ? 'rate limited'
    : status >= 500 ? 'upstream error'
    : 'request failed';
  return `jev ${status} ${phrase}`;
}

// The docs (api.md) give no tokenizer, so token counts are estimated at ~4 characters/token (a
// common rough ratio for English text) with headroom under the documented ceilings: 64,000
// tokens per request (`state` + all `questions`), 32,000 tokens for `state` + the single longest
// question.
const CHARS_PER_TOKEN = 4;
const MAX_STATE_TOKENS = 28_000;
const MAX_REQUEST_TOKENS = 56_000;
// Fixed cost of one question's instructions + criteria text, independent of SLOT length: a
// question references its slot by name (`text_N`) rather than inlining the slot's own text, so
// growing slot text only grows `state`, never `questions`. This is NOT true of a slot's `context`
// (round 2 audit's owner-ruled hours context, `run.ts`): `noulQuestion` inlines it directly into
// `instructions`, adding roughly 100+ tokens to THIS question's own share of `questions` for every
// hours-labeled slot — a real, if currently negligible at brief-sized inputs, undercount this
// fixed constant does not budget for (round 3 audit, Opus N4). Batching still checks against
// `MAX_REQUEST_TOKENS` using this same undercounted estimate, so a brief whose hours clause were
// unusually long could in principle push a batch over the real ceiling before this constant says
// to split it — worth revisiting if hours slots or their context text ever grow materially.
const QUESTION_TOKENS = 60;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export type BatchedSlots = { batches: FaithfulnessSlot[][]; oversized: FaithfulnessSlot[] };

/**
 * Groups slots into requests that stay under both documented context ceilings. A slot that
 * cannot fit even alone with the brief (its own text already exceeds a ceiling before any other
 * slot joins it) would overflow a batch of one too — sending it anyway would only trade this
 * graceful exclusion for a near-certain 422, so it is pulled out into `oversized` up front
 * instead of ever reaching a request.
 */
export function batchFaithfulnessSlots(brief: string, slots: FaithfulnessSlot[]): BatchedSlots {
  const briefTokens = estimateTokens(brief);
  const batches: FaithfulnessSlot[][] = [];
  const oversized: FaithfulnessSlot[] = [];
  let current: FaithfulnessSlot[] = [];
  let stateTokens = briefTokens;
  let questionTokens = 0;
  for (const slot of slots) {
    const slotTokens = estimateTokens(slot.text);
    const aloneState = briefTokens + slotTokens;
    const aloneTotal = aloneState + QUESTION_TOKENS;
    if (aloneState + QUESTION_TOKENS > MAX_STATE_TOKENS || aloneTotal > MAX_REQUEST_TOKENS) {
      oversized.push(slot);
      continue;
    }
    const wouldState = stateTokens + slotTokens;
    const wouldTotal = wouldState + questionTokens + QUESTION_TOKENS;
    if (current.length > 0 && (wouldState + QUESTION_TOKENS > MAX_STATE_TOKENS || wouldTotal > MAX_REQUEST_TOKENS)) {
      batches.push(current);
      current = [];
      stateTokens = briefTokens;
      questionTokens = 0;
    }
    current.push(slot);
    stateTokens += slotTokens;
    questionTokens += QUESTION_TOKENS;
  }
  if (current.length > 0) batches.push(current);
  return { batches, oversized };
}

type NoulQuestion = { type: 'noul'; instructions: string; criteria: { true: string; false: string } };

/**
 * Per the typesafe-ai skill: the judgment in `instructions`, its possible answers in `criteria`.
 *
 * `context`, when given, is a short, fixed, structured note about what KIND of slot `textKey`
 * fills and where in `brief` to check it against — never a hint at the right answer. G8 final on
 * 857a46b982: halcyon's hours-row day labels and combined rows (a bare day range or a
 * "<days>, <status>" line, no contact/date/price/award/credential/place shape at all) sat outside
 * every category this question's own rubric names, and Jev's judgment on them was noisy across
 * repeated, identical, correct answers — the deterministic hours-row gate (`hours-label.ts`) never
 * agreed. `makeCheckOnce` in run.ts attaches an hours-row context (the brief's own opening-hours
 * clause, quoted) to exactly these slots, so Jev checks the text against the SAME narrow clause
 * the deterministic gate does, instead of searching the whole brief for a shape the rubric does not
 * name. Every other slot is unaffected.
 */
function noulQuestion(textKey: string, context?: string): NoulQuestion {
  return {
    type: 'noul',
    instructions: `Does \`${textKey}\` assert a specific fact (a contact detail, number, date, price, award, credential, or place) that \`brief\` does not contain?${context === undefined ? '' : ` ${context}`}`,
    criteria: {
      true: 'The text asserts a specific fact — a contact detail, number, date, price, award, credential, or place — that brief does not contain or reasonably imply: a fabrication the fill step invented.',
      false: 'Every factual claim in the text traces back to brief, or the text carries no such verifiable factual claim (pure tone, style, or a generic CTA phrase).',
    },
  };
}

type JevAnswer = { type: 'noul'; noul: number };
type JevResponseBody = { model: string; answers: Record<string, JevAnswer>; usage?: { input_tokens: number; output_tokens: number } };

export type JevKeyResolver = () => Promise<string>;

/**
 * A lazy, cached resolver for a Jev API key: resolves once — whether given as a literal string or
 * an async function (`vaultSecret('typesafe_api_key')`, typically) — and caches the result for
 * every later call. `createJevChecker` below still carries its own copy of this pattern; shared
 * here for `route.ts`'s `createJevRouter` and `profile.ts`'s `createJevProfiler`.
 *
 * Only a *successful* read is cached. A failed one is forgotten, so the next call tries again: a
 * long-lived caller (the daemon resolves the key on the first Jev request of the process, not at
 * startup) would otherwise be stuck on one rejected promise for its whole life — a vault that was
 * locked, or a key that was added a minute later, could never be picked up without a restart.
 */
export function resolveJevKey(apiKey: string | (() => Promise<string>)): JevKeyResolver {
  let cachedKey: Promise<string> | undefined;
  return () => {
    if (cachedKey) return cachedKey;
    const pending = typeof apiKey === 'string' ? Promise.resolve(apiKey) : apiKey();
    cachedKey = pending.catch((error: unknown) => {
      cachedKey = undefined;
      throw error;
    });
    return cachedKey;
  };
}

/**
 * The signal one Jev request runs under: its own timeout, combined with the caller's cancellation
 * when there is one. Built per request, since `AbortSignal.timeout` starts counting the moment it
 * is created. Shared with `route.ts`'s router, which needs the same combination.
 */
export function jevRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type JevRequestInput = {
  endpoint: string;
  model: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  key: JevKeyResolver;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  /** Cancels the request. Combined with `timeoutMs` through `jevRequestSignal`, never replacing it. */
  signal?: AbortSignal;
};

export type JevRawResponse = { status: number; ok: boolean; text: string };

/**
 * The mechanical POST + auth header + timeout a Jev (TypeSafe System One) caller needs. Currently
 * used by `profile.ts`'s fail-closed design profiler and `sections.ts`'s keep/drop judge: this file's own `createJevChecker`
 * (below) and `route.ts`'s `createJevRouter` each still carry their own inline copy of this same
 * request shape, predating this extraction — moving either onto `postSystemOne` is a follow-up,
 * not done here to avoid touching their already-tested request paths. Returns the raw response
 * status and body text; each caller decides how to turn a non-2xx response or a network failure
 * into its own advisory-vs-throwing behavior — this helper makes no such policy choice itself.
 */
export async function postSystemOne(input: JevRequestInput): Promise<JevRawResponse> {
  const response = await input.fetchImpl(input.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await input.key()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: input.state, model: input.model, questions: input.questions }),
    signal: jevRequestSignal(input.timeoutMs, input.signal),
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, text };
}

const FAITHFULNESS_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const FAITHFULNESS_MONTH_PATTERN = FAITHFULNESS_MONTHS.join('|');

/** Normalize presentation before Jev scoring, never the deterministic checks.
 * Only explicit discourse filler and unambiguous date/quantity spellings are
 * rewritten. Negations, qualifiers, names and ambiguous numeric dates survive.
 * This reduces phrasing variance; it does not promise calibrated probabilities.
 */
export function normalizeFaithfulnessText(text: string): string {
  let normalized = text.replace(/\s+/gu, ' ').trim();
  normalized = normalized.replace(/(^|[.!?]\s+)(?:(?:it is|it's) (?:worth noting|important to note) that\s+|in fact,\s+)/giu,
    (_match: string, boundary: string) => boundary);
  if (!normalized) return text;
  normalized = normalized.replace(/^(we|our)(?=\s|$)/u, word => word[0]!.toUpperCase() + word.slice(1));

  const normalizeFacts = (fragment: string, precedingText: string): string => {
    let normalized = fragment;
    const date = (original: string, year: string, month: number, day: string): string => {
      const value = new Date(Date.UTC(Number(year), month, Number(day)));
      // Reject invalid dates rather than silently rolling February 30 into March.
      if (value.getUTCFullYear() !== Number(year) || value.getUTCMonth() !== month || value.getUTCDate() !== Number(day)) return original;
      return `${year}-${String(month + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
    };
    normalized = normalized.replace(new RegExp(`\\b(${FAITHFULNESS_MONTH_PATTERN}) (\\d{1,2})(?:st|nd|rd|th)?[,]? (\\d{4})\\b`, 'giu'),
      (match: string, month: string, day: string, year: string) => date(match, year, FAITHFULNESS_MONTHS.indexOf(month.toLowerCase()), day));
    normalized = normalized.replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${FAITHFULNESS_MONTH_PATTERN})[,]? (\\d{4})\\b`, 'giu'),
      (match: string, day: string, month: string, year: string) => date(match, year, FAITHFULNESS_MONTHS.indexOf(month.toLowerCase()), day));
    normalized = normalized.replace(/(\b(?:on|since|until|before|after|by|dated|date:) )(\d{4})-(\d{1,2})-(\d{1,2})\b/giu,
      (match: string, prefix: string, year: string, month: string, day: string) => prefix + date(match.slice(prefix.length), year, Number(month) - 1, day));
    const quantityUnits = 'seats?\\b|stars?\\b|years?\\b|days?\\b|hours?\\b|minutes?\\b|people\\b|guests?\\b|dollars?\\b|euros?\\b|percent\\b';
    // A single comma can be a decimal separator, even with three fractional
    // digits. Require repeated grouping or an explicit dot-decimal suffix and
    // a nonzero leading group; otherwise keep the locale-ambiguous text intact.
    const unambiguousGrouping = '(?:[1-9]\\d{0,2}(?:,\\d{3}){2,}|[1-9]\\d{0,2}(?:,\\d{3})+\\.\\d+)';
    const groupedQuantities = new RegExp(`(?<=[$€£])${unambiguousGrouping}(?![\\p{L}\\p{N},_-]|\\.\\d)|(?<![\\p{L}\\p{N}.,_-])${unambiguousGrouping}(?= (?:${quantityUnits}))`, 'gu');
    normalized = normalized.replace(groupedQuantities, value => value.replaceAll(',', ''));
    // Restrict word-number rewrites to explicit quantities, preserving names such
    // as Studio One and prose such as "one of a kind". Reuse the existing parser
    // without changing any deterministic flag function or its inputs.
    const units = [...NUMBER_WORDS.keys()].filter(word => NUMBER_WORDS.get(word)! > 0 && NUMBER_WORDS.get(word)! < 10).join('|');
    const quantityWords = `(?:${units}) hundred(?: (?:and )?(?:${TENS_ALT})(?:[ -](?:${units}))?| (?:and )?(?:${ONES_ALT}))?|(?:${TENS_ALT})(?:[ -](?:${units}))?|${ONES_ALT}|half|a dozen|dozen`;
    const quantities = new RegExp(`\\b(${quantityWords}) (?=${quantityUnits})`, 'gu');
    const compoundPrefix = new RegExp(`\\b(?:\\d+|${[...NUMBER_WORDS.keys()].join('|')}|and|a|half|dozen|hundred|thousand)[ -]$`, 'iu');
    normalized = normalized.replace(quantities, (match: string, words: string, offset: number) => {
      // Never rewrite just the tail of an unsupported compound, e.g. two dozen
      // guests or two and a half hours. Capitalized quantity names stay untouched.
      if (compoundPrefix.test(precedingText + normalized.slice(0, offset))) return match;
      const value = numberWordValueOf(words);
      return value === undefined ? match : `${value} `;
    });
    return normalized;
  };
  // Protect whole identity-bearing tokens, including schemeless hosts, relative
  // paths and Windows paths. Conservative token protection also covers query
  // strings and filenames; prose on either side still gets normalized.
  const protectedSpans = /(?<!\S)([^\s]*[\/\\?#@][^\s]*|[^\s]*:[^\s]+|[^\s]*\.\p{L}[^\s]*)/gu;
  let fragmentOffset = 0;
  return normalized.split(protectedSpans).map((fragment, index) => {
    // Protected tokens still supply compound context, e.g. the fraction in 1/2 dozen.
    const precedingText = normalized.slice(0, fragmentOffset);
    fragmentOffset += fragment.length;
    return index % 2 ? fragment : normalizeFacts(fragment, precedingText);
  }).join('');
}

export function createJevChecker(options: JevCheckerOptions): FaithfulnessChecker {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  let cachedKey: Promise<string> | undefined;
  const key = () => (cachedKey ??= typeof options.apiKey === 'string' ? Promise.resolve(options.apiKey) : options.apiKey());

  const checkFaithfulness: FaithfulnessChecker['checkFaithfulness'] = async ({ brief, slots }) => {
    const startedAt = performance.now();
    if (slots.length === 0) return { flagged: [], ms: 0, calls: 0 };
    const { batches, oversized } = batchFaithfulnessSlots(brief, slots);
    const oversizedPaths = oversized.length > 0 ? oversized.map((slot) => slot.path) : undefined;
    const flagged: FlaggedSlot[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let calls = 0;

    const done = (skipped?: string): FaithfulnessCheckResult => ({
      flagged,
      ms: Math.round(performance.now() - startedAt),
      calls,
      ...(calls > 0 ? { usage: { input_tokens: inputTokens, output_tokens: outputTokens } } : {}),
      ...(skipped !== undefined ? { skipped } : {}),
      ...(oversizedPaths ? { oversized: oversizedPaths } : {}),
    });

    for (const batch of batches) {
      const state: Record<string, string> = { brief };
      const questions: Record<string, NoulQuestion> = {};
      batch.forEach((slot, index) => {
        const textKey = `text_${index}`;
        state[textKey] = normalizeFaithfulnessText(slot.text);
        questions[`slot_${index}`] = noulQuestion(textKey, slot.context);
      });

      let response: Response | undefined;
      let networkError: unknown;
      for (let attempt = 0; ; attempt += 1) {
        networkError = undefined;
        response = undefined;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${await key()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ state, model, questions }),
            signal: jevRequestSignal(timeoutMs, options.signal),
          });
        } catch (error) {
          // A cancellation is not an advisory outcome and must not be reported as one — see the
          // throw below, unchanged from before this retry loop existed.
          if (options.signal?.aborted) throw error;
          networkError = error;
        }
        const retryableStatus = response !== undefined && !response.ok && JEV_RETRYABLE_STATUS.has(response.status);
        if ((networkError === undefined && !retryableStatus) || attempt >= JEV_RETRY_DELAYS_MS.length) break;
        // A retryable batch response still has a body to drain before the connection can be reused.
        if (response !== undefined) await response.text().catch(() => {});
        await jevRetryDelay(JEV_RETRY_DELAYS_MS[attempt]!);
      }
      if (networkError !== undefined) {
        // `skipped` means "Jev could not be reached, you decide what that is worth", which
        // `strict` reads as a failed gate and `advisory` publishes straight past — neither is what
        // a caller that asked for the build to stop wants. A batch after the first one that
        // already succeeded keeps what those batches verified; a batch-one failure has nothing
        // accumulated to keep, so this and the non-ok shape below are the same code path either way.
        return done(networkError instanceof Error ? networkError.message : String(networkError));
      }
      calls += 1;
      const text = await response!.text();
      if (!response!.ok) {
        // Sanitized: the response body (`text`) is never read into this message — see
        // `jevErrorMessage`'s docblock.
        const reason = jevErrorMessage(response!.status);
        // The very first response is a real API/request-shape error worth failing loudly on;
        // once earlier batches have already succeeded, a later failure must not discard them.
        if (calls === 1) throw new Error(reason);
        return done(reason);
      }
      const json = JSON.parse(text) as JevResponseBody;
      inputTokens += json.usage?.input_tokens ?? 0;
      outputTokens += json.usage?.output_tokens ?? 0;
      batch.forEach((slot, index) => {
        const answer = json.answers[`slot_${index}`];
        if (answer && typeof answer.noul === 'number' && answer.noul >= threshold) flagged.push({ path: slot.path, probability: answer.noul });
      });
    }
    return done();
  };

  return { checkFaithfulness };
}

/**
 * The text slots the fast lane's fill step may write, for one recipe: string leaves outside
 * `LOCKED_KEYS`, `id` excluded as an anchor, and (when given) paths kept from a re-targeted spine
 * via `--lock` excluded too, since that text was never written by this run. Mirrors spine.ts's
 * `editableTemplate` exclusions plus the prototype's `faithfulness-check.mjs` anchor exclusion —
 * `editableTemplate` itself keeps `id` in what it shows the model (as a match anchor), so it is
 * not reused here directly.
 *
 * `illustrativePaths` names slots the family schema marks `x-mock` (see spine.ts's
 * `mockPathsFor`): sample data the page shows under a visible caption, which asserts nothing about
 * the client and is skipped like a locked path. Its default is empty on purpose: `repairLockPaths`
 * calls this with no third argument to list EVERY text path and lock all but the flagged ones, and
 * an excluding default would leave every mock slot unlocked and re-filled. `repairLockPaths` then
 * adds the mock paths to the lock list explicitly, so the repair does not depend on that alone.
 */
export function collectFaithfulnessSlots(
  recipe: Json,
  lockedPaths: ReadonlySet<string> = new Set(),
  illustrativePaths: ReadonlySet<string> = new Set(),
): FaithfulnessSlot[] {
  const out: FaithfulnessSlot[] = [];
  const walk = (value: Json, key: string | undefined, at: string): void => {
    if (key !== undefined && LOCKED_KEYS.has(key)) return;
    if (key === ANCHOR_KEY) return;
    if (lockedPaths.has(at) || illustrativePaths.has(at)) return;
    if (typeof value === 'string') {
      if (value.trim()) out.push({ path: at, text: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(recipe, undefined, '');
  return out;
}

/**
 * The paths a repair of `flaggedPaths` keeps locked: every editable leaf in `recipe` — each text
 * slot, an empty string, and a null slot or null group (a fact the brief did not state) — minus
 * the flagged fact slots it re-generates. Leaves are walked on the editable template exactly as a
 * fill computes it (see run.ts), so a nulled group such as marketing testimonials is locked
 * although it carries no text: `editableTemplate` would otherwise show that null to the model,
 * and repairing an unrelated flag could write brand-new testimonials into it. Section anchors
 * (`id`) stay unlocked because the fill needs them to match answers back to units.
 *
 * Slots the family schema marks `x-mock` are ALWAYS locked — listed explicitly, not left to the
 * assumption that the checker never flags them — so even a flag that names sample data (a checker
 * regression, a missed mark) cannot make a repair re-generate it.
 */
export function repairLockPaths(recipe: Json, flaggedPaths: readonly string[], schema: JsonObject): string[] {
  const template = editableTemplate(recipe) ?? {};
  const illustrative = mockPathsFor(schema, template);
  const regenerate = new Set(flaggedPaths.filter((path) => !illustrative.has(path)));
  const locked = new Set(editableLeafPaths(template).filter((path) => !regenerate.has(path)));
  for (const path of illustrative) locked.add(path);
  return [...locked];
}

/** Every leaf `editableTemplate` shows the model (strings, empty or not, and nulls), anchors excluded. */
function editableLeafPaths(template: Json): string[] {
  const out: string[] = [];
  const walk = (value: Json, key: string | undefined, at: string): void => {
    if (key === ANCHOR_KEY) return;
    if (typeof value === 'string' || value === null) {
      out.push(at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(template, undefined, '');
  return out;
}
