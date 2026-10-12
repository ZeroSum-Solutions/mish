import { describe, expect, it } from 'vitest';

import { parseSectionCatalogResponse, type SectionCatalogEntry } from '../src/api/section-catalog.js';
import type {
  MotionSitesCatalogResponse,
  MotionSitesConnectionStatusDto,
  MotionSitesPaidAccessRequiredDetails,
  MotionSitesStartingPoint,
  MotionSitesStartingPointsResponse,
} from '../src/api/motionsites.js';

function motionSitesEntry(): SectionCatalogEntry {
  return {
    id: 'motionsites-prompt:fixture-hero-01',
    title: 'Fixture Aurora Hero',
    sourceKind: 'motionsites-prompt',
    sectionKind: 'hero',
    sourceType: 'Hero',
    spineAffinities: 'any',
    rights: { license: 'proprietary', decision: 'metadata-only', evidence: 'no redistribution grant' },
    access: 'free-account',
    availability: 'reference-only',
    preview: { kind: 'external-link', url: 'https://motionsites.ai/?prompt=fixture-hero-01' },
    content: { kind: 'motion-prompt', remoteId: 'fixture-hero-01', url: 'https://motionsites.ai/?prompt=fixture-hero-01' },
  };
}

describe('MotionSitesCatalogResponse', () => {
  // NIT (delta audit): this used to be a bare `type MotionSitesCatalogResponse = SectionCatalogResponse`
  // alias — it is now its own DTO (`connection` required, `upstream` optional), but its `catalog`
  // field still carries exactly `SectionCatalogResponse`'s shape, so `parseSectionCatalogResponse`
  // (which only inspects `value.catalog`) keeps validating it without a parallel parser.
  it('carries a distinct connection field, and a normalized MotionSites entry still round-trips through parseSectionCatalogResponse', () => {
    const response: MotionSitesCatalogResponse = {
      catalog: { schema: 'section-catalog/1', entries: [motionSitesEntry()] },
      connection: 'connected',
    };
    expect(parseSectionCatalogResponse(response)).toBe(response);
  });

  it('accepts an empty entries array for a signed-out request (never an error)', () => {
    const response: MotionSitesCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [] }, connection: 'not_connected' };
    expect(() => parseSectionCatalogResponse(response)).not.toThrow();
  });

  it('omits upstream entirely for the ordinary not-connected/expired case', () => {
    const response: MotionSitesCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [] }, connection: 'not_connected' };
    expect('upstream' in response).toBe(false);
  });

  it('carries a structured upstream field only when the federated half degraded from an upstream failure', () => {
    const response: MotionSitesCatalogResponse = {
      catalog: { schema: 'section-catalog/1', entries: [] },
      connection: 'connected',
      upstream: { code: 'MOTIONSITES_UPSTREAM_UNAVAILABLE', message: 'could not reach https://motionsites.ai/mcp: fetch failed' },
    };
    expect(() => parseSectionCatalogResponse(response)).not.toThrow();
    expect(response.upstream!.code).toBe('MOTIONSITES_UPSTREAM_UNAVAILABLE');
  });
});

describe('MotionSitesConnectionStatusDto', () => {
  it('accepts every connection status', () => {
    for (const status of ['not_connected', 'connected', 'expired'] as const) {
      const dto: MotionSitesConnectionStatusDto = { status };
      expect(dto.status).toBe(status);
    }
  });
});

describe('MotionSitesStartingPoint', () => {
  it('carries only title/category/spineAffinity/url — no image or remix-target fields', () => {
    const point: MotionSitesStartingPoint = {
      id: 'f6cafabe-f404-44bd-a631-685e7bc8610a',
      title: 'Agency Template',
      category: 'Agency',
      spineAffinity: ['TL'],
      url: 'https://motionsites.ai/templates#f6cafabe-f404-44bd-a631-685e7bc8610a',
    };
    expect(Object.keys(point).sort()).toEqual(['category', 'id', 'spineAffinity', 'title', 'url']);
  });

  it('allows category to be omitted and spineAffinity to be "unclassified"', () => {
    const point: MotionSitesStartingPoint = {
      id: 'x',
      title: 'Glow',
      spineAffinity: 'unclassified',
      url: 'https://motionsites.ai/templates#x',
    };
    const response: MotionSitesStartingPointsResponse = { startingPoints: [point] };
    expect(response.startingPoints).toHaveLength(1);
  });
});

describe('MotionSitesPaidAccessRequiredDetails', () => {
  it('names the prompt and links only to the real MotionSites pricing page', () => {
    const details: MotionSitesPaidAccessRequiredDetails = {
      kind: 'motionsites-paid-access-required',
      promptId: 'dreamcore-landing',
      upgradeUrl: 'https://motionsites.ai/unlimited',
    };
    expect(details.upgradeUrl).toBe('https://motionsites.ai/unlimited');
  });
});
