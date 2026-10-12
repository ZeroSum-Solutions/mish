export type Action = { label: string; href: string };
export type Image = { file: string; alt: string; focal: 'left' | 'center' | 'right' };
export type Section =
  | { id: string; type: 'hero'; eyebrow: string; title: string; body: string; image: Image; action: Action }
  | { id: string; type: 'collection'; eyebrow: string; title: string; items: { title: string; body: string; label: string }[] }
  | { id: string; type: 'proof'; eyebrow: string; title: string; body: string; facts: { label: string; value: string }[] }
  | { id: string; type: 'contact'; eyebrow: string; title: string; body: string; action: Action };
export type Recipe = {
  version: 1;
  revision: string;
  name: string;
  description: string;
  direction: 'editorial' | 'landscape';
  brand: { background: string; ink: string; muted: string; accent: string; surface: string; display: 'serif' | 'sans' };
  sections: Section[];
};

function object(value: unknown, keys: string[], at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: expected an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`${at}.${key}: unknown field`);
  return record;
}
function text(value: unknown, at: string, max = 600): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`${at}: expected non-empty text, at most ${max} characters`);
  }
  return value.trim();
}
function choice<T extends string>(value: unknown, choices: readonly T[], at: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`${at}: choose ${choices.join(', ')}`);
  return value as T;
}
function items<T>(value: unknown, at: string, min: number, max: number, parse: (value: unknown, at: string) => T): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${at}: expected ${min}–${max} items`);
  return value.map((item, i) => parse(item, `${at}[${i}]`));
}
export function slug(value: unknown, at: string): string {
  const result = text(value, at, 40);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(result)) throw new Error(`${at}: use a lowercase slug, e.g. site-r1`);
  return result;
}
function color(value: unknown, at: string): string {
  const result = text(value, at, 7);
  if (!/^#[a-f0-9]{6}$/i.test(result)) throw new Error(`${at}: use a six-digit hex color`);
  return result.toLowerCase();
}
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const x = luminance(a); const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function action(value: unknown, at: string): Action {
  const v = object(value, ['label', 'href'], at);
  const href = text(v.href, `${at}.href`, 300);
  const isMail = /^mailto:[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(href);
  const isPhone = /^tel:\+[0-9]{7,15}$/.test(href);
  let isWeb = false;
  try { const url = new URL(href); isWeb = href.startsWith('https://') && url.protocol === 'https:' && !url.username && !url.password; } catch { /* Checked below. */ }
  if (/[\s\\<>"']/.test(href) || !(isWeb || isMail || isPhone || href === '#contact')) {
    throw new Error(`${at}.href: use HTTPS, a plain mailto address, international tel number, or #contact`);
  }
  return { label: text(v.label, `${at}.label`, 60), href };
}
function image(value: unknown, at: string): Image {
  const v = object(value, ['file', 'alt', 'focal'], at);
  const file = text(v.file, `${at}.file`, 100);
  if (!/^[a-z0-9][a-z0-9-]*\.(png|jpe?g|webp|avif)$/.test(file)) throw new Error(`${at}.file: use a local raster filename, no folders or URLs`);
  return { file, alt: text(v.alt, `${at}.alt`, 250), focal: choice(v.focal, ['left', 'center', 'right'], `${at}.focal`) };
}
function section(value: unknown, at: string): Section {
  const v = object(value, ['id', 'type', 'eyebrow', 'title', 'body', 'image', 'action', 'items', 'facts'], at);
  const type = choice(v.type, ['hero', 'collection', 'proof', 'contact'], `${at}.type`);
  const common = ['id', 'type', 'eyebrow', 'title'];
  object(value, [...common, ...({ hero: ['body', 'image', 'action'], collection: ['items'], proof: ['body', 'facts'], contact: ['body', 'action'] }[type])], at);
  const base = { id: slug(v.id, `${at}.id`), eyebrow: text(v.eyebrow, `${at}.eyebrow`, 80), title: text(v.title, `${at}.title`, 120) };
  if (type === 'collection') return { ...base, type, items: items(v.items, `${at}.items`, 2, 4, (item, p) => {
    const x = object(item, ['title', 'body', 'label'], p);
    return { title: text(x.title, `${p}.title`, 100), body: text(x.body, `${p}.body`, 300), label: text(x.label, `${p}.label`, 60) };
  }) };
  const body = text(v.body, `${at}.body`);
  if (type === 'proof') return { ...base, type, body, facts: items(v.facts, `${at}.facts`, 2, 4, (item, p) => {
    const x = object(item, ['label', 'value'], p);
    return { label: text(x.label, `${p}.label`, 100), value: text(x.value, `${p}.value`, 120) };
  }) };
  if (type === 'hero') return { ...base, type, body, image: image(v.image, `${at}.image`), action: action(v.action, `${at}.action`) };
  return { ...base, type, body, action: action(v.action, `${at}.action`) };
}

/** Validate at the JSON boundary; return only fields the renderer understands. */
export function parseRecipe(value: unknown): Recipe {
  const v = object(value, ['version', 'revision', 'name', 'description', 'direction', 'brand', 'sections'], 'recipe');
  if (v.version !== 1) throw new Error('recipe.version: expected 1');
  const b = object(v.brand, ['background', 'ink', 'muted', 'accent', 'surface', 'display'], 'brand');
  const brand = { background: color(b.background, 'brand.background'), ink: color(b.ink, 'brand.ink'), muted: color(b.muted, 'brand.muted'), accent: color(b.accent, 'brand.accent'), surface: color(b.surface, 'brand.surface'), display: choice(b.display, ['serif', 'sans'], 'brand.display') };
  for (const foreground of [brand.ink, brand.muted, brand.accent]) for (const background of [brand.background, brand.surface]) {
    if (contrast(foreground, background) < 4.5) throw new Error('brand: ink, muted and accent need at least 4.5:1 contrast on both backgrounds');
  }
  const sections = items(v.sections, 'sections', 4, 6, section);
  if (sections.some((s) => ['main', 'site-header', 'site-name', 'site-nav', 'site-footer', 'footer-name', 'footer-description'].includes(s.id))) throw new Error('sections: ID is reserved by the page shell');
  if (new Set(sections.map((s) => s.id)).size !== sections.length) throw new Error('sections: IDs must be unique');
  if (sections[0]?.type !== 'hero' || sections.at(-1)?.type !== 'contact' || sections.at(-1)?.id !== 'contact') throw new Error('sections: begin with hero and end with contact (id: contact)');
  if (sections.filter((s) => s.type === 'hero').length !== 1 || sections.filter((s) => s.type === 'contact').length !== 1 || !sections.some((s) => s.type === 'collection') || !sections.some((s) => s.type === 'proof')) throw new Error('sections: one hero, one contact, at least one collection and one proof required');
  const contact = sections.at(-1);
  if (contact?.type === 'contact' && contact.action.href === '#contact') throw new Error('contact.action: provide an actual contact destination');
  return { version: 1, revision: slug(v.revision, 'revision'), name: text(v.name, 'name', 80), description: text(v.description, 'description', 200), direction: choice(v.direction, ['editorial', 'landscape'], 'direction'), brand, sections };
}
