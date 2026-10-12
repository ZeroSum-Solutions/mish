import { describe, expect, it } from 'vitest';

import { parseGenuiCatalogResponse, type GenuiCatalogResponse } from '../src/api/genui-catalog.js';

function validEntry() {
  return {
    id: 'glare-hover',
    name: 'Glare Hover',
    category: 'hover',
    source: { name: 'react-bits', component: 'GlareHover', license: 'MIT', category: 'Animations', description: '', dependencies: '' },
    sourceUrl: 'https://example.test/glare-hover',
    licenceDecision: 'clean-room',
    verdict: 'keep',
    rationale: 'keep',
    tier: 1,
    tierNote: 'Tier 1',
    portDifficulty: 'Easy',
    status: 'ported',
  };
}

function validResponse(): GenuiCatalogResponse {
  return {
    catalog: {
      schema: 'genui-catalog/1',
      components: [validEntry() as never],
    },
  };
}

describe('parseGenuiCatalogResponse', () => {
  it('returns the value unchanged for a valid response', () => {
    const response = validResponse();
    expect(parseGenuiCatalogResponse(response)).toBe(response);
  });

  it('accepts a null tier', () => {
    const response = validResponse();
    (response.catalog.components[0] as { tier: unknown }).tier = null;
    expect(() => parseGenuiCatalogResponse(response)).not.toThrow();
  });

  it('throws naming the top-level path when the value is not an object', () => {
    expect(() => parseGenuiCatalogResponse(null)).toThrow('catalog response must be an object');
    expect(() => parseGenuiCatalogResponse('nope')).toThrow('catalog response must be an object');
  });

  it('throws naming the path when catalog is missing or not an object', () => {
    expect(() => parseGenuiCatalogResponse({})).toThrow('catalog.catalog must be an object');
  });

  it('throws naming the path when catalog.schema is wrong', () => {
    const response = validResponse();
    (response.catalog as { schema: string }).schema = 'genui-catalog/2';
    expect(() => parseGenuiCatalogResponse(response)).toThrow('catalog.schema must be "genui-catalog/1"');
  });

  it('throws naming the path when catalog.components is not an array', () => {
    expect(() =>
      parseGenuiCatalogResponse({ catalog: { schema: 'genui-catalog/1', components: 'x' } }),
    ).toThrow('catalog.components must be an array');
  });

  it('throws naming the failing entry field, e.g. catalog.components[0].status', () => {
    const response = validResponse();
    (response.catalog.components[0] as { status: unknown }).status = 'nope';
    expect(() => parseGenuiCatalogResponse(response)).toThrow('catalog.components[0].status is invalid');
  });

  it('throws naming the failing entry index for a bad category', () => {
    const response = validResponse();
    response.catalog.components.push(validEntry() as never);
    (response.catalog.components[1] as { category: unknown }).category = 'not-a-category';
    expect(() => parseGenuiCatalogResponse(response)).toThrow('catalog.components[1].category is invalid');
  });

  it('throws naming the failing entry field for a missing source sub-field', () => {
    const response = validResponse();
    (response.catalog.components[0] as { source: { license: unknown } }).source.license = 123;
    expect(() => parseGenuiCatalogResponse(response)).toThrow('catalog.components[0].source.license must be a string');
  });
});
