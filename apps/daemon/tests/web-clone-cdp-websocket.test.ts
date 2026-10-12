import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const clientPath = path.join(repoRoot, 'skills/web-clone/scripts/lib/cdp-websocket.mjs');

type CloseInfo = { code: number; reason: string; error: Error | null };
type Client = {
  onmessage: ((data: string) => void) | null;
  onclose: ((info: CloseInfo) => void) | null;
  isOpen: boolean;
};
const { CdpWebSocket, DEFAULT_MAX_MESSAGE_BYTES } = (await import(pathToFileURL(clientPath).href)) as {
  CdpWebSocket: new (socket: FakeSocket, head: Buffer | null, options?: { maxMessageBytes?: number }) => Client;
  DEFAULT_MAX_MESSAGE_BYTES: number;
};

// Stands in for the TCP socket under the WebSocket client, so the transport is
// covered on every host, including CI hosts without a usable Chrome.
class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: Buffer[] = [];
  setNoDelay() {}
  write(data: Buffer) {
    this.writes.push(data);
    return true;
  }
  end() {}
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

// Server-to-client frames are unmasked.
function frame(opcode: number, payload: Buffer, fin = true, forceLength?: 16 | 64): Buffer {
  const first = (fin ? 0x80 : 0) | opcode;
  if (payload.length < 126 && !forceLength) return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  if (payload.length < 65536 && forceLength !== 64) {
    const header = Buffer.from([first, 126, 0, 0]);
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = first;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function open(maxMessageBytes?: number) {
  const socket = new FakeSocket();
  const client = new CdpWebSocket(socket, null, maxMessageBytes ? { maxMessageBytes } : {});
  const messages: string[] = [];
  const closes: CloseInfo[] = [];
  client.onmessage = (data) => messages.push(data);
  client.onclose = (info) => closes.push(info);
  return { socket, client, messages, closes };
}

describe('Website Clone CDP WebSocket client', () => {
  it('keeps the default message cap below the V8 string length limit', () => {
    // A message is decoded into one JS string; V8 strings stop at ~536,870,888 chars.
    expect(DEFAULT_MAX_MESSAGE_BYTES).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it('reassembles a fragmented message at the cap with an interleaved ping', () => {
    const { socket, client, messages, closes } = open(4);
    socket.emit('data', frame(1, Buffer.from('abc'), false));
    socket.emit('data', frame(9, Buffer.from('!!')));
    socket.emit('data', frame(0, Buffer.from('d'), true));

    expect(closes).toEqual([]);
    expect(client.isOpen).toBe(true);
    expect(messages).toEqual(['abcd']);
    // The ping is answered with a masked pong carrying the same payload.
    expect(socket.writes).toHaveLength(1);
    expect(socket.writes[0]![0]).toBe(0x8a);
  });

  it('reads 16-bit and 64-bit payload lengths, also when split across TCP chunks', () => {
    const { socket, messages, closes } = open();
    const medium = 'm'.repeat(300);
    const large = 'L'.repeat(70_000);
    socket.emit('data', frame(1, Buffer.from(medium), true, 16));
    const big = frame(1, Buffer.from(large), true, 64);
    for (let offset = 0; offset < big.length; offset += 4096) socket.emit('data', big.subarray(offset, offset + 4096));

    expect(closes).toEqual([]);
    expect(messages).toEqual([medium, large]);
  });

  it('closes with 1009 and a clear reason when a message exceeds the cap', () => {
    const { socket, messages, closes } = open(4);
    expect(() => socket.emit('data', frame(1, Buffer.from('abcde')))).not.toThrow();

    expect(messages).toEqual([]);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(1009);
    expect(closes[0]!.reason).toContain('exceeds the 4-byte CDP message limit');
  });

  it('closes with 1011 instead of throwing when a message cannot be delivered', () => {
    const { socket, client, closes } = open();
    client.onmessage = () => {
      throw new RangeError('Invalid string length');
    };
    expect(() => socket.emit('data', frame(1, Buffer.from('{}')))).not.toThrow();

    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(1011);
    expect(closes[0]!.reason).toContain('Invalid string length');
  });
});
