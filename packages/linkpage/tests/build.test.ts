import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPage, checkPage, connectors, deriveTheme, renderPage } from '../src/index.ts';
import { contrast, parseHex } from '../src/color.ts';
import type { Rgb } from '../src/index.ts';
import { net } from './helpers.ts';

const rgb = (hex: string): Rgb => parseHex(hex) as Rgb;

const SITE = `<html><head><title>Studio</title><meta property="og:site_name" content="Studio Name"/>
<meta name="description" content="Hand made."/><link rel="stylesheet" href="/s.css"/><link rel="stylesheet" href="https://cdn.other.example.com/x.css"/></head>
<body><a href="https://www.instagram.com/studio">ig</a><a href="/about">about</a><a href="https://example.org/">other</a></body></html>`;
const CSS = 'body{background:#fcfbf9;color:#000;font-family:"Cormorant Garamond",Georgia,serif}h2{font-family:Tenor Sans,Arial}a{color:#bf9b5d}.x{background:#fcfbf9}';
const FEED = `<rss><channel><title><![CDATA[Mud &amp; Clay]]></title><description>Notes</description><link>https://studio.substack.com</link>
<item><title>First</title><link>https://studio.substack.com/p/first</link><pubDate>Mon, 01 Oct 2026</pubDate></item></channel></rss>`;
const IG = '<meta property="og:title" content="Studio (&#064;studio) &#x2022; Instagram photos and videos" /><meta property="og:image" content="https://cdn.example.com/a.jpg?x=1&amp;y=2" />';

const FETCH = net({ 'https://studio.example.com/s.css': CSS, 'https://studio.example.com': SITE, 'https://studio.substack.com/feed': FEED, 'https://www.instagram.com/studio/': IG });

test('the website connector reads colours, fonts and social links, and ignores other sites\' stylesheets', async () => {
  const s = await connectors.website({ fetch: FETCH }).read('https://studio.example.com');
  assert.equal(s.name, 'Studio Name');
  assert.deepEqual(s.colors?.find((c) => c.hex === '#fcfbf9'), { hex: '#fcfbf9', weight: 2 });
  assert.deepEqual(s.fonts?.map((f) => f.family).sort(), ['Cormorant Garamond', 'Tenor Sans']);
  assert.deepEqual(s.links?.map((l) => l.kind), ['instagram']);
});

test('the Substack and Instagram connectors read the public feed and page', async () => {
  const sub = await connectors.substack({ fetch: FETCH }).read('studio');
  assert.equal(sub.name, 'Mud & Clay');
  assert.equal(sub.posts?.[0]?.url, 'https://studio.substack.com/p/first');
  const ig = await connectors.instagram({ fetch: FETCH }).read('@studio');
  assert.equal(ig.name, 'Studio');
  assert.equal(ig.avatar_url, 'https://cdn.example.com/a.jpg?x=1&y=2');
  assert.equal(ig.links?.[0]?.handle, '@studio');
});

test('the theme follows the creator: cream stays the background, the accent is their colour, serif sets the mood', async () => {
  const s = await connectors.website({ fetch: FETCH }).read('https://studio.example.com');
  const t = deriveTheme([s]);
  assert.equal(t.palette.bg, '#fcfbf9');
  assert.equal(t.mood, 'editorial');
  assert.equal(t.fonts.heading.family, 'Cormorant Garamond');
  assert.equal(t.fonts.heading.google, true);
  const bg = rgb(t.palette.bg);
  assert.ok(contrast(rgb(t.palette.text), bg) >= 7);
  assert.ok(contrast(rgb(t.palette.accent), bg) >= 3);
  assert.ok(contrast(rgb(t.palette.accentText), rgb(t.palette.accent)) >= 3);
});

test('a dark, sans-serif creator gets a dark modern page, and no signals still gives a readable default', () => {
  const t = deriveTheme([{ colors: [{ hex: '#0b0b10', weight: 9 }, { hex: '#ff3d71', weight: 4 }], fonts: [{ family: 'Poppins', weight: 5 }] }]);
  assert.equal(t.palette.dark, true);
  assert.equal(t.mood, 'modern');
  assert.equal(t.palette.accent, '#ff3d71');
  const none = deriveTheme([{}]);
  assert.ok(contrast(rgb(none.palette.text), rgb(none.palette.bg)) >= 7);
});

test('a page builds from several platforms, and one failing platform is skipped and reported', async () => {
  const { spec, warnings } = await buildPage({
    sources: [{ connector: 'website', ref: 'https://studio.example.com' }, { connector: 'substack', ref: 'studio' }, { connector: 'tiktok', ref: '@studio' }],
    options: { slug: 'studio', signup: { endpoint: 'https://studio.example.com/api/lead' }, links: [{ label: 'Shop', url: 'https://studio.example.com', featured: true }] },
    fetch: FETCH,
  });
  assert.deepEqual(spec.blocks.map((b) => b.type), ['link', 'email', 'posts', 'social']);
  const social = spec.blocks[3];
  assert.equal(social?.type, 'social');
  assert.deepEqual(social?.type === 'social' ? social.items.map((i) => i.kind) : [], ['instagram', 'substack']);
  assert.match(warnings[0] as string, /^tiktok: .*404/);
  await assert.rejects(buildPage({ sources: [{ connector: 'tiktok', ref: 'x' }], options: { slug: 's' }, fetch: FETCH }), /nothing could be read/);
});

test('a spec with a bad slug, unknown block, bad address or repeated id is refused with a plain message', () => {
  const theme = deriveTheme([{}]);
  const ok = { slug: 'a', profile: { name: 'A' }, theme, blocks: [] };
  assert.throws(() => checkPage({ ...ok, slug: 'No Spaces' }), /slug/);
  assert.throws(() => checkPage({ ...ok, blocks: [{ type: 'carousel' }] }), /unknown type "carousel"/);
  assert.throws(() => checkPage({ ...ok, blocks: [{ type: 'link', label: 'x', url: 'javascript:alert(1)' }] }), /http or https/);
  assert.throws(() => checkPage({ ...ok, blocks: [{ type: 'text', id: 'a', body: 'x' }, { type: 'text', id: 'a', body: 'y' }] }), /share the id/);
});

test('rendering escapes creator text, can route clicks through a tracker, and ships a bot trap in the form', () => {
  const theme = deriveTheme([{}]);
  const spec = checkPage({ slug: 'a', profile: { name: '<b>Al</b>', bio: 'x"y' }, theme, blocks: [
    { type: 'link', label: '<script>1</script>', url: 'https://x.example.com/?a=1&b=2' },
    { type: 'email', endpoint: 'https://x.example.com/api/lead' },
  ] });
  const html = renderPage(spec);
  assert.ok(!html.includes('<script>1</script>') && !html.includes('<b>Al</b>'));
  assert.match(html, /href="https:\/\/x\.example\.com\/\?a=1&amp;b=2"/);
  assert.match(html, /name="website"[^>]*class="trap"/);
  assert.match(renderPage(spec, { trackBase: 'https://m.example.com/l' }), /href="https:\/\/m\.example\.com\/l\/a\/link-1\/0"/);
});

test('a bad post or social address is dropped with a warning instead of failing the build', async () => {
  const manual = { connector: 'manual', ref: {
    name: 'Sam', bio: 'Potter.',
    posts: [{ title: 'ok', url: 'https://sam.example.com/p/1', image_url: 'not a url' }, { title: 'relative', url: '/p/2' }, { title: 'js', url: 'javascript:alert(1)' }],
    links: [{ url: 'mailto:sam@example.com', kind: 'link' }, { url: 'https://instagram.com/sam', kind: 'instagram' }, { url: '/x', kind: 'x' }],
  } };
  const out = await buildPage({ sources: [manual as never], options: { slug: 'sam', links: [{ label: 'Shop', url: '/shop' }, { label: 'Real', url: 'https://sam.example.com/' }] } });
  const posts = out.spec.blocks.find((b) => b.type === 'posts');
  assert.deepEqual(posts?.type === 'posts' && posts.items.map((i) => [i.title, i.image_url]), [['ok', '']]);
  const social = out.spec.blocks.find((b) => b.type === 'social');
  assert.deepEqual(social?.type === 'social' && social.items.map((i) => i.kind), ['instagram']);
  assert.deepEqual(out.spec.blocks.filter((b) => b.type === 'link').map((b) => b.type === 'link' && b.label), ['Real']);
  assert.ok(out.warnings.some((w) => /post/.test(w) && /dropped/.test(w)), out.warnings.join('|'));
  assert.ok(out.warnings.some((w) => /link/.test(w) && /dropped/.test(w)));
  // A page whose only posts are bad has no posts block at all.
  const none = await buildPage({ sources: [{ connector: 'manual', ref: { name: 'Sam', posts: [{ title: 'x', url: '/p' }] } } as never], options: { slug: 'sam' } });
  assert.ok(!none.spec.blocks.some((b) => b.type === 'posts'));
});
