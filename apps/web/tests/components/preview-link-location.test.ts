import { describe, expect, it } from 'vitest';
import {
  applyPreviewLinkLocationToSrc,
  sanitizePreviewLinkHash,
  sanitizePreviewLinkLocation,
  sanitizePreviewLinkSearch,
} from '../../src/components/preview-link-location';

describe('preview link location validation', () => {
  it.each([
    ['#work', '#work'],
    ['#section-2_a:b.c', '#section-2_a:b.c'],
    ['#', ''],
    ['', ''],
    ['work', ''],
    ['#a b', ''],
    ['#%E2%9C%93', '#%E2%9C%93'],
    ['#billing%20details', '#billing%20details'],
    ['#R%C3%A9sum%C3%A9', '#R%C3%A9sum%C3%A9'],
    ['#bad%2', ''],
    ['#bad%zz', ''],
    ['#%', ''],
    ['#"><img>', ''],
    [`#${'a'.repeat(255)}`, `#${'a'.repeat(255)}`],
    [`#${'a'.repeat(256)}`, ''],
    [42, ''],
    [null, ''],
  ])('hash %j -> %j', (input, expected) => {
    expect(sanitizePreviewLinkHash(input)).toBe(expected);
  });

  it.each([
    ['?tab=2', '?tab=2'],
    ['?a=1&b=%20x', '?a=1&b=%20x'],
    ['?', ''],
    ['', ''],
    ['tab=2', ''],
    ['?a=1#b', ''],
    ['?a=\u0000', ''],
    ['?a=\u007f', ''],
    [`?${'a'.repeat(1023)}`, `?${'a'.repeat(1023)}`],
    [`?${'a'.repeat(1024)}`, ''],
    [undefined, ''],
  ])('search %j -> %j', (input, expected) => {
    expect(sanitizePreviewLinkSearch(input)).toBe(expected);
  });

  it('validates each part on its own', () => {
    expect(sanitizePreviewLinkLocation({ search: '?a=1#x', hash: '#work' })).toEqual({ search: '', hash: '#work' });
    expect(sanitizePreviewLinkLocation({})).toEqual({ search: '', hash: '' });
  });
});

describe('applyPreviewLinkLocationToSrc', () => {
  const src = '/api/projects/p/raw/index.html?odPreviewBridge=scroll&odPreviewViewport=desktop';

  it('appends the query after the transport params and the fragment last', () => {
    expect(applyPreviewLinkLocationToSrc(src, { search: '?tab=2', hash: '#work' }))
      .toBe(`${src}&tab=2#work`);
  });

  it('starts a query when the src has none', () => {
    expect(applyPreviewLinkLocationToSrc('/raw/index.html', { search: '?tab=2', hash: '' }))
      .toBe('/raw/index.html?tab=2');
  });

  it('replaces an existing fragment', () => {
    expect(applyPreviewLinkLocationToSrc('/raw/index.html#old', { search: '', hash: '#work' }))
      .toBe('/raw/index.html#work');
  });

  it('leaves the src alone without a valid location or for a parked frame', () => {
    expect(applyPreviewLinkLocationToSrc(src, null)).toBe(src);
    expect(applyPreviewLinkLocationToSrc(src, { search: 'x', hash: 'y' })).toBe(src);
    expect(applyPreviewLinkLocationToSrc('about:blank', { search: '', hash: '#work' })).toBe('about:blank');
  });
});
