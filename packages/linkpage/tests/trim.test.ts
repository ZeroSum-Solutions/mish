import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captionTitle, clip } from '../src/trim.ts';
import { checkPage } from '../src/spec.ts';
import { connectors } from '../src/connectors.ts';
import { understandPerson } from '../src/understand.ts';
import type { FetchFn } from '../src/types.ts';
import { fakeLlm } from './helpers.ts';

test('clip leaves short text alone and trims at a word with an ellipsis', () => {
  assert.equal(clip('  short text ', 20), 'short text');
  const out = clip('ceramicist carving stoneware and writing about a creative life', 60);
  assert.equal(out, 'ceramicist carving stoneware and writing about a creative…');
  assert.ok(out.length <= 60);
});

test('clip can cut without an ellipsis', () => {
  assert.equal(clip('one two three four', 10, { ellipsis: false }), 'one two');
});

test('clip never leaves dangling punctuation and stays within the limit', () => {
  const out = clip('alpha beta, gamma delta', 13);
  assert.equal(out, 'alpha beta…');
  for (let n = 1; n < 30; n++) assert.ok(clip('alpha beta, gamma - delta (epsilon) zeta', n).length <= n);
  assert.equal(clip('alpha - beta', 8), 'alpha…');
});

test('clip is safe for CJK and emoji', () => {
  const cjk = clip('陶芸家として石器を彫り、創造的な生活について書いています', 10);
  assert.equal(cjk.length <= 10, true);
  assert.ok(cjk.endsWith('…'));
  const emoji = '😀'.repeat(10);
  for (let n = 1; n <= 12; n++) {
    const out = clip(emoji, n);
    assert.ok(out.length <= n);
    assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  }
  assert.equal(clip('one 😀😀😀😀', 7), 'one…');
});

test('clip handles a limit of one and a single long word', () => {
  assert.equal(clip('abcdefghij', 5), 'abcd…');
  assert.ok(clip('abc def', 1).length <= 1);
});

test('checkPage trims headline, bio, about and block text at words', () => {
  const long = 'word '.repeat(300);
  const page = checkPage({
    slug: 's',
    profile: { name: 'A', headline: 'ceramicist carving stoneware and writing about a creative life and more and more', bio: long, about: long },
    theme: { mood: 'm', radius: 'soft', background: 'plain', palette: { bg: '#fff', surface: '#fff', text: '#000', muted: '#555', accent: '#00f', accentText: '#fff', dark: false }, fonts: { heading: { family: 'x', kind: 'sans', stack: 'x' }, body: { family: 'x', kind: 'sans', stack: 'x' } } },
    blocks: [{ type: 'text', body: long }, { type: 'link', label: 'l', url: 'https://x.example.com', description: long }, { type: 'posts', items: [{ title: long, url: 'https://x.example.com/p' }] }],
  } as never);
  assert.equal(page.profile.headline, 'ceramicist carving stoneware and writing about a creative life and more and more');
  for (const [s, max] of [[page.profile.bio, 400], [page.profile.about, 800]] as const) assert.ok(s.length <= max && s.endsWith('word…'), s.slice(-12));
  const [t, l, p] = page.blocks;
  assert.ok(t.type === 'text' && t.body.length <= 1000 && t.body.endsWith('word…'));
  assert.ok(l.type === 'link' && (l.description ?? '').endsWith('word…'));
  assert.ok(p.type === 'posts' && (p.items[0]?.title ?? '').endsWith('word…'));
});

test('a long headline is cut at a word in checkPage', () => {
  const page = checkPage({ slug: 's', profile: { name: 'A', headline: 'ceramicist carving stoneware and writing about a creative life that never ends well, truly and deeply and always' }, theme: { palette: {}, fonts: {} }, blocks: [] } as never);
  assert.ok(page.profile.headline.length <= 90);
  assert.match(page.profile.headline, /^ceramicist carving .* (well|ends|never|that|life|truly)…$/);
});

test('captionTitle takes the first sentence or line, within 80 characters', () => {
  assert.equal(captionTitle('New glaze test. Fired it twice and loved it.\nmore'), 'New glaze test.');
  assert.equal(captionTitle('first line without stop\nsecond line. Third.'), 'first line without stop');
  assert.equal(captionTitle(''), '');
  const long = captionTitle('Today I want to tell you about the first few hundred days of running a studio on my own without help from anyone');
  assert.ok(long.length <= 80 && long.endsWith('…') && !long.includes('anyone'));
  assert.equal(captionTitle('Version 2.0 is out'), 'Version 2.0 is out');
});

test('instagram and tiktok posts get a short title, not the whole caption', async () => {
  const caption = 'Kiln day!\nA very long story follows about the first few hundred pieces I made this year and what I learned.';
  const login: FetchFn = async (input) => {
    const url = String(input);
    const body = url.includes('tiktokapis')
      ? { data: { user: { display_name: 'T' }, videos: [{ title: 'Studio tour. Then a long ' + 'tail '.repeat(40), share_url: 'https://tiktok.com/v/1' }] } }
      : url.includes('/media') ? { data: [{ caption, permalink: 'https://instagram.com/p/1' }] } : { username: 'studio' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const ig = await connectors.instagram({ fetch: async () => new Response(''), login }).read('@studio');
  assert.equal(ig.posts?.[0]?.title, 'Kiln day!');
  const tt = await connectors.tiktok({ fetch: async () => new Response(''), login }).read('@studio');
  assert.equal(tt.posts?.[0]?.title, 'Studio tour.');
});

test('the profile prompt asks for a headline of at most 60 characters', async () => {
  const llm = fakeLlm({ headline: 'h' });
  await understandPerson({ signals: [{ source: 'x', bio: 'a potter' }], llm });
  assert.match(JSON.stringify(llm.calls), /headline[^}]*max 60 chars/);
});
