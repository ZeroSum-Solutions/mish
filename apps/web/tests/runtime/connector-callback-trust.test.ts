import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTOR_CALLBACK_MESSAGE_TYPE,
  createConnectorCallbackNonce,
  isTrustedConnectorCallbackMessage,
  resetConnectorCallbackNonces,
} from '../../src/runtime/connector-callback-trust';

const APP = 'http://127.0.0.1:60809';
const message = (origin: string, data: unknown) => ({ origin, data });

afterEach(() => {
  resetConnectorCallbackNonces();
  vi.useRealTimers();
});

describe('isTrustedConnectorCallbackMessage', () => {
  it('keeps trusting the app and loopback daemon origins', () => {
    const data = { type: CONNECTOR_CALLBACK_MESSAGE_TYPE };
    expect(isTrustedConnectorCallbackMessage(message(APP, data), APP)).toBe(true);
    expect(isTrustedConnectorCallbackMessage(message('http://localhost:60807', data), APP)).toBe(true);
    expect(isTrustedConnectorCallbackMessage(message('https://example.com', data), APP)).toBe(false);
  });

  it('trusts an opaque-origin callback only with a nonce this window created', () => {
    const nonce = createConnectorCallbackNonce();
    const type = CONNECTOR_CALLBACK_MESSAGE_TYPE;
    expect(isTrustedConnectorCallbackMessage(message('null', { type, callbackNonce: nonce }), APP)).toBe(true);
    expect(isTrustedConnectorCallbackMessage(message('null', { type }), APP)).toBe(false);
    expect(isTrustedConnectorCallbackMessage(
      message('null', { type, callbackNonce: 'abcdefabcdefabcdefabcdef' }),
      APP,
    )).toBe(false);
    // A real foreign origin never passes on a stolen nonce.
    expect(isTrustedConnectorCallbackMessage(
      message('https://example.com', { type, callbackNonce: nonce }),
      APP,
    )).toBe(false);
    expect(isTrustedConnectorCallbackMessage(message('null', { type: 'other', callbackNonce: nonce }), APP))
      .toBe(false);
  });

  it('expires nonces of abandoned flows', () => {
    vi.useFakeTimers();
    const nonce = createConnectorCallbackNonce();
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(isTrustedConnectorCallbackMessage(
      message('null', { type: CONNECTOR_CALLBACK_MESSAGE_TYPE, callbackNonce: nonce }),
      APP,
    )).toBe(false);
  });
});
