/**
 * Events a link page sends home (a view, a click, a signup), checked and written to the page's local
 * log. Pure of Express: the route hands in the parsed body, the slug from the address and a store.
 *
 * The signup form carries a hidden `website` field that people never fill in. A post that fills it is
 * a bot: it is answered as a success (so the bot learns nothing) and nothing is stored.
 */
import { parseLinkPageEvent } from '@mish/contracts';
import type { LinkPageEventResponse } from '@mish/contracts';
import type { LinkPageStore } from './store.js';

export const HONEYPOT_FIELD = 'website';

export type EventOutcome =
  | { ok: true; response: LinkPageEventResponse }
  | { ok: false; error: string };

export async function recordLinkPageEvent(
  store: Pick<LinkPageStore, 'appendEvent'>,
  slug: string,
  body: unknown,
  now: () => string = () => new Date().toISOString(),
): Promise<EventOutcome> {
  const raw = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!raw) return { ok: false, error: 'the event must be an object' };
  // The address decides the page; a slug in the body is ignored.
  const parsed = parseLinkPageEvent({ ...raw, slug }, now);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (typeof raw[HONEYPOT_FIELD] === 'string' && raw[HONEYPOT_FIELD].trim() !== '') {
    return { ok: true, response: { ok: true, stored: false } };
  }
  const stored = await store.appendEvent(slug, parsed.value);
  return { ok: true, response: { ok: true, stored } };
}
