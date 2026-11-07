import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_AUTH_PROVIDERS,
  NATIVE_OAUTH_STATE_PATTERN,
  isConnectorAuthProvider,
  parseNativeOAuthCallbackQuery,
} from '../src/api/connectors';

describe('native connector auth provider', () => {
  it('keeps composio and adds native', () => {
    expect(CONNECTOR_AUTH_PROVIDERS).toEqual(['local', 'none', 'oauth', 'composio', 'native']);
    expect(isConnectorAuthProvider('native')).toBe(true);
    expect(isConnectorAuthProvider('composio')).toBe(true);
    expect(isConnectorAuthProvider('basic')).toBe(false);
    expect(isConnectorAuthProvider(undefined)).toBe(false);
  });

  it('accepts only well-formed state values', () => {
    expect(NATIVE_OAUTH_STATE_PATTERN.test('a'.repeat(43))).toBe(true);
    expect(NATIVE_OAUTH_STATE_PATTERN.test('short')).toBe(false);
    expect(NATIVE_OAUTH_STATE_PATTERN.test(`${'a'.repeat(43)}&x=1`)).toBe(false);
  });
});

describe('parseNativeOAuthCallbackQuery', () => {
  const state = 'S'.repeat(43);
  it('reads state and code', () => {
    expect(parseNativeOAuthCallbackQuery({ state, code: 'abc.def*1' })).toEqual({ ok: true, state, code: 'abc.def*1' });
  });
  it('reports a provider denial without a code', () => {
    expect(parseNativeOAuthCallbackQuery({ state, error: 'access_denied', error_description: 'no' })).toEqual({ ok: false, reason: 'denied', state });
  });
  it('rejects a missing, repeated or malformed state or code', () => {
    expect(parseNativeOAuthCallbackQuery({ code: 'x' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parseNativeOAuthCallbackQuery({ state: 'bad state', code: 'x' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parseNativeOAuthCallbackQuery({ state, code: ['a', 'b'] })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parseNativeOAuthCallbackQuery({ state })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parseNativeOAuthCallbackQuery({ state, code: 'x'.repeat(2049) })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
