import { describe, expect, it } from 'vitest';
import {
  API_TOKEN_BASIC_USERNAME,
  apiTokenAuthorizationMatches,
} from '../src/api-token-auth.js';

const TOKEN = 'correct-horse-battery-staple';
const basic = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('apiTokenAuthorizationMatches', () => {
  it('accepts a Bearer token, case-insensitive scheme, tab or space separators', () => {
    expect(apiTokenAuthorizationMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(apiTokenAuthorizationMatches(`bEaReR\t ${TOKEN} \t`, TOKEN)).toBe(true);
    expect(apiTokenAuthorizationMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches('Bearer', TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches('Bearer   ', TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches(`Bearer a ${TOKEN}`, TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches(`Bearerx ${TOKEN}`, TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches(`Bearer${TOKEN}`, TOKEN)).toBe(false);
  });

  it('accepts Basic credentials for the mish user only', () => {
    expect(apiTokenAuthorizationMatches(basic(API_TOKEN_BASIC_USERNAME, TOKEN), TOKEN)).toBe(true);
    expect(apiTokenAuthorizationMatches(`basic\t${basic('mish', TOKEN).slice(6)}  `, TOKEN)).toBe(true);
    expect(apiTokenAuthorizationMatches(basic('root', TOKEN), TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches(basic('mish', 'wrong'), TOKEN)).toBe(false);
  });

  it('rejects malformed Basic payloads and non-strings', () => {
    const good = basic('mish', TOKEN).slice(6);
    expect(apiTokenAuthorizationMatches(`Basic ${good.slice(0, -1)}`, TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches(`Basic ${good}=`, TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches('Basic !!!!', TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches(`Basic ${Buffer.from('no-colon').toString('base64')}`, TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches(undefined, TOKEN)).toBe(false);
    expect(apiTokenAuthorizationMatches(`Bearer ${TOKEN}`, '')).toBe(false);
  });

  it('rejects adversarial blank runs in linear time (js/polynomial-redos)', () => {
    const blanks = '\t'.repeat(200_000);
    const cases = [
      `basic\t${blanks}!`,
      `Basic ${blanks}${'A'.repeat(7)}`,
      `bearer\t${blanks}`,
      `Bearer ${blanks} x ${blanks}`,
      `Basic ${'AAAA'.repeat(50_000)}A`,
      `Basic ${' \t'.repeat(100_000)}=`,
    ];
    const started = performance.now();
    for (const value of cases) {
      expect(apiTokenAuthorizationMatches(value, TOKEN)).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
