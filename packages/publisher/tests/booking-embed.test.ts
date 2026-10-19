/** The booking embed slot: validation, exact markup, placement, the page CSP and the compile path. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowCspSource, BookingEmbedError, finishBookingEmbeds, parseBookingEmbed, parseBookingEmbeds, renderBookingEmbed, spliceBookingEmbeds, type BookingEmbed,
} from '../src/booking-embed.ts';
import { compile } from '../src/compile.ts';
import { entryHtml, KEY_A, KEY_B, loadExample } from './helpers.ts';

const API = 'https://api.example.com';
const iframe: BookingEmbed = { id: 'book-online', heading: 'Book a visit', key: KEY_A, pageUrl: `${API}/book/${KEY_A}`, mode: 'iframe' };
const script: BookingEmbed = { id: 'reserve', heading: 'Reserve a table', key: KEY_B, pageUrl: `${API}/book/${KEY_B}`, mode: 'script', scriptUrl: `${API}/embed.js` };
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">`;
const page = (body: string, head = CSP) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const rejects = (input: unknown, pattern: RegExp) => assert.throws(() => parseBookingEmbed(input), (error: unknown) => error instanceof BookingEmbedError && error.code === 'invalid-booking-embed' && pattern.test(error.message));
const cspOf = (html: string) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1];

test('booking embed: a valid slot parses with defaults and a normalized URL', () => {
  const parsed = parseBookingEmbed({ ...iframe, pageUrl: `HTTPS://API.Example.com:443/book/${KEY_A}` });
  assert.equal(parsed.pageUrl, `https://api.example.com/book/${KEY_A}`);
  assert.equal(parsed.height, 720);
  assert.equal(parsed.linkLabel, 'Open the booking page');
});

test('booking embed: invalid slots are refused with a field-level reason', () => {
  rejects(null, /must be an object/);
  rejects({ ...iframe, colour: 'red' }, /unknown field "colour"/);
  rejects({ ...iframe, id: 'Book Online' }, /\.id must be/);
  rejects({ ...iframe, key: 'has spaces' }, /\.key must be a widget key/);
  rejects({ ...iframe, key: 'x' }, /\.key must be a widget key/);
  rejects({ ...iframe, key: `zsb1_${'a'.repeat(63)}` }, /\.key must be a widget key/);
  rejects({ ...iframe, key: `zsb1_${'a'.repeat(65)}` }, /\.key must be a widget key/);
  rejects({ ...iframe, key: `zsb2_${'a'.repeat(64)}` }, /\.key must be a widget key/);
  rejects({ ...iframe, key: `zsb1_${'a'.repeat(63)}.` }, /\.key must be a widget key/);
  rejects({ ...iframe, heading: '   ' }, /\.heading must be/);
  rejects({ ...iframe, heading: 'x'.repeat(121) }, /\.heading must be/);
  rejects({ ...iframe, body: 'x'.repeat(401) }, /\.body must be/);
  rejects({ ...iframe, mode: 'popup' }, /\.mode must be/);
  rejects({ ...iframe, pageUrl: `http://api.example.com/book/${KEY_A}` }, /must use https/);
  rejects({ ...iframe, pageUrl: 'javascript:alert(1)' }, /must use https/);
  rejects({ ...iframe, pageUrl: `https://user:pass@api.example.com/book/${KEY_A}` }, /credentials/);
  rejects({ ...iframe, pageUrl: `https://api.example.com/book/${KEY_A}#top` }, /fragment/);
  rejects({ ...iframe, pageUrl: 'not a url' }, /is not a URL/);
  rejects({ ...iframe, scriptUrl: `${API}/embed.js` }, /only used in script mode/);
  rejects({ ...script, scriptUrl: undefined }, /\.scriptUrl must be a URL/);
  rejects({ ...script, pageUrl: `https://book.example.org/book/${KEY_B}` }, /must share an origin/);
  rejects({ ...iframe, height: 100 }, /\.height must be/);
  rejects({ ...iframe, height: 720.5 }, /\.height must be/);
  rejects({ ...iframe, placement: { after: 'a', before: 'b' } }, /placement must be/);
  rejects({ ...iframe, placement: { after: 'a"><script>' } }, /plain element id/);
});

test('booking embed: http is allowed only for a loopback host', () => {
  assert.equal(parseBookingEmbed({ ...iframe, pageUrl: `http://127.0.0.1:8799/book/${KEY_A}` }).pageUrl, `http://127.0.0.1:8799/book/${KEY_A}`);
  assert.equal(parseBookingEmbed({ ...iframe, pageUrl: `http://localhost:8799/book/${KEY_A}` }).pageUrl, `http://localhost:8799/book/${KEY_A}`);
  // CSP has no syntax for an IPv6 host, so no IPv6 URL is accepted.
  rejects({ ...iframe, pageUrl: `http://[::1]:8799/book/${KEY_A}` }, /must use https/);
});

test('booking embed: a host that is not a plain DNS name or IPv4 address is refused, so no URL can inject CSP', () => {
  for (const host of ['api.example.com;report-to', '*.example.com', 'a_b.example.com', '[2001:db8::1]', "api.example.com'unsafe-inline'", 'api.example.com,x']) {
    rejects({ ...iframe, pageUrl: `https://${host}/book/${KEY_A}` }, /plain DNS or IPv4 host|is not a URL/);
    rejects({ ...script, pageUrl: `https://${host}/book/${KEY_A}`, scriptUrl: `https://${host}/embed.js` }, /plain DNS or IPv4 host|is not a URL/);
  }
  assert.equal(parseBookingEmbed({ ...iframe, pageUrl: `https://xn--bcher-kva.example/book/${KEY_A}` }).pageUrl, `https://xn--bcher-kva.example/book/${KEY_A}`);
  assert.equal(parseBookingEmbed({ ...iframe, pageUrl: `https://bücher.example/book/${KEY_A}` }).pageUrl, `https://xn--bcher-kva.example/book/${KEY_A}`, 'IDN hosts arrive as punycode');
  assert.throws(() => allowCspSource("default-src 'none'", 'script-src', 'https://a.test;report-to'), /not a single CSP source/);
  assert.throws(() => allowCspSource("default-src 'none'", 'script-src', 'https://a.test x'), /not a single CSP source/);
});

test('booking embed: a page list needs distinct ids and one widget script', () => {
  assert.equal(parseBookingEmbeds([iframe, script, { ...script, id: 'second' }]).length, 3);
  assert.throws(() => parseBookingEmbeds([iframe, iframe]), /use the id "book-online" twice/);
  assert.throws(() => parseBookingEmbeds([{ ...iframe, id: 'a-title' }, { ...iframe, id: 'a' }]), /use the id "a-title" twice/);
  const other = { ...script, id: 'other', pageUrl: `https://book.example.org/book/${KEY_B}`, scriptUrl: 'https://book.example.org/embed.js' };
  assert.throws(() => parseBookingEmbeds([script, other]), /same scriptUrl \(found 2\)/);
  assert.throws(() => spliceBookingEmbeds(page('<main></main>'), [script, other]), /same scriptUrl/);
});

test('booking embed: exact iframe markup', () => {
  assert.equal(renderBookingEmbed({ ...iframe, body: 'Pick a time.' }, false),
    `<section id="book-online" data-od-id="book-online" class="mish-booking" data-mish-slot="booking-embed" aria-labelledby="book-online-title"><div class="mish-booking__inner"><h2 id="book-online-title" data-od-id="book-online--title">Book a visit</h2><p class="mish-booking__body" data-od-id="book-online--body">Pick a time.</p><iframe class="mish-booking__frame" src="${API}/book/${KEY_A}" title="Book a visit" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-forms allow-same-origin" style="height:720px" data-zs-booking-frame="${KEY_A}" data-od-id="book-online--frame"></iframe><p class="mish-booking__fallback"><a href="${API}/book/${KEY_A}" data-od-id="book-online--link">Open the booking page</a></p></div></section>`);
});

test('booking embed: exact script-mode mount markup (the widget script is added by the finish step)', () => {
  assert.equal(renderBookingEmbed({ ...script, height: 640, linkLabel: 'Book on our booking page' }, false),
    `<section id="reserve" data-od-id="reserve" class="mish-booking" data-mish-slot="booking-embed" aria-labelledby="reserve-title"><div class="mish-booking__inner"><h2 id="reserve-title" data-od-id="reserve--title">Reserve a table</h2><div class="mish-booking__mount" data-zs-booking="${KEY_B}" data-zs-title="Reserve a table" style="min-height:640px" data-od-id="reserve--mount"></div><p class="mish-booking__fallback"><a href="${API}/book/${KEY_B}" data-od-id="reserve--link">Book on our booking page</a></p></div></section>`);
});

test('booking embed: text is escaped', () => {
  const html = renderBookingEmbed({ ...iframe, heading: 'Book <now> & "save"', body: '<img src=x onerror=alert(1)>', linkLabel: "Fish & 'Chips'" });
  assert.ok(!html.includes('<now>') && !html.includes('<img'));
  assert.ok(html.includes('Book &lt;now&gt; &amp; &quot;save&quot;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('Fish &amp; &#39;Chips&#39;'));
});

test('booking embed: styles are inlined once, by the first slot', () => {
  const html = spliceBookingEmbeds(page('<main></main>'), [iframe, { ...script, id: 'second' }]);
  assert.equal(html.split('data-mish-booking-style').length - 1, 1);
  assert.ok(html.indexOf('data-mish-booking-style') < html.indexOf('id="second"'));
});

test('booking embed: placement after, before and by default', () => {
  const body = '<header id="top"></header><main><section id="a"><div><section>inner</section></div></section><section id="b"></section></main><footer id="end"></footer>';
  const at = (embed: BookingEmbed) => spliceBookingEmbeds(page(body), [embed]);
  assert.match(at({ ...iframe, placement: { after: 'a' } }), /inner<\/section><\/div><\/section><section id="book-online"[^]*<\/section><section id="b">/);
  assert.match(at({ ...iframe, placement: { before: 'b' } }), /<\/section><section id="book-online"[^]*<\/section><section id="b">/);
  assert.match(at(iframe), /<section id="b"><\/section><section id="book-online"[^]*<\/section><\/main>/, 'default: the end of <main>');
  assert.match(spliceBookingEmbeds(page('<section id="a"></section><footer id="end"></footer>'), [iframe]), /<section id="a"><\/section><section id="book-online"[^]*<\/section><footer id="end">/, 'no <main>: before the last <footer>');
  assert.match(spliceBookingEmbeds(page('<section id="a"></section>'), [iframe]), /<section id="a"><\/section><section id="book-online"[^]*<\/section><\/body>/, 'neither: the end of <body>');
});

test('booking embed: markup inside comments and raw-text elements is never an anchor', () => {
  const html = spliceBookingEmbeds(page('<!-- <div id="x"></div> --><script>const s = \'<div id="x">\';</script><style>/* <div id="x"> */</style><iframe title="t"><div id="x"></div></iframe><noscript>Turn on scripts for the menu.</noscript><textarea><div id="x"></div></TEXTAREA ><div id="x"></div><p id="after"></p>'), [{ ...iframe, placement: { after: 'x' } }]);
  assert.match(html, /<div id="x"><\/div><section id="book-online"[^]*<\/section><p id="after">/);
  // Without scripting a browser parses <noscript> content as markup, so it must be text only.
  for (const inner of ['<div id="x"></div>', '<template>', '<!-- c -->', '<textarea>']) {
    assert.throws(() => spliceBookingEmbeds(page(`<main><noscript>${inner}</noscript></main>`), [iframe]), /<noscript> contains markup/, inner);
  }
});

test('booking embed: table parts, document structure and head content are never anchors', () => {
  const at = (body: string, placement: { after: string } | { before: string }, head = CSP) => spliceBookingEmbeds(page(body, head), [{ ...iframe, placement }]);
  assert.throws(() => at('<main><tr id="x"></tr></main>', { after: 'x' }), /anchor "x" is a <tr>/);
  assert.throws(() => at('<table><tr><td id="x"></td></tr></table>', { before: 'x' }), /anchor "x" is a <td>/);
  assert.throws(() => at('<main></main>', { before: 'x' }, `<title id="x">t</title>${CSP}`), /anchor "x" is a <title>/);
  assert.throws(() => at('<main></main>', { before: 'x' }, `<meta id="x" charset="utf-8">${CSP}`), /anchor "x" is a <meta>/);
  assert.throws(() => spliceBookingEmbeds(`<!doctype html><html><head>${CSP}</head><body id="x"></body></html>`, [{ ...iframe, placement: { after: 'x' } }]), /anchor "x" is a <body>/);
  assert.match(at('<table id="x"><tr><td>a</td></tr></table><p></p>', { after: 'x' }), /<\/table><section id="book-online"[^]*<\/section><p>/, 'a whole table is an anchor');
  // Error repair clones formatting elements, so one <b id> can become two elements: never an anchor.
  assert.throws(() => at('<b id="x"><p>hello</b></p>', { after: 'x' }), /anchor "x" is a <b>/);
  // A form inside an open form is discarded; once the first form closes, a form is real.
  assert.throws(() => at('<form><form id="x"></form></form>', { before: 'x' }), /<form> inside another form/);
  assert.match(at('<form></form><form id="x"></form><p></p>', { after: 'x' }), /<form id="x"><\/form><section id="book-online"[^]*<\/section><p>/);
  assert.match(at('<template><form></template><form id="x"></form><p></p>', { after: 'x' }), /<form id="x"><\/form><section id="book-online"/, 'a form in a template does not count');
});

test('booking embed: the scanner reads attributes, not text that looks like one', () => {
  const after = (body: string) => spliceBookingEmbeds(page(body), [{ ...iframe, placement: { after: 'x' } }]);
  // A quoted ">" does not end the tag.
  assert.match(after('<div title="a > b" id="x"><p>in</p></div><p id="z"></p>'), /<p>in<\/p><\/div><section id="book-online"[^]*<\/section><p id="z">/);
  // An attribute value that spells id="x" is not the id.
  assert.match(after(`<div data-note=' id="x"'></div><div id="x"></div><p id="z"></p>`), /<div id="x"><\/div><section id="book-online"/);
  // Attribute names are case-insensitive; unquoted values count; a repeated attribute keeps the first.
  assert.match(after('<DIV ID=x></DIV><p id="z"></p>'), /<DIV ID=x><\/DIV><section id="book-online"/);
  assert.match(after('<div id="x" id="y"></div><p id="z"></p>'), /<div id="x" id="y"><\/div><section id="book-online"/);
  assert.throws(() => after('<div id="y" id="x"></div>'), /found 0/);
  // Character references in a value are decoded, as a browser does, with or without `;`.
  assert.match(after('<div id="&#120;"></div><p id="z"></p>'), /<div id="&#120;"><\/div><section id="book-online"/);
  assert.match(after('<div id="&#120"></div><p id="z"></p>'), /<div id="&#120"><\/div><section id="book-online"/);
  assert.match(after('<div id="&#x78"></div><p id="z"></p>'), /<div id="&#x78"><\/div><section id="book-online"/);
  assert.match(after('<div id="&#X0078;"></div><p id="z"></p>'), /<div id="&#X0078;"><\/div><section id="book-online"/);
  // Ids taken by the page are found the same way.
  assert.throws(() => spliceBookingEmbeds(page('<main><P ID=book-online></P></main>'), [iframe]), /"book-online" is already used/);
  assert.ok(spliceBookingEmbeds(page(`<main><p data-x='id="book-online"'></p></main>`), [iframe]).includes('<section id="book-online"'));
});

test('booking embed: offsets survive text whose lowercase is longer (a Unicode heading and title)', () => {
  const heading = 'İ'.repeat(30);
  const head = `${CSP}<title>${'İ'.repeat(40)}</title>`;
  const embeds = [{ ...script, heading }];
  const html = finishBookingEmbeds(spliceBookingEmbeds(page('<main></main>', head), embeds), embeds);
  assert.ok(html.endsWith(`<script src="${API}/embed.js" async data-mish-booking-script></script></body></html>`));
  assert.ok(html.includes(`<h2 id="reserve-title" data-od-id="reserve--title">${heading}</h2>`));
  assert.match(cspOf(html), /script-src https:\/\/api\.example\.com\/embed\.js; frame-src https:\/\/api\.example\.com$/);
});

test('booking embed: slots that share an anchor keep their input order', () => {
  const body = '<main><section id="x"></section><p id="z"></p></main>';
  const order = (html: string) => [...html.matchAll(/<section id="([a-z-]+)"/g)].map((match) => match[1]);
  const slots = (placement: BookingEmbed['placement']) => ['first', 'second', 'third'].map((id) => ({ ...iframe, id, placement }));
  assert.deepEqual(order(spliceBookingEmbeds(page(body), slots({ after: 'x' }))), ['x', 'first', 'second', 'third']);
  assert.deepEqual(order(spliceBookingEmbeds(page(body), slots({ before: 'z' }))), ['x', 'first', 'second', 'third']);
  assert.deepEqual(order(spliceBookingEmbeds(page(body), slots(undefined))), ['x', 'first', 'second', 'third']);
});

test('booking embed: a missing, repeated or void anchor is refused', () => {
  assert.throws(() => spliceBookingEmbeds(page('<main></main>'), [{ ...iframe, placement: { after: 'nope' } }]), /anchor "nope" must name exactly one element \(found 0\)/);
  assert.throws(() => spliceBookingEmbeds(page('<p id="d"></p><p id="d"></p>'), [{ ...iframe, placement: { after: 'd' } }]), /found 2/);
  assert.throws(() => spliceBookingEmbeds(page('<img id="pic"><main></main>'), [{ ...iframe, placement: { after: 'pic' } }]), /not a container element/);
  assert.ok(spliceBookingEmbeds(page('<img id="pic"><main></main>'), [{ ...iframe, placement: { before: 'pic' } }]).includes('</section><img id="pic">'));
});

test('booking embed: an id already on the page is refused, including the heading id', () => {
  assert.throws(() => spliceBookingEmbeds(page('<main id="book-online"></main>'), [iframe]), /"book-online" is already used/);
  assert.throws(() => spliceBookingEmbeds(page('<main><p id="book-online-title"></p></main>'), [iframe]), /"book-online-title" is already used/);
  assert.throws(() => spliceBookingEmbeds(page('<main></main>'), [iframe, iframe]), /use the id "book-online" twice/);
});

test('booking embed: a static prototype page is refused', () => {
  assert.throws(() => spliceBookingEmbeds(page('<main></main><footer><p data-od-output-scope="static-prototype">x</p></footer>'), [iframe]), /static prototype/);
});

test('booking embed: the page CSP allows exactly the frame origin', () => {
  const html = spliceBookingEmbeds(page('<main></main>'), [iframe]);
  assert.equal(cspOf(html), `default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; frame-src ${API}`);
  assert.equal(finishBookingEmbeds(html, [iframe]), html, 'iframe mode adds no script');
});

test('booking embed: script mode allows the script URL and its frame origin, and adds the script once', () => {
  const other = { ...iframe, id: 'third', pageUrl: `https://book.example.org/book/${KEY_A}` };
  const embeds = [script, { ...script, id: 'second' }, other];
  const html = finishBookingEmbeds(spliceBookingEmbeds(page('<main></main>'), embeds), embeds);
  assert.equal(cspOf(html), `default-src 'none'; style-src 'unsafe-inline'; script-src ${API}/embed.js; frame-src ${API} https://book.example.org`);
  assert.equal(html.split(`<script src="${API}/embed.js" async data-mish-booking-script></script>`).length - 1, 1);
  assert.ok(html.endsWith('<script src="https://api.example.com/embed.js" async data-mish-booking-script></script></body></html>'));
});

test('booking embed: every CSP meta on the page is widened; a page without one is left alone', () => {
  const two = page('<main></main>', `${CSP}<meta http-equiv="content-security-policy" content="frame-src 'self'">`);
  const html = spliceBookingEmbeds(two, [iframe]);
  assert.ok(html.includes(`content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; frame-src ${API}"`));
  assert.ok(html.includes(`content="frame-src 'self' ${API}"`));
  const bare = spliceBookingEmbeds(page('<main></main>', ''), [iframe]);
  assert.ok(!bare.includes('Content-Security-Policy') && bare.includes('<iframe'));
  assert.throws(() => spliceBookingEmbeds(page('<main></main>', `<meta http-equiv="Content-Security-Policy" content='default-src none'>`), [iframe]), /must quote its content/);
  // Matched case-insensitively and with character references decoded, then written back escaped.
  const encoded = spliceBookingEmbeds(page('<main></main>', `<META HTTP-EQUIV="Content-Security-Policy" CONTENT="default-src &#39;none&#39;; frame-src &#x27;none&#x27;">`), [iframe]);
  assert.ok(encoded.includes(`CONTENT="default-src 'none'; frame-src ${API}">`));
});

test('booking embed: allowCspSource adds, replaces a lone none, and never duplicates', () => {
  assert.equal(allowCspSource("default-src 'none'", 'frame-src', 'https://a.test'), "default-src 'none'; frame-src https://a.test");
  assert.equal(allowCspSource("default-src 'none';  ", 'frame-src', 'https://a.test'), "default-src 'none'; frame-src https://a.test");
  assert.equal(allowCspSource("script-src 'none'; img-src 'none'", 'script-src', 'https://a.test/x.js'), "script-src https://a.test/x.js; img-src 'none'");
  assert.equal(allowCspSource("a 'b'; script-src 'sha256-x'", 'script-src', 'https://a.test/x.js'), "a 'b'; script-src 'sha256-x' https://a.test/x.js");
  assert.equal(allowCspSource('frame-src https://a.test', 'frame-src', 'https://a.test'), 'frame-src https://a.test');
  assert.equal(allowCspSource('FRAME-SRC https://b.test', 'frame-src', 'https://a.test'), 'frame-src https://b.test https://a.test', 'names match case-insensitively');
});

test('booking embed: the script URL must be exactly the widget script, never a directory or another path', () => {
  for (const scriptUrl of [`${API}/`, API, `${API}/static/`, `${API}/w;v=1/embed.js`, `${API}/embed.js/`, `${API}/embed.js?v=1`, `${API}/other.js`]) {
    rejects({ ...script, scriptUrl }, /scriptUrl must be the widget script/);
  }
  const html = finishBookingEmbeds(spliceBookingEmbeds(page('<main></main>'), [script]), [script]);
  assert.ok(cspOf(html).includes(`script-src ${API}/embed.js;`));
});

test('booking embed: script text follows HTML escape states and tags end only at ASCII whitespace', () => {
  const after = (body: string, anchor: string) => spliceBookingEmbeds(page(body), [{ ...iframe, placement: { after: anchor } }]);
  // <!-- then <script hides the next </script>: the div is script text up to the real end tag.
  const hidden = '<script><!--<script></script><div id="x"></div>--></script><div id="y"></div>';
  assert.throws(() => after(hidden, 'x'), /found 0/);
  assert.match(after(hidden, 'y'), /--><\/script><div id="y"><\/div><section id="book-online"/);
  // Escaped but not double escaped: </script> still ends the element, so the div is real.
  assert.match(after('<script><!-- </script><div id="x"></div>', 'x'), /<div id="x"><\/div><section id="book-online"/);
  // --> leaves the escape, and <!--> enters and leaves it at once.
  assert.match(after('<script><!--> <script></script><div id="x"></div>', 'x'), /<div id="x"><\/div><section id="book-online"/);
  assert.match(after('<script><!--<script>--></script><div id="x"></div>', 'x'), /<div id="x"><\/div><section id="book-online"/);
  // Double escaped, </script> returns to escaped, where the next </script> ends the element.
  assert.match(after('<script><!--<script></script></SCRIPT ><div id="x"></div>', 'x'), /<div id="x"><\/div><section id="book-online"/);
  // Only ASCII whitespace ends a tag name: </textarea\u00a0> is text, so the div inside is too.
  assert.throws(() => after('<textarea></textarea\u00a0><div id="x"></div></textarea>', 'x'), /found 0/);
  assert.throws(() => after('<div\u00a0id="x"></div>', 'x'), /found 0/);
  // A script that never closes, or <plaintext>, hides the rest of the page.
  assert.throws(() => after('<script><!--<script></script><div id="x"></div>', 'x'), /found 0/);
  assert.throws(() => after('<plaintext><div id="x"></div>', 'x'), /found 0/);
});

test('booking embed: inline <svg> and <math> are foreign content, never a place for the slot', () => {
  const after = (body: string) => spliceBookingEmbeds(page(body), [{ ...iframe, placement: { after: 'x' } }]);
  // An icon: elements inside it are SVG elements, so none is an anchor; the <svg> itself is.
  assert.throws(() => after('<svg><g id="x"><path d="M0 0"/></g></svg>'), /found 0/);
  assert.throws(() => after('<math><mrow id="x"></mrow></math>'), /found 0/);
  assert.match(after('<svg id="x" viewBox="0 0 24 24"><svg><path/></svg><path d="M0 0"/></svg><p></p>'), /<path d="M0 0"\/><\/svg><section id="book-online"[^]*<\/section><p>/);
  assert.match(after('<div id="x"><svg><g><path/></g></svg></div><p></p>'), /<\/svg><\/div><section id="book-online"[^]*<\/section><p>/);
  // Text-only <title> and <style>, and an SVG <template>, which is not HTML's inert template.
  assert.match(after('<svg><title>Close</title><style>.a{fill:red}</style><path/></svg><div id="x"></div>'), /<div id="x"><\/div><section id="book-online"/);
  assert.match(after('<svg><template></template></svg><div id="x"></div>'), /<div id="x"><\/div><section id="book-online"/);
  // Default placement ignores a <main> end tag that only an SVG element could have.
  assert.match(spliceBookingEmbeds(page('<main><svg><g></g></svg></main>'), [iframe]), /<\/svg><section id="book-online"[^]*<\/section><\/main>/);
  // A <select> drops (or, in newer browsers, keeps in its picker) a section, so nothing in one is an
  // anchor, and only options, groups, <hr>, text and comments are accepted inside one.
  assert.throws(() => after('<select><option id="x">a</option></select>'), /found 0/);
  assert.match(after('<select><optgroup label="g"><option>a<option>b</optgroup><hr><!-- c --></select><div id="x"></div>'), /<div id="x"><\/div><section id="book-online"/);
  for (const inner of ['<b id="x"></b>', '<input>', '<style></style>', '<template></template>', '<textarea></textarea>', '<select>', '</div>']) {
    assert.throws(() => after(`<select>${inner}</select><div id="x"></div>`), /the page's <select> contains/, inner);
  }
  assert.throws(() => after('<select><style><textarea></style><input><div id="x"></div></textarea>'), /<select> contains <style>/);
  // A select inside a template ends with the template.
  assert.match(spliceBookingEmbeds(page('<main><div id="x"><template><select></template></div><p></p></main>'), [{ ...iframe, placement: { after: 'x' } }]), /<\/template><\/div><section id="book-online"[^]*<\/section><p>/);
  assert.throws(() => spliceBookingEmbeds(page('<frameset id="x"></frameset>'), [{ ...iframe, placement: { after: 'x' } }]), /<frameset> page/);
  // What the scanner cannot follow exactly is refused, never guessed: CDATA, HTML that breaks out,
  // markup in a text element, a stray end tag.
  assert.throws(() => after('<svg><![CDATA[> <div id="x"></div>]]></svg>'), /contains a CDATA section/);
  assert.throws(() => after('<svg><title><div id="x"></div></title></svg>'), /contains markup inside <title>/);
  assert.throws(() => after('<svg><foreignObject><textarea></svg><div id="x"></textarea></foreignObject></svg>'), /contains markup inside <foreignobject>/);
  assert.throws(() => after('<svg><p><div id="x"></div></svg>'), /contains an HTML <p>/);
  assert.throws(() => after('<svg><font color="red"></font></svg>'), /contains an HTML <font>/);
  assert.throws(() => after('<div id="x"><svg></div><p></p>'), /contains a stray <\/div>/);
  // An unclosed <svg> runs on, so the page's own </body> is refused too.
  assert.throws(() => after('<svg><g id="x"></g>'), /contains a stray <\/body>/);
});

test('booking embed: the scanner follows HTML tag and comment rules', () => {
  const after = (body: string) => spliceBookingEmbeds(page(body), [{ ...iframe, placement: { after: 'x' } }]);
  // A quote only opens a value after `=`: `"x` and `<div` are attribute names of <a>, so the id is the <a>'s.
  assert.throws(() => after('<a "x <div id="x"></a>'), /anchor "x" is a <a>/);
  // Bogus comments and the doctype end at the first `>`; `--!>` and an abrupt `<!-->` end a comment.
  assert.throws(() => after('<!x <div id="x"></div>'), /found 0/);
  assert.throws(() => after('<?x <div id="x"></div>'), /found 0/);
  assert.throws(() => after('</ x <div id="x"></div>'), /found 0/);
  assert.match(after('<!-- a --!><div id="x"></div>'), /<div id="x"><\/div><section id="book-online"/);
  assert.match(after('<!--><div id="x"></div>'), /<div id="x"><\/div><section id="book-online"/);
  assert.match(after('<!---><div id="x"></div>'), /<div id="x"><\/div><section id="book-online"/);
  // Only `/>` self-closes; `/ >` does not.
  assert.match(after('<div id="x" / ></div>'), /<div id="x" \/ ><\/div><section id="book-online"/);
  // A tag cut off by the end of the page is dropped.
  assert.throws(() => after('<div id="x'), /found 0/);
});

test('booking embed: scanning is linear on inputs that are quadratic for a backtracking pattern', { timeout: 10_000 }, () => {
  const n = 200_000;
  for (const body of ['<!--a'.repeat(n / 5), '<a'.repeat(n / 2), `<a title="${'x'.repeat(n)}`, '<div id="x">'.repeat(n / 12), `<svg>${'<g>'.repeat(n / 3)}${'</svg>'.repeat(n / 6)}`, `<svg>${'<title>'.repeat(n / 7)}`, `<div id="${'&#120'.repeat(n / 5)}">`, '<select><b>'.repeat(n / 11)]) {
    assert.throws(() => spliceBookingEmbeds(page(body), [{ ...iframe, placement: { after: 'missing' } }]), BookingEmbedError);
  }
  assert.equal(allowCspSource(`frame-src 'none'${'\t'.repeat(n)}x`, 'script-src', 'https://a.test/embed.js'), `frame-src 'none'${'\t'.repeat(n)}x; script-src https://a.test/embed.js`);
  assert.equal(allowCspSource(`frame-src 'none'${'; \t'.repeat(n)}`, 'script-src', 'https://a.test/embed.js'), "frame-src 'none'; script-src https://a.test/embed.js");
});

test('booking embed: compile places it on a family page, after effects, with effects still applied', async () => {
  const { compiler } = await loadExample('restaurant');
  const result = await compile({
    compiler,
    spec: { recipe: compiler.reference, effects: { effects: [{ placement: 'hero-title', componentId: 'split-text', source: 'hint' }] }, bookingEmbeds: [{ ...script, placement: { after: 'restaurant-reservations' } }] },
  });
  const html = entryHtml(result);
  assert.equal(result.effects!.applied.length, 1);
  assert.match(html, /id="restaurant-reservations"[^]*<\/section><section id="reserve"/);
  const csp = cspOf(html);
  assert.match(csp, /script-src 'sha256-[^']+' https:\/\/api\.example\.com\/embed\.js;/, 'the effect hash stays and the widget URL joins it');
  assert.match(csp, /frame-src https:\/\/api\.example\.com$/);
  assert.ok(html.indexOf('data-genui-script') < html.indexOf('data-mish-booking-script'), 'the widget script comes after the effect scripts');
});

test('booking embed: compile refuses a static-prototype family and a non-array slot list', async () => {
  const { compiler } = await loadExample('app-shell');
  await assert.rejects(compile({ compiler, spec: { recipe: compiler.reference, bookingEmbeds: [iframe] } }), /static prototype/);
  await assert.rejects(compile({ compiler, spec: { recipe: compiler.reference, bookingEmbeds: iframe as never } }), /must be an array/);
});

test('booking embed: a page without slots compiles exactly as before', async () => {
  const { compiler } = await loadExample('practice');
  const without = await compile({ compiler, spec: { recipe: compiler.reference } });
  const empty = await compile({ compiler, spec: { recipe: compiler.reference, bookingEmbeds: [] } });
  assert.equal(empty.digest, without.digest);
});

test('booking embed: compile with a Unicode heading, script mode and an effect keeps every offset right', async () => {
  const { compiler } = await loadExample('practice');
  const result = await compile({
    compiler,
    spec: { recipe: compiler.reference, effects: { effects: [{ placement: 'hero-title', componentId: 'split-text', source: 'hint' }] }, bookingEmbeds: [{ ...script, heading: 'İ'.repeat(30) }] },
  });
  const html = entryHtml(result);
  assert.equal(result.effects!.applied.length, 1);
  assert.ok(html.includes(`<script src="${API}/embed.js" async data-mish-booking-script></script></body>`));
});

test('booking embed: compile checks the slot list before rendering', async () => {
  const { compiler } = await loadExample('practice');
  await assert.rejects(compile({ compiler, spec: { recipe: compiler.reference, bookingEmbeds: [{ ...iframe, key: 'x' }] } }), /key must be a widget key/);
});

test('booking embed: the page URL must be the key\'s booking page', () => {
  rejects({ ...iframe, pageUrl: `${API}/book/${KEY_B}` }, /must be the key's booking page/);
  rejects({ ...iframe, pageUrl: `${API}/somewhere-else` }, /must be the key's booking page/);
  assert.equal(parseBookingEmbed({ ...iframe, pageUrl: `${API}/v1/book/${KEY_A}?ref=site` }).pageUrl, `${API}/v1/book/${KEY_A}?ref=site`, 'iframe mode: any API prefix and query');
  // Script mode: exactly the page the widget frames, <script origin>/book/<key>.
  rejects({ ...script, pageUrl: `${API}/book/${KEY_A}` }, /must be the key's booking page/);
  rejects({ ...script, pageUrl: `${API}/v1/book/${KEY_B}` }, /must be <scriptUrl origin>\/book\/<key> in script mode/);
});

test('booking embed: content inside a <template> is never a placement or the page CSP', () => {
  const after = (body: string, head = CSP) => spliceBookingEmbeds(page(body, head), [{ ...iframe, placement: { after: 'x' } }]);
  assert.throws(() => after('<main><template><section id="x"></section></template></main>'), /found 0/);
  assert.match(after('<main><template><section id="x"></section></template><section id="x"></section></main>'), /<\/template><section id="x"><\/section><section id="book-online"/);
  assert.match(after('<main><div id="x"><template><div>t</div></template></div><p></p></main>'), /<\/template><\/div><section id="book-online"[^]*<\/section><p>/, 'same-name tags inside a template still nest');
  assert.match(after('<main><div id="x"><template></div></template></div><p></p></main>'), /<\/template><\/div><section id="book-online"[^]*<\/section><p>/, 'an end tag inside a template does not close the anchor');
  assert.match(spliceBookingEmbeds(page('<main></main><template><main></main></template>'), [iframe]), /<main><section id="book-online"[^]*<\/section><\/main><template>/, 'default placement ignores a template <main>');
  const inertCsp = spliceBookingEmbeds(page('<main></main>', `${CSP}<template><meta http-equiv="Content-Security-Policy" content="frame-src 'none'"></template>`), [iframe]);
  assert.ok(inertCsp.includes(`<template><meta http-equiv="Content-Security-Policy" content="frame-src 'none'"></template>`));
});
