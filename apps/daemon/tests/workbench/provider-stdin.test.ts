import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { assertProviderStdinUsage, parseProviderStdin, readProviderStdin } from '../../src/workbench/provider-stdin.js';
it('reads only bounded strict transient provider input without echoing malformed secret data', async () => {
  const carrier = { protocol: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'test-private-key', requiresApiKey: true };
  expect(await readProviderStdin(Readable.from([JSON.stringify(carrier)]))).toEqual(carrier);
  for (const text of ['{"apiKey":"test-private-key"', JSON.stringify({ ...carrier, secretExtension: 'test-private-key' }), JSON.stringify({ ...carrier, apiKey: 'private'.repeat(3000) })]) {
    try { parseProviderStdin(text); throw new Error('accepted'); } catch (error) { expect(String(error)).not.toContain('test-private-key'); expect(String(error)).not.toContain('privateprivate'); }
  }
  await expect(readProviderStdin(Readable.from(['x'.repeat(16000), 'x'.repeat(1000)]))).rejects.toThrow('16384');
});
it('refuses stdin ownership conflicts and unsupported commands before reading input', () => {
  expect(() => assertProviderStdinUsage({ 'byok-provider-stdin': true, 'prompt-file': '-' }, 'start')).toThrow('both consume stdin');
  expect(() => assertProviderStdinUsage({ 'byok-provider-stdin': true }, 'steer')).toThrow('start and continue');
  expect(() => assertProviderStdinUsage({ 'byok-provider-stdin': true, 'prompt-file': 'prompt.txt' }, 'continue')).not.toThrow();
});
