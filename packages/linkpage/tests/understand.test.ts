import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectors, loginNeeds } from '../src/connectors.ts';
import { createLlm } from '../src/llm.ts';
import { gatherCorpus, understandPerson } from '../src/understand.ts';
import { styleFromImages } from '../src/vision.ts';
import type { FetchFn, Signal } from '../src/types.ts';
import { defined, exactNet, fakeLlm } from './helpers.ts';

const reply = (content: string, extra = {}): FetchFn => async () => new Response(JSON.stringify({ choices: [{ message: { content } }], ...extra }), { status: 200 });

test('the llm client sends images after the text and parses fenced JSON', async () => {
  let sent: { url: string; init: RequestInit & { headers: Record<string, string> }; body: { model: string; response_format: unknown; messages: { content: unknown }[] } } | undefined;
  const fetch: FetchFn = async (url, init) => { sent = { url: String(url), init: init as never, body: JSON.parse(init?.body as string) }; return reply('```json\n{"a":1}\n```')(url, init); };
  const out = await createLlm({ apiKey: 'k', fetch }).json({ system: 's', user: 'u', images: ['https://x.example.com/a.png'] });
  assert.deepEqual(out, { a: 1 });
  const got = defined(sent, 'the request');
  assert.equal(got.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(got.init.headers.Authorization, 'Bearer k');
  assert.equal(got.init.headers['X-Title'], 'Mish link page');
  assert.deepEqual(got.body.response_format, { type: 'json_object' });
  assert.equal(got.body.model, 'anthropic/claude-sonnet-5.5');
  assert.deepEqual(got.body.messages[1].content, [{ type: 'text', text: 'u' }, { type: 'image_url', image_url: { url: 'https://x.example.com/a.png' } }]);
});

test('the llm client fails on no key, an error in a 200 reply, an HTTP error and non-JSON', async () => {
  assert.throws(() => createLlm({}), /apiKey/);
  const call = (fetch: FetchFn) => createLlm({ apiKey: 'k', fetch }).json({ system: 's', user: 'u' });
  await assert.rejects(call(async () => new Response(JSON.stringify({ error: { message: 'out of credit' } }), { status: 200 })), /out of credit/);
  await assert.rejects(call(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })), /401.*bad key/);
  await assert.rejects(call(reply('sorry, no')), /valid JSON/);
});

const HOME = '<html><body><a href="/about-the-studio">About</a><a href="/shop">Shop</a><a href="/contact">Say hi</a><a href="https://other.example.com/about">About</a><p>Home</p></body></html>';
const net = exactNet;

test('the corpus picks about-like same-origin pages, strips markup, caps size and adds llms.txt, posts and bios', async () => {
  const long = '<script>var x=1</script><style>p{}</style><p>' + 'word '.repeat(2000) + '</p>';
  const fetch = net({
    'https://s.example.com/': HOME, 'https://s.example.com/about-the-studio': long, 'https://s.example.com/contact': '<p>Write   to us</p>',
    'https://s.example.com/shop': 'NO', 'https://s.example.com/llms.txt': 'Plain notes about Studio',
  });
  const signals: Signal[] = [
    { source: 'website', bio: 'Hand made.', site: { url: 'https://s.example.com' } },
    { source: 'substack', bio: 'Notes', posts: [{ title: 'First', url: 'https://s.example.com/p/1' }, { title: 'Second', url: 'https://s.example.com/p/2' }] },
  ];
  const c = await gatherCorpus({ signals, fetch });
  assert.deepEqual(c.pages.map((p) => p.url), ['https://s.example.com/', 'https://s.example.com/about-the-studio', 'https://s.example.com/contact', 'https://s.example.com/llms.txt']);
  assert.equal(c.pages[1].text.length, 4000);
  assert.ok(!c.pages[1].text.includes('var x'));
  assert.equal(c.pages[2].text, 'Write to us');
  assert.deepEqual(c.posts, ['First', 'Second']);
  assert.deepEqual(c.bios, ['Hand made.', 'Notes']);
});

test('an llms.txt that is really an HTML page is ignored, and a dead site gives an empty corpus', async () => {
  const c = await gatherCorpus({ signals: [{ site: { url: 'https://s.example.com' } }], fetch: net({ 'https://s.example.com/': '<p>Hi</p>', 'https://s.example.com/llms.txt': '<html>not found</html>' }) });
  assert.deepEqual(c.pages.map((p) => p.url), ['https://s.example.com/']);
  const none = await gatherCorpus({ signals: [{ site: { url: 'https://s.example.com' } }], fetch: net({}) });
  assert.deepEqual(none, { pages: [], posts: [], bios: [] });
});

test('understandPerson trims to the limits, keeps only real offering URLs, and is null without an llm', async () => {
  assert.equal(await understandPerson({ signals: [], corpus: { pages: [], posts: [], bios: [] } }), null);
  const llm = fakeLlm({
    headline: 'h'.repeat(100), bio: 'b'.repeat(300), about: 'a'.repeat(900), themes: ['1', '2', '3', '4', '5', '6', '7'],
    voice: Array(30).fill('warm').join(' '), offerings: [{ label: 'Shop', url: 'https://s.example.com/shop' }, { label: 'Odd', url: 'javascript:x' }, { label: '' }],
    confidence: 'certain',
  });
  const r = defined(await understandPerson({ signals: [], corpus: { pages: [{ url: 'https://s.example.com/', text: 'Potter' }], posts: ['First'], bios: ['Hand made.'] }, llm }));
  assert.equal(r.headline.length, 70);
  assert.equal(r.bio.length, 220);
  assert.equal(r.about.length, 600);
  assert.equal(r.themes.length, 6);
  assert.equal(r.voice.split(' ').length, 20);
  assert.deepEqual(r.offerings, [{ label: 'Shop', url: 'https://s.example.com/shop' }, { label: 'Odd' }]);
  assert.equal(r.confidence, 'low');
  assert.match(llm.calls[0].system, /Never invent/);
  assert.match(llm.calls[0].user, /PAGE https:\/\/s\.example\.com\/\nPotter/);
});

test('styleFromImages drops invalid hex, clamps weights, caps lengths, and is null without llm or images', async () => {
  assert.equal(await styleFromImages({ images: ['https://x.example.com/a.png'] }), null);
  assert.equal(await styleFromImages({ images: [], llm: fakeLlm({}) }), null);
  const llm = fakeLlm({
    colors: [{ hex: '#ABC', weight: 99 }, { hex: 'red', weight: 5 }, { hex: '#12345', weight: 5 }, { hex: '#112233', weight: -3 }, { hex: '#aabbcc', weight: 4 },
      ...Array.from({ length: 8 }, (_, i) => ({ hex: `#00000${i}`, weight: 2 }))],
    fonts: [{ family: 'Abril Fatface', weight: 20 }, { family: '' }], mood: 'Warm and a great deal more than one word', imagery: 'x'.repeat(300),
  });
  const s = defined(await styleFromImages({ images: ['https://x.example.com/a.png', 'http://insecure.example.com/b.png'], llm, notes: 'logo' }));
  assert.deepEqual((s.colors ?? []).slice(0, 2), [{ hex: '#aabbcc', weight: 10 }, { hex: '#112233', weight: 1 }]);
  assert.equal((s.colors ?? []).length, 6);
  assert.ok((s.colors ?? []).every((c) => /^#[0-9a-f]{6}$/.test(c.hex)));
  assert.deepEqual(s.fonts, [{ family: 'Abril Fatface', weight: 10 }]);
  assert.equal(s.source, 'vision');
  assert.equal(s.imagery?.length, 120);
  assert.equal(s.mood?.length, 24);
  assert.deepEqual(llm.calls[0].images, ['https://x.example.com/a.png']);
});

const IG = '<meta property="og:title" content="Studio (&#064;studio) Instagram" /><meta property="og:image" content="https://cdn.example.com/a.jpg" />';

test('without a login Instagram and TikTok still read the public page and ask for a login', async () => {
  const fetch = net({ 'https://www.instagram.com/studio/': IG, 'https://www.tiktok.com/@studio': IG });
  const ig = await connectors.instagram({ fetch }).read('@studio');
  assert.equal(ig.name, 'Studio');
  assert.equal(ig.needs_login?.platform, 'instagram');
  assert.match((ig.needs_login?.why as string), /bio.*posts.*follower/i);
  const tt = await connectors.tiktok({ fetch }).read('studio');
  assert.equal(tt.needs_login?.platform, 'tiktok');
  assert.deepEqual(loginNeeds([ig, tt, { source: 'website' }, null]).map((n) => n.platform), ['instagram', 'tiktok']);
});

test('with a login Instagram uses the Graph API and reports no needs_login', async () => {
  const seen: string[] = [];
  const login: FetchFn = async (input) => {
    const url = String(input);
    seen.push(url);
    const body = url.includes('/me/media')
      ? { data: [{ caption: 'First line\nmore', permalink: 'https://instagram.com/p/1', thumbnail_url: 'https://cdn/t.jpg', media_url: 'https://cdn/m.mp4', timestamp: '2026-10-01' }, { caption: 'Photo', permalink: 'https://instagram.com/p/2', media_url: 'https://cdn/p.jpg' }] }
      : { username: 'studio', name: 'Studio', biography: 'Pots.', profile_picture_url: 'https://cdn/me.jpg', followers_count: 3091 };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const fetch: FetchFn = async () => assert.fail('the public page must not be read when logged in');
  const s = await connectors.instagram({ fetch, login }).read('@studio');
  assert.match(seen[0] as string, /^https:\/\/graph\.instagram\.com\/me\?fields=username,name,biography,profile_picture_url,followers_count,media_count$/);
  assert.match(seen[1] as string, /\/me\/media\?fields=caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=6$/);
  assert.equal(s.bio, 'Pots.');
  assert.equal(s.stats, '3,091 followers');
  assert.equal(s.avatar_url, 'https://cdn/me.jpg');
  assert.equal(s.links?.[0]?.handle, '@studio');
  assert.deepEqual((s.posts ?? []).map((p) => [p.title, p.url, p.image_url]), [['First line', 'https://instagram.com/p/1', 'https://cdn/t.jpg'], ['Photo', 'https://instagram.com/p/2', 'https://cdn/p.jpg']]);
  assert.equal(s.needs_login, undefined);
});

test('with a login TikTok uses the Display API (a POST for videos) and reports no needs_login', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const login: FetchFn = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const body = url.includes('/video/list/')
      ? { data: { videos: [{ title: 'Wheel day', share_url: 'https://tiktok.com/v/1', cover_image_url: 'https://cdn/c.jpg', create_time: 1790000000 }] } }
      : { data: { user: { display_name: 'Studio', bio_description: 'Clay.', avatar_url: 'https://cdn/a.jpg', profile_deep_link: 'https://tiktok.com/@studio', follower_count: 1200 } } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const s = await connectors.tiktok({ login }).read('@studio');
  assert.match(calls[0]?.url as string, /^https:\/\/open\.tiktokapis\.com\/v2\/user\/info\/\?fields=open_id,display_name,avatar_url,bio_description,profile_deep_link,follower_count$/);
  assert.equal(calls[1]?.init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1]?.init.body as string), { max_count: 6 });
  assert.equal(s.bio, 'Clay.');
  assert.equal(s.stats, '1,200 followers');
  assert.equal(s.posts?.[0]?.title, 'Wheel day');
  assert.equal(s.posts?.[0]?.image_url, 'https://cdn/c.jpg');
  assert.equal(s.needs_login, undefined);
});

test('when the login read fails, the connector falls back to the public page and says so', async () => {
  const fetch = net({ 'https://www.tiktok.com/@x': IG, 'https://www.instagram.com/x/': IG });
  const login: FetchFn = async () => new Response('', { status: 401 });
  const tt = await connectors.tiktok({ fetch, login }).read('x');
  assert.equal(tt.needs_login?.platform, 'tiktok');
  assert.match(tt.warnings?.[0] as string, /login.*401/i);
  assert.match(tt.warnings?.[0] as string, /public page/);
  // If the public page fails as well, the connector fails.
  await assert.rejects(connectors.instagram({ fetch: net({}), login }).read('x'), /404/);
});

test('the website connector returns https images: the share image first, small and non-https ones left out', async () => {
  const html = `<html><head><meta property="og:image" content="/og.jpg"/></head><body>
<img src="/big.jpg" width="800"/><img src="/tiny.png" width="16"/><img src="http://plain.example.com/x.jpg"/><img src="https://cdn.other.example.com/y.jpg"/>
<img src="/logo.svg"/><img src="/a.jpg"/><img src="/b.jpg"/><img src="/c.jpg"/></body></html>`;
  const s = await connectors.website({ fetch: net({ 'https://s.example.com/': html }) }).read('https://s.example.com');
  assert.deepEqual(s.images, ['https://s.example.com/og.jpg', 'https://s.example.com/big.jpg', 'https://cdn.other.example.com/y.jpg', 'https://s.example.com/a.jpg', 'https://s.example.com/b.jpg']);
});
