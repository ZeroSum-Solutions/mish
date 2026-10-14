import type { Destination, EventPayloads, EventType, IntegrationEvent } from '../events.ts';
import type { KlaviyoClient, KlaviyoPerson } from './client.ts';

export { createKlaviyoClient, type KlaviyoClient, type KlaviyoClientOptions, type KlaviyoPerson, type KlaviyoTrack } from './client.ts';

const E164 = /^\+[1-9]\d{7,14}$/;

interface Described {
  metric: string;
  properties: Record<string, unknown>;
  value?: number;
  currency?: string;
}

/**
 * What Klaviyo is told about each event: the metric it is filed under and the details flows can use.
 * The order metric is not "Placed Order" because Klaviyo's own Shopify connection already uses that name,
 * and a store with both would count every order twice.
 */
const KINDS: { [T in EventType]: (p: EventPayloads[T]) => Described } = {
  'lead.created': (p) => ({ metric: 'Submitted Form', properties: { kind: p.kind, message: p.message, page: p.page } }),
  'booking.created': (p) => ({
    metric: 'Booked Appointment',
    properties: { title: p.title, starts_at: p.starts_at, ends_at: p.ends_at, time_zone: p.timezone, location: p.location, notes: p.notes },
  }),
  'order.paid': (p) => ({
    metric: 'Paid Order',
    value: p.total_cents / 100,
    currency: p.currency.toUpperCase(),
    properties: {
      order_id: p.order_id,
      items: p.items.map((i) => ({ id: i.id, name: i.name, quantity: i.qty, price: i.unit_price_cents / 100 })),
      item_names: p.items.map((i) => i.name),
      subtotal: p.subtotal_cents / 100,
      discount: p.discount_cents / 100,
      shipping: p.shipping_cents / 100,
      tax: p.tax_cents / 100,
    },
  }),
};

export const KLAVIYO_TYPES = Object.keys(KINDS) as EventType[];

export interface KlaviyoOptions {
  client: KlaviyoClient;
  /** The list people who opted in join. Without one, nobody is subscribed. */
  listId?: string;
  /** False sends no activity and leaves only the list sign-up. */
  events?: boolean;
  /** Which events count, e.g. leave out `order.paid` where Klaviyo's Shopify connection already sends orders. */
  types?: EventType[];
}

function describe(event: IntegrationEvent): Described {
  // The event's type picks its payload; the table above is typed per type.
  return (KINDS[event.type] as (p: EventPayloads[EventType]) => Described)(event.payload);
}

function personOf(event: IntegrationEvent): KlaviyoPerson {
  const p = event.payload;
  const fullName = 'name' in p ? p.name : (p.ship_to?.name ?? '');
  const [first = '', ...rest] = String(fullName ?? '').trim().split(/\s+/);
  const phone = 'phone' in p && E164.test(p.phone || '') ? p.phone : '';
  const person: KlaviyoPerson = { email: p.email };
  if (first) person.first_name = first;
  if (rest.length) person.last_name = rest.join(' ');
  if (phone) person.phone_number = phone;
  return person;
}

/**
 * Keeps Klaviyo informed about each person: what they did, as an event automated emails can start from,
 * and who they are. People join the list only if they opted in to marketing; everyone else gets a profile
 * and their activity, and stays unsubscribed. Safe to run twice for the same event.
 */
export function createKlaviyo({ client, listId, events = true, types = KLAVIYO_TYPES }: KlaviyoOptions): Destination {
  return {
    name: 'klaviyo',
    types,
    async handle(event) {
      const p = event.payload;
      if (!p.email) return;
      if (events) {
        const { metric, properties, value, currency } = describe(event);
        await client.track({
          metric,
          uniqueId: `${event.source}:${event.type}:${p.source_ref}`,
          time: event.created_at,
          person: personOf(event),
          properties: { ...properties, source: event.source },
          value,
          currency,
        });
      }
      if (p.accepts_marketing && listId) await client.subscribe(listId, p.email);
    },
  };
}
