import { describe, expect, it } from 'vitest';

import {
  isLinkPageSlug,
  parseLinkPageBuildRequest,
  parseLinkPageConnectedAccounts,
  parseLinkPageEvent,
  parseLinkPagePutRequest,
  parseLinkPageSpec,
  parseLinkPageTheme,
} from '../src/index';

const font = { family: 'Inter', kind: 'sans', stack: '"Inter", Helvetica, Arial, sans-serif', google: true };
const theme = {
  mood: 'modern',
  radius: 12,
  background: 'mesh',
  palette: { bg: '#fcfbf9', surface: '#f2f1ef', text: '#1a1a1a', muted: '#555555', accent: '#2255aa', accentText: '#ffffff', dark: false },
  fonts: { heading: font, body: font },
};
const spec = {
  version: 1,
  slug: 'sam',
  profile: { name: 'Sam', headline: '', bio: '', about: '', themes: [], avatar_url: '', site_url: '' },
  theme,
  blocks: [{ type: 'text', id: 'text-1', body: 'hello' }],
};
const request = { slug: 'sam', sources: [{ connector: 'website', ref: 'https://example.com' }] };

describe('link page slugs', () => {
  it('accepts lowercase words and refuses paths and long names', () => {
    expect(isLinkPageSlug('sam-1')).toBe(true);
    for (const bad of ['', 'Sam', '-sam', 'a/b', '../x', 'a b', 'x'.repeat(61), 4]) expect(isLinkPageSlug(bad)).toBe(false);
  });
});

describe('parseLinkPageBuildRequest', () => {
  it('accepts a plain website source', () => {
    expect(parseLinkPageBuildRequest(request)).toEqual({ ok: true, value: request });
  });

  it('carries options, links, signup and connected accounts through', () => {
    const got = parseLinkPageBuildRequest({
      ...request,
      sources: [...request.sources, { connector: 'instagram', ref: '@sam' }, { connector: 'manual', ref: { name: 'Sam' } }],
      options: {
        name: 'Sam', avatar: 'assets/avatar.png',
        theme: { palette: { accent: '#ff0000' }, background: 'grid' },
        links: [{ label: 'Shop', url: 'https://example.com/shop', featured: true }],
        signup: { endpoint: 'https://example.com/signup' },
      },
      connectedAccounts: { instagram: 'ca_abc123' },
      save: false,
    });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value.connectedAccounts).toEqual({ instagram: 'ca_abc123' });
      expect(got.value.options?.links?.[0]?.url).toBe('https://example.com/shop');
      expect(got.value.save).toBe(false);
    }
  });

  it.each([
    ['not an object', 'nope'],
    ['bad slug', { ...request, slug: '../etc' }],
    ['no sources', { ...request, sources: [] }],
    ['unknown connector', { ...request, sources: [{ connector: 'myspace', ref: 'x' }] }],
    ['website that is not http', { ...request, sources: [{ connector: 'website', ref: 'file:///etc/passwd' }] }],
    ['manual without an object', { ...request, sources: [{ connector: 'manual', ref: 'x' }] }],
    ['javascript link', { ...request, options: { links: [{ label: 'x', url: 'javascript:alert(1)' }] } }],
    ['css in a colour', { ...request, options: { theme: { palette: { bg: 'red;}</style>' } } } }],
    ['avatar path escape', { ...request, options: { avatar: 'assets/../../x' } }],
    ['unknown background', { ...request, options: { theme: { background: 'fire' } } }],
    ['account on a connector with no login', { ...request, connectedAccounts: { website: 'ca_1' } }],
    ['account id that is a url', { ...request, connectedAccounts: { instagram: 'https://x/y' } }],
  ])('refuses %s', (_name, input) => {
    expect(parseLinkPageBuildRequest(input).ok).toBe(false);
  });
});

describe('parseLinkPageConnectedAccounts', () => {
  it('defaults to an empty map', () => {
    expect(parseLinkPageConnectedAccounts(undefined)).toEqual({ ok: true, value: {} });
  });
});

describe('parseLinkPageSpec and parseLinkPageTheme', () => {
  it('accepts a built spec', () => {
    expect(parseLinkPageSpec(spec).ok).toBe(true);
    expect(parseLinkPageTheme(theme).ok).toBe(true);
  });

  it('refuses a theme that could break out of the stylesheet', () => {
    const evil = { ...theme, palette: { ...theme.palette, bg: '#fff;}</style><script>alert(1)</script>' } };
    expect(parseLinkPageTheme(evil).ok).toBe(false);
    const stack = { ...theme, fonts: { heading: { ...font, stack: 'x;}</style>' }, body: font } };
    expect(parseLinkPageTheme(stack).ok).toBe(false);
    const unbalanced = { ...theme, fonts: { heading: { ...font, stack: '"Inter, serif' }, body: font } };
    expect(parseLinkPageTheme(unbalanced).ok).toBe(false);
    expect(parseLinkPageSpec({ ...spec, theme: evil }).ok).toBe(false);
  });

  it.each([
    ['wrong version', { ...spec, version: 2 }],
    ['bad slug', { ...spec, slug: 'A B' }],
    ['no name', { ...spec, profile: { ...spec.profile, name: ' ' } }],
    ['unknown block', { ...spec, blocks: [{ type: 'script', id: 'x' }] }],
    ['blocks not a list', { ...spec, blocks: {} }],
  ])('refuses %s', (_name, input) => {
    expect(parseLinkPageSpec(input).ok).toBe(false);
  });

  it('parses a put request with accounts', () => {
    const got = parseLinkPagePutRequest({ spec, connectedAccounts: { tiktok: 'ca_9' } });
    expect(got.ok && got.value.connectedAccounts).toEqual({ tiktok: 'ca_9' });
    expect(parseLinkPagePutRequest({ spec: 1 }).ok).toBe(false);
  });
});

describe('parseLinkPageEvent', () => {
  const now = () => '2026-10-30T00:00:00.000Z';

  it('stamps view, click and signup events', () => {
    expect(parseLinkPageEvent({ kind: 'view', slug: 'sam' }, now)).toEqual({ ok: true, value: { kind: 'view', slug: 'sam', at: now() } });
    expect(parseLinkPageEvent({ kind: 'click', slug: 'sam', block: 'link-1', index: 0 }, now).ok).toBe(true);
    const signup = parseLinkPageEvent({ kind: 'signup', slug: 'sam', email: ' A@B.co ' }, now);
    expect(signup.ok && signup.value).toMatchObject({ kind: 'signup', email: 'a@b.co' });
  });

  it('refuses a bad kind, address or index', () => {
    expect(parseLinkPageEvent({ kind: 'purge', slug: 'sam' }, now).ok).toBe(false);
    expect(parseLinkPageEvent({ kind: 'signup', slug: 'sam', email: 'nope' }, now).ok).toBe(false);
    expect(parseLinkPageEvent({ kind: 'click', slug: 'sam', block: 'b', index: -1 }, now).ok).toBe(false);
  });
});
