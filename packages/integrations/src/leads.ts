import { randomUUID } from 'node:crypto';
import { LEAD_KINDS, type LeadKind, type LeadPayload } from './events.ts';

export type LeadResult = { payload: LeadPayload } | { error: 'email' | 'name' } | { spam: true };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const isKind = (value: unknown): value is LeadKind => (LEAD_KINDS as readonly unknown[]).includes(value);

/**
 * A submitted site form (contact, commission, trade, appointment, or an email-only signup) as a
 * `lead.created` payload. Returns `{ error }` naming the bad field, or `{ spam: true }` when the hidden
 * "website" field, which people never see, was filled in: drop those quietly.
 *
 * A signup asks for an email alone and is itself the opt-in. Any other form opts in only when
 * `accepts_marketing` is exactly `true`.
 */
export function leadFromForm(form: Record<string, unknown> | null | undefined): LeadResult {
  if (text(form?.website, 10)) return { spam: true };
  const email = text(form?.email, 200).toLowerCase();
  if (!EMAIL.test(email)) return { error: 'email' };
  const signup = form?.kind === 'signup';
  const name = text(form?.name, 200);
  if (!name && !signup) return { error: 'name' };
  const id = randomUUID();
  return {
    payload: {
      lead_id: id,
      source_ref: id,
      kind: isKind(form?.kind) ? form.kind : 'contact',
      email,
      name,
      phone: text(form?.phone, 40),
      message: text(form?.message, 5000),
      page: text(form?.page, 300),
      accepts_marketing: signup || form?.accepts_marketing === true,
    },
  };
}
