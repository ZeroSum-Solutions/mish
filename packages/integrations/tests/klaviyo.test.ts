/**
 * The Klaviyo destination: every form, booking and paid order becomes one Klaviyo event with the person's
 * name, repeats carry the same unique id, and only people who opted in are subscribed. The client tests pin
 * the request shapes Klaviyo's API documents (revision 2026-07-15).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { BookingPayload, IntegrationEvent, OrderPaidPayload } from '../src/events.ts';
import { createKlaviyo, createKlaviyoClient, type KlaviyoClient, type KlaviyoTrack } from '../src/klaviyo/index.ts';
import { leadFromForm } from '../src/leads.ts';

const AT = new Date('2026-10-09T05:50:00Z');
const FORM = { name: 'Dana Lee Park', email: 'dana@example.com', phone: '+13105550100', message: 'Do you resize rings?', kind: 'appointment', page: '/contact', accepts_marketing: false };
const BOOKING: BookingPayload = {
  booking_id: 42, source_ref: 'bk_abc', email: 'dana@example.com', name: 'Dana Lee Park', phone: '555-0100', title: 'Showroom visit',
  starts_at: '2026-10-12T18:00:00Z', ends_at: '2026-10-12T18:30:00Z', timezone: 'America/Los_Angeles', location: '1 Example Ave', notes: 'Engagement rings',
  accepts_marketing: false,
};
const order = (over: Partial<OrderPaidPayload> = {}): IntegrationEvent => ({ id: 3, type: 'order.paid', source: 'shopify', created_at: AT, payload: {
  order_id: 1001, source_ref: '555', email: 'dana@example.com', currency: 'usd', accepts_marketing: false, ship_to: { name: 'Dana Lee Park' },
  items: [{ id: 'r1', name: 'Signet Ring', qty: 1, unit_price_cents: 120000 }],
  subtotal_cents: 120000, discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: 120000, ...over,
} });
const lead = (form: Record<string, unknown>): IntegrationEvent => {
  const result = leadFromForm(form);
  assert.ok('payload' in result);
  return { id: 1, type: 'lead.created', source: 'site', created_at: AT, payload: result.payload };
};

function fakeKlaviyo() {
  const tracked: KlaviyoTrack[] = [];
  const subscribed: Array<[string, string]> = [];
  const client: KlaviyoClient = {
    get: async () => ({}),
    track: async (e) => { tracked.push(e); },
    subscribe: async (listId, email) => { subscribed.push([listId, email]); },
  };
  return { client, tracked, subscribed };
}

test('Klaviyo is told what each person did, with their name, whether or not they opted in', async () => {
  const fake = fakeKlaviyo();
  const k = createKlaviyo({ client: fake.client, listId: 'L1' });
  await k.handle(lead(FORM));
  await k.handle({ id: 2, type: 'booking.created', source: 'calcom', created_at: AT, payload: BOOKING });
  await k.handle(order());

  const [form, booking, paid] = fake.tracked;
  assert.ok(form && booking && paid);
  assert.deepEqual([form.metric, booking.metric, paid.metric], ['Submitted Form', 'Booked Appointment', 'Paid Order']);
  assert.deepEqual(form.person, { email: 'dana@example.com' }); // a form cannot change who the profile says this is
  assert.deepEqual([form.properties.name, form.properties.phone], ['Dana Lee Park', '+13105550100']);
  assert.deepEqual(booking.person, { email: 'dana@example.com', first_name: 'Dana', last_name: 'Lee Park' }); // "555-0100" is not a full number, so it is left out
  assert.deepEqual([form.properties.kind, form.properties.message, form.properties.source], ['appointment', 'Do you resize rings?', 'site']);
  assert.deepEqual([booking.properties.title, booking.properties.starts_at, booking.properties.time_zone], ['Showroom visit', '2026-10-12T18:00:00Z', 'America/Los_Angeles']);
  assert.deepEqual([paid.value, paid.currency, paid.properties.order_id, paid.properties.item_names], [1200, 'USD', 1001, ['Signet Ring']]);
  assert.deepEqual(paid.person, { email: 'dana@example.com', first_name: 'Dana', last_name: 'Lee Park' });
  assert.equal(paid.uniqueId, 'shopify:order.paid:555');
  assert.match(form.uniqueId, /^site:lead\.created:[0-9a-f-]{36}$/);
  assert.deepEqual(fake.subscribed, []); // nobody opted in
});

test('a form sets the profile name and phone only when the client turns that on', async () => {
  const fake = fakeKlaviyo();
  await createKlaviyo({ client: fake.client, formsSetProfile: true }).handle(lead(FORM));
  assert.deepEqual(fake.tracked[0]?.person, { email: 'dana@example.com', first_name: 'Dana', last_name: 'Lee Park', phone_number: '+13105550100' });
});

test('only people who opted in join the list, and a repeat gets the same unique id', async () => {
  const fake = fakeKlaviyo();
  const k = createKlaviyo({ client: fake.client, listId: 'L1' });
  const event = order({ accepts_marketing: true });
  await k.handle(event);
  await k.handle(event);
  assert.deepEqual(fake.subscribed, [['L1', 'dana@example.com'], ['L1', 'dana@example.com']]); // Klaviyo ignores the second
  assert.equal(fake.tracked[0]?.uniqueId, fake.tracked[1]?.uniqueId);

  const noList = fakeKlaviyo();
  await createKlaviyo({ client: noList.client }).handle(event);
  assert.deepEqual([noList.tracked.length, noList.subscribed.length], [1, 0]);
});

test('a signup reaches the list and the activity with just an email', async () => {
  const fake = fakeKlaviyo();
  await createKlaviyo({ client: fake.client, listId: 'L1' }).handle(lead({ kind: 'signup', email: 'New@Example.com', page: '/links' }));
  assert.deepEqual(fake.subscribed, [['L1', 'new@example.com']]);
  assert.deepEqual([fake.tracked[0]?.metric, fake.tracked[0]?.person, fake.tracked[0]?.properties.kind], ['Submitted Form', { email: 'new@example.com' }, 'signup']);
});

test('Klaviyo events can be switched off or limited to some kinds, and an event with no email is skipped', async () => {
  const off = fakeKlaviyo();
  await createKlaviyo({ client: off.client, listId: 'L1', events: false }).handle(order({ accepts_marketing: true }));
  assert.deepEqual([off.tracked.length, off.subscribed.length], [0, 1]);
  assert.deepEqual(createKlaviyo({ client: off.client, types: ['lead.created'] }).types, ['lead.created']);
  assert.deepEqual(createKlaviyo({ client: off.client }).types, ['lead.created', 'booking.created', 'order.paid']);

  const noEmail = fakeKlaviyo();
  await createKlaviyo({ client: noEmail.client, listId: 'L1' }).handle(order({ email: '', accepts_marketing: true }));
  assert.deepEqual([noEmail.tracked.length, noEmail.subscribed.length], [0, 0]);
});

function recorder(status: number, body: unknown = null) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(body == null ? null : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test('the Klaviyo client sends events and list sign-ups in the shapes its API documents', async () => {
  const { calls, fetch } = recorder(202);
  const client = createKlaviyoClient({ apiKey: 'pk_x', fetch });
  await client.track({
    metric: 'Paid Order', uniqueId: 'shopify:order.paid:555', time: '2026-10-09T05:50:00Z', person: { email: 'a@b.co', first_name: 'A' },
    properties: { order_id: 1001 }, value: 1200, currency: 'USD',
  });
  await client.subscribe('L1', 'a@b.co');

  const [event, signup] = calls;
  assert.ok(event && signup);
  assert.equal(event.url, 'https://a.klaviyo.com/api/events');
  const headers = event.init.headers as Record<string, string>;
  assert.deepEqual([headers.Authorization, headers.revision], ['Klaviyo-API-Key pk_x', '2026-07-15']);
  assert.deepEqual(event.body.data, { type: 'event', attributes: {
    properties: { order_id: 1001 }, time: '2026-10-09T05:50:00.000Z', unique_id: 'shopify:order.paid:555', value: 1200, value_currency: 'USD',
    metric: { data: { type: 'metric', attributes: { name: 'Paid Order' } } },
    profile: { data: { type: 'profile', attributes: { email: 'a@b.co', first_name: 'A' } } },
  } });
  assert.equal(signup.url, 'https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs');
  assert.equal(signup.body.data.relationships.list.data.id, 'L1');
  assert.deepEqual(signup.body.data.attributes.profiles.data[0].attributes, { email: 'a@b.co', subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } } });
});

test('a Klaviyo refusal surfaces as an error naming its status and detail, so the host retries', async () => {
  const { fetch } = recorder(403, { errors: [{ detail: 'API key is missing required scope events:write' }] });
  await assert.rejects(createKlaviyoClient({ apiKey: 'pk_x', fetch }).track({
    metric: 'Submitted Form', uniqueId: 'x', time: AT, person: { email: 'a@b.co' }, properties: {},
  }), /Klaviyo 403: API key is missing required scope events:write/);
  const bare = recorder(500);
  await assert.rejects(createKlaviyoClient({ apiKey: 'pk_x', fetch: bare.fetch }).subscribe('L1', 'a@b.co'), /Klaviyo 500: request failed/);
});
