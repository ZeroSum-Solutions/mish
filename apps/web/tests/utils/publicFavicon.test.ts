import { describe, expect, it } from 'vitest';

import { BRAND_REFERENCES, brandFaviconUrl } from '../../src/runtime/brand-references';
import { publicFaviconHost, publicFaviconUrl } from '../../src/utils/publicFavicon';

// Audit L8: the favicon service received a project name as a "domain", which
// leaked the name to a third party. Only a real public hostname may reach it.
describe('publicFaviconHost', () => {
  it.each([
    'My dentist site',
    'acme',
    'atlas-tl-02-kit-warm-wellness-retail-dental-lang',
    '',
    '   ',
    'localhost',
    'http://localhost:3000/x',
    'printer.local',
    'api.internal',
    'https://10.0.0.1/admin',
    '192.168.1.20',
    'http://[::1]/',
    'file:///Users/me/page.html',
    'ftp://stripe.com/',
    'my site.com',
    'stripe.c0m',
    '-bad.com',
    // Letter-only TLD syntax is not proof of a public hostname (review of L8).
    'client-project.test',
    'secret-client.example',
    'https://acme.example/',
    'client.notarealtld',
    'foo.home.arpa',
    'router.home',
    'files.corp',
    // Punycode (IDN) labels are refused outright: whether a runtime's URL
    // parser validates them differs between Node/ICU and browser builds.
    'xn--a.com',
    'a.xn--zz',
    'xn--bcher-kva.com',
    'https://bücher.com/',
    // Only delegated ccTLDs; unassigned two-letter codes and unlisted
    // punycode TLDs never reach the favicon service.
    'client.zz',
    'client.aa',
    'client.xx',
    'client.qz',
    'client.xn--bcher-kva',
    'shop.xn--p1ai',
  ])('rejects %j', (input) => {
    expect(publicFaviconHost(input)).toBeNull();
    expect(publicFaviconUrl(input, 64)).toBeNull();
  });

  it('rejects missing input', () => {
    expect(publicFaviconHost(undefined)).toBeNull();
    expect(publicFaviconHost(null)).toBeNull();
  });

  it.each([
    ['https://stripe.com/x', 'stripe.com'],
    ['http://www.linear.app', 'www.linear.app'],
    ['https://styles.refero.design/', 'styles.refero.design'],
    ['stripe.com', 'stripe.com'],
    ['Stripe.COM/pricing', 'stripe.com'],
    ['https://acme.co.uk/about', 'acme.co.uk'],
    ['stripe.co.uk', 'stripe.co.uk'],
    ['example.de', 'example.de'],
    ['foo.io', 'foo.io'],
    ['shop.qa', 'shop.qa'],
    ['europa.eu', 'europa.eu'],
    ['nic.ac', 'nic.ac'],
    ['https://godly.website/', 'godly.website'],
    ['bright-smile.dental', 'bright-smile.dental'],
  ])('accepts %j as %j', (input, host) => {
    expect(publicFaviconHost(input)).toBe(host);
  });

  it('builds the favicon service URL only from the parsed hostname', () => {
    expect(publicFaviconUrl('https://stripe.com/x?secret=1', 128)).toBe(
      'https://www.google.com/s2/favicons?sz=128&domain=stripe.com',
    );
  });

  it('accepts every curated brand reference domain', () => {
    for (const brand of BRAND_REFERENCES) {
      expect(publicFaviconHost(brand.domain), brand.domain).toBe(brand.domain);
    }
  });
});

describe('brandFaviconUrl', () => {
  it('routes curated domains through the public-hostname gate', () => {
    expect(brandFaviconUrl('stripe.com', 64)).toBe(
      'https://www.google.com/s2/favicons?sz=64&domain=stripe.com',
    );
    expect(brandFaviconUrl('client.notarealtld', 64)).toBeNull();
    expect(brandFaviconUrl('My dentist site', 64)).toBeNull();
  });
});
