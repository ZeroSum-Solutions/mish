import { blocks, url } from './blocks.ts';
import type { Block, BlockType, PageSpec, RawBlock, RawPageSpec } from './types.ts';

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

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
      return { ...type.check(b), id, type: b.type as BlockType } as Block;
    } catch (err) {
      throw new Error(`block "${id}": ${(err as Error).message}`);
    }
  });
  if (!spec.theme?.palette) throw new Error('the page has no theme');
  return { version: 1, slug, profile, theme: spec.theme, blocks: list };
}
