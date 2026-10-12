import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchAntigravityOauth } from '../../src/providers/daemon';

afterEach(() => { vi.unstubAllGlobals(); });

describe('OAuth terminal launch error response', () => {
  it.each([
    { error: { code: 'INTERNAL_ERROR', message: 'internal server error' } },
    { ok: false, error: 'internal server error' },
  ])('returns a string message from the daemon error contract or legacy response', async (body) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    expect(await launchAntigravityOauth()).toEqual({ ok: false, error: 'internal server error' });
  });
});
