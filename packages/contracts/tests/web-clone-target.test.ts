import { describe, expect, it } from 'vitest';

import { extractWebCloneTargetUrl, extractWebCloneTargetUrls } from '../src/api/web-clone-target';

describe('extractWebCloneTargetUrls', () => {
  it('reads nothing from a brief that names no address', () => {
    expect(extractWebCloneTargetUrls('Website URL to clone: not a url')).toEqual([]);
    expect(extractWebCloneTargetUrls('Website URL to clone: ')).toEqual([]);
    expect(extractWebCloneTargetUrls('ftp://example.com/')).toEqual([]);
    expect(extractWebCloneTargetUrls('mail me at a@b.com')).toEqual([]);
  });

  it('reads an explicit URL and a bare domain', () => {
    expect(extractWebCloneTargetUrls('clone https://github.com/ZeroSum-Solutions please.')).toEqual(['https://github.com/ZeroSum-Solutions/']);
    expect(extractWebCloneTargetUrls('想要复刻的网站链接：stripe.com')).toEqual(['https://stripe.com/']);
    expect(extractWebCloneTargetUrl('Website URL to clone: example.com/about')).toBe('https://example.com/about');
  });

  it('collects every address in the brief, not only the first', () => {
    expect(extractWebCloneTargetUrls('see https://example.com then clone http://localhost:3000')).toEqual([
      'https://example.com/',
      'http://localhost:3000/',
    ]);
    expect(extractWebCloneTargetUrls('clone example.com, styled like http://10.0.0.5/admin')).toEqual([
      'http://10.0.0.5/admin',
      'https://example.com/',
    ]);
  });

  it('does not read a URL query or path as another host', () => {
    expect(extractWebCloneTargetUrls('https://example.com/?next=evil.com')).toEqual([
      'https://example.com/?next=evil.com',
    ]);
  });

  it('does not read either side of an email address as a host', () => {
    expect(extractWebCloneTargetUrls('Clone stripe.com, email me at jane.doe@acme.com')).toEqual([
      'https://stripe.com/',
    ]);
  });

  it('does not take file names for domains', () => {
    expect(extractWebCloneTargetUrls('see file.txt')).toEqual([]);
    expect(extractWebCloneTargetUrls('unpack my.site.zip and index.html, logo.png, data.json, README.md, app.js, site.css')).toEqual([]);
  });

  it('keeps a closing parenthesis the URL opened, and drops sentence punctuation', () => {
    expect(extractWebCloneTargetUrls('clone https://en.wikipedia.org/wiki/Foo_(bar).')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
    expect(extractWebCloneTargetUrls('(see https://example.com/pricing).')).toEqual([
      'https://example.com/pricing',
    ]);
  });
});
