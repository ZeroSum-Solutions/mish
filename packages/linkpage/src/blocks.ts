// The blocks a page is made of. Each type has `check` (returns the cleaned block or throws) and `html`.
// A new kind of block (a product, a booking, an embed) is one more entry here.
import type { Block, BlockContext, EmailBlock, LinkBlock, PostsBlock, RawBlock, SocialBlock, TextBlock } from './types.ts';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

type Raw = Record<string, unknown>;
const rows = (v: unknown): Raw[] => (v || []) as Raw[];

export function url(v: unknown, what: string): string {
  let u: URL;
  try {
    u = new URL(str(v, 2000));
  } catch {
    throw new Error(`${what} is not a web address`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${what} must start with http or https`);
  return u.href;
}

const LABELS: Record<string, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', substack: 'Substack', x: 'X', facebook: 'Facebook', pinterest: 'Pinterest', linkedin: 'LinkedIn', threads: 'Threads', spotify: 'Spotify', etsy: 'Etsy', twitch: 'Twitch', github: 'GitHub', bluesky: 'Bluesky', link: 'Website' };

interface BlockType<B extends Block> {
  check: (b: RawBlock) => Omit<B, 'id' | 'type'> & Raw;
  html: (b: B, ctx: BlockContext) => string;
}

const needs = (message: string): never => {
  throw new Error(message);
};

const link: BlockType<LinkBlock> = {
  check: (b) => ({ ...b, label: str(b.label, 120) || needs('a link needs a label'), url: url(b.url, 'a link'), description: str(b.description, 200), image_url: b.image_url ? url(b.image_url, 'a link image') : '', featured: b.featured === true }),
  html: (b, ctx) => `<a class="link${b.featured ? ' link--featured' : ''}" href="${esc(ctx.href(b.id, 0, b.url))}" rel="noopener">${b.image_url ? `<img src="${esc(b.image_url)}" alt="" loading="lazy">` : ''}<span><strong>${esc(b.label)}</strong>${b.description ? `<small>${esc(b.description)}</small>` : ''}</span></a>`,
};

const social: BlockType<SocialBlock> = {
  check: (b) => ({ ...b, items: rows(b.items).map((i) => ({ kind: str(i.kind, 30) || 'link', url: url(i.url, 'a social link'), handle: str(i.handle, 80) })) }),
  html: (b, ctx) => `<nav class="social" aria-label="Social profiles">${b.items.map((i, n) => `<a href="${esc(ctx.href(b.id, n, i.url))}" rel="me noopener" data-kind="${esc(i.kind)}"><span>${esc(LABELS[i.kind] || i.kind)}</span>${i.handle ? `<small>${esc(i.handle)}</small>` : ''}</a>`).join('')}</nav>`,
};

const posts: BlockType<PostsBlock> = {
  check: (b) => ({ ...b, heading: str(b.heading, 80) || 'Latest', items: rows(b.items).map((i) => ({ title: str(i.title, 200), url: url(i.url, 'a post'), image_url: i.image_url ? url(i.image_url, 'a post image') : '' })) }),
  html: (b, ctx) => `<section class="posts"><h2>${esc(b.heading)}</h2>${b.items.map((i, n) => `<a class="post" href="${esc(ctx.href(b.id, n, i.url))}" rel="noopener">${i.image_url ? `<img src="${esc(i.image_url)}" alt="" loading="lazy">` : ''}<span>${esc(i.title)}</span></a>`).join('')}</section>`,
};

const email: BlockType<EmailBlock> = {
  check: (b) => ({ ...b, heading: str(b.heading, 120) || 'Get the next one first', button: str(b.button, 30) || 'Subscribe', note: str(b.note, 200), endpoint: url(b.endpoint, 'the signup endpoint') }),
  html: (b) => `<section class="email"><h2>${esc(b.heading)}</h2><form data-signup action="${esc(b.endpoint)}" novalidate><input type="email" name="email" placeholder="Email address" aria-label="Email address" autocomplete="email" required><input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" class="trap"><button type="submit">${esc(b.button)}</button></form>${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}<p class="status" role="status" hidden></p></section>`,
};

const text: BlockType<TextBlock> = {
  check: (b) => ({ ...b, body: str(b.body, 1000) || needs('a text block needs text') }),
  html: (b) => `<p class="text">${esc(b.body)}</p>`,
};

// ctx.href(blockId, index, url) gives the address a link points at: the address itself, or a tracked one.
export const blocks = { link, social, posts, email, text };

/** Renders one checked block. */
export function renderBlock(b: Block, ctx: BlockContext): string {
  switch (b.type) {
    case 'link': return link.html(b, ctx);
    case 'social': return social.html(b, ctx);
    case 'posts': return posts.html(b, ctx);
    case 'email': return email.html(b, ctx);
    case 'text': return text.html(b, ctx);
  }
}
