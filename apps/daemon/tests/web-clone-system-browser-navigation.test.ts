import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const adapterPath = path.join(repoRoot, 'skills/web-clone/scripts/lib/system-browser.mjs');
type Command = { id: number; method: string; params: Record<string, unknown> };
type Message = Record<string, unknown>;
type Page = {
  goto: (url: string, options: { waitUntil: string; timeout: number }) => Promise<unknown>;
  url: () => string;
  waitForLoadState: (state: string, options: { timeout: number }) => Promise<unknown>;
  listeners: Map<string, Set<unknown>>;
  connection: { send: (method: string, params?: unknown, timeout?: number) => Promise<unknown> };
};

// A fake wire under the real CDP connection. No browser, port or provider is opened.
class FakeSocket extends EventEmitter {
  destroyed = false;
  constructor(private navigate: (command: Command, emit: (message: Message) => void) => void) {
    super();
  }
  setNoDelay() {}
  setTimeout() {}
  write(frame: Buffer) {
    if ((frame[0]! & 0x0f) !== 1) return true;
    const size = frame[1]! & 0x7f;
    const length = size === 126 ? frame.readUInt16BE(2) : size;
    const header = size === 126 ? 4 : 2;
    const mask = frame.subarray(header, header + 4);
    const payload = Buffer.from(frame.subarray(header + 4, header + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
    const command = JSON.parse(payload.toString()) as Command;
    const emit = (message: Message) => {
      const body = Buffer.from(JSON.stringify(message));
      const prefix = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, 0, 0]);
      if (body.length >= 126) prefix.writeUInt16BE(body.length, 2);
      this.emit('data', Buffer.concat([prefix, body]));
    };
    queueMicrotask(() => {
      if (command.method === 'Page.navigate') this.navigate(command, emit);
      else emit({ id: command.id, result: {} });
    });
    return true;
  }
  end() { this.destroy(); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

const sockets: FakeSocket[] = [];
const observedRejections: unknown[] = [];
const observe = (error: unknown) => { observedRejections.push(error); };
afterEach(() => {
  process.off('unhandledRejection', observe);
  for (const socket of sockets.splice(0)) socket.destroy();
  observedRejections.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function pageFor(navigate: ConstructorParameters<typeof FakeSocket>[0]): Promise<Page> {
  process.on('unhandledRejection', observe);
  vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    request.destroy = () => {};
    request.end = () => {
      const socket = new FakeSocket(navigate);
      sockets.push(socket);
      const key = (options.headers as Record<string, string>)['Sec-WebSocket-Key'];
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      request.emit('upgrade', { headers: { 'sec-websocket-accept': accept } }, socket, Buffer.alloc(0));
    };
    return request;
  }) as typeof http.request);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/browser-sessions')) {
      return Response.json({ browserSession: { id: 'fixture-session', websocketUrl: 'ws://fixture.invalid/devtools/browser/fixture' } });
    }
    return Response.json({ id: 'fixture-page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fixture.invalid/devtools/page/fixture' });
  }));
  const { systemChromium } = await import(pathToFileURL(adapterPath).href) as {
    systemChromium: { connectOverDaemon: (options: unknown) => Promise<{ newPage: () => Promise<Page> }> };
  };
  const browser = await systemChromium.connectOverDaemon({ daemonUrl: 'http://fixture.invalid', projectId: 'fixture-project' });
  return browser.newPage();
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const listenerCount = (page: Page) => [...page.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);

describe('Website Clone navigation promise ownership', () => {
  it('catches an event timeout while Page.navigate is still pending and cleans its listener', async () => {
    const page = await pageFor(() => {});
    const navigationError = new Error('synthetic late Page.navigate rejection');
    vi.spyOn(page.connection, 'send').mockImplementation(async () => {
      await delay(30);
      throw navigationError;
    });
    const outcome = page.goto('https://fixture.invalid/page', { waitUntil: 'domcontentloaded', timeout: 5 }).catch((error: unknown) => error);
    const result = await outcome;
    await delay(40);
    expect(observedRejections).toEqual([]);
    expect(result).toBe(navigationError);
    expect(listenerCount(page)).toBe(0);
  });

  it.each(['domcontentloaded', 'load'])('preserves the real Page.navigate timeout when %s and acknowledgement both stall', async (waitUntil) => {
    const page = await pageFor(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const outcome = page.goto('https://fixture.invalid/stalled', { waitUntil, timeout: 30 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(31);
    expect(await outcome).toMatchObject({ message: 'Page.navigate timed out after 30ms' });
    expect(page.url()).toBe('about:blank');
    expect(listenerCount(page)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(observedRejections).toEqual([]);
  });

  it.each(['domcontentloaded', 'load'])('removes only the failed navigation %s wait and its timer, leaving a sibling wait live', async (waitUntil) => {
    let emitWire: (message: Message) => void = () => { throw new Error('Wire not ready'); };
    const page = await pageFor((command, emit) => {
      emitWire = emit;
      emit({ id: command.id, error: { message: 'synthetic refusal' } });
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const removedAbort = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    const navigation = page.goto('https://fixture.invalid/refused', { waitUntil, timeout: 30 }).catch((error: unknown) => error);
    let siblingSettled = false;
    const sibling = page.waitForLoadState(waitUntil, { timeout: 100 }).then(() => { siblingSettled = true; });
    const eventName = waitUntil === 'load' ? '__load' : '__domcontentloaded';
    const siblingListener = [...page.listeners.get(eventName)!][1];
    expect(siblingListener).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(0);
    expect(await navigation).toMatchObject({ message: 'Page.navigate failed: synthetic refusal' });
    expect(siblingSettled).toBe(false);
    expect([...page.listeners.get(eventName)!]).toEqual([siblingListener]);
    expect(vi.getTimerCount()).toBe(1);
    expect(removedAbort).toHaveBeenCalledWith('abort', expect.any(Function));
    emitWire({ method: waitUntil === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired', params: {} });
    await sibling;
    expect(siblingSettled).toBe(true);
    expect(listenerCount(page)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(observedRejections).toEqual([]);
  });

  it('reports the document event timeout after an actual successful navigate acknowledgement', async () => {
    const page = await pageFor((command, emit) => emit({ id: command.id, result: { frameId: 'fixture-frame' } }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const outcome = page.goto('https://fixture.invalid/no-dom-event', { waitUntil: 'domcontentloaded', timeout: 30 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(31);
    expect(await outcome).toMatchObject({ message: '__domcontentloaded timed out after 30ms' });
    expect(page.url()).toBe('https://fixture.invalid/no-dom-event');
    expect(listenerCount(page)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(observedRejections).toEqual([]);
  });

  it('preserves networkidle without arming a document event timer', async () => {
    const page = await pageFor((command, emit) => emit({ id: command.id, result: { frameId: 'fixture-frame' } }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const result = page.goto('https://fixture.invalid/idle', { waitUntil: 'networkidle', timeout: 1_000 });
    await vi.advanceTimersByTimeAsync(550);
    await expect(result).resolves.toBeNull();
    expect(page.url()).toBe('https://fixture.invalid/idle');
    expect(listenerCount(page)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(observedRejections).toEqual([]);
  });

  it.each(['command', 'errorText'])('keeps %s navigation failures and cancels the prearmed event wait', async (mode) => {
    const page = await pageFor((command, emit) => {
      emit(mode === 'command'
        ? { id: command.id, error: { message: 'synthetic refusal' } }
        : { id: command.id, result: { errorText: 'synthetic refusal' } });
    });
    await expect(page.goto('https://fixture.invalid/page', { waitUntil: 'domcontentloaded', timeout: 5 }))
      .rejects.toThrow(mode === 'command' ? 'Page.navigate failed: synthetic refusal' : 'Navigation failed: synthetic refusal');
    await delay(15);
    expect(observedRejections).toEqual([]);
    expect(listenerCount(page)).toBe(0);
  });

  it.each(['domcontentloaded', 'load'])('accepts a %s event before the navigate acknowledgement without losing it', async (waitUntil) => {
    const page = await pageFor((command, emit) => {
      emit({ method: waitUntil === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired', params: {} });
      emit({ id: command.id, result: { frameId: 'fixture-frame' } });
    });
    await expect(page.goto('https://fixture.invalid/page', { waitUntil, timeout: 20 })).resolves.toBeNull();
    await delay(0);
    expect(page.url()).toBe('https://fixture.invalid/page');
    expect(listenerCount(page)).toBe(0);
    expect(observedRejections).toEqual([]);
  });
});
