/**
 * Checks a client's Klaviyo key and list, and optionally runs one address through the real package.
 *
 *   pnpm --filter @mish/integrations klaviyo-check                                  key and list only; changes nothing
 *   pnpm --filter @mish/integrations klaviyo-check -- someone@example.com "Their Name"
 *       sends a test form, booking and $1 order for that address, each twice, sets that name on the
 *       profile, and subscribes the address to the list
 *
 * Reads KLAVIYO_API_KEY and KLAVIYO_LIST_ID from the environment. Klaviyo is slow to show a new subscriber
 * (about eight minutes in testing), so this waits up to 12. Only use an address whose owner agreed to it.
 */

import type { IntegrationEvent } from '../src/events.ts';
import { createKlaviyo, createKlaviyoClient } from '../src/klaviyo/index.ts';

const { KLAVIYO_API_KEY: apiKey, KLAVIYO_LIST_ID: listId } = process.env;
if (!apiKey || !listId) throw new Error('Set KLAVIYO_API_KEY and KLAVIYO_LIST_ID');
const client = createKlaviyoClient({ apiKey });
const [email, name = 'Test Person'] = process.argv.slice(2).filter((a) => a !== '--');

const list = (await client.get(`/lists/${listId}`)).data.attributes;
const doubleOptIn = list.opt_in_process === 'double_opt_in';
console.log(`List "${list.name}" found. Opt-in: ${doubleOptIn ? 'double (a confirmation email is sent first)' : 'single (joins straight away)'}.`);
if (!email) process.exit(0);

const run = `check-${Date.now()}`;
const status = async () => {
  const filter = encodeURIComponent(`equals(email,"${email}")`);
  const profile = (await client.get(`/profiles?filter=${filter}&additional-fields[profile]=subscriptions`)).data[0];
  const onList = (await client.get(`/lists/${listId}/profiles?filter=${filter}`)).data.length > 0;
  let events: string[] = [];
  if (profile) {
    try {
      const found = await client.get(`/events?filter=${encodeURIComponent(`equals(profile_id,"${profile.id}")`)}&include=metric&sort=-datetime`);
      const names = new Map<string, string>((found.included || []).map((m: any) => [m.id, m.attributes.name]));
      events = found.data.filter((e: any) => e.attributes.event_properties?.check_run === run)
        .map((e: any) => `${names.get(e.relationships.metric.data.id)}${e.attributes.event_properties.$value != null ? ` ($${e.attributes.event_properties.$value})` : ''}`);
    } catch (err) {
      events = [`cannot read events: ${(err as Error).message}`];
    }
  }
  return {
    name: profile ? `${profile.attributes.first_name || '-'} ${profile.attributes.last_name || '-'}` : null,
    consent: profile?.attributes.subscriptions?.email?.marketing?.consent ?? null,
    onList,
    events: events.sort(),
  };
};

console.log('Before:', JSON.stringify(await status()));
// Tag each test event so this run can pick its own out.
const tagged = { ...client, track: (e: Parameters<typeof client.track>[0]) => client.track({ ...e, properties: { ...e.properties, check_run: run } }) };
const klaviyo = createKlaviyo({ client: tagged, listId });
const at = new Date();
const tests: IntegrationEvent[] = [
  { id: 1, type: 'lead.created', source: 'check', created_at: at, payload: {
    lead_id: `${run}-lead`, source_ref: `${run}-lead`, kind: 'contact', email, name, phone: '', message: 'Test message from klaviyo-check.', page: '/check', accepts_marketing: true,
  } },
  { id: 2, type: 'booking.created', source: 'check', created_at: at, payload: {
    booking_id: 0, source_ref: `${run}-booking`, email, name, phone: '', title: 'Test appointment', starts_at: at.toISOString(), ends_at: at.toISOString(),
    timezone: 'UTC', location: '', notes: '', accepts_marketing: false,
  } },
  { id: 3, type: 'order.paid', source: 'check', created_at: at, payload: {
    order_id: 0, source_ref: `${run}-order`, email, currency: 'usd', accepts_marketing: false, ship_to: { name },
    items: [{ id: 'test', name: 'Test item', qty: 1, unit_price_cents: 100 }], subtotal_cents: 100, discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: 100,
  } },
];
// Each is delivered twice: repeats must not double up.
for (const event of tests) {
  await klaviyo.handle(event);
  await klaviyo.handle(event);
}
console.log('Klaviyo accepted a form, a booking and a $1 order, each sent twice. Waiting for them to show...');
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 30_000));
  const now = await status();
  console.log(`  ${((i + 1) / 2).toFixed(1)} min:`, JSON.stringify(now));
  if (now.events.length >= 3 && (now.onList || doubleOptIn)) break;
}
