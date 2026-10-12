/**
 * `dishonestLinks` (shared `sections.ts`): every `<a href>` on a rendered page must resolve to a
 * real in-page anchor or a real destination (http(s)/mailto/tel) — never an invented-looking
 * relative path implying a page this compiler never builds (the exact defect a review of a
 * sibling family's build found: invented "Privacy policy"/"Careers"/"New patient forms" links).
 *
 * Also proves storefront's and practice's own reference fixtures are honest end to end, now that
 * their footer links render as plain text rather than `href="#"` placeholders.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { dishonestLinks } from '../scripts/sections.ts';

test('dishonestLinks: an in-page anchor to a real id is honest', () => {
  const html = '<a href="#hero">Shop</a><section id="hero">x</section>';
  assert.deepEqual(dishonestLinks(html), []);
});

test('dishonestLinks: a real http(s), mailto or tel destination is honest', () => {
  const html = '<a href="https://shop.example.com/drop">Shop</a><a href="mailto:hi@example.com">Email</a><a href="tel:2065550148">Call</a>';
  assert.deepEqual(dishonestLinks(html), []);
});

test('dishonestLinks: a scheme with no address after it is flagged, not accepted as a real destination', () => {
  // The exact hole an independent audit found: `/^(https?:|mailto:|tel:)/i` matched the scheme
  // alone and let a bare "http:", "tel:" or "mailto:" href through as if it pointed anywhere.
  const html = '<a href="http:">Shop</a><a href="https:">Shop</a><a href="tel:">Call</a><a href="mailto:">Email</a>';
  assert.deepEqual(dishonestLinks(html), ['http:', 'https:', 'tel:', 'mailto:']);
});

test('dishonestLinks: an invented relative path implying a page that does not exist is flagged', () => {
  const html = '<a href="/careers">Careers</a><a href="/privacy-policy">Privacy policy</a><a href="/new-patient-forms">New patient forms</a>';
  assert.deepEqual(dishonestLinks(html), ['/careers', '/privacy-policy', '/new-patient-forms']);
});

test('dishonestLinks: a bare "#" or an anchor to an id that does not exist on the page is flagged', () => {
  const html = '<a href="#">Home</a><a href="#missing-section">Missing</a><section id="present">x</section>';
  assert.deepEqual(dishonestLinks(html), ['#', '#missing-section']);
});

test('dishonestLinks: never confused by an href-looking string inside a script, style or comment', () => {
  const html = '<style>/* href="/fake" */</style><script>const x = "href=\\"/also-fake\\"";</script><!-- href="/comment-fake" --><a href="#real">Real</a><section id="real">x</section>';
  assert.deepEqual(dishonestLinks(html), []);
});

test('storefront: the reference fixture, rendered, has no dishonest links', async () => {
  const dir = path.resolve(import.meta.dirname, '../../../examples/agency-storefront/compiler/scripts/families/storefront');
  const { validateStorefrontRecipe, renderStorefront } = await import(pathToFileURL(path.join(dir, 'render.ts')).href) as {
    validateStorefrontRecipe: (input: unknown) => unknown;
    renderStorefront: (recipe: unknown, paths: Record<string, string>) => string;
  };
  const fixture = JSON.parse(readFileSync(path.join(dir, 'reference.fixture.json'), 'utf8'));
  const html = renderStorefront(validateStorefrontRecipe(fixture), {});
  assert.deepEqual(dishonestLinks(html), []);
});

test('practice: the reference fixture, rendered, has no dishonest links', async () => {
  // Regression coverage for the exact defect this check's own docblock names: practice's header
  // nav once linked every item with a bare `href="#"` placeholder, and its footer once carried
  // invented nav labels ("Privacy policy", "New patient forms", "Careers") as free model text.
  const dir = path.resolve(import.meta.dirname, '../../../examples/agency-practice/compiler/scripts/families/practice');
  const { validatePracticeRecipe, renderPractice } = await import(pathToFileURL(path.join(dir, 'render.ts')).href) as {
    validatePracticeRecipe: (input: unknown) => unknown;
    renderPractice: (recipe: unknown, paths: Record<string, string>) => string;
  };
  const fixture = JSON.parse(readFileSync(path.join(dir, 'reference.fixture.json'), 'utf8'));
  const html = renderPractice(validatePracticeRecipe(fixture), {});
  assert.deepEqual(dishonestLinks(html), []);
});
