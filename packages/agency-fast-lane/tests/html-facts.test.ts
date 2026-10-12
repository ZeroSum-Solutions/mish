/**
 * `htmlFacts`: regex-only extraction of what Jev should see from an uploaded HTML page (no DOM
 * library — see `src/html-facts.ts`'s header). A fixture page covers every field; separate tests
 * cover the strip/cap/malformed-input edges the design doc calls out explicitly (section 5).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { htmlFacts } from '../src/html-facts.ts';

const FIXTURE = `<!DOCTYPE html>
<html>
<head>
  <title>Riverbend Dental — modern, gentle care</title>
  <style>
    body { font-family: 'Inter', sans-serif; }
    h1 { font-family: "Fraunces", serif; animation: fadeIn 2s; }
    .card { transition: transform 0.2s ease; }
  </style>
</head>
<body>
  <header id="site-header" class="sticky top-0">
    <nav class="main-nav"><a href="#services">Services</a></nav>
  </header>
  <main>
    <section id="hero" class="hero-section">
      <h1>Gentle, modern dental care</h1>
      <p>Book your visit today. <script>alert('inline should not appear')</script></p>
    </section>
    <section class="features">
      <h2>Why patients choose us</h2>
      <h3>Comfort first</h3>
    </section>
  </main>
  <footer id="site-footer"></footer>
  <img src="a.jpg"><img src="b.jpg">
  <video src="hero.mp4"></video>
  <canvas id="fx"></canvas>
  <svg><circle /></svg>
  <form action="/contact"></form>
  <iframe src="https://maps.example"></iframe>
  <script src="https://unpkg.com/three@0.160.0/build/three.module.js"></script>
  <script>
    gsap.to('.card', { opacity: 1 });
    window.addEventListener('scroll', () => {});
    const obs = new IntersectionObserver(() => {});
    requestAnimationFrame(() => {});
  </script>
  <style>
    @media (prefers-reduced-motion: reduce) { .hero-section { animation: none; } }
  </style>
</body>
</html>`;

test('extracts title, headings (h1-h3), landmarks, counts, fonts, and signals from a fixture page', () => {
  const facts = htmlFacts(FIXTURE);
  assert.equal(facts.title, 'Riverbend Dental — modern, gentle care');
  assert.deepEqual(facts.headings, ['Gentle, modern dental care', 'Why patients choose us', 'Comfort first']);

  assert.ok(facts.landmarks.some((l) => l.tag === 'header' && l.id === 'site-header'));
  assert.ok(facts.landmarks.some((l) => l.tag === 'nav' && l.class === 'main-nav'));
  assert.ok(facts.landmarks.some((l) => l.tag === 'section' && l.id === 'hero'));
  assert.ok(facts.landmarks.some((l) => l.tag === 'footer' && l.id === 'site-footer'));
  assert.ok(facts.landmarks.some((l) => l.tag === 'main'), 'main is one of the requested landmark tags');

  assert.deepEqual(facts.counts, { video: 1, canvas: 1, svg: 1, img: 2, form: 1, iframe: 1 });

  assert.ok(facts.fonts.includes('Inter'));
  assert.ok(facts.fonts.includes('Fraunces'));

  assert.equal(facts.signals.animation, true);
  assert.equal(facts.signals.transition, true);
  assert.equal(facts.signals.scroll, true);
  assert.equal(facts.signals.IntersectionObserver, true);
  assert.equal(facts.signals.requestAnimationFrame, true);
  assert.equal(facts.signals.three, true);
  assert.equal(facts.signals.gsap, true);
  assert.equal(facts.signals.framer, false);
  assert.equal(facts.signals.prefersReducedMotion, true);
});

test('text strips scripts and styles, collapses whitespace, and excludes tag markup', () => {
  const facts = htmlFacts(FIXTURE);
  assert.ok(!facts.text.includes('alert('), 'inline script content is not in visible text');
  assert.ok(!facts.text.includes('font-family'), 'style block content is not in visible text');
  assert.ok(!facts.text.includes('<'), 'no raw tag markup in visible text');
  assert.ok(facts.text.includes('Gentle, modern dental care'));
  assert.ok(facts.text.includes('Book your visit today.'));
  assert.ok(!/\s{2,}/.test(facts.text), 'whitespace is collapsed to single spaces');
});

test('text is capped at 20,000 characters', () => {
  const bigBody = `<p>${'lorem ipsum dolor sit amet '.repeat(2000)}</p>`;
  const facts = htmlFacts(`<html><body>${bigBody}</body></html>`);
  assert.ok(facts.text.length <= 20_000, `text length ${facts.text.length} should be capped at 20000`);
});

test('headings are capped at 40 and landmarks at 60', () => {
  const manyHeadings = Array.from({ length: 50 }, (_, i) => `<h2>Heading ${i}</h2>`).join('');
  const manySections = Array.from({ length: 80 }, (_, i) => `<section id="s${i}"></section>`).join('');
  const facts = htmlFacts(`<html><body>${manyHeadings}${manySections}</body></html>`);
  assert.ok(facts.headings.length <= 40, `headings length ${facts.headings.length} should be capped at 40`);
  assert.ok(facts.landmarks.length <= 60, `landmarks length ${facts.landmarks.length} should be capped at 60`);
});

test('a malformed page still yields facts instead of throwing', () => {
  const malformed = '<html><body><h1>Unclosed heading<p>Some <b>text</b'; // truncated, unbalanced
  assert.doesNotThrow(() => htmlFacts(malformed));
  const facts = htmlFacts(malformed);
  assert.equal(typeof facts.text, 'string');
  assert.ok(Array.isArray(facts.headings));
});

test('decodeEntities: numeric (decimal and hex) and the common named entities decode correctly', () => {
  const facts = htmlFacts('<html><head><title>Caf&#233; &mdash; &ldquo;best&rdquo; &amp; &#x2013; fresh&hellip; &copy;2026 &rsquo;tis</title></head><body></body></html>');
  assert.equal(facts.title, 'Café — “best” & – fresh… ©2026 ’tis');
});

test('decodeEntities: a double-escaped entity (&amp;lt;) decodes to &lt; only, never all the way to <', () => {
  const facts = htmlFacts('<html><head><title>&amp;lt;script&amp;gt;</title></head><body></body></html>');
  assert.equal(facts.title, '&lt;script&gt;');
});

test('signals.scroll: plain body copy mentioning "scroll" is not a signal; scrollY/ScrollTrigger/scroll-timeline/onscroll are', () => {
  const plainCopy = htmlFacts('<html><body><p>Scroll down to see more of our work.</p></body></html>');
  assert.equal(plainCopy.signals.scroll, false, 'plain body copy is not a scroll-JS signal');

  for (const marker of ['window.scrollY', 'gsap.registerPlugin(ScrollTrigger)', 'animation-timeline: scroll-timeline;', 'window.onscroll = fn;']) {
    const facts = htmlFacts(`<html><body><script>${marker}</script></body></html>`);
    assert.equal(facts.signals.scroll, true, `${marker} should set signals.scroll`);
  }
});

test('a page with no matching signals reports every signal false and empty collections', () => {
  const facts = htmlFacts('<html><head><title>Plain</title></head><body><p>Just text.</p></body></html>');
  assert.equal(facts.title, 'Plain');
  assert.deepEqual(facts.headings, []);
  assert.deepEqual(facts.counts, { video: 0, canvas: 0, svg: 0, img: 0, form: 0, iframe: 0 });
  assert.deepEqual(facts.fonts, []);
  for (const value of Object.values(facts.signals)) assert.equal(value, false);
});
