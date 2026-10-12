// The Cult UI Pro brand scrub: the one rule for what a person may see of a catalogued item.
//
// Every text field a person sees (title, summary, state reason, tags, source category) goes
// through one scrub driven by an explicit deny list (`DENIED_BRANDS`): style providers the
// inventory names ("Marketing Pricing Vercel", "Vite-inspired hero", "Apple Keyboard") become a
// neutral series letter — the same titles `packages/section-catalog/scripts/build-catalog.ts`'s
// `cultDisplayTitle` gives the section catalog — and vendors and libraries ("OpenAI's
// GPT-5-nano", "Stripe and Redis", "Sonner-backed") become a neutral noun. Every name matches at
// word boundaries in its bare, possessive and plural forms and inside "-style", "-inspired",
// "-powered" and "inspired by" clauses. The scrub fails closed: after the phrase rules, a
// backstop replaces any deny-list name still present, and `assertBrandFree` throws if one
// survives.
//
// The same rule names things a person types and installs: the public slug of every row
// (`assignCultSlugs`, generated with the catalog into
// `packages/cult-ui-catalog/generated/slugs.json`), the brand-free file and folder names of a
// served item (`cultBrandFreePath`) and its export names (`cultBrandFreeIdentifier`). It lives in
// contracts so the daemon (display, registry) and the catalog package's generator share it.

// ---------------------------------------------------------------------------------------------
// Brand scrub
// ---------------------------------------------------------------------------------------------

export interface DeniedBrand {
  /** Regex source for the name, without boundaries (matched case-insensitively unless noted). */
  readonly name: string;
  /** Series letter, for a style provider whose look the inventory names. */
  readonly series?: string;
  /** Neutral words for a title ('' drops the name). Defaults to `series X` / ''. */
  readonly title?: string;
  /** Neutral phrase for running text. Defaults to `series X`. */
  readonly text?: string;
  /**
   * The name is also an ordinary word ("stripe", "polar", "resend", "linear"): match only the
   * capitalized form in text. Tags (slugs) still match it case-insensitively unless `contextOnly`.
   */
  readonly caseSensitive?: boolean;
  /**
   * Too common a word to match alone: only its brand forms count ("Linear-style", "Notion's",
   * "inspired by Slack").
   */
  readonly contextOnly?: boolean;
}

/**
 * The explicit deny list, longest names first where one contains another. Style providers carry a
 * series letter; vendors, services and libraries carry a neutral noun.
 */
export const DENIED_BRANDS: readonly DeniedBrand[] = [
  // Style providers the inventory names (series letters, as section-catalog titles them).
  { name: 'heerich\\.js', series: 'H', text: 'a voxel library' },
  { name: 'heerich', series: 'H' },
  { name: 'shadcn(?:/ui)?', series: 'S' },
  { name: 'vercel', series: 'V' },
  { name: 'vite', series: 'VT' },
  { name: 'dynamic\\s+island', series: 'A', title: 'Camera Cutout', text: 'camera cutout' },
  { name: 'pro\\s+display\\s+xdr', series: 'A', title: 'Display', text: 'series A display' },
  { name: 'studio\\s+display', series: 'A', title: 'Display', text: 'series A display' },
  { name: 'watch\\s+ultra', series: 'A', title: 'Watch', text: 'series A watch' },
  { name: 'iphone(?:\\s+\\d+)?(?:\\s+pro)?(?:\\s+max)?', series: 'A', title: 'Phone', text: 'series A phone' },
  { name: 'ipad(?:\\s+pro)?', series: 'A', title: 'Tablet', text: 'series A tablet' },
  { name: 'macbook(?:\\s+(?:pro|air))?', series: 'A', title: 'Laptop', text: 'series A laptop' },
  { name: 'macos', series: 'A', title: 'Desktop', text: 'desktop' },
  { name: 'iOS', series: 'A', title: 'Mobile', text: 'mobile', caseSensitive: true },
  { name: 'mac', series: 'A' },
  { name: 'apple', series: 'A' },
  // AI vendors and models.
  { name: 'openai', title: 'Hosted Model', text: 'a hosted AI service' },
  { name: '(?:chat)?gpt(?:-?\\w+(?:\\.\\d+)?)*', title: 'Language Model', text: 'a hosted language model' },
  { name: 'dall[-·\\s]?e(?:\\s*\\d+)?', title: 'Image Model', text: 'a hosted image model' },
  { name: 'gemini(?:\\s+\\d+(?:\\.\\d+)?)?(?:\\s+(?:flash|pro|ultra|nano))?', title: '', text: 'a hosted model' },
  { name: 'google', title: '', text: 'a hosted AI service' },
  { name: 'anthropic', title: '', text: 'a hosted AI service' },
  { name: 'claude', title: '', text: 'a hosted model' },
  { name: 'perplexity', title: '', text: 'a hosted search service' },
  { name: 'sonar', title: '', text: 'a hosted search model' },
  { name: 'mistral', title: '', text: 'a hosted model' },
  { name: 'deepseek', title: '', text: 'a hosted model' },
  { name: 'openrouter', title: '', text: 'a hosted model router' },
  { name: 'hugging\\s*face', title: '', text: 'a model hub' },
  { name: 'v0', title: 'Interface Builder', text: 'an interface builder' },
  // Services and infrastructure.
  { name: 'jina(?:\\s+ai)?', title: 'Hosted', text: 'a hosted scraping service' },
  { name: 'trigger\\.dev(?:\\s+v\\d+)?', title: 'Background Job', text: 'a background job service' },
  { name: 'Resend', title: 'Email', text: 'an email service', caseSensitive: true },
  { name: 'Stripe', title: 'Card Payment', text: 'a payments service', caseSensitive: true },
  { name: 'Polar(?:\\.sh)?', title: '', text: 'a payments service', caseSensitive: true },
  { name: 'supabase(?:\\s+vector\\s+store)?', title: 'a Vector Store', text: 'a vector store' },
  { name: '(?:upstash\\s+)?redis', title: 'Cache', text: 'a cache' },
  { name: 'upstash', title: 'Cache', text: 'a hosted cache' },
  { name: 'postgres(?:ql)?', title: 'Database', text: 'a database' },
  { name: 'pgvector', title: 'Vector Index', text: 'a vector index' },
  { name: 'firebase', title: '', text: 'a hosted backend' },
  { name: 'netlify', title: '', text: 'a hosting service' },
  { name: 'cloudflare', title: '', text: 'a hosting service' },
  { name: 'twilio', title: '', text: 'a messaging service' },
  { name: 'shopify', title: '', text: 'a commerce platform' },
  { name: 'reddit', title: 'Forum', text: 'forum' },
  { name: 'mozilla', title: '', text: 'a browser vendor' },
  // Libraries and frameworks.
  { name: 'next(?:\\.js|js|[-\\s]js)', title: 'Web App', text: 'a web framework' },
  { name: 'React', title: '', text: 'a UI library', caseSensitive: true },
  { name: 'three\\.js', title: '', text: 'a 3D library' },
  { name: 'cheerio', title: '', text: 'an HTML parser' },
  { name: 'zod', title: 'Schema', text: 'schema' },
  { name: 'radix(?:\\s+slot)?', title: '', text: 'a slot primitive' },
  { name: 'sonner', title: '', text: 'a toast library' },
  { name: 'cobe', title: '', text: 'a globe library' },
  { name: 'tailwind(?:\\s*css)?', title: '', text: 'a utility CSS library' },
  { name: 'framer(?:\\s+motion)?', title: '', text: 'a motion library' },
  { name: 'Paper\\s+Design', title: '', text: 'a design studio', caseSensitive: true },
  // Other companies a style label could name.
  { name: 'microsoft', title: '', text: 'a third-party service' },
  { name: 'amazon', title: '', text: 'a third-party service' },
  { name: 'aws', title: '', text: 'a third-party service' },
  { name: 'github', title: '', text: 'a code host' },
  { name: 'gitlab', title: '', text: 'a code host' },
  { name: 'figma', title: '', text: 'a design tool' },
  { name: 'twitter', title: '', text: 'a social network' },
  { name: 'x\\.com', title: '', text: 'a social network' },
  { name: 'facebook', title: '', text: 'a social network' },
  { name: 'instagram', title: '', text: 'a social network' },
  { name: 'tiktok', title: '', text: 'a social network' },
  { name: 'youtube', title: '', text: 'a video site' },
  { name: 'netflix', title: '', text: 'a streaming service' },
  { name: 'spotify', title: '', text: 'a streaming service' },
  { name: 'airbnb', title: '', text: 'a third-party service' },
  { name: 'uber', title: '', text: 'a third-party service' },
  { name: 'Linear', title: '', text: 'a third-party service', caseSensitive: true, contextOnly: true },
  { name: 'Notion', title: '', text: 'a third-party service', caseSensitive: true, contextOnly: true },
  { name: 'Slack', title: '', text: 'a third-party service', caseSensitive: true, contextOnly: true },
  { name: 'Discord', title: '', text: 'a third-party service', caseSensitive: true, contextOnly: true },
  { name: 'Meta', title: '', text: 'a third-party service', caseSensitive: true, contextOnly: true },
  { name: 'Llama', title: '', text: 'a hosted model', caseSensitive: true, contextOnly: true },
];

const START = '(?<![A-Za-z0-9])';
const END = '(?![A-Za-z0-9])';
const POSSESSIVE = "(?:['’]s)?";

function regexFlags(brand: DeniedBrand, slug: boolean): string {
  return brand.caseSensitive && !slug ? 'g' : 'gi';
}

/** The bare name in its plain, possessive and (unless it is also a common word) plural forms. */
function barePattern(brand: DeniedBrand, slug = false): RegExp {
  const plural = brand.caseSensitive ? '' : '|s';
  return new RegExp(`${START}(?:${brand.name})(?:['’]s${plural})?${END}`, regexFlags(brand, slug));
}

/** The brand forms of a context-only name: "Linear-style", "Notion's", "inspired by Slack". */
function contextPattern(brand: DeniedBrand): RegExp {
  return new RegExp(
    `${START}(?:${brand.name})(?:['’]s${END}|[-–—\\s]+(?:inspired|style|like|powered|based)${END})`
      + `|${START}(?:inspired\\s+by|in\\s+the\\s+style\\s+of|like)\\s+(?:${brand.name})${END}`,
    regexFlags(brand, false),
  );
}

/** Where a name counts in `mode`: running text / titles, or a slug (tag, category). */
function detector(brand: DeniedBrand, mode: 'text' | 'slug'): RegExp | null {
  if (brand.contextOnly) return mode === 'slug' ? null : contextPattern(brand);
  return barePattern(brand, mode === 'slug');
}

/** The first deny-list name found in `value` (slugs read with `-`, `_` and `/` as spaces). */
export function findDeniedBrand(value: string, mode: 'text' | 'slug' = 'text'): string | null {
  const subject = mode === 'slug' ? value.replace(/[-_/]+/g, ' ') : value;
  for (const brand of DENIED_BRANDS) {
    const pattern = detector(brand, mode);
    if (pattern && new RegExp(pattern.source, pattern.flags.replace('g', '')).test(subject)) return brand.name;
  }
  return null;
}

/** Fail closed: a display string that still names a denied brand never reaches the DTO. */
export function assertBrandFree(value: string, field: string): string {
  const found = findDeniedBrand(value);
  if (found !== null) throw new Error(`cult projection: ${field} still names a denied brand (${found})`);
  return value;
}

function textFor(brand: DeniedBrand): string {
  return brand.text ?? `series ${brand.series ?? ''}`.trim();
}

/** One line, no control characters (a reason can reach a tab-separated CLI line). */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const MODEL = '(?:(?:chat)?gpt(?:-?\\w+(?:\\.\\d+)?)*|claude|gemini(?:\\s+\\d+(?:\\.\\d+)?)?(?:\\s+flash)?|dall[-·\\s]?e(?:\\s*\\d+)?|sonar)';
const VENDOR_OWNER = '(?:openai|google|perplexity|anthropic|jina\\s+ai|jina)';

/** Phrase rules that read better than the per-name backstop. Order matters. */
const PHRASE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Apple product names: a plain noun plus series A.
  [/\b(?:apple\s+)?iphone(?:\s+\d+)?(?:\s+pro)?(?:\s+max)?(?:[–—-]style)?/gi, 'series A phone'],
  [/\b(?:apple\s+)?(?:pro|studio)\s+display(?:\s+xdr)?[–—-]style\b/gi, 'series A'],
  [/\b(?:apple\s+)?watch\s+ultra[–—-]style(?:\s+watch)?\b/gi, 'series A watch'],
  [/\bvercel\s+(?=ai\s+sdk\b)/gi, ''],
  [/\bshadcn(?:\/ui)?\s+(?=[A-Z])/g, ''],
  // "like GPT-4, Claude, and Gemini" → "from several providers"; a bare list → one neutral phrase.
  [new RegExp(`${START}(?:like|such\\s+as)\\s+${MODEL}(?:\\s*,\\s*(?:and\\s+)?${MODEL}|\\s+and\\s+${MODEL})+${END}`, 'gi'), 'from several providers'],
  [new RegExp(`${START}${MODEL}(?:\\s*,\\s*(?:and\\s+)?${MODEL}|\\s+and\\s+${MODEL})+${END}`, 'gi'), 'several hosted models'],
  // "Google's Gemini 2.5 Flash model" → "a hosted model"; "OpenAI's language models" → "hosted language models".
  [new RegExp(`${START}${VENDOR_OWNER}['’]s\\s+(?=${MODEL}${END})`, 'gi'), ''],
  [new RegExp(`${START}${VENDOR_OWNER}['’]s\\s+(?=[\\w-]+\\s+models${END})`, 'gi'), 'hosted '],
  [new RegExp(`${START}${VENDOR_OWNER}['’]s\\s+`, 'gi'), 'a hosted '],
  [new RegExp(`${START}(${MODEL})\\s+model${END}`, 'gi'), '$1'],
  [/\bopenai\s+embeddings\b/gi, 'hosted embeddings'],
  [/\bcobe\s+(?=webgl\b)/gi, ''],
  [/\bReact\s+(?=Server\s+Components\b)/g, ''],
  [/\bResend\s+(?=email\b)/g, ''],
  [/\bPaper\s+Design\s+/g, ''],
  // "inspired by V0", "in the style of Acme": drop the clause for any proper name (fails closed).
  [/,?\s*\b(?:inspired\s+by|in\s+the\s+style\s+of|modell?ed\s+on)\s+[A-Z]\w*(?:\.\w+)*(?:\s+[A-Z]\w*(?:\.\w+)*)*/g, ''],
];

/** Per-name clause rules, applied before the bare backstop. */
function scrubBrand(text: string, brand: DeniedBrand): string {
  const flags = regexFlags(brand, false);
  const name = `(?:${brand.name})`;
  if (brand.series) {
    return text
      // "Vercel-inspired", "Apple style" → "series V", "series A".
      .replace(new RegExp(`${START}${name}${POSSESSIVE}[-–—\\s]+(?:inspired|style)${END}`, flags), `series ${brand.series}`)
      // "hero-vite" → "hero (series VT)".
      .replace(new RegExp(`(\\w)-${name}${END}`, flags), `$1 (series ${brand.series})`)
      .replace(barePattern(brand), textFor(brand));
  }
  const withoutClauses = text
    // "Stripe-inspired", "Sonner-backed", "COBE-powered": the clause goes, the noun stays.
    .replace(new RegExp(`${START}${name}${POSSESSIVE}[-–—\\s]+(?:inspired|style|backed|powered|based)${END}\\s*`, flags), '')
    .replace(new RegExp(`${START}(?:like|via)\\s+${name}${END}`, flags), '');
  if (brand.contextOnly) return withoutClauses.replace(contextPattern(brand), textFor(brand));
  return withoutClauses.replace(barePattern(brand), textFor(brand));
}

const SENTENCE_START_WORDS = /(^|[.!?]\s+)(series|a|an|hosted|several|forum|schema|desktop|camera|mobile)\b/g;

/**
 * Brand-free running text: "Vercel-inspired pricing section" → "Series V pricing section";
 * "through the Vercel AI SDK" → "through the AI SDK"; "uses OpenAI's GPT-5-nano model" → "uses a
 * hosted language model"; "Sonner-backed polished toasts" → "Polished toasts". One line.
 */
export function cultDisplayText(raw: string): string {
  let text = oneLine(raw);
  for (const [pattern, replacement] of PHRASE_RULES) text = text.replace(pattern, replacement);
  for (const brand of DENIED_BRANDS) text = scrubBrand(text, brand);
  text = text
    .replace(/\b(series \w+)(?:\s+\1\b)+/gi, '$1')
    .replace(/\b(?:a|an|the)\s+(?=(?:a|an)\s)/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(SENTENCE_START_WORDS, (_m, lead: string, word: string) => `${lead}${word.charAt(0).toUpperCase()}${word.slice(1)}`);
  if (/^[a-z]/.test(text) && /^[A-Z]/.test(oneLine(raw))) text = text.charAt(0).toUpperCase() + text.slice(1);
  return assertBrandFree(text, 'text');
}

/**
 * Title brands and their series letters, in section-catalog's order (longer phrases first so
 * "Apple Style" is consumed whole). These rules must title every section and page exactly as
 * `packages/section-catalog/scripts/build-catalog.ts` does; the deny-list backstop below then
 * covers every other name.
 */
const TITLE_BRANDS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\bapple[- ]style\b/i, 'A', ' '],
  [/\biphone(?:\s+\d+)?(?:\s+pro)?(?:\s+max)?\b/i, 'A', ' Phone '],
  [/\bwatch\s+ultra\b/i, 'A', ' Watch '],
  [/\bpro\s+display\s+xdr\b/i, 'A', ' Display '],
  [/\bmac\b/i, 'A', ' '],
  [/\bapple\b/i, 'A', ' '],
  [/\bheerich\b/i, 'H', ' '],
  [/\bshadcn\b/i, 'S', ' '],
  [/\bvercel\b/i, 'V', ' '],
  [/\bvite\b/i, 'VT', ' '],
];

const TITLE_ACRONYMS: ReadonlySet<string> = new Set(['ai', 'api', 'cta', 'faq', 'sdk', 'ui', 'ux', 'svg', 'css', '3d', 'pdf', 'seo']);

/**
 * "apple-keyboard-demo" / "Apple-Keyboard-Demo" → "Apple Keyboard Demo": the inventory titles demo
 * rows by their slug, in any case. Known acronyms stay upper case ("ai-chat" → "AI Chat").
 */
function humanize(title: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(title)) return title;
  return title
    .split('-')
    .map((word) => (TITLE_ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * "Marketing Pricing Vercel" → "Pricing (series V)"; "Marketing CTA — Heerich" → "CTA (series H)";
 * "Apple Keyboard" → "Keyboard (series A)"; "Stripe Subscription" → "Card Payment Subscription".
 * The leading "Marketing" is dropped (every Cult section is a marketing section; its category
 * stays in `sourceCategory`).
 */
function titleParts(rawTitle: string): { title: string; series: string[] } {
  let title = humanize(oneLine(rawTitle));
  const series: string[] = [];
  for (const [pattern, letter, replacement] of TITLE_BRANDS) {
    if (!pattern.test(title)) continue;
    title = title.replace(pattern, replacement);
    if (!series.includes(letter)) series.push(letter);
  }
  for (const brand of DENIED_BRANDS) {
    const pattern = detector(brand, 'text');
    if (!pattern || !pattern.test(title)) continue;
    title = title.replace(pattern, ` ${brand.title ?? ''} `);
    if (brand.series && !series.includes(brand.series)) series.push(brand.series);
  }
  title = title
    // A dash left dangling where a name was removed: "CTA — ", "CTA —", "CTA— ".
    .replace(/\s*[—–]+\s*(?=\s|$)/g, ' ')
    .replace(/(^|\s)-+(?=\s|$)/g, '$1')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[—–+&-]|and\b|with\b)\s*/i, '')
    .replace(/\s+(?:[—–+&-]|and|with)$/i, '')
    .replace(/^Marketing\s+(?=\S)/, '');
  return { title, series };
}

export function cultDisplayTitle(rawTitle: string): string {
  const { title, series } = titleParts(rawTitle);
  const named = title.length === 0 ? 'Untitled' : title;
  const display = series.length > 0 ? `${named} (series ${series.join(', ')})` : named;
  return assertBrandFree(display, 'title');
}

/** `cultDisplayTitle`, but '' (never "Untitled") when no word but a series letter is left. */
export function cultDisplayTitleOrEmpty(rawTitle: string): string {
  const { title, series } = titleParts(rawTitle);
  if (title.length === 0) return '';
  return assertBrandFree(series.length > 0 ? `${title} (series ${series.join(', ')})` : title, 'title');
}

/** Provider tags without any that name a denied brand ("vercel", "apple-style", "stripe-payments"). */
export function cultDisplayTags(tags: readonly string[]): string[] {
  return tags.map(oneLine).filter((tag) => tag.length > 0 && findDeniedBrand(tag, 'slug') === null);
}

/** The provider's category slug, or `other` when it names a denied brand. */
export function cultDisplayCategory(category: string): string {
  const slug = oneLine(category);
  return findDeniedBrand(slug, 'slug') === null ? slug : 'other';
}

// ---------------------------------------------------------------------------------------------
// Public slugs, brand-free file names and export names
// ---------------------------------------------------------------------------------------------

/** A public slug: lower-case words joined by single dashes, like a registry item name. */
export const CULT_PUBLIC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest slug base, cut at a word boundary (a numeric suffix may follow). */
const SLUG_BASE_MAX = 60;

/** "Pricing (series V)" → "pricing-series-v"; "Web App + Forms" → "web-app-forms". '' when no word is left. */
export function cultSlugify(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_BASE_MAX && slug) break;
    slug = next.slice(0, SLUG_BASE_MAX);
  }
  return slug;
}

/** True when a slug, file stem or identifier (read as words) names no denied brand. */
export function isCultBrandFree(value: string): boolean {
  const words = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return findDeniedBrand(words, 'text') === null
    && findDeniedBrand(words.toLowerCase(), 'slug') === null
    && cultBrandRun(cultNameTokens(value)) === null;
}

/**
 * The words of an identifier, slug or path segment: camel and Pascal humps, acronyms and digits,
 * with any other character splitting too. `IPhone17ProMax` → I, Phone, 17, Pro, Max;
 * `OpenAIIconWhite` → Open, AI, Icon, White.
 */
export function cultNameTokens(value: string): string[] {
  return value.split(/[^A-Za-z0-9]+/).flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []);
}

/** A run of this many adjacent words at most is read joined (`Open`+`AI`, `I`+`Pad`+`Pro`). */
const BRAND_RUN_MAX = 4;
/** Words that make a name an integration mark, where even a context-only name is the brand. */
const MARK_WORDS: ReadonlySet<string> = new Set(['icon', 'logo', 'badge', 'mark', 'wordmark', 'logomark']);

const RUN_PATTERNS: ReadonlyArray<readonly [DeniedBrand, RegExp]> = DENIED_BRANDS.map((brand) => [
  brand,
  // A joined run has no spaces or dots: `pro display xdr` reads `prodisplayxdr`, `trigger.dev`
  // reads `triggerdev`.
  new RegExp(`^(?:${brand.name.replace(/\\s[+*]/g, '').replace(/\\\./g, '')})$`, 'i'),
]);

/**
 * The first denied brand that a run of adjacent words spells when joined and lower-cased, with
 * the run's bounds: `I`+`Phone` (iphone), `Open`+`AI` (openai), `Git`+`Hub` (github). A splitter
 * cuts these apart, so a word-by-word check alone misses them. The whole run must be the name,
 * so an ordinary word that merely contains one (`Machine`, `Invite`) is not a match. A
 * context-only name (`Linear`, `Notion`) counts only in an integration mark (`LinearIcon`).
 */
export function cultBrandRun(tokens: readonly string[]): { start: number; end: number; brand: DeniedBrand } | null {
  for (let start = 0; start < tokens.length; start += 1) {
    const run = brandRunAt(tokens, start);
    if (run !== null) return run;
  }
  return null;
}

/** The shortest brand run that starts at `start` (see `cultBrandRun`), or null. */
function brandRunAt(tokens: readonly string[], start: number): { start: number; end: number; brand: DeniedBrand } | null {
  const mark = tokens.some((token) => MARK_WORDS.has(token.toLowerCase()));
  // Shortest run first, so `I Phone 17 Pro` yields the run `I Phone` and the title scrub still
  // reads the model words after it.
  for (let end = start + 1; end <= Math.min(tokens.length, start + BRAND_RUN_MAX); end += 1) {
    const joined = tokens.slice(start, end).join('').toLowerCase();
    for (const [brand, pattern] of RUN_PATTERNS) {
      if (brand.contextOnly && !mark) continue;
      if (pattern.test(joined)) return { start, end, brand };
    }
  }
  return null;
}

/**
 * The slug base of one catalog row: its brand-free display title, slugified. "Marketing Pricing
 * Vercel" → "pricing-series-v"; "Stripe Subscription" → "card-payment-subscription".
 */
export function cultPublicSlugBase(rawTitle: string): string {
  return cultSlugify(cultDisplayTitle(rawTitle)) || 'item';
}

export interface CultSlugRow {
  id: string;
  name: string;
  title: string;
}

/**
 * One public slug per row, keyed by row id: unique, brand-free, and never another row's internal
 * name (so an old name used as an alias can only mean its own row).
 *
 * Stable: a row keeps its `previous` slug while that slug is still valid for it (same title base,
 * free, brand-free). A row without one takes its base, then `<base>-2`, `<base>-3`, … in row-id
 * order. The result depends only on the rows and `previous`, so a regeneration is deterministic.
 * Throws when a slug would name a denied brand (the title scrub missed one): fail closed.
 */
export function assignCultSlugs(rows: readonly CultSlugRow[], previous: Readonly<Record<string, string>> = {}): Record<string, string> {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const names = new Map(sorted.map((row) => [row.name, row.id]));
  const taken = new Set<string>();
  const out: Record<string, string> = {};
  const free = (slug: string, row: CultSlugRow): boolean => {
    const owner = names.get(slug);
    return !taken.has(slug) && (owner === undefined || owner === row.id);
  };
  const bases = new Map(sorted.map((row) => [row.id, cultPublicSlugBase(row.title)]));
  for (const row of sorted) {
    const kept = previous[row.id];
    const base = bases.get(row.id)!;
    if (kept === undefined || !CULT_PUBLIC_SLUG.test(kept)) continue;
    // The base itself, or the base with any suffix from 2 up (`-2` … `-9`, `-10`, `-11`, …).
    if (kept !== base && !new RegExp(`^${base}-(?:[2-9]|[1-9][0-9]+)$`).test(kept)) continue;
    if (!free(kept, row) || !isCultBrandFree(kept)) continue;
    out[row.id] = kept;
    taken.add(kept);
  }
  for (const row of sorted) {
    if (out[row.id] !== undefined) continue;
    const base = bases.get(row.id)!;
    let slug = base;
    for (let n = 2; !free(slug, row); n += 1) slug = `${base}-${n}`;
    if (!isCultBrandFree(slug)) throw new Error(`cult slug: ${row.id} would be "${slug}", which names a denied brand`);
    out[row.id] = slug;
    taken.add(slug);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** "a payments service" → "payments-service": a brand's neutral noun, as a slug. */
function neutralNounSlug(stem: string): string {
  const run = cultBrandRun(cultNameTokens(stem));
  if (run !== null) return cultSlugify(textFor(run.brand).replace(/^(?:a|an|the)\s+/i, '')) || 'item';
  const subject = stem.replace(/[-_/]+/g, ' ');
  for (const brand of DENIED_BRANDS) {
    const pattern = detector(brand, 'slug');
    if (pattern && new RegExp(pattern.source, pattern.flags.replace('g', '')).test(subject)) {
      return cultSlugify(textFor(brand).replace(/^(?:a|an|the)\s+/i, ''));
    }
  }
  return 'item';
}

/**
 * A brand-free file or folder name for one path segment, keeping its extension. A segment that
 * names no brand is returned as it is. `rowSlugs` maps a catalog row's internal name to its public
 * slug, so a folder named after an item (`sections/marketing-about-vite/`) takes that item's slug;
 * any other branded stem is titled like a row and slugified (`pricing-vite` →
 * `pricing-series-vt`, `stripe` → `card-payment`), or, when nothing is left (`polar`), the
 * brand's neutral noun (`payments-service`). A pure function of the segment, so every item that
 * names the same file names it the same way.
 */
export function cultBrandFreeSegment(segment: string, rowSlugs: ReadonlyMap<string, string>): string {
  const dot = segment.lastIndexOf('.');
  const stem = dot > 0 ? segment.slice(0, dot) : segment;
  const ext = dot > 0 ? segment.slice(dot) : '';
  if (isCultBrandFree(stem)) return segment;
  const fromRow = rowSlugs.get(stem);
  if (fromRow !== undefined) return `${fromRow}${ext}`;
  // Title-case each word first, so a name the scrub matches only capitalized ("stripe") is caught.
  // Split at humps too (`postgresGradient` → Postgres Gradient), so a brand is never left inside
  // one lower-cased word.
  const words = cultNameTokens(stem).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  for (const candidate of [words, replaceBrandRuns(cultNameTokens(stem)).join(' ')]) {
    const titled = cultSlugify(cultDisplayTitleOrEmpty(candidate));
    if (titled && isCultBrandFree(titled)) return `${titled}${ext}`;
  }
  return `${neutralNounSlug(stem)}${ext}`;
}

/**
 * A directory segment's brand-free name: a row's own internal name (`marketing-cta-hex`) takes
 * that row's public slug (`cta-hex`) even when the name is already brand-free — `isCultBrandFree`
 * has nothing to catch there, since the name carries no vendor brand, only the internal row name
 * that names its own folder. Falls back to `cultBrandFreeSegment`'s ordinary brand scrub for a
 * segment that names no row. Never applied to a path's last segment (the file name): a file is
 * still named by `cultBrandFreeSegment` alone, so a segment equal to a row's name isn't retargeted
 * unless it is genuinely the row's own folder.
 */
function cultBrandFreeDirSegment(segment: string, rowSlugs: ReadonlyMap<string, string>): string {
  return rowSlugs.get(segment) ?? cultBrandFreeSegment(segment, rowSlugs);
}

/**
 * `cultBrandFreeSegment` over every `/`-separated segment of a path or import specifier, with
 * every directory segment (every segment but the last) also checked against `rowSlugs` for a
 * brand-free internal row name (`cultBrandFreeDirSegment`), so a served item's own folder always
 * takes its public slug.
 */
export function cultBrandFreePath(value: string, rowSlugs: ReadonlyMap<string, string>): string {
  const segments = value.split('/');
  const last = segments.length - 1;
  return segments.map((segment, index) => {
    if (segment === '' || segment === '.' || segment === '..' || segment.startsWith('@')) return segment;
    return index === last ? cultBrandFreeSegment(segment, rowSlugs) : cultBrandFreeDirSegment(segment, rowSlugs);
  }).join('/');
}

type IdentifierCase = 'pascal' | 'camel' | 'screaming';

function identifierWords(name: string): { words: string[]; style: IdentifierCase } | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(name) || name.includes('$')) return null;
  const style: IdentifierCase = /^[A-Z0-9_]+$/.test(name) && /[A-Z]/.test(name) && (name.includes('_') || name.length > 1)
    ? 'screaming'
    : /^[a-z]/.test(name) ? 'camel' : 'pascal';
  const words = style === 'screaming'
    ? name.split('_').filter(Boolean)
    : name.split('_').flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []);
  return words.length > 0 ? { words, style } : null;
}

/** "AI" stays; "vite" / "VITE" → "Vite", so a case-sensitive name ("Stripe") is still titled. */
function titleWord(word: string, style: IdentifierCase): string {
  if (style !== 'screaming' && /^[A-Z]{2,3}$/.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * A brand-free name for an exported identifier, in its own case style, or null when it names no
 * brand or no safe name is left: `VercelPricing` → `PricingSeriesV`, `useStatsVite` →
 * `useStatsSeriesVT`, `STRIPE_SUB_CACHE` → `CARD_PAYMENT_SUB_CACHE`, `Polar` → `PaymentsService`.
 * A pure function of the name.
 */
export function cultBrandFreeIdentifier(name: string): string | null {
  const parsed = identifierWords(name);
  if (parsed === null || isCultBrandFree(name)) return null;
  // Candidates, first brand-free one wins: the words as split; digits kept on ("V0 Icon"); brand
  // runs joined ("I Phone" → "Iphone", so the title scrub sees it); brand runs replaced directly
  // by their neutral word (a context-only name in a mark, which the title scrub leaves alone).
  const joinedDigits = parsed.words.join(' ').replace(/([A-Za-z]) (\d+)(?= |$)/g, '$1$2').split(' ');
  for (const words of [parsed.words, joinedDigits, mergeBrandRuns(parsed.words), replaceBrandRuns(parsed.words)]) {
    const next = renameWords(name, words, parsed.style);
    if (next !== null) return next;
  }
  return null;
}

/** Each brand run joined into one word: [Open, AI, Icon] → [Openai, Icon]. */
function mergeBrandRuns(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let start = 0; start < words.length;) {
    const run = brandRunAt(words, start);
    if (run === null || run.end - run.start === 1) {
      out.push(words[start]!);
      start += 1;
      continue;
    }
    const joined = words.slice(run.start, run.end).join('');
    out.push(joined.charAt(0).toUpperCase() + joined.slice(1).toLowerCase());
    start = run.end;
  }
  return out;
}

/**
 * Each brand run replaced by its neutral word: its title words (`iphone` → `Phone`), or nothing
 * when it has none; a style provider's series letter is appended (`Series A`); and when nothing
 * is left the brand's neutral noun names it.
 */
function replaceBrandRuns(words: readonly string[]): string[] {
  let out = [...words];
  const series: string[] = [];
  let lastNoun = '';
  for (let run = cultBrandRun(out), guard = 0; run !== null && guard < 16; run = cultBrandRun(out), guard += 1) {
    const { brand } = run;
    const replacement = (brand.title ?? '').split(/\s+/).filter(Boolean);
    if (brand.series && !series.includes(brand.series)) series.push(brand.series);
    lastNoun = textFor(brand).replace(/^(?:a|an|the)\s+/i, '');
    out = [...out.slice(0, run.start), ...replacement, ...out.slice(run.end)];
  }
  if (out.length === 0 && series.length === 0) out = lastNoun.split(/\s+/).filter(Boolean);
  return [...out, ...series.flatMap((letter) => ['Series', letter])];
}

function renameWords(name: string, source: readonly string[], style: IdentifierCase): string | null {
  const phrase = source.map((word) => titleWord(word, style)).join(' ');
  // Nothing left but the brand (`Polar`): its neutral noun, as file names get (`PaymentsService`).
  const titled = cultDisplayTitleOrEmpty(phrase) || neutralNounSlug(phrase.toLowerCase());
  let words = titled.split(/[^A-Za-z0-9]+/).filter(Boolean);
  // The title drops a leading "Marketing"; keep it when the name would start with a digit.
  if (/^\d/.test(words[0] ?? '') && /^marketing$/i.test(source[0] ?? '')) words = ['Marketing', ...words];
  if (words.length === 0) return null;
  let next: string;
  if (style === 'screaming') next = words.map((word) => word.toUpperCase()).join('_');
  else {
    const pascal = words.map((word) => (/^[A-Z0-9]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)));
    next = pascal.join('');
    if (style === 'camel') next = next.charAt(0).toLowerCase() + next.slice(1);
  }
  if (!/^[A-Za-z_][\w]*$/.test(next) || next === name || !isCultBrandFree(next)) return null;
  return next;
}

/**
 * True when a short label a person reads or hears (an `aria-label`, `alt`, `title`, `placeholder`)
 * names no denied brand. Stricter than `isCultBrandFree`: a context-only name (`Discord`, `Slack`)
 * counts here, the way it does in an integration mark, since a label on a social or integration
 * link is exactly that mark in words.
 */
export function isCultBrandFreeLabel(value: string): boolean {
  return isCultBrandFree(value) && cultBrandRun([...cultNameTokens(value), 'Icon']) === null;
}

/**
 * A label with every denied brand replaced: the display scrub first ("Visit us on GitHub" →
 * "Visit us on a code host"), then any name it leaves, context-only ones included, becomes its
 * neutral noun ("Discord" → "A third-party service"). A leading capital is kept.
 */
export function cultBrandFreeLabel(value: string): string {
  let text = cultDisplayText(value);
  for (const brand of DENIED_BRANDS) {
    if (isCultBrandFreeLabel(text)) break;
    text = text.replace(new RegExp(`${START}(?:${brand.name})${POSSESSIVE}${END}`, brand.caseSensitive ? 'g' : 'gi'), textFor(brand));
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (/^[A-Z]/.test(value) && /^[a-z]/.test(text)) text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!isCultBrandFreeLabel(text)) throw new Error('cult label: a denied brand survived the scrub');
  return text;
}
