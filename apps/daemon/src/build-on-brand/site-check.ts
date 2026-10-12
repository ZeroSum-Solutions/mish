/**
 * Post-build site check for a Build on brand project (spec §"Check"). Pure: it reads the
 * project's root `.html` and `.css` text it is given and returns one pass/fail per rule.
 */
import { load } from 'cheerio';
import {
  BUILD_ON_BRAND_PAGE_COUNT_MIN,
  SITE_CHECK_RULE_IDS,
  type SiteCheckResult,
  type SiteCheckRuleId,
} from '@mish/contracts';

export interface SiteFiles {
  /** Project-relative path → text, for every root-level `.html` and every `.css` file. */
  [path: string]: string;
}

const EXTERNAL_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;
const REMOTE_URL = /^(?:https?:)?\/\//iu;

function localTarget(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || EXTERNAL_HREF.test(trimmed)) return null;
  const withoutQuery = trimmed.split(/[?#]/u)[0] ?? '';
  if (!withoutQuery) return null;
  const normalized = withoutQuery.replace(/^\.\//u, '').replace(/^\//u, '');
  return normalized === '' ? 'index.html' : normalized.endsWith('/') ? `${normalized}index.html` : normalized;
}

function rule(id: SiteCheckRuleId, failures: string[], okDetail: string): SiteCheckResult['rules'][number] {
  return failures.length === 0
    ? { id, ok: true, detail: okDetail }
    : { id, ok: false, detail: failures.slice(0, 12).join('; ').slice(0, 2000) };
}

export function checkBuiltSite(files: SiteFiles): SiteCheckResult {
  const names = Object.keys(files);
  const pages = names.filter((name) => !name.includes('/') && name.endsWith('.html')).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  const cssText = names.filter((name) => name.endsWith('.css')).map((name) => files[name] ?? '').join('\n');
  const existing = new Set(names);

  const pageFailures: string[] = [];
  if (!pages.includes('index.html')) pageFailures.push('index.html is missing');
  if (pages.length < BUILD_ON_BRAND_PAGE_COUNT_MIN) pageFailures.push(`${pages.length} page(s) found, at least ${BUILD_ON_BRAND_PAGE_COUNT_MIN} expected`);

  const navFailures: string[] = [];
  const viewportFailures: string[] = [];
  const tokenFailures: string[] = [];
  const standInFailures: string[] = [];
  const remoteFailures: string[] = [];
  let inlineReducedMotion = false;

  if (!existing.has('tokens.css')) tokenFailures.push('tokens.css is missing from the project');

  for (const page of pages) {
    const $ = load(files[page] ?? '');
    if ($('meta[name="viewport"]').length === 0) viewportFailures.push(`${page} has no viewport meta`);

    const styles = $('style').text();
    if (/prefers-reduced-motion/u.test(styles)) inlineReducedMotion = true;

    const linksTokens = $('link[rel~="stylesheet"]').toArray().some((link) => localTarget($(link).attr('href') ?? '') === 'tokens.css');
    if (!linksTokens) tokenFailures.push(`${page} does not link tokens.css`);

    const navLinks = $('a[href]').toArray();
    let pageNavLinks = 0;
    for (const link of navLinks) {
      const target = localTarget($(link).attr('href') ?? '');
      if (!target) continue;
      pageNavLinks += 1;
      if (!existing.has(target)) navFailures.push(`${page} links to ${target}, which does not exist`);
    }
    if (pages.length > 1 && pageNavLinks === 0) navFailures.push(`${page} links to no other page`);

    $('.od-stand-in').each((_i, el) => {
      const node = $(el);
      const label = (node.attr('aria-label') ?? '').trim() || node.text().trim();
      if (!label) standInFailures.push(`${page} has a stand-in with no label`);
    });
    $('img').each((_i, el) => {
      const src = ($(el).attr('src') ?? '').trim();
      if (REMOTE_URL.test(src)) remoteFailures.push(`${page} loads a remote image`);
      const srcset = $(el).attr('srcset') ?? '';
      if (/(?:^|[\s,])(?:https?:)?\/\//u.test(srcset)) remoteFailures.push(`${page} loads a remote srcset image`);
    });
    $('[style]').each((_i, el) => {
      if (/url\(\s*['"]?(?:https?:)?\/\//iu.test($(el).attr('style') ?? '')) remoteFailures.push(`${page} has a remote background image`);
    });
    if (/url\(\s*['"]?(?:https?:)?\/\/[^)]*\.(?:png|jpe?g|webp|gif|avif|svg)/iu.test(styles)) remoteFailures.push(`${page} styles load a remote image`);
  }
  if (/url\(\s*['"]?(?:https?:)?\/\/[^)]*\.(?:png|jpe?g|webp|gif|avif|svg)/iu.test(cssText)) remoteFailures.push('a stylesheet loads a remote image');

  const reducedMotion = inlineReducedMotion || /prefers-reduced-motion/u.test(cssText);
  const rules = [
    rule('pages-present', pageFailures, `${pages.length} pages: ${pages.join(', ')}`),
    rule('nav-links-resolve', [...new Set(navFailures)], 'Every local link opens a page in the project'),
    rule('viewport-meta', viewportFailures, 'Every page sets a viewport'),
    rule('reduced-motion', reducedMotion ? [] : ['No prefers-reduced-motion rule found in the pages or their stylesheets'], 'Reduced motion is honoured'),
    rule('kit-tokens-linked', tokenFailures, 'Every page links the kit tokens.css'),
    rule('stand-ins-labelled', standInFailures, 'Every stand-in image is labelled'),
    rule('no-remote-images', [...new Set(remoteFailures)], 'No image loads from another site'),
  ];
  // Keep the declared rule order even if this list is edited.
  rules.sort((a, b) => SITE_CHECK_RULE_IDS.indexOf(a.id) - SITE_CHECK_RULE_IDS.indexOf(b.id));
  return { pages, rules, ok: rules.every((entry) => entry.ok) };
}
