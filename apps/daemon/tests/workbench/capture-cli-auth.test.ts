import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkbenchCli } from '../../src/workbench-cli.js';

afterEach(() => vi.unstubAllGlobals());
const commands = [
  { name: 'capture', args: ['capture', 'list', '--project', 'p', '--json'], payload: { projectId: 'p', captures: [], nextCursor: null } },
  { name: 'unit', args: ['unit', 'list', '--json'], payload: { units: [] } },
  { name: 'draft-from-capture', args: ['draft-from-capture', 'list', '--project', 'p', '--json'], payload: { drafts: [] } },
];
const response = (payload: unknown) => new Response(JSON.stringify(payload));
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

describe('capture and reusable-unit CLI scoped credentials', () => {
  it.each(commands)('$name forwards automatic tokens only to the explicit issuing origin', async ({ args, payload }) => {
    const calls = vi.fn().mockImplementation(async () => response(payload)); vi.stubGlobal('fetch', calls);
    const destination = 'http://127.0.0.1:48123';
    for (const [issuer, expected] of [
      [undefined, undefined], ['http://127.0.0.1:48124', undefined], ['https://foreign.example', undefined],
      [destination, 'Bearer scoped-test-token'], [`${destination}/issuer-path`, 'Bearer scoped-test-token'],
    ] as const) {
      calls.mockClear();
      const env = { OD_DAEMON_URL: destination, OD_TOOL_TOKEN: 'scoped-test-token', ...(issuer ? { OD_TOOL_TOKEN_ISSUER_ORIGIN: issuer } : {}) };
      expect(await runWorkbenchCli([...args, '--daemon-url', destination], { env, write: () => {} })).toBe(0);
      const headers = calls.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers.authorization).toBe(expected);
      expect(calls.mock.calls[0]?.[1]?.redirect).toBe('error');
    }
    calls.mockClear();
    expect(await runWorkbenchCli([...args, '--daemon-url', 'https://foreign.example'], { env: { OD_DAEMON_URL: destination, OD_TOOL_TOKEN_ISSUER_ORIGIN: destination, OD_TOOL_TOKEN: 'scoped-test-token' }, write: () => {} })).toBe(0);
    expect((calls.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it.each(commands)('$name refuses real HTTP redirects without requesting the destination', async ({ args, payload }) => {
    let destinationRequests = 0;
    const destination = createServer((_req, res) => { destinationRequests++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); });
    const destinationUrl = await listen(destination);
    const issuer = createServer((_req, res) => { res.writeHead(302, { location: destinationUrl }); res.end(); });
    const issuerUrl = await listen(issuer);
    const output: unknown[] = [];
    try {
      const code = await runWorkbenchCli([...args, '--daemon-url', issuerUrl], { env: { OD_DAEMON_URL: issuerUrl, OD_TOOL_TOKEN_ISSUER_ORIGIN: issuerUrl, OD_TOOL_TOKEN: 'scoped-test-token' }, write: value => output.push(value) });
      expect(code).toBe(1);
      expect(destinationRequests).toBe(0);
      expect(output).toEqual([{ error: { code: 'transport-or-server-failure', message: expect.any(String) } }]);
      expect(JSON.stringify(output)).not.toContain('scoped-test-token');
    } finally { await close(issuer); await close(destination); }
  });
});
