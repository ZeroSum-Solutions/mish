// The independent vendor-name check for the brand-free Cult tests, written apart from the
// production deny list (packages/contracts/src/api/cult-brand.ts) so a gap there fails here. No
// test-runner import, so any test can load it (tests/helpers/cult-brands.ts adds the vitest form).
//
// Two reads of the text: word by word (identifiers split at their humps, `-_/.:` as spaces), and
// joined runs of up to four adjacent words (`I`+`Phone`, `Open`+`AI`, `Git`+`Hub`), because a
// hump splitter cuts some names apart and a word check alone then misses them.

// The brand list of tests/cult-catalog-routes.test.ts, plus vendor names found in the inventory's
// file and export names (gemini-flash-image, google-flash-text, not-found-vercel, polar,
// YouTubeIcon, TailwindCSSIcon), Linear, Notion and Slack, and every other name on the production
// deny list except the context-only ones that are ordinary words (Meta, Llama) and x.com.
const NAMES = [
  'vercel', 'vite', 'apple', 'shadcn', 'heerich', 'iphone', 'ipad', 'mac', 'macos', 'macbook',
  'dynamic island', 'watch ultra', 'xdr', 'openai', 'gpt', 'chatgpt', 'dall-e', 'gemini',
  'google', 'claude', 'anthropic', 'perplexity', 'sonar', 'stripe', 'supabase', 'resend',
  'jina', 'reddit', 'trigger\\.dev', 'polar', 'v0', 'next\\.js', 'nextjs', 'redis', 'upstash',
  'radix', 'zod', 'cheerio', 'cobe', 'sonner', 'react', 'paper design', 'postgres', 'pgvector',
  'mozilla', 'linear', 'notion', 'slack', 'github', 'youtube', 'tailwind', 'framer', 'three\\.js',
  'figma', 'twitter', 'discord', 'aws', 'hugging face', 'huggingface', 'deepseek', 'mistral',
  'openrouter', 'firebase', 'netlify', 'cloudflare', 'twilio', 'shopify', 'microsoft', 'amazon',
  'gitlab', 'ios', 'studio display', 'pro display', 'facebook', 'instagram', 'tiktok', 'netflix',
  'spotify', 'airbnb', 'uber', 'postgresql', 'dynamic island', 'jina ai',
];

/**
 * Names that are also ordinary words in markup (`linear-gradient`, an SVG `paint0_linear` id). In
 * `markup` mode they count only as capitalized proper nouns (`aria-label="Slack"`).
 */
const ORDINARY_IN_MARKUP: ReadonlySet<string> = new Set(['linear', 'notion', 'slack']);

const wordsPattern = (names: readonly string[]) => new RegExp(`(?<![a-z0-9])(?:${names.join('|')})(?:['’]s|s)?(?![a-z0-9])`, 'i');
const runsPattern = (names: readonly string[]) => new RegExp(`^(?:${names.map((name) => name.replace(/\\\.|[\s-]/g, '')).join('|')})$`, 'i');
const WORDS = wordsPattern(NAMES);
const RUNS = runsPattern(NAMES);
const MARKUP_NAMES = NAMES.filter((name) => !ORDINARY_IN_MARKUP.has(name));
const MARKUP_WORDS = wordsPattern(MARKUP_NAMES);
const MARKUP_RUNS = runsPattern(MARKUP_NAMES);
/**
 * Names distinctive enough to count even inside one word (`postgresGradient` lower-cased to
 * `postgresgradient`), where neither the word nor the joined-run read can see them. Names that
 * are also parts of ordinary words (`apple` in `pineapple`, `vite` in `invite`, `stripe` in
 * `striped`, `framer` in `framerate`, `mac`, `aws`, `uber`, `ios`, `zod`, `cobe`, `sonar`) are left
 * to the word and run reads.
 */
const DISTINCTIVE = /(?:vercel|shadcn|heerich|iphone|ipad|macbook|openai|chatgpt|gemini|google|anthropic|perplexity|supabase|cheerio|sonner|postgres|pgvector|mozilla|github|gitlab|youtube|tailwind|figma|twitter|discord|deepseek|mistral|openrouter|firebase|netlify|cloudflare|twilio|shopify|microsoft|instagram|tiktok|netflix|spotify|airbnb|upstash|nextjs|huggingface|jina)/i;

const PROPER_NOUNS = new RegExp(`(?<![A-Za-z0-9])(?:${[...ORDINARY_IN_MARKUP].map((name) => name.charAt(0).toUpperCase() + name.slice(1)).join('|')})(?![a-z0-9])`);

/** Identifiers, paths and slugs read as words: `PricingVercel`, `pricing-vercel` → words. */
export function asWords(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[-_/.:]+/g, ' ');
}

function tokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []);
}

/**
 * The first vendor name in `text`, read word by word or as a joined run; null when none. `markup`
 * reads an attribute value or CSS name: `linear`, `notion` and `slack` count there only as
 * capitalized proper nouns (see `ORDINARY_IN_MARKUP`), and a distinctive name counts even inside
 * one word (`DISTINCTIVE`); every other name counts as always.
 */
export function brandHit(text: string, mode: 'text' | 'markup' = 'text'): string | null {
  const words = asWords(text);
  const hit = (mode === 'markup' ? MARKUP_WORDS : WORDS).exec(words) ?? (mode === 'markup' ? PROPER_NOUNS.exec(words) : null);
  if (hit) return words.slice(Math.max(0, hit.index - 40), hit.index + 40);
  if (mode === 'markup') {
    const inside = DISTINCTIVE.exec(text);
    if (inside) return text.slice(Math.max(0, inside.index - 40), inside.index + 40);
  }
  const list = tokens(text);
  const runs = mode === 'markup' ? MARKUP_RUNS : RUNS;
  for (let start = 0; start < list.length; start += 1) {
    for (let end = start + 2; end <= Math.min(list.length, start + 4); end += 1) {
      if (runs.test(list.slice(start, end).join(''))) return list.slice(Math.max(0, start - 4), end + 4).join(' ');
    }
  }
  return null;
}
