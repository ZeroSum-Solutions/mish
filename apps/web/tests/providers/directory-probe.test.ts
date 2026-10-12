import { afterEach, expect, it, vi } from 'vitest';
import { dirExists } from '../../src/providers/registry';

afterEach(() => vi.unstubAllGlobals());

it.each([
  [{ exists: true }, true],
  [{ exists: false }, false],
  [{ exists: null, status: 'unknown', reason: 'timeout' }, null],
  [{ exists: null, status: 'unknown', reason: 'unavailable' }, null],
  [{}, null],
])('preserves directory probe certainty for %j', async (body, expected) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  expect(await dirExists('/reference')).toBe(expected);
});

it('returns cannot-verify when the daemon is unreachable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  expect(await dirExists('/reference')).toBeNull();
});
