/**
 * `htmlFacts`: what a design profile's Jev fan-out (`profile.ts`) should see from an uploaded
 * HTML page, extracted as named state fields instead of the raw markup — regex only, no DOM
 * library, per `2026-09-19-design-profile-index-design.md` section 5. A malformed or truncated
 * page (unbalanced tags, a cut-off document) still yields facts: every extraction below is a
 * best-effort regex match over the raw string, never a parse that can throw on invalid markup.
 */

export type Landmark = { tag: string; id?: string; class?: string };

export type HtmlSignals = {
  animation: boolean;
  transition: boolean;
  scroll: boolean;
  IntersectionObserver: boolean;
  requestAnimationFrame: boolean;
  three: boolean;
  gsap: boolean;
  framer: boolean;
  prefersReducedMotion: boolean;
};

export type HtmlCounts = { video: number; canvas: number; svg: number; img: number; form: number; iframe: number };

export type HtmlFacts = {
  title: string;
  headings: string[];
  landmarks: Landmark[];
  text: string;
  counts: HtmlCounts;
  fonts: string[];
  signals: HtmlSignals;
};

const MAX_HEADINGS = 40;
const MAX_LANDMARKS = 60;
const MAX_TEXT_CHARS = 20_000;
const LANDMARK_TAGS = ['header', 'nav', 'main', 'section', 'footer'] as const;
const COUNT_TAGS: (keyof HtmlCounts)[] = ['video', 'canvas', 'svg', 'img', 'form', 'iframe'];

/** Strips every HTML tag's angle brackets, leaving only the text between them. Applied after
 * `<script>`/`<style>` blocks are already removed, so no script or style text can leak through. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

// Named entities the fixed set of pages this extracts from tends to carry, plus the four
// structural ones (amp/lt/gt/quot/apos). Numeric entities (&#123;, &#x1F;) are decoded generically
// below, not listed here.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  copy: '©',
};

/** One pass over every `&name;`/`&#123;`/`&#x1F;` entity, so decoding a named entity can never
 * accidentally re-match text a numeric or named decode already produced (the risk with sequential
 * `.replace` calls, e.g. `&amp;lt;` double-unescaping into `<` instead of stopping at `&lt;`). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = isHex ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    const replacement = NAMED_ENTITIES[entity.toLowerCase()];
    return replacement ?? match;
  });
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function removeScriptsAndStyles(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? collapseWhitespace(decodeEntities(match[1] ?? '')) : '';
}

function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  const pattern = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && headings.length < MAX_HEADINGS) {
    const text = collapseWhitespace(decodeEntities(stripTags(match[2] ?? '')));
    if (text) headings.push(text);
  }
  return headings;
}

function attr(tagSource: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tagSource);
  return match ? match[1] : undefined;
}

function extractLandmarks(html: string): Landmark[] {
  const landmarks: Landmark[] = [];
  for (const tag of LANDMARK_TAGS) {
    const pattern = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null && landmarks.length < MAX_LANDMARKS) {
      const id = attr(match[1] ?? '', 'id');
      const cls = attr(match[1] ?? '', 'class');
      landmarks.push({ tag, ...(id ? { id } : {}), ...(cls ? { class: cls } : {}) });
    }
    if (landmarks.length >= MAX_LANDMARKS) break;
  }
  return landmarks.slice(0, MAX_LANDMARKS);
}

function extractCounts(html: string): HtmlCounts {
  const counts = { video: 0, canvas: 0, svg: 0, img: 0, form: 0, iframe: 0 } as HtmlCounts;
  for (const tag of COUNT_TAGS) {
    const matches = html.match(new RegExp(`<${tag}\\b`, 'gi'));
    counts[tag] = matches ? matches.length : 0;
  }
  return counts;
}

function extractFonts(html: string): string[] {
  const fonts = new Set<string>();
  const pattern = /font-family\s*:\s*([^;}]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const list = match[1] ?? '';
    for (const rawName of list.split(',')) {
      const name = rawName.trim().replace(/^["']|["']$/g, '');
      if (name && !/^(sans-serif|serif|monospace|cursive|fantasy|system-ui|inherit|initial|unset)$/i.test(name)) {
        fonts.add(name);
      }
    }
  }
  return [...fonts];
}

function extractSignals(html: string): HtmlSignals {
  return {
    animation: /animation\s*:/i.test(html) || /@keyframes/i.test(html),
    transition: /transition\s*:/i.test(html),
    // Actual scroll-JS/CSS terms, not plain body copy that happens to mention "scroll" (e.g. a
    // "scroll down to see more" hint) — that plain-word match was a false-positive signal.
    scroll:
      /\bscrollY\b/.test(html) ||
      /\bScrollTrigger\b/.test(html) ||
      /scroll-timeline/i.test(html) ||
      /\bonscroll\b/i.test(html) ||
      /addEventListener\(\s*["']scroll["']/i.test(html),
    IntersectionObserver: /IntersectionObserver/.test(html),
    requestAnimationFrame: /requestAnimationFrame/.test(html),
    three: /\bthree(\.js|\.module\.js)?\b/i.test(html) || /\bTHREE\./.test(html),
    gsap: /\bgsap\b/i.test(html),
    framer: /framer-motion/i.test(html) || /\bframer\b/i.test(html),
    prefersReducedMotion: /prefers-reduced-motion/i.test(html),
  };
}

export function htmlFacts(html: string): HtmlFacts {
  const withoutScriptsAndStyles = removeScriptsAndStyles(html);
  const text = collapseWhitespace(decodeEntities(stripTags(withoutScriptsAndStyles))).slice(0, MAX_TEXT_CHARS);
  return {
    title: extractTitle(html),
    headings: extractHeadings(html),
    landmarks: extractLandmarks(html),
    text,
    counts: extractCounts(html),
    fonts: extractFonts(html),
    signals: extractSignals(html),
  };
}
