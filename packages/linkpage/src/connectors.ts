import type { ColorSignal, Connector, ConnectorFactory, ConnectorOptions, FetchFn, FontSignal, LoginFetch, NeedsLogin, Signal, SignalLink } from './types.ts';

// Profile connectors read what a creator already has online and report it as signals.
//
// A connector is { name, read(ref) } where read returns a signal:
//   { source, name, bio, avatar_url, links: [{ label, url, kind }], posts: [{ title, url, image_url, published }],
//     colors: [{ hex, weight }], fonts: [{ family, weight }], stats, images: [url], needs_login: { platform, why } }
// Every field is optional. Add a platform by adding one entry to `connectors`; nothing else changes.

const UA = 'Mozilla/5.0 (compatible; MishLinkPage/1)';

const KINDS = [
  ['instagram.com', 'instagram'], ['tiktok.com', 'tiktok'], ['youtube.com', 'youtube'], ['youtu.be', 'youtube'],
  ['substack.com', 'substack'], ['twitter.com', 'x'], ['x.com', 'x'], ['facebook.com', 'facebook'],
  ['pinterest.com', 'pinterest'], ['linkedin.com', 'linkedin'], ['threads.net', 'threads'], ['spotify.com', 'spotify'],
  ['etsy.com', 'etsy'], ['twitch.tv', 'twitch'], ['github.com', 'github'], ['bsky.app', 'bluesky'],
];

export function kindOfUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return KINDS.find(([h]) => host === h || host.endsWith('.' + h))?.[1] || 'link';
  } catch {
    return 'link';
  }
}

const decode = (s: string): string => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .trim();

function meta(html: string, key: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const k = /\b(?:property|name)=["']([^"']+)["']/i.exec(tag)?.[1];
    if (k?.toLowerCase() === key) {
      const v = /\bcontent=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      if (v) return decode((v[1] ?? v[2]) as string);
    }
  }
  return '';
}

async function get(fetch: FetchFn, url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml,text/css,*/*' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

const count = (items: string[]): [string, number][] => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) || 0) + 1);
  return [...m].map(([k, weight]) => [k, weight]);
};

const GENERIC = /^(inherit|initial|unset|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|arial|helvetica|helvetica neue|segoe ui|roboto|avenir)$/i;

export function colorsFromCss(css: string): ColorSignal[] {
  const hexes = (css.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) || []).map((h) => h.toLowerCase());
  return count(hexes).map(([hex, weight]) => ({ hex: hex.length === 4 ? '#' + [...hex.slice(1)].map((c) => c + c).join('') : hex, weight }));
}

// Not a font name: a function (clamp(...), calc(...)) or a number or size (13px, 700).
const NOT_A_NAME = /[()]|^[-+.]?\d/;
// Variables that hold sizes, weights and spacing rather than a family, though "font" is in their name.
const NOT_A_FAMILY_VAR = /font-(?:size|weight|style|stretch|variant|feature|kerning)|line-height|letter-spacing|text-/i;

export function fontsFromCss(css: string): FontSignal[] {
  const families: string[] = [];
  const firstName = (list: string): string | undefined => list.split(',').map((f) => f.replace(/\s*!important/i, '').replace(/["']/g, '').trim()).find((f) => f && !GENERIC.test(f) && !NOT_A_NAME.test(f));
  for (const [, list] of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    if (list.includes('var(')) continue;
    const first = firstName(list);
    if (first) families.push(first);
  }
  // A font declared once with a variable, like --serif, still counts.
  for (const [, name, list] of css.matchAll(/(--[a-z0-9-]*(?:serif|sans|font|display|mono)[a-z0-9-]*)\s*:\s*([^;}]+)/gi)) {
    if (NOT_A_FAMILY_VAR.test(name as string)) continue;
    const first = firstName(list as string);
    if (first) families.push(first);
  }
  return count(families).map(([family, weight]) => ({ family, weight }));
}

// The creator's own website: its title, social links and, most useful, the colours and fonts its CSS uses.
// Pictures worth looking at: the share image first, then up to four big-enough <img> tags. https only.
export function imagesFromHtml(html: string, base: string | URL): string[] {
  const found: string[] = [];
  const add = (src: string): void => {
    try {
      const u = new URL(src, base);
      if (u.protocol === 'https:' && !found.includes(u.href)) found.push(u.href);
    } catch { /* not a usable address */ }
  };
  const og = meta(html, 'og:image');
  if (og) add(og);
  let imgs = 0;
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    if (imgs >= 4) break;
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src || /^data:|\.(svg|gif)(\?|$)/i.test(src) || /sprite|icon|pixel|tracking/i.test(src)) continue;
    const size = (k: string): number => Number(new RegExp(`\\b${k}=["']?(\\d+)`, 'i').exec(tag)?.[1] || 0);
    // A declared size under 150px is an icon or a spacer. No declared size gets the benefit of the doubt.
    if ((size('width') && size('width') < 150) || (size('height') && size('height') < 150)) continue;
    const before = found.length;
    add(src);
    if (found.length > before) imgs++;
  }
  return found;
}

function website({ fetch = globalThis.fetch }: ConnectorOptions = {}): Connector {
  return {
    name: 'website',
    async read(url: string): Promise<Signal> {
      const base = new URL(url);
      const html = await get(fetch, base.href);
      const sheets = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]
        .map((t) => /href=["']([^"']+)["']/i.exec(t[0])?.[1])
        .filter(Boolean)
        .map((h) => new URL(h as string, base))
        .filter((u) => u.origin === base.origin)
        .slice(0, 4);
      const css = [...(html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [])];
      for (const sheet of sheets) css.push(await get(fetch, sheet.href).catch(() => ''));
      const all = css.join('\n');
      const themeColor = meta(html, 'theme-color');

      const links: SignalLink[] = [];
      for (const [, href] of html.matchAll(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["']/gi)) {
        const kind = kindOfUrl(href as string);
        if (kind !== 'link' && new URL(href as string).origin !== base.origin) links.push({ url: href as string, kind });
      }
      const image = meta(html, 'og:image');
      return {
        source: 'website',
        name: meta(html, 'og:site_name') || decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || ''),
        bio: meta(html, 'og:description') || meta(html, 'description'),
        site: { url: base.origin, title: meta(html, 'og:title'), image_url: image ? new URL(image, base).href : '' },
        links,
        colors: [...colorsFromCss(all), ...(themeColor ? [{ hex: themeColor, weight: 3 }] : [])],
        fonts: fontsFromCss(all),
        images: imagesFromHtml(html, base),
      };
    },
  };
}

// Public Substack feed: the publication and its latest posts.
function substack({ fetch = globalThis.fetch }: ConnectorOptions = {}): Connector {
  return {
    name: 'substack',
    async read(ref: string): Promise<Signal> {
      const url = /^https?:/.test(ref) ? new URL('/feed', ref).href : `https://${ref}.substack.com/feed`;
      const xml = await get(fetch, url);
      const tag = (s: string, t: string): string => decode(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(s)?.[1] || '');
      const channel = xml.split(/<item>/i)[0] as string;
      const posts = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 6).map(([, item]) => ({
        title: tag(item as string, 'title'),
        url: tag(item as string, 'link'),
        image_url: /<enclosure[^>]*url=["']([^"']+)["']/i.exec(item as string)?.[1] || '',
        published: tag(item as string, 'pubDate'),
      }));
      return {
        source: 'substack',
        name: tag(channel, 'title'),
        bio: tag(channel, 'description'),
        links: [{ url: tag(channel, 'link') || url.replace('/feed', ''), kind: 'substack', label: tag(channel, 'title') }],
        posts,
      };
    },
  };
}

// Instagram and TikTok publish only a little to anyone who is not signed in: a name, a profile picture, a
// follower count. That is what this reads without a login, and the signal says so in `needs_login`.
// With `login` (a fetch that carries the creator's own login, like createComposioFetch) it uses the
// platform's official API for their own bio, posts and follower count.
const WHY: Record<string, string> = {
  instagram: 'Signing in with Instagram lets the page show your own bio, latest posts and follower count.',
  tiktok: 'Signing in with TikTok lets the page show your own bio, latest videos and follower count.',
};
const cap = (kind: string): string => kind[0].toUpperCase() + kind.slice(1);
const followers = (n: unknown): string => (Number.isFinite(n) ? `${(n as number).toLocaleString('en-US')} followers` : '');

// The shapes of the two platforms' replies, as far as this reads them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function api(login: LoginFetch, url: string, init?: RequestInit): Promise<Json> {
  const res = await login(url, init);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

// NOTE: the request and reply formats below come from Instagram's and TikTok's documentation. They have not
// yet been checked against real accounts, so expect to adjust field names after the first live run.
async function instagramApi(login: LoginFetch, handle: string): Promise<Signal> {
  const me = await api(login, 'https://graph.instagram.com/me?fields=username,name,biography,profile_picture_url,followers_count,media_count');
  const media = await api(login, 'https://graph.instagram.com/me/media?fields=caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=6');
  const user = me.username || handle;
  const url = `https://www.instagram.com/${user}/`;
  return {
    source: 'instagram',
    name: me.name || user,
    bio: me.biography || '',
    avatar_url: me.profile_picture_url || '',
    stats: followers(me.followers_count),
    links: [{ url, kind: 'instagram', label: 'Instagram', handle: '@' + user }],
    posts: (media.data || []).map((m: Json) => ({
      title: String(m.caption || '').split('\n')[0].trim(),
      url: m.permalink || '',
      image_url: m.thumbnail_url || m.media_url || '',
      published: m.timestamp || '',
    })),
  };
}

async function tiktokApi(login: LoginFetch, handle: string): Promise<Signal> {
  const info = await api(login, 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,bio_description,profile_deep_link,follower_count');
  const list = await api(login, 'https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,share_url,create_time', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_count: 6 }),
  });
  const u = info.data?.user || {};
  return {
    source: 'tiktok',
    name: u.display_name || handle,
    bio: u.bio_description || '',
    avatar_url: u.avatar_url || '',
    stats: followers(u.follower_count),
    links: [{ url: u.profile_deep_link || `https://www.tiktok.com/@${handle}`, kind: 'tiktok', label: 'TikTok', handle: '@' + handle }],
    posts: (list.data?.videos || []).map((v: Json) => ({
      title: String(v.title || '').split('\n')[0].trim(),
      url: v.share_url || '',
      image_url: v.cover_image_url || '',
      published: v.create_time ? new Date(v.create_time * 1000).toISOString() : '',
    })),
  };
}

function socialMeta(kind: string, profileUrl: (handle: string) => string, withLogin: (login: LoginFetch, handle: string) => Promise<Signal>): ConnectorFactory {
  return ({ fetch = globalThis.fetch, login }: ConnectorOptions = {}) => ({
    name: kind,
    async read(handle: string): Promise<Signal> {
      const clean = String(handle || '').replace(/^@/, '');
      if (login) return withLogin(login, clean);
      const url = profileUrl(clean);
      const html = await get(fetch, url);
      const title = meta(html, 'og:title');
      return {
        source: kind,
        name: title.replace(/\s*\(@[^)]*\).*$/, '').replace(/\s*[•|·-]\s*(Instagram|TikTok).*$/i, '').trim(),
        avatar_url: meta(html, 'og:image'),
        stats: meta(html, 'og:description'),
        links: [{ url, kind, label: cap(kind), handle: '@' + clean }],
        needs_login: { platform: kind, why: WHY[kind] },
      };
    },
  });
}

// The login prompts a set of signals is asking for, one per platform that was read without a login.
export function loginNeeds(signals: (Signal | null | undefined)[] | null | undefined): NeedsLogin[] {
  return (signals || []).map((s) => s?.needs_login).filter((n): n is NeedsLogin => Boolean(n));
}

// Anything typed in by hand, so the page can always be built even when a platform shows nothing.
function manual(): Connector {
  return { name: 'manual', read: async (signal: unknown) => ({ source: 'manual', ...(signal as Signal) }) };
}

export const connectors: Record<string, ConnectorFactory> = {
  website,
  substack,
  instagram: socialMeta('instagram', (h) => `https://www.instagram.com/${h}/`, instagramApi),
  tiktok: socialMeta('tiktok', (h) => `https://www.tiktok.com/@${h}`, tiktokApi),
  manual,
};
