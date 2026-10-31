import { blocks, url } from './blocks.ts';
import type { Block, BlockType, PageSpec, RawBlock, RawPageSpec, Theme } from './types.ts';

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// The fields each block type keeps. Anything else on a stored or hand-edited spec is dropped here.
const BLOCK_KEYS: Record<string, string[]> = {
  link: ['label', 'url', 'description', 'image_url', 'featured'],
  social: ['items'],
  posts: ['heading', 'items'],
  email: ['heading', 'button', 'note', 'endpoint'],
  text: ['body'],
};
const PALETTE_KEYS = ['bg', 'surface', 'text', 'muted', 'accent', 'accentText', 'dark'] as const;
const FONT_KEYS = ['family', 'kind', 'stack', 'google'] as const;

const pick = <T extends object>(from: T, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((k) => k in from).map((k) => [k, (from as Record<string, unknown>)[k]]));

function cleanTheme(theme: Theme): Theme {
  const font = (f: Theme['fonts']['heading']): Theme['fonts']['heading'] => pick(f ?? {}, FONT_KEYS) as never;
  return {
    mood: theme.mood, radius: theme.radius, background: theme.background,
    palette: pick(theme.palette, PALETTE_KEYS) as never,
    fonts: { heading: font(theme.fonts?.heading), body: font(theme.fonts?.body) },
  };
}

type Checkable = { check: (b: RawBlock) => Record<string, unknown> };

// Checks a page spec and returns it cleaned, with every block given an id. Throws a plain message on the
// first problem, so a person (or an agent) editing a spec file can fix it.
export function checkPage(spec: RawPageSpec): PageSpec {
  const slug = str(spec?.slug, 60);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('slug must be lowercase letters, numbers and dashes');
  const avatar = spec.profile?.avatar_url;
  const profile = {
    name: str(spec.profile?.name, 120) || (() => { throw new Error('profile needs a name'); })(),
    headline: str(spec.profile?.headline, 90),
    bio: str(spec.profile?.bio, 400),
    about: str(spec.profile?.about, 800),
    themes: (spec.profile?.themes || []).map((t) => str(t, 40)).filter(Boolean).slice(0, 8),
    // A picture that ships with the page (assets/avatar.png) or one at a web address.
    avatar_url: /^assets\/[\w.-]+$/.test((avatar as string) || '') ? (avatar as string) : avatar ? url(avatar, 'the avatar') : '',
    site_url: spec.profile?.site_url ? url(spec.profile.site_url, 'the site address') : '',
  };
  const seen = new Set<string>();
  const list = (spec.blocks || []).map((b, i): Block => {
    const type = (blocks as Record<string, Checkable | undefined>)[b?.type as string];
    if (!type) throw new Error(`block ${i + 1} has an unknown type "${b?.type}"`);
    const id = str(b.id, 40) || `${b.type}-${i + 1}`;
    if (seen.has(id)) throw new Error(`two blocks share the id "${id}"`);
    seen.add(id);
    try {
      return { ...pick(type.check(b), BLOCK_KEYS[b.type as string] as string[]), id, type: b.type as BlockType } as Block;
    } catch (err) {
      throw new Error(`block "${id}": ${(err as Error).message}`);
    }
  });
  if (!spec.theme?.palette) throw new Error('the page has no theme');
  return { version: 1, slug, profile, theme: cleanTheme(spec.theme), blocks: list };
}
