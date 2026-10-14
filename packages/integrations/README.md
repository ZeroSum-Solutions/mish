# @mish/integrations

Business integrations Mishmash sets up for client sites. The first piece is Klaviyo.

Everything speaks three standard events (`src/events.ts`):

| Event | Means |
|---|---|
| `lead.created` | Someone sent a site form: contact, commission, trade, appointment, or an email-only signup |
| `booking.created` | Someone booked a time |
| `order.paid` | An order was paid |

A **source** turns something that happened into one of these. A **destination** acts on it. Any source works
with any destination, so a client's new tool needs one new source or one new destination, never a pair.

| Piece | Kind | Entry |
|---|---|---|
| Site forms | Source | `@mish/integrations/leads` → `leadFromForm(form)` |
| Klaviyo | Destination | `@mish/integrations/klaviyo` → `createKlaviyo({ client, listId })` |

The host (the service that receives a client's forms, bookings and orders) stores each event once and
delivers it to each destination at least once, retrying failures. Destinations are written to be safe to
run twice. The host is not in this package yet.

## Klaviyo

For every form, booking and paid order it:

- **Records what the person did**, as a Klaviyo event with their name on the profile. Events are what
  automated emails ("flows") start from: a welcome after a form, a reminder before an appointment, a
  thank-you after an order.
- **Adds them to an email list**, only if they opted in to marketing (`accepts_marketing: true`). Someone
  who did not opt in still gets a profile and their activity, and stays unsubscribed.

| Event | Klaviyo metric | Details sent |
|---|---|---|
| `lead.created` | Submitted Form | `kind`, `message`, `page` |
| `booking.created` | Booked Appointment | `title`, `starts_at`, `ends_at`, `time_zone`, `location`, `notes` |
| `order.paid` | Paid Order, with its value | `order_id`, `items`, `item_names`, `subtotal`, `discount`, `shipping`, `tax` |

```ts
import { createKlaviyo, createKlaviyoClient } from '@mish/integrations/klaviyo';

const client = createKlaviyoClient({ apiKey });
createKlaviyo({ client, listId: 'AbC123' });
createKlaviyo({ client, listId, types: ['lead.created', 'booking.created'] }); // leave orders to Klaviyo's Shopify connection
createKlaviyo({ client, listId, events: false });                              // list sign-up only
```

Per client: a Klaviyo private API key and the id of the list. The key needs `lists:write`,
`profiles:write`, `subscriptions:write` and `events:write`; add `lists:read`, `profiles:read` and
`events:read` to run the check script:

```bash
KLAVIYO_API_KEY=… KLAVIYO_LIST_ID=… pnpm --filter @mish/integrations klaviyo-check
KLAVIYO_API_KEY=… KLAVIYO_LIST_ID=… pnpm --filter @mish/integrations klaviyo-check -- someone@example.com "Their Name"
```

The first changes nothing. The second sends a test form, booking and $1 order for that address, each twice,
and subscribes it; use only an address whose owner agreed.

### What Klaviyo does that is worth knowing

- A new subscriber is slow to show: about eight minutes in testing, while events showed within 30
  seconds. Do not treat an empty lookup straight after as a failure.
- On a double opt-in list, Klaviyo's default for a new list, the person is emailed a confirmation and joins
  only when they click it.
- Subscribing lifts an earlier unsubscribe for that address. That is right when the person has just opted in
  again, which is the only time this package subscribes anyone.
- Phone numbers are sent only in international format (+13105550100); Klaviyo rejects others.
- A Shopify store using Klaviyo's own Shopify connection already gets orders and buyers there. Pass `types`
  without `order.paid`, so this package covers what that connection cannot see: forms, bookings,
  link-in-bio signups and agent conversations. The order metric is "Paid Order", not "Placed Order", so the
  two never collide.

### Where this stands

Proven against a real Klaviyo account (single opt-in list, 2026-10-12): an opted-in sign-up delivered twice
produced one subscribed profile; a form, a booking and a paid order, each delivered twice, produced exactly
one event each, the order with its value, and set the name on the profile.

Still needed before a client gets value from it:

| Needed | State |
|---|---|
| A hosted service receiving each client's forms, bookings and orders, with stored events and retries | Not in this package yet |
| A real form on a real client page feeding it, end to end | Not run yet |
| The automated emails, built in Klaviyo off these events | Agency work per client |
| Double opt-in lists | Not tried |
| Text-message consent | Not handled |
| A privacy notice, a client data agreement and a retention period | Not written |

Not handled on purpose: unsubscribes (Klaviyo owns those) and building flows, which happens inside Klaviyo.
