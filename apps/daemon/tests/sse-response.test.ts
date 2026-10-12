import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCompatApiErrorResponse, createSseResponse } from '../src/server.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createSseResponse', () => {
  it('sets SSE headers and sends JSON app events', () => {
    const res = new FakeResponse();
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });

    expect(res.headers).toEqual({
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    expect(res.flushed).toBe(true);

    expect(sse.send('start', { ok: true })).toBe(true);
    expect(res.writes.join('')).toBe('event: start\ndata: {"ok":true}\n\n');
  });

  it('can attach SSE event ids for resumable streams', () => {
    const res = new FakeResponse();
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });

    expect(sse.send('stdout', { chunk: 'hello' }, 12)).toBe(true);

    expect(res.writes.join('')).toBe('id: 12\nevent: stdout\ndata: {"chunk":"hello"}\n\n');
  });

  it('emits heartbeat comments before real events', () => {
    const res = new FakeResponse();
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });

    expect(sse.writeKeepAlive()).toBe(true);
    expect(sse.send('end', {})).toBe(true);
    expect(res.writes.join('')).toBe(': keepalive\n\nevent: end\ndata: {}\n\n');
  });

  it('clears interval heartbeat on close', () => {
    vi.useFakeTimers();
    const res = new FakeResponse();
    createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 10 });

    vi.advanceTimersByTime(10);
    expect(res.writes).toEqual([': keepalive\n\n']);

    res.emit('close');
    vi.advanceTimersByTime(30);
    expect(res.writes).toEqual([': keepalive\n\n']);
  });

  it('skips writes after the response ends', () => {
    const res = new FakeResponse();
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });

    sse.end();

    expect(res.ended).toBe(true);
    expect(sse.writeKeepAlive()).toBe(false);
    expect(sse.send('end', {})).toBe(false);
    expect(res.writes).toEqual([]);
  });
  it('D21 pauses writes until drain and keeps event order through end', () => {
    const res = new FakeResponse();
    res.writeAccepted = false;
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });
    sse.send('one', {});
    sse.send('two', {});
    expect(res.writes).toHaveLength(1);
    sse.end();
    expect(res.ended).toBe(false);
    res.writeAccepted = true;
    res.emit('drain');
    expect(res.writes.join('')).toBe('event: one\ndata: {}\n\nevent: two\ndata: {}\n\n');
    expect(res.ended).toBe(true);
    expect(res.listenerCount('drain')).toBe(0);
  });

  it('D21 closes a client before its buffered bytes grow without bound', () => {
    const res = new FakeResponse();
    res.writeAccepted = false;
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });
    sse.send('one', {});
    expect(sse.send('too-large', { value: 'x'.repeat(1024 * 1024) })).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(res.writes).toHaveLength(1);
    expect(res.listenerCount('drain')).toBe(0);
  });

  it('D21 suppresses heartbeats while blocked and closes on excess backlog', () => {
    vi.useFakeTimers();
    const res = new FakeResponse();
    res.writeAccepted = false;
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 10 });
    sse.send('one', {});
    vi.advanceTimersByTime(100);
    expect(res.writes).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(res.destroyed).toBe(false);
    expect(sse.send('overflow', { value: 'x'.repeat(1024 * 1024) })).toBe(false);
    expect(res.destroyed).toBe(true);
    const writes = res.writes.length;
    vi.advanceTimersByTime(50_000);
    expect(res.writes).toHaveLength(writes);
  });

  it('D21 resumes replay before live events and flushes both before ending', () => {
    const res = new FakeResponse();
    res.writeAccepted = false;
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });
    sse.replay([
      { event: 'historical', data: {}, id: 1 },
      { event: 'historical', data: {}, id: 2 },
    ]);
    sse.send('live', {}, 3);
    sse.end();
    expect(res.writes).toHaveLength(1);
    res.writeAccepted = true;
    res.emit('drain');
    expect(res.writes.map((frame) => frame.match(/^id: (\d+)/)?.[1])).toEqual(['1', '2', '3']);
    expect(res.ended).toBe(true);
  });

  it('D21 accepts a bounded large event and preserves order across chunk drains', () => {
    const res = new FakeResponse();
    res.writeAccepted = false;
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });
    expect(sse.send('large', { value: 'x'.repeat(1024 * 1024 + 1) })).toBe(true);
    res.writableLength = Buffer.byteLength(res.writes[0]!);
    expect(res.destroyed).toBe(false);
    expect(sse.send('next', {})).toBe(true);
    expect(res.writes).toHaveLength(1);
    res.writeAccepted = true;
    res.writableLength = 0;
    res.emit('drain');
    expect(res.writes.length).toBeGreaterThan(2);
    expect(res.writes.join('')).toContain('event: next\ndata: {}\n\n');
    sse.end();
  });

  it('D21 drains a 20 MiB frame over more than ten seconds with bounded transport writes', () => {
    vi.useFakeTimers();
    const res = new FakeResponse();
    res.writeAccepted = false;
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });
    const value = 'x'.repeat(20 * 1024 * 1024);
    expect(sse.send('large', { value })).toBe(true);
    expect(Buffer.byteLength(res.writes[0]!)).toBeLessThanOrEqual(64 * 1024);
    sse.send('after', {});
    sse.end();
    // Like Node, writableLength stays constant until each individual write completes.
    for (let second = 0; !res.ended && second < 2000; second += 1) {
      res.writableLength = Buffer.byteLength(res.writes.at(-1)!);
      vi.advanceTimersByTime(1000);
      expect(res.destroyed).toBe(false);
      res.writableLength = 0;
      res.emit('drain');
    }
    expect(res.ended).toBe(true);
    expect(res.writes.length).toBeGreaterThan(10);
    expect(res.writes.every((chunk) => Buffer.byteLength(chunk) <= 64 * 1024)).toBe(true);
    expect(res.writes.join('')).toBe(`event: large\ndata: ${JSON.stringify({ value })}\n\nevent: after\ndata: {}\n\n`);
  });

  it('D21 preserves UTF-8 bytes across transport chunks and keeps replay before live frames', () => {
    const res = new FakeResponse();
    res.writeAccepted = false;
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });
    const value = '🥳é'.repeat(30_000);
    sse.replay([{ event: 'large', data: { value }, id: 1 }]);
    sse.send('after', {}, 2);
    sse.end();
    while (!res.ended) res.emit('drain');
    expect(Buffer.concat(res.rawWrites).toString()).toBe(
      `id: 1\nevent: large\ndata: ${JSON.stringify({ value })}\n\nid: 2\nevent: after\ndata: {}\n\n`,
    );
  });

  it('D21 rejects an oversized first frame before passing it to Node', () => {
    const res = new FakeResponse();
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });
    expect(sse.send('huge', { value: 'x'.repeat(32 * 1024 * 1024) })).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(res.writes).toHaveLength(0);
  });

  it('D21 keeps a bounded pending transfer alive when TCP progress is not observable', () => {
    vi.useFakeTimers();
    const res = new FakeResponse();
    res.writeAccepted = false;
    res.writableLength = 65_536;
    res.socket = { _handle: { writeQueueSize: 65_536 } };
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });
    sse.send('one', {});
    vi.advanceTimersByTime(600_000);
    expect(res.destroyed).toBe(false);
    expect(sse.send('overflow', { value: 'x'.repeat(1024 * 1024) })).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(res.listenerCount('drain')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('D21 closes corrupt replay safely when serialization fails after drain', () => {
    const res = new FakeResponse();
    res.writeAccepted = false;
    const sse = createSseResponse(res as unknown as Response, { keepAliveIntervalMs: 0 });
    sse.replay([
      { event: 'valid', data: {}, id: 1 },
      { event: 'invalid', data: 1n, id: 2 },
    ]);
    expect(res.destroyed).toBe(false);
    res.writeAccepted = true;
    expect(() => res.emit('drain')).not.toThrow();
    expect(res.destroyed).toBe(true);
    expect(res.listenerCount('drain')).toBe(0);
  });

});

describe('createCompatApiErrorResponse', () => {
  it('wraps legacy string errors in the shared ApiError response shape', () => {
    expect(createCompatApiErrorResponse('BAD_REQUEST', 'message required')).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'message required',
      },
    });
  });

  it('preserves shared ApiError metadata fields', () => {
    expect(
      createCompatApiErrorResponse('AGENT_UNAVAILABLE', 'missing agent', {
        retryable: true,
        details: { legacyCode: 'ENOENT' },
      }),
    ).toEqual({
      error: {
        code: 'AGENT_UNAVAILABLE',
        message: 'missing agent',
        retryable: true,
        details: { legacyCode: 'ENOENT' },
      },
    });
  });
});

class FakeResponse extends EventEmitter {
  headers: Record<string, string> = {};
  writes: string[] = [];
  rawWrites: Buffer[] = [];
  destroyed = false;
  writableEnded = false;
  flushed = false;
  ended = false;
  writeAccepted = true;
  writableLength = 0;
  socket?: { _handle: { writeQueueSize: number } };

  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  flushHeaders() {
    this.flushed = true;
  }

  write(chunk: string | Buffer) {
    this.rawWrites.push(Buffer.from(chunk));
    this.writes.push(chunk.toString());
    return this.writeAccepted;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }

  end() {
    this.ended = true;
    this.writableEnded = true;
    this.emit('finish');
  }
}
