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
  const track = (i: PageItem): { tracked_url?: string } => (trackBase ? { tracked_url: `${trackBase.replace(/\/$/, '')}/${spec.slug}/${i.block}/${i.index}` } : {});
  return {
    name: spec.profile.name,
    bio: spec.profile.bio,
    avatar_url: spec.profile.avatar_url,
    site_url: spec.profile.site_url,
    page_url: `${base(origin)}/${spec.slug}`,
    links: pageItems(spec).map((i) => ({ id: i.id, kind: i.kind, label: i.label, url: i.url, description: i.description, ...track(i) })),
    subscribe: signupOf(spec),
    generated_from: 'mish-linkpage',
    version: 1,
  };
}

export function llmsTxt(spec: PageSpec, { origin = '' }: Pick<MachineOptions, 'origin'> = {}): string {
  const o = base(origin);
  const lines = [`# ${spec.profile.name}`, ''];
  if (spec.profile.bio) lines.push(`> ${spec.profile.bio.replace(/\s+/g, ' ')}`, '');
  lines.push('## Links', '');
  for (const i of pageItems(spec)) lines.push(`- [${i.label.replace(/[[\]]/g, '')}](${i.url})${i.description ? `: ${i.description.replace(/\s+/g, ' ')}` : ''}`);
  lines.push('', '## For agents', '');
  lines.push(`- JSON: ${o}/${spec.slug}/links.json lists every link as structured data.`);
  lines.push(`- MCP: ${o}/${spec.slug}/mcp is a Model Context Protocol endpoint (streamable HTTP) with tools to read the profile and links.`);
  const sub = signupOf(spec);
  if (sub) lines.push(`- Subscribe: POST {"email": "..."} to ${sub.endpoint}, or call the subscribe tool on the MCP endpoint, to join the email list.`);
  return `${lines.join('\n')}\n`;
}
