/**
 * `src/preview-url.ts` — the single rule the daemon parser, the catalog preview hydration and the
 * web card builder all apply to a preview URL before anything hands it to a browser. Its whole
 * value is that those three agree, so the cases are pinned here rather than in any one caller.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLIC_PREVIEW_URL_MAX_CHARS,
  isPublicPreviewUrl,
  publicPreviewUrlProblem,
} from '../src/preview-url.ts';

test('isPublicPreviewUrl: accepts an absolute https: URL', () => {
  assert.equal(isPublicPreviewUrl('https://cdn.test/urban.jpg'), true);
  assert.equal(isPublicPreviewUrl('https://cdn.test/a/b.mp4?v=2#t=1'), true);
  assert.equal(publicPreviewUrlProblem('https://cdn.test/urban.jpg'), undefined);
});

test('isPublicPreviewUrl: accepts a URL of exactly the maximum length', () => {
  const prefix = 'https://cdn.test/';
  const url = prefix + 'a'.repeat(PUBLIC_PREVIEW_URL_MAX_CHARS - prefix.length);
  assert.equal(url.length, PUBLIC_PREVIEW_URL_MAX_CHARS);
  assert.equal(isPublicPreviewUrl(url), true);
});

// `new URL` parses every scheme below, so only the protocol test refuses them.
test('isPublicPreviewUrl: refuses every non-https scheme, with "not-https" as the reason', () => {
  for (const url of ['http://cdn.test/a.jpg', 'data:image/png;base64,iVBORw0KGgo=', 'javascript:alert(1)', 'file:///etc/passwd']) {
    assert.equal(isPublicPreviewUrl(url), false, `${url} must not pass`);
    assert.equal(publicPreviewUrlProblem(url), 'not-https');
  }
});

test('isPublicPreviewUrl: refuses a relative or malformed URL', () => {
  for (const url of ['cdn.test/a.jpg', '/media/a.jpg', 'https://']) {
    assert.equal(isPublicPreviewUrl(url), false, `${url} must not pass`);
    assert.equal(publicPreviewUrlProblem(url), 'malformed');
  }
});

test('isPublicPreviewUrl: refuses a URL one character over the maximum', () => {
  const url = `https://cdn.test/${'a'.repeat(PUBLIC_PREVIEW_URL_MAX_CHARS)}`;
  assert.equal(isPublicPreviewUrl(url), false);
  assert.equal(publicPreviewUrlProblem(url), 'too-long');
});

test('isPublicPreviewUrl: refuses anything that is not a non-empty string', () => {
  for (const value of ['', null, undefined, 7, true, {}, ['https://cdn.test/a.jpg']]) {
    assert.equal(isPublicPreviewUrl(value), false, `${JSON.stringify(value) ?? String(value)} must not pass`);
    assert.equal(publicPreviewUrlProblem(value), 'not-a-string');
  }
});
