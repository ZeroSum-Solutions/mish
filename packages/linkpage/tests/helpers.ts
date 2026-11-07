import assert from 'node:assert/strict';
import type { FetchFn, Llm, LlmRequest } from '../src/index.ts';

/** A fake network: the first route whose key starts the URL answers 200, anything else 404. */
export const net = (routes: Record<string, string>): FetchFn => async (input) => {
  const url = String(input);
  const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
  return hit ? new Response(hit[1], { status: 200 }) : new Response('', { status: 404 });
};

/** Like `net`, but a route must match the whole URL. */
export const exactNet = (routes: Record<string, string>): FetchFn => async (input) => {
  const url = String(input);
  return url in routes ? new Response(routes[url], { status: 200 }) : new Response('', { status: 404 });
};

/** A fake model that records its calls and always answers the same thing. */
export function fakeLlm(answer: unknown): Llm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return { calls, json: async (a) => (calls.push(a), answer) };
}

/** Narrows a value the test expects to exist. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  assert.ok(value !== null && value !== undefined, `${what} should exist`);
  return value;
}
