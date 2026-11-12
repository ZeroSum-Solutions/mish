/**
 * A site form becomes a lead.created payload: cleaned up, with the bad field named, bots dropped quietly,
 * and marketing consent taken only from an explicit opt-in or an email-only signup.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { leadFromForm } from '../src/leads.ts';

const FORM = { name: 'Dana Lee Park', email: ' Dana@Example.com ', phone: '555-0100', message: 'Do you resize rings?', kind: 'appointment', page: '/contact', accepts_marketing: true };

test('a form becomes a lead: cleaned up, with bad input named and bots dropped quietly', () => {
  const result = leadFromForm(FORM);
  assert.ok('payload' in result);
  const { payload } = result;
  assert.deepEqual([payload.email, payload.name, payload.kind, payload.accepts_marketing], ['dana@example.com', 'Dana Lee Park', 'appointment', true]);
  assert.equal(payload.lead_id, payload.source_ref);
  assert.deepEqual(leadFromForm({ ...FORM, email: 'nope' }), { error: 'email' });
  assert.deepEqual(leadFromForm({ ...FORM, name: ' ' }), { error: 'name' });
  assert.deepEqual(leadFromForm({ ...FORM, website: 'http://spam' }), { spam: true });
  assert.deepEqual(leadFromForm(null), { error: 'email' });
});

test('an unknown kind is a contact, and only a literal true opts in', () => {
  const other = leadFromForm({ ...FORM, kind: 'other', accepts_marketing: 'yes' });
  assert.ok('payload' in other);
  assert.deepEqual([other.payload.kind, other.payload.accepts_marketing], ['contact', false]);
});

test('a newsletter signup needs only an email and counts as opting in', () => {
  const result = leadFromForm({ kind: 'signup', email: 'New@Example.com', page: '/links' });
  assert.ok('payload' in result);
  assert.deepEqual([result.payload.kind, result.payload.email, result.payload.name, result.payload.accepts_marketing], ['signup', 'new@example.com', '', true]);
  assert.deepEqual(leadFromForm({ kind: 'contact', email: 'new@example.com' }), { error: 'name' });
});
