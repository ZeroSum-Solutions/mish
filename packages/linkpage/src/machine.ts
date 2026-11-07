import type { PageSpec } from './types.ts';

// The page as machines read it: llms.txt for language models, links.json for scripts and agents.

const NAMES: Record<string, string> = { x: 'X', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn', github: 'GitHub', link: 'Website' };
const cap = (s: string): string => NAMES[s] || s.charAt(0).toUpperCase() + s.slice(1);
const base = (origin: unknown): string => String(origin || '').replace(/\/$/, '');

// Every link, social profile and post on the page, flat and in page order.
// `block` and `index` match the click-tracking address `${trackBase}/${slug}/${block}/${index}`.
export interface PageItem {
  id: string;
  kind: 'link' | 'social' | 'post';
  label: string;
  url: string;
  description: string;
  block: string;
  index: number;
}

export function pageItems(spec: PageSpec): PageItem[] {
  const out: PageItem[] = [];
  for (const b of spec.blocks) {
    if (b.type === 'link') out.push({ id: b.id, kind: 'link', label: b.label, url: b.url, description: b.description || '', block: b.id, index: 0 });
    if (b.type === 'social') b.items.forEach((i, n) => out.push({ id: `${b.id}-${n + 1}`, kind: 'social', label: i.handle ? `${cap(i.kind)} (${i.handle})` : cap(i.kind), url: i.url, description: `${cap(i.kind)} profile`, block: b.id, index: n }));
    if (b.type === 'posts') b.items.forEach((i, n) => out.push({ id: `${b.id}-${n + 1}`, kind: 'post', label: i.title || i.url, url: i.url, description: b.heading, block: b.id, index: n }));
  }
  return out;
}

// The signup the page offers, or null when it has no email block.
export interface Signup {
  endpoint: string;
  method: 'POST';
  fields: string[];
  kind: 'signup';
}

export function signupOf(spec: PageSpec): Signup | null {
  const b = spec.blocks.find((x) => x.type === 'email');
  return b ? { endpoint: b.endpoint, method: 'POST', fields: ['email'], kind: 'signup' } : null;
}

// A path segment in a tracked address: block ids are free text, so they are encoded.
const seg = (s: string): string => encodeURIComponent(s);
export const trackedUrl = (trackBase: string, slug: string, block: string, index: number): string => `${trackBase.replace(/\/$/, '')}/${seg(slug)}/${seg(block)}/${index}`;

export interface MachineOptions {
  origin?: string;
  trackBase?: string;
}

export interface LinksJson {
  name: string;
  bio: string;
  avatar_url: string;
  site_url: string;
  page_url: string;
  links: (Omit<PageItem, 'block' | 'index'> & { tracked_url?: string })[];
  subscribe: Signup | null;
  generated_from: 'mish-linkpage';
  version: 1;
}

export function linksJson(spec: PageSpec, { origin = '', trackBase = '' }: MachineOptions = {}): LinksJson {
  const track = (i: PageItem): { tracked_url?: string } => (trackBase ? { tracked_url: trackedUrl(trackBase, spec.slug, i.block, i.index) } : {});
  return {
    name: spec.profile.name,
    bio: spec.profile.bio,
    avatar_url: spec.profile.avatar_url,
    site_url: spec.profile.site_url,
    page_url: `${base(origin)}/`,
    links: pageItems(spec).map((i) => ({ id: i.id, kind: i.kind, label: i.label, url: i.url, description: i.description, ...track(i) })),
    subscribe: signupOf(spec),
    generated_from: 'mish-linkpage',
    version: 1,
  };
}

// The site is served at its own root (one subdomain or domain per creator), so `origin` is the whole site and
// no address carries the slug. With `trackBase`, each link goes through the click counter like the page's own.
export function llmsTxt(spec: PageSpec, { origin = '', trackBase = '' }: MachineOptions = {}): string {
  const o = base(origin);
  const lines = [`# ${spec.profile.name}`, ''];
  if (spec.profile.bio) lines.push(`> ${spec.profile.bio.replace(/\s+/g, ' ')}`, '');
  lines.push('## Links', '');
  for (const i of pageItems(spec)) lines.push(`- [${i.label.replace(/[[\]]/g, '')}](${trackBase ? trackedUrl(trackBase, spec.slug, i.block, i.index) : i.url})${i.description ? `: ${i.description.replace(/\s+/g, ' ')}` : ''}`);
  lines.push('', '## For agents', '');
  lines.push(`- JSON: ${o}/links.json lists every link as structured data.`);
  const sub = signupOf(spec);
  if (sub) lines.push(`- Subscribe: POST {"email": "..."} to ${sub.endpoint} to join the email list.`);
  return `${lines.join('\n')}\n`;
}
