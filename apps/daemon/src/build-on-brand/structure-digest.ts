/**
 * Structure-only digest of a reference page (Build on brand, spec §"Structure digest").
 *
 * Input: the HTML of ONE page. Output: `BuildOnBrandReferenceDigest`, whose every string leaf is
 * a fixed enum value. Nothing read from the page — text, alt text, class names, URLs, slugs, the
 * host — is copied into the result: roles and layouts are CHOSEN from closed lists by heuristics
 * over the markup, and counts are numbers. A page that renders in JavaScript gives an empty
 * digest and a warning, and the caller falls back to the brief-only plan.
 */
import { load, type CheerioAPI } from 'cheerio';
import {
  BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA,
  buildOnBrandReferenceDigestSchema,
  type BuildOnBrandPageRole,
  type BuildOnBrandReferenceDigest,
  type BuildOnBrandSectionLayout,
  type BuildOnBrandSectionRole,
} from '@open-design/contracts';

export interface StructureDigestResult {
  digest: BuildOnBrandReferenceDigest;
  warnings: string[];
}

export const THIN_DIGEST_WARNING =
  'The reference page gave almost no structure (it may render in JavaScript); the plan uses the default page roles instead.';

/** Keyword → section role, matched against class names, ids and aria labels (never copied). */
const ROLE_HINTS: ReadonlyArray<[RegExp, BuildOnBrandSectionRole]> = [
  [/\bhero|banner|masthead|jumbotron|intro\b/u, 'hero'],
  [/testimonial|review|quote|voices/u, 'testimonials'],
  [/pricing|plans?\b|tiers?|membership/u, 'pricing'],
  [/\bfaqs?\b|questions|accordion/u, 'faq'],
  [/\bcta\b|call-to-action|signup|sign-up|get-started/u, 'cta'],
  [/footer/u, 'footer'],
  [/logos?\b|clients|partners|brands|trusted/u, 'logos'],
  [/stats|metrics|numbers|counters?/u, 'stats'],
  [/process|steps|how-it-works|timeline/u, 'process'],
  [/team|people|staff|doctors|founders/u, 'team'],
  [/gallery|portfolio|work|projects|showcase/u, 'gallery'],
  [/services|treatments|offerings/u, 'services'],
  [/features?|benefits|why/u, 'features'],
  [/booking|appointment|schedule|reserve/u, 'booking'],
  [/contact/u, 'contact'],
  [/\bmap\b|location|hours|directions/u, 'map'],
  [/newsletter|subscribe|waitlist/u, 'newsletter'],
  [/blog|articles|news|posts/u, 'blog'],
  [/about|story|mission/u, 'content'],
];

/** Path keyword → page role. Only the role leaves this module, never the path. */
const PAGE_HINTS: ReadonlyArray<[RegExp, BuildOnBrandPageRole]> = [
  [/pric|plan|member|club|subscri/u, 'pricing'],
  [/about|story|mission|who/u, 'about'],
  [/contact|visit|location|find-us/u, 'contact'],
  [/servic|treatment|offer|what-we-do|menu|product|shop/u, 'services'],
  [/work|portfolio|case|project|gallery/u, 'work'],
  [/team|people|staff|doctor/u, 'team'],
  [/faq|question|help/u, 'faq'],
  [/book|appoint|schedule|reserv/u, 'booking'],
];

/** The few DOM-node fields this module reads (cheerio's own node type lives in domhandler). */
type Element = { tagName: string; attribs?: Record<string, string>; parent?: unknown };

const ITEM_SELECTOR = 'article, li, blockquote, details, figure, .card, [class*="card"], [class*="item"], [class*="plan"]';
const MIN_SECTIONS = 2;

function hintText($: CheerioAPI, el: Element): string {
  const own = [el.attribs?.class, el.attribs?.id, el.attribs?.['aria-label'], el.attribs?.['data-section'], el.tagName]
    .filter(Boolean)
    .join(' ');
  return own.toLowerCase();
}

function roleOf($: CheerioAPI, el: Element, index: number): BuildOnBrandSectionRole {
  if (el.tagName === 'footer') return 'footer';
  const hints = hintText($, el);
  for (const [pattern, role] of ROLE_HINTS) if (pattern.test(hints)) return role;
  const node = $(el as never);
  if (node.find('details, summary').length >= 2) return 'faq';
  if (node.find('blockquote').length >= 1) return 'testimonials';
  if (node.find('form').length >= 1) return node.find('input[type="email"]').length === 1 && node.find('input').length <= 2 ? 'newsletter' : 'contact';
  if (node.find('h1').length >= 1 || index === 0) return 'hero';
  return 'content';
}

function itemCountOf($: CheerioAPI, el: Element): number {
  const node = $(el as never);
  // The most numerous group of sibling items is the section's list of things.
  let best = 0;
  node.find(ITEM_SELECTOR).each((_i, item) => {
    const parent = (item as unknown as Element).parent;
    if (!parent) return;
    const siblings = $(parent as never).children().filter((_j, sibling) => (sibling as unknown as Element).tagName === (item as unknown as Element).tagName).length;
    if (siblings > best) best = siblings;
  });
  return Math.min(best, 64);
}

function layoutOf($: CheerioAPI, el: Element, role: BuildOnBrandSectionRole, items: number): BuildOnBrandSectionLayout {
  const node = $(el as never);
  if (role === 'faq' || node.find('details').length >= 2) return 'list';
  if (node.find('form').length >= 1) return 'form';
  if (/carousel|slider|swiper|marquee/u.test(hintText($, el))) return 'carousel';
  if (role === 'logos') return 'marquee';
  if (role === 'hero') return node.find('img, picture, video, svg').length > 0 ? 'split' : 'centered';
  if (items >= 5) return role === 'testimonials' ? 'carousel' : 'grid-4';
  if (items === 4) return 'grid-4';
  if (items === 3) return 'grid-3';
  if (items === 2) return 'grid-2';
  return 'single-column';
}

function sectionElements($: CheerioAPI): Element[] {
  const main = $('main').first();
  const scope = main.length > 0 ? main : $('body').first();
  const blocks: Element[] = [];
  scope.children().each((_i, child) => {
    const el = child as unknown as Element;
    if (!el.tagName || ['script', 'style', 'noscript', 'template', 'link', 'meta', 'nav', 'header'].includes(el.tagName)) return;
    // Wrapper divs that hold the real sections are unwrapped one level.
    const inner = $(el as never).children('section');
    if (el.tagName === 'div' && inner.length >= 2) {
      inner.each((_j, section) => { blocks.push(section as unknown as Element); });
      return;
    }
    if ($(el as never).text().trim().length === 0 && $(el as never).find('img, svg, video').length === 0) return;
    blocks.push(el);
  });
  const footer = $('body footer').last();
  const footerEl = footer.get(0) as unknown as Element | undefined;
  if (footerEl && !blocks.includes(footerEl)) blocks.push(footerEl);
  return blocks;
}

function pageRoleOfHref(href: string): BuildOnBrandPageRole | null {
  let pathPart: string;
  try {
    pathPart = new URL(href, 'https://reference.invalid/').pathname.toLowerCase();
  } catch {
    return null;
  }
  if (pathPart === '/' || pathPart === '' || /^\/index(\.html?)?$/u.test(pathPart)) return 'home';
  for (const [pattern, role] of PAGE_HINTS) if (pattern.test(pathPart)) return role;
  return null;
}

/** Digest one page's HTML. Pure: no network, no filesystem. */
export function digestReferenceHtml(html: string): StructureDigestResult {
  const $ = load(html);
  const nav = $('header nav, nav[aria-label], nav').first();
  const navLinks = nav.find('a');
  const hasCta = navLinks.toArray().some((a) => /button|btn|cta/u.test(String((a as unknown as Element).attribs?.class ?? '').toLowerCase()));

  const sections = sectionElements($).map((el, index) => {
    const role = roleOf($, el, index);
    const items = itemCountOf($, el);
    const layout = layoutOf($, el, role, items);
    return items > 1 ? { role, layout, itemCount: items } : { role, layout };
  });

  const warnings: string[] = [];
  const thin = sections.length < MIN_SECTIONS;
  if (thin) warnings.push(THIN_DIGEST_WARNING);

  const pageRoles: BuildOnBrandPageRole[] = ['home'];
  if (!thin) {
    for (const a of navLinks.toArray()) {
      const role = pageRoleOfHref(String((a as unknown as Element).attribs?.href ?? ''));
      if (role && !pageRoles.includes(role)) pageRoles.push(role);
      if (pageRoles.length >= 5) break;
    }
  }

  const digest = buildOnBrandReferenceDigestSchema.parse({
    schema: BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA,
    nav: { itemCount: Math.min(navLinks.length, 32), hasCta },
    pages: thin
      ? []
      : pageRoles.map((role) => ({ role, sections: role === 'home' ? sections.slice(0, 40) : [] })),
  });
  return { digest, warnings };
}
