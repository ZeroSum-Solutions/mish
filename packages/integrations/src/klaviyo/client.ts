const BASE = 'https://a.klaviyo.com/api';
const REVISION = '2026-07-15';

export interface KlaviyoPerson {
  email: string;
  first_name?: string;
  last_name?: string;
  /** E.164 only; Klaviyo rejects anything else. */
  phone_number?: string;
}

export interface KlaviyoTrack {
  metric: string;
  /** Klaviyo keeps one event per unique id for a person and metric, so a repeat changes nothing. */
  uniqueId: string;
  time: Date | string;
  person: KlaviyoPerson;
  properties: Record<string, unknown>;
  value?: number | undefined;
  currency?: string | undefined;
}

export interface KlaviyoClient {
  get(path: string): Promise<any>;
  track(event: KlaviyoTrack): Promise<void>;
  subscribe(listId: string, email: string): Promise<void>;
}

export interface KlaviyoClientOptions {
  /**
   * A Klaviyo private API key with the lists:write, profiles:write, subscriptions:write and events:write
   * scopes, plus lists:read, profiles:read and events:read for `get`, which only the check script uses.
   */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export function createKlaviyoClient({ apiKey, fetch = globalThis.fetch }: KlaviyoClientOptions): KlaviyoClient {
  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: REVISION,
    'Content-Type': 'application/vnd.api+json',
    Accept: 'application/vnd.api+json',
  };
  const fail = async (res: Response): Promise<never> => {
    const out = (await res.json().catch(() => ({}))) as { errors?: Array<{ detail?: string }> };
    throw new Error(`Klaviyo ${res.status}: ${out.errors?.[0]?.detail || 'request failed'}`);
  };
  const post = async (path: string, body: unknown): Promise<void> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) await fail(res);
  };

  return {
    async get(path) {
      const res = await fetch(`${BASE}${path}`, { headers });
      return res.ok ? res.json() : fail(res);
    },

    // Records something a person did, and fills in their name on the profile.
    track({ metric, uniqueId, time, person, properties, value, currency }) {
      return post('/events', { data: { type: 'event', attributes: {
        properties,
        time: new Date(time).toISOString(),
        unique_id: uniqueId,
        ...(value == null ? {} : { value, value_currency: currency }),
        metric: { data: { type: 'metric', attributes: { name: metric } } },
        profile: { data: { type: 'profile', attributes: person } },
      } } });
    },

    // Subscribing someone already on the list changes nothing. On a double opt-in list Klaviyo emails them a
    // confirmation and they only join once they click it.
    subscribe(listId, email) {
      return post('/profile-subscription-bulk-create-jobs', { data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: { profiles: { data: [{ type: 'profile', attributes: { email, subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } } } }] } },
        relationships: { list: { data: { type: 'list', id: listId } } },
      } });
    },
  };
}
