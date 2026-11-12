/**
 * The standard events every integration speaks. A source (a site form, a booking tool, a store) turns
 * something that happened into one of these; a destination (a CRM, an email tool, accounting) acts on it.
 * Any source works with any destination, so adding a client's tool means writing one source or one
 * destination, never a pair.
 *
 * `source_ref` is the source's own id for the thing (form submission, booking uid, order id). Together with
 * the event type and source it identifies the event, so a destination can ignore one it has already handled.
 */

export interface LeadPayload {
  lead_id: string;
  source_ref: string;
  kind: LeadKind;
  email: string;
  /** Empty for an email-only signup. */
  name: string;
  phone: string;
  message: string;
  /** The page the form was on. */
  page: string;
  /** True only when the person ticked an opt-in, or signed up for the list itself. */
  accepts_marketing: boolean;
}

export const LEAD_KINDS = ['contact', 'commission', 'trade', 'appointment', 'signup'] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];

export interface BookingPayload {
  booking_id: string | number;
  source_ref: string;
  email: string;
  name: string;
  phone: string;
  title: string;
  /** ISO 8601. */
  starts_at: string;
  ends_at: string;
  /** The attendee's IANA time zone. */
  timezone: string;
  location: string;
  notes: string;
  accepts_marketing: boolean;
}

export interface OrderItem {
  id: string;
  name: string;
  qty: number;
  unit_price_cents: number;
}

/** A paid order. Every amount is in the smallest currency unit; total = subtotal - discount + shipping + tax. */
export interface OrderPaidPayload {
  order_id: string | number;
  source_ref: string;
  email: string;
  /** ISO 4217, any case. */
  currency: string;
  accepts_marketing: boolean;
  ship_to?: { name?: string };
  items: OrderItem[];
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
}

export interface EventPayloads {
  'lead.created': LeadPayload;
  'booking.created': BookingPayload;
  'order.paid': OrderPaidPayload;
}
export type EventType = keyof EventPayloads;

export type IntegrationEvent = {
  [T in EventType]: { id: string | number; type: T; source: string; created_at: Date | string; payload: EventPayloads[T] };
}[EventType];

/**
 * Something that acts on events. The host delivers each event at least once and retries a failed `handle`,
 * so `handle` must be safe to run twice for the same event.
 */
export interface Destination {
  name: string;
  /** The event types this destination wants. */
  types: EventType[];
  handle(event: IntegrationEvent): Promise<void>;
}
