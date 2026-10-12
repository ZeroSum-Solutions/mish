import { CONNECTOR_CALLBACK_NONCE_PATTERN } from '@mish/contracts';

export const CONNECTOR_CALLBACK_MESSAGE_TYPE = 'mish:connector-connected';

// A connector OAuth flow can take a while (provider login, MFA), so a nonce
// stays valid well past a typical consent screen.
const CONNECTOR_CALLBACK_NONCE_TTL_MS = 30 * 60 * 1000;
const pendingNonces = new Map<string, number>();

function pruneExpiredNonces(now = Date.now()): void {
  for (const [nonce, expiresAt] of pendingNonces) {
    if (expiresAt <= now) pendingNonces.delete(nonce);
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Create the nonce for one connector OAuth flow. The opener sends it with the
 * connect request; the daemon echoes it in the callback page's postMessage.
 */
export function createConnectorCallbackNonce(): string {
  pruneExpiredNonces();
  const nonce = randomNonce();
  pendingNonces.set(nonce, Date.now() + CONNECTOR_CALLBACK_NONCE_TTL_MS);
  return nonce;
}

/** Same origin, or a loopback daemon origin (packaged and dev ports differ). */
export function isTrustedConnectorCallbackOrigin(origin: string, currentOrigin?: string): boolean {
  const expectedOrigin = currentOrigin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  if (origin === expectedOrigin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]'
      || url.hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Whether a `message` event is a connector OAuth callback this window should
 * act on.
 *
 * Invariant: the callback page is reached by a cross-site navigation from the
 * provider, so the daemon renders it in an opaque-origin sandbox and its
 * message arrives with `origin === 'null'` — the same origin any sandboxed
 * preview has. A 'null'-origin message is therefore trusted only when it
 * echoes a nonce this window created for a pending flow. Messages from the
 * window's own or a loopback daemon origin keep working as before. Listeners
 * still re-read status from the daemon; the message is only a refresh signal,
 * with status polling and focus refresh as the fallback.
 */
export function isTrustedConnectorCallbackMessage(
  event: Pick<MessageEvent, 'origin' | 'data'>,
  currentOrigin?: string,
): boolean {
  const data = event.data as { type?: unknown; callbackNonce?: unknown } | null;
  if (!data || typeof data !== 'object' || data.type !== CONNECTOR_CALLBACK_MESSAGE_TYPE) return false;
  if (event.origin !== 'null') return isTrustedConnectorCallbackOrigin(event.origin, currentOrigin);
  const nonce = data.callbackNonce;
  if (typeof nonce !== 'string' || !CONNECTOR_CALLBACK_NONCE_PATTERN.test(nonce)) return false;
  const expiresAt = pendingNonces.get(nonce);
  return expiresAt !== undefined && expiresAt > Date.now();
}

/** Test-only: forget pending connector callback nonces. */
export function resetConnectorCallbackNonces(): void {
  pendingNonces.clear();
}
