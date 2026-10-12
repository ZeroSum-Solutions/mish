import http from 'node:http';
import type { Response } from 'express';
import { expect, it } from 'vitest';
import { createSseResponse } from '../src/server.js';

it('delivers an intact 20 MiB SSE frame to a throttled HTTP client over twenty seconds', async () => {
  const value = 'x'.repeat(20 * 1024 * 1024);
  const expected = `event: large\ndata: ${JSON.stringify({ value })}\n\nevent: after\ndata: {}\n\n`;
  const server = http.createServer((_request, response) => {
    const sse = createSseResponse(response as unknown as Response, { keepAliveIntervalMs: 0 });
    sse.send('large', { value });
    sse.send('after', {});
    sse.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  let client: http.ClientRequest | undefined;
  try {
    const body = await new Promise<Buffer>((resolve, reject) => {
      client = http.get(`http://127.0.0.1:${address.port}`, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          bytes += chunk.length;
          // This real clock exercises TCP backpressure and Node drain events.
          // Fake timers cannot witness the native write that caused this regression.
          response.pause();
          const targetElapsedMs = bytes / (1024 * 1024) * 1000;
          resumeTimer = setTimeout(() => response.resume(), Math.max(0, targetElapsedMs - (Date.now() - startedAt)));
        });
        response.once('error', reject);
        response.once('end', () => resolve(Buffer.concat(chunks)));
      });
      client.once('error', reject);
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20_000);
    expect(body.toString()).toBe(expected);
  } finally {
    clearTimeout(resumeTimer);
    client?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 40_000);
