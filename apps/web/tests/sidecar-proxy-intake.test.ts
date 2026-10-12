import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { createDaemonProxyHandler } from '../sidecar/server';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function listen(server: Server) { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as AddressInfo).port; }

it('streams raw intake PUT above the direct Next10MiB limit before the tail arrives, with authority headers', async () => {
 const chunk = Buffer.alloc(64 * 1024, 0x5a); const chunks = 192; //12MiB, never one full body buffer.
 let seen = 0; let requests = 0; let firstBytes!: () => void;
 const receiving = new Promise<void>(resolve => { firstBytes = resolve; });
 const hash = createHash('sha256'); const expectedHash = createHash('sha256');
 for (let i = 0; i < chunks; i++) expectedHash.update(chunk);
 const daemonPort = await listen(createServer((request, response) => {
  requests++; expect(request.method).toBe('PUT'); expect(request.url).toBe('/api/workbench/intake/batch/files/file');
  expect(request.headers['x-od-workspace-id']).toBe('workspace'); expect(request.headers['x-od-workspace-member-id']).toBe('member');
  expect(request.headers.origin).toBe(`http://127.0.0.1:${daemonPort}`);
  request.on('data', (bytes: Buffer) => { seen += bytes.length; hash.update(bytes); firstBytes(); });
  request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ size: seen, hash: hash.digest('hex') })); });
 }));
 const fallback = () => { throw new Error('Intake must reach the existing daemon proxy before Next'); };
 const proxyPort = await listen(createServer(createDaemonProxyHandler(`http://127.0.0.1:${daemonPort}`, fallback)));
 const client = httpRequest(`http://127.0.0.1:${proxyPort}/api/workbench/intake/batch/files/file`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': chunk.length * chunks, 'Origin': `http://127.0.0.1:${proxyPort}`, 'x-od-workspace-id': 'workspace', 'x-od-workspace-member-id': 'member' } });
 const response = new Promise<{ size: number; hash: string }>((resolve, reject) => { client.on('error', reject); client.on('response', message => { let text = ''; message.setEncoding('utf8'); message.on('data', part => { text += part; }); message.on('end', () => resolve(JSON.parse(text))); }); });
 for (let i = 0; i < 16; i++) if (!client.write(chunk)) await once(client, 'drain');
 await receiving; expect(seen).toBeGreaterThan(0); expect(seen).toBeLessThan(chunk.length * chunks);
 for (let i = 16; i < chunks; i++) if (!client.write(chunk)) await once(client, 'drain');
 client.end(); expect(await response).toEqual({ size: chunk.length * chunks, hash: expectedHash.digest('hex') }); expect(requests).toBe(1);
});
