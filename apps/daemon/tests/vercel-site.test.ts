import { afterEach, describe, expect, it, vi } from 'vitest';
import * as contracts from '@open-design/contracts';

afterEach(() => vi.unstubAllGlobals());

describe('Vercel site names', () => {
  it.each(['bobs-bakery', 'a', '9-site', 'a'.repeat(63)])('accepts a DNS-compatible Vercel name %s', (name) => {
    expect(contracts.validateVercelProjectName(name)).toEqual({ valid: true });
  });
  it.each(['', 'A-site', '-site', 'site-', 'a---b', 'a.b', 'a_b', 'a'.repeat(64), 'a'.repeat(101), 'www', 'api', 'vercel', 'admin'])('rejects %s', (name) => {
    expect(contracts.validateVercelProjectName(name).valid).toBe(false);
  });
  it('makes a valid project-name default and a bounded suggestion', () => {
    expect(contracts.vercelSiteNameSuggestion("Bob’s Bakery")).toBe('bobs-bakery');
    expect(contracts.validateVercelProjectName(contracts.vercelSiteNameSuggestion('a'.repeat(63), '2')).valid).toBe(true);
  });
});
