// RED SPEC (C1-B, "Build on brand", docs/plans/2026-10-09-build-on-brand/spec.md).
//
// The acceptance gate for the shared contract C2 adds in
// `packages/contracts/src/api/build-on-brand.ts` and re-exports from the package index.
// Until it exists this file fails with "Failed to load url ../src/api/build-on-brand.js".
//
// What it pins:
// - A request carries a brief, a reference URL or both, a required design-system id, a
//   `useLibrary` toggle (default on), a page count of 3 to 5 and a target.
// - A reference URL is refused unless it is http(s), and it may not carry credentials.
// - The reference digest is structure-only: every string it can hold is a fixed enum value,
//   so no copy, alt text, image URL, path slug or host from the reference site can travel in it.
// - A plan names its pages, each page's sections by role and source, the library inserts, and
//   the kit binding.
import { describe, expect, it } from 'vitest';

import {
  BUILD_ON_BRAND_PAGE_COUNT_MAX,
  BUILD_ON_BRAND_PAGE_COUNT_MIN,
  BUILD_ON_BRAND_PAGE_ROLES,
  BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA,
  BUILD_ON_BRAND_SECTION_LAYOUTS,
  BUILD_ON_BRAND_SECTION_ROLES,
  BUILD_ON_BRAND_TARGETS,
  buildOnBrandPlanSchema,
  buildOnBrandReferenceDigestSchema,
  buildOnBrandRequestSchema,
  buildOnBrandResultSchema,
} from '../src/api/build-on-brand.js';

const KIT = 'neutral-product';
const BRIEF = 'A two-person physiotherapy clinic that treats running injuries.';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { brief: BRIEF, designSystemId: KIT, ...overrides };
}

function digest(): Record<string, unknown> {
  return {
    schema: BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA,
    nav: { itemCount: 4, hasCta: true },
    pages: [
      {
        role: 'home',
        sections: [
          { role: 'hero', layout: 'split' },
          { role: 'features', layout: 'grid-3', itemCount: 3 },
          { role: 'testimonials', layout: 'carousel', itemCount: 5 },
          { role: 'cta', layout: 'single-column' },
          { role: 'footer', layout: 'grid-4' },
        ],
      },
      { role: 'pricing', sections: [{ role: 'pricing', layout: 'grid-3', itemCount: 3 }, { role: 'faq', layout: 'list', itemCount: 6 }] },
    ],
  };
}

function plan(): Record<string, unknown> {
  return {
    pageCount: 3,
    useLibrary: true,
    target: BUILD_ON_BRAND_TARGETS[0],
    designSystem: {
      id: KIT,
      binding: { tokensStylesheet: 'tokens.css', componentsManifest: 'components.manifest.json' },
    },
    pages: [
      {
        role: 'home',
        file: 'index.html',
        sections: [
          { role: 'hero', source: 'kit' },
          { role: 'features', source: 'catalog', ref: 'hyperui:feature-grid-3' },
          { role: 'testimonials', source: 'library', ref: 'lib-item-1' },
          { role: 'footer', source: 'kit' },
        ],
      },
      { role: 'about', file: 'about.html', sections: [{ role: 'content', source: 'kit' }, { role: 'footer', source: 'kit' }] },
      { role: 'contact', file: 'contact.html', sections: [{ role: 'contact', source: 'kit' }, { role: 'footer', source: 'kit' }] },
    ],
    libraryInserts: [{ itemId: 'lib-item-1', page: 'index.html', role: 'testimonials' }],
    reference: { digest: digest() },
  };
}

/** Every string leaf of a value, with the key path it sits on. */
function stringLeaves(value: unknown, at = '$'): Array<{ at: string; value: string }> {
  if (typeof value === 'string') return [{ at, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => stringLeaves(item, `${at}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => stringLeaves(item, `${at}.${key}`));
  }
  return [];
}

describe('BuildOnBrandRequest', () => {
  it('accepts a brief alone, a reference URL alone, or both', () => {
    expect(buildOnBrandRequestSchema.safeParse(request()).success).toBe(true);
    expect(buildOnBrandRequestSchema.safeParse({ referenceUrl: 'https://example.com/', designSystemId: KIT }).success).toBe(true);
    expect(buildOnBrandRequestSchema.safeParse(request({ referenceUrl: 'http://example.com/studio' })).success).toBe(true);
  });

  it('refuses a request with neither a brief nor a reference URL, including a blank brief', () => {
    expect(buildOnBrandRequestSchema.safeParse({ designSystemId: KIT }).success).toBe(false);
    expect(buildOnBrandRequestSchema.safeParse({ brief: '   ', designSystemId: KIT }).success).toBe(false);
  });

  it('requires a design-system id', () => {
    expect(buildOnBrandRequestSchema.safeParse({ brief: BRIEF }).success).toBe(false);
    expect(buildOnBrandRequestSchema.safeParse({ brief: BRIEF, designSystemId: '' }).success).toBe(false);
    expect(buildOnBrandRequestSchema.safeParse({ brief: BRIEF, designSystemId: '  ' }).success).toBe(false);
  });

  it('refuses every reference URL that is not http(s), and URLs that carry credentials', () => {
    for (const referenceUrl of [
      'ftp://example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'example.com',
      '//example.com/',
      'https://user:secret@example.com/',
    ]) {
      expect(buildOnBrandRequestSchema.safeParse(request({ referenceUrl })).success, referenceUrl).toBe(false);
    }
  });

  it('defaults useLibrary to on and lets the caller turn it off', () => {
    const parsed = buildOnBrandRequestSchema.parse(request());
    expect(parsed.useLibrary).toBe(true);
    expect(buildOnBrandRequestSchema.parse(request({ useLibrary: false })).useLibrary).toBe(false);
  });

  it('bounds the page count to 3..5 and defaults inside that range', () => {
    expect(BUILD_ON_BRAND_PAGE_COUNT_MIN).toBe(3);
    expect(BUILD_ON_BRAND_PAGE_COUNT_MAX).toBe(5);
    for (const pageCount of [3, 4, 5]) {
      expect(buildOnBrandRequestSchema.parse(request({ pageCount })).pageCount).toBe(pageCount);
    }
    for (const pageCount of [0, 1, 2, 6, 3.5, '4']) {
      expect(buildOnBrandRequestSchema.safeParse(request({ pageCount })).success, String(pageCount)).toBe(false);
    }
    const fallback = buildOnBrandRequestSchema.parse(request()).pageCount;
    expect(fallback).toBeGreaterThanOrEqual(3);
    expect(fallback).toBeLessThanOrEqual(5);
  });

  it('carries a target from a closed set, with a default', () => {
    expect(BUILD_ON_BRAND_TARGETS.length).toBeGreaterThan(0);
    expect(BUILD_ON_BRAND_TARGETS).toContain(buildOnBrandRequestSchema.parse(request()).target);
    expect(buildOnBrandRequestSchema.safeParse(request({ target: 'not-a-target' })).success).toBe(false);
  });

  it('does not accept caller-supplied digest, plan or project fields', () => {
    // The daemon computes the digest and the plan; a caller cannot smuggle either in.
    expect(buildOnBrandRequestSchema.safeParse(request({ digest: digest() })).success).toBe(false);
    expect(buildOnBrandRequestSchema.safeParse(request({ plan: plan() })).success).toBe(false);
  });

  it('is re-exported from the package index', async () => {
    const index = await import('../src/index.js');
    expect(index).toHaveProperty('buildOnBrandRequestSchema');
    expect(index).toHaveProperty('buildOnBrandPlanSchema');
    expect(index).toHaveProperty('buildOnBrandReferenceDigestSchema');
  });

  it('adds DESIGN_SYSTEM_NOT_INSTALLED and REFERENCE_URL_REFUSED to the shared API error codes', async () => {
    const { API_ERROR_CODES } = await import('../src/errors.js');
    expect(API_ERROR_CODES).toContain('DESIGN_SYSTEM_NOT_INSTALLED');
    expect(API_ERROR_CODES).toContain('REFERENCE_URL_REFUSED');
  });
});

describe('reference digest is structure-only', () => {
  it('parses a structure digest', () => {
    expect(buildOnBrandReferenceDigestSchema.safeParse(digest()).success).toBe(true);
  });

  it('holds no free text: every string leaf is a fixed enum value', () => {
    const parsed = buildOnBrandReferenceDigestSchema.parse(digest());
    const allowed = new Set<string>([
      BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA,
      ...BUILD_ON_BRAND_PAGE_ROLES,
      ...BUILD_ON_BRAND_SECTION_ROLES,
      ...BUILD_ON_BRAND_SECTION_LAYOUTS,
    ]);
    for (const leaf of stringLeaves(parsed)) expect(allowed.has(leaf.value), leaf.at).toBe(true);
  });

  it('refuses copy, image, link and source fields at every level', () => {
    const forbidden = {
      text: 'Small-batch coffee since 1987',
      heading: 'Roasted in Portland',
      copy: 'Our story',
      title: 'Harbor & Pine',
      label: 'Shop now',
      alt: 'Two baristas',
      image: 'https://cdn.example.com/hero.jpg',
      images: ['https://cdn.example.com/hero.jpg'],
      src: 'https://cdn.example.com/hero.jpg',
      href: 'https://example.com/about',
      url: 'https://example.com/',
      path: '/our-roasts',
      host: 'example.com',
      html: '<h1>Hi</h1>',
    };
    for (const [key, value] of Object.entries(forbidden)) {
      const atRoot = { ...digest(), [key]: value };
      expect(buildOnBrandReferenceDigestSchema.safeParse(atRoot).success, `root.${key}`).toBe(false);

      const atNav = digest();
      atNav.nav = { ...(atNav.nav as object), [key]: value };
      expect(buildOnBrandReferenceDigestSchema.safeParse(atNav).success, `nav.${key}`).toBe(false);

      const atPage = digest();
      const pages = atPage.pages as Array<Record<string, unknown>>;
      pages[0] = { ...pages[0], [key]: value };
      expect(buildOnBrandReferenceDigestSchema.safeParse(atPage).success, `page.${key}`).toBe(false);

      const atSection = digest();
      const sections = (atSection.pages as Array<{ sections: Array<Record<string, unknown>> }>)[0]!.sections;
      sections[0] = { ...sections[0], [key]: value };
      expect(buildOnBrandReferenceDigestSchema.safeParse(atSection).success, `section.${key}`).toBe(false);
    }
  });

  it('refuses a role or layout that is not one of the fixed values', () => {
    const badRole = digest();
    (badRole.pages as Array<{ sections: Array<Record<string, unknown>> }>)[0]!.sections[0]!.role = 'Roasted in Portland';
    expect(buildOnBrandReferenceDigestSchema.safeParse(badRole).success).toBe(false);

    const badLayout = digest();
    (badLayout.pages as Array<{ sections: Array<Record<string, unknown>> }>)[0]!.sections[0]!.layout = 'hero with latte photo';
    expect(buildOnBrandReferenceDigestSchema.safeParse(badLayout).success).toBe(false);
  });
});

describe('BuildOnBrandPlan and result', () => {
  it('parses a plan with pages, sections by role and source, library inserts and the kit binding', () => {
    const parsed = buildOnBrandPlanSchema.parse(plan());
    expect(parsed.designSystem.id).toBe(KIT);
    expect(parsed.designSystem.binding.tokensStylesheet).toBe('tokens.css');
    expect(parsed.pages.map((page: { file: string }) => page.file)).toEqual(['index.html', 'about.html', 'contact.html']);
    expect(parsed.pages[0]!.sections.map((section: { role: string }) => section.role)).toEqual(['hero', 'features', 'testimonials', 'footer']);
    expect(parsed.libraryInserts).toEqual([{ itemId: 'lib-item-1', page: 'index.html', role: 'testimonials' }]);
  });

  it('keeps the page list inside 3..5 pages and equal to pageCount', () => {
    const tooFew = plan();
    tooFew.pages = (tooFew.pages as unknown[]).slice(0, 2);
    tooFew.pageCount = 2;
    expect(buildOnBrandPlanSchema.safeParse(tooFew).success).toBe(false);

    const mismatched = plan();
    mismatched.pageCount = 4;
    expect(buildOnBrandPlanSchema.safeParse(mismatched).success).toBe(false);
  });

  it('only allows kit, library and catalog as section sources', () => {
    const bad = plan();
    (bad.pages as Array<{ sections: Array<Record<string, unknown>> }>)[0]!.sections[0]!.source = 'reference';
    expect(buildOnBrandPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses library inserts when useLibrary is off', () => {
    const off = plan();
    off.useLibrary = false;
    expect(buildOnBrandPlanSchema.safeParse(off).success).toBe(false);
    off.libraryInserts = [];
    (off.pages as Array<{ sections: Array<Record<string, unknown>> }>)[0]!.sections[2] = { role: 'testimonials', source: 'kit' };
    expect(buildOnBrandPlanSchema.safeParse(off).success).toBe(true);
  });

  it('refuses a library insert that points at a page the plan does not have', () => {
    const bad = plan();
    bad.libraryInserts = [{ itemId: 'lib-item-1', page: 'missing.html', role: 'testimonials' }];
    expect(buildOnBrandPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('carries the reference digest under the same structure-only schema', () => {
    const leaky = plan();
    leaky.reference = { digest: { ...digest(), heading: 'Roasted in Portland' } };
    expect(buildOnBrandPlanSchema.safeParse(leaky).success).toBe(false);
  });

  it('answers a started build with project, conversation, run and plan', () => {
    const result = { projectId: 'p-1', conversationId: 'c-1', runId: 'r-1', plan: plan() };
    expect(buildOnBrandResultSchema.safeParse(result).success).toBe(true);
    const { runId: _omitted, ...withoutRun } = result;
    expect(buildOnBrandResultSchema.safeParse(withoutRun).success).toBe(false);
  });
});
