import type { FetchFn, Llm, Signal } from './types.ts';

// Works out who a creator is from what they have published: their site, their posts and their bios.

const UA = 'Mozilla/5.0 (compatible; MishLinkPage/1)';
const PAGE_CAP = 4000;
const PICK = /about|studio|info|story|contact|who|bio|press/i;

const strip = (html: string): string => html
  .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

async function fetchText(fetch: FetchFn, url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,*/*' }, redirect: 'follow' });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

// Same-origin links whose words or address suggest an about or contact page.
function aboutLinks(html: string, base: URL): string[] {
  const out: string[] = [];
  for (const [, href, inner] of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const u = new URL(href, base);
      u.hash = '';
      if (u.origin !== base.origin || u.pathname === '/' || u.href === base.href) continue;
      if ((PICK.test(strip(inner)) || PICK.test(u.pathname)) && !out.includes(u.href)) out.push(u.href);
    } catch { /* skip */ }
  }
  return out.slice(0, 4);
}

export interface Corpus {
  pages: { url: string; text: string }[];
  posts: string[];
  bios: string[];
}

export async function gatherCorpus({ signals = [], fetch = globalThis.fetch }: { signals?: Signal[]; fetch?: FetchFn } = {}): Promise<Corpus> {
  const pages: Corpus['pages'] = [];
  const posts = signals.flatMap((s) => (s.source === 'substack' ? s.posts || [] : [])).map((p) => p.title).filter(Boolean);
  const bios = signals.map((s) => s.bio).filter((b): b is string => Boolean(b));

  for (const url of [...new Set(signals.map((s) => s.site?.url).filter((u): u is string => Boolean(u)))]) {
    const base = new URL(url);
    const home = await fetchText(fetch, base.href);
    if (home) pages.push({ url: base.href, text: strip(home).slice(0, PAGE_CAP) });
    for (const link of aboutLinks(home, base)) {
      const html = await fetchText(fetch, link);
      if (html) pages.push({ url: link, text: strip(html).slice(0, PAGE_CAP) });
    }
    const llms = await fetchText(fetch, new URL('/llms.txt', base).href);
    // A site without llms.txt often answers with a page; only keep plain text.
    if (llms && !llms.toLowerCase().includes('<html')) pages.push({ url: new URL('/llms.txt', base).href, text: llms.replace(/\s+/g, ' ').trim().slice(0, PAGE_CAP) });
  }
  return { pages, posts, bios };
}

const SYSTEM = `You write a short, true profile of a creator for their link page.
Use ONLY the material in the corpus. Never invent facts, places, dates, awards, prices or names.
If the corpus is thin or unclear, say less and set confidence to "low". Use "high" only when several sources agree.
Describe the whole person: who they are and what they make or say, not just their newest product.
Answer with JSON only:
{"headline":"max 70 chars, who they are","bio":"max 220 chars, plain, avoid first person, about the whole person and what they make or say",
"about":"max 600 chars","themes":["up to 6 short strings"],"voice":"tone in at most 20 words",
"offerings":[{"label":"...","url":"optional, only a URL that appears in the corpus"}],"confidence":"high|medium|low"}`;

const text = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export interface Person {
  headline: string;
  bio: string;
  about: string;
  themes: string[];
  voice: string;
  offerings: { label: string; url?: string }[];
  confidence: 'high' | 'medium' | 'low';
}

interface PersonReply {
  headline?: unknown;
  bio?: unknown;
  about?: unknown;
  themes?: unknown;
  voice?: unknown;
  offerings?: { label?: unknown; url?: unknown }[];
  confidence?: unknown;
}

export async function understandPerson({ signals = [], corpus, llm }: { signals?: Signal[]; corpus?: Corpus; llm?: Llm } = {}): Promise<Person | null> {
  if (!llm) return null;
  const c: Corpus = corpus || { pages: [], posts: [], bios: signals.map((s) => s.bio).filter((b): b is string => Boolean(b)) };
  const user = [
    ...c.bios.map((b, i) => `BIO ${i + 1}: ${b}`),
    ...(c.posts.length ? [`POST TITLES: ${c.posts.join(' | ')}`] : []),
    ...c.pages.map((p) => `PAGE ${p.url}\n${p.text}`),
  ].join('\n\n') || '(the corpus is empty)';
  const r = (await llm.json({ system: SYSTEM, user })) as PersonReply | null | undefined;
  const offerings = (Array.isArray(r?.offerings) ? r.offerings : [])
    .map((o) => ({ label: text(o?.label, 60), ...(/^https?:\/\//.test((o?.url as string) || '') ? { url: String(o.url) } : {}) }))
    .filter((o) => o.label)
    .slice(0, 8);
  return {
    headline: text(r?.headline, 70),
    bio: text(r?.bio, 220),
    about: text(r?.about, 600),
    themes: (Array.isArray(r?.themes) ? (r.themes as unknown[]) : []).map((t) => text(t, 30)).filter(Boolean).slice(0, 6),
    voice: text(r?.voice, 200).split(' ').slice(0, 20).join(' '),
    offerings,
    confidence: r?.confidence === 'high' || r?.confidence === 'medium' ? r.confidence : 'low',
  };
}
