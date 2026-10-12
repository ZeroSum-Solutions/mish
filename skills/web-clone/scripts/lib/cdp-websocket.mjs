// Minimal RFC 6455 client for the Chrome DevTools Protocol.
//
// Node's built-in WebSocket (undici) always offers permessage-deflate, Chrome
// accepts it, and undici then refuses any compressed frame that inflates past
// 4 MiB ("Max decompressed message size exceeded", close 1009). A full-page
// PNG of a real photographic site is far larger than that, so the socket died
// in the middle of Page.captureScreenshot. This client offers no extensions,
// so Chrome sends plain frames, and it enforces its own explicit size limit.
//
// The limit stays at 256 MiB: a complete message is decoded into one JS string
// and V8 strings stop at ~536,870,888 characters, so a larger cap would let an
// accepted frame throw from the socket handler instead of failing cleanly.
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODES = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };

function encodeFrame(opcode, payload) {
  const length = payload.length;
  const lengthBytes = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + 4);
  header[0] = 0x80 | opcode;
  if (lengthBytes === 0) header[1] = 0x80 | length;
  else if (lengthBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = crypto.randomBytes(4);
  mask.copy(header, 2 + lengthBytes);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, masked]);
}

export class CdpWebSocket {
  constructor(socket, head, { maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.chunks = [];
    this.buffered = 0;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    this.open = true;
    this.closeEmitted = false;
    this.closeFrame = null;
    this.error = null;
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => {
      this.error = error;
    });
    socket.on("close", () => this.#emitClose());
    if (head?.length) this.#onData(head);
  }

  get isOpen() {
    return this.open && !this.socket.destroyed;
  }

  send(text) {
    if (!this.isOpen) throw new Error("WebSocket is not open");
    this.socket.write(encodeFrame(OPCODES.text, Buffer.from(text, "utf8")));
  }

  close(code = 1000, reason = "") {
    if (!this.open) return;
    this.open = false;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try {
      this.socket.write(encodeFrame(OPCODES.close, payload));
    } catch {}
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
  }

  #fail(code, reason) {
    this.closeFrame = { code, reason };
    this.close(code, reason.slice(0, 120));
    this.socket.destroy();
  }

  #emitClose() {
    this.open = false;
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    const frame = this.closeFrame || { code: 1006, reason: "" };
    this.onclose?.({ code: frame.code, reason: frame.reason, error: this.error });
  }

  #take(count) {
    const out = Buffer.allocUnsafe(count);
    let offset = 0;
    while (offset < count) {
      const chunk = this.chunks[0];
      const needed = count - offset;
      if (chunk.length <= needed) {
        chunk.copy(out, offset);
        offset += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, offset, 0, needed);
        this.chunks[0] = chunk.subarray(needed);
        offset += needed;
      }
    }
    this.buffered -= count;
    return out;
  }

  #peek(count) {
    if (this.chunks[0].length < count) {
      let parts = 0;
      let size = 0;
      while (size < count) size += this.chunks[parts++].length;
      this.chunks.splice(0, parts, Buffer.concat(this.chunks.slice(0, parts), size));
    }
    return this.chunks[0].subarray(0, count);
  }

  #onData(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= 2) {
      const first = this.#peek(2);
      const fin = (first[0] & 0x80) !== 0;
      const rsv = first[0] & 0x70;
      const opcode = first[0] & 0x0f;
      const masked = (first[1] & 0x80) !== 0;
      let length = first[1] & 0x7f;
      let headerLength = 2;
      if (length === 126) headerLength = 4;
      else if (length === 127) headerLength = 10;
      if (masked) headerLength += 4;
      if (this.buffered < headerLength) return;
      const header = this.#peek(headerLength);
      if (length === 126) length = header.readUInt16BE(2);
      else if (length === 127) {
        const big = header.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageBytes)) {
          this.#fail(1009, `frame of ${big} bytes exceeds the ${this.maxMessageBytes}-byte CDP message limit`);
          return;
        }
        length = Number(big);
      }
      if (rsv) {
        this.#fail(1002, "received a compressed or extended frame that was not negotiated");
        return;
      }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) {
        this.#fail(1002, "received a fragmented or oversized control frame");
        return;
      }
      // Control frames (ping/pong/close) may be interleaved inside a fragmented
      // message (RFC 6455 section 5.4); they never count toward its size.
      if (!control && this.fragmentBytes + length > this.maxMessageBytes) {
        this.#fail(1009, `message of ${this.fragmentBytes + length} bytes exceeds the ${this.maxMessageBytes}-byte CDP message limit`);
        return;
      }
      if (this.buffered < headerLength + length) return;
      const mask = masked ? Buffer.from(header.subarray(headerLength - 4, headerLength)) : null;
      this.#take(headerLength);
      const payload = this.#take(length);
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      this.#onFrame(fin, opcode, payload);
      if (!this.open && this.closeFrame) return;
    }
  }

  #onFrame(fin, opcode, payload) {
    if (opcode === OPCODES.ping) {
      if (this.isOpen) this.socket.write(encodeFrame(OPCODES.pong, payload));
      return;
    }
    if (opcode === OPCODES.pong) return;
    if (opcode === OPCODES.close) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      this.closeFrame = { code, reason };
      this.close(code === 1005 ? 1000 : code);
      return;
    }
    if (opcode !== OPCODES.continuation) this.fragmentOpcode = opcode;
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (!fin) return;
    const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments, this.fragmentBytes);
    this.fragments = [];
    this.fragmentBytes = 0;
    if (this.fragmentOpcode !== OPCODES.text && this.fragmentOpcode !== OPCODES.binary) return;
    try {
      this.onmessage?.(message.toString("utf8"));
    } catch (error) {
      // Decoding or handling must never throw out of the socket data handler;
      // close so every pending CDP request fails with this reason instead.
      this.error = error;
      this.#fail(1011, `failed to deliver a ${message.length}-byte CDP message: ${error?.message || error}`);
    }
  }
}

export function connectCdpWebSocket(url, { timeoutMs = 15_000, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === "wss:";
    if (!secure && target.protocol !== "ws:") {
      reject(new Error(`CDP WebSocket failed: unsupported protocol ${target.protocol} (${url})`));
      return;
    }
    const key = crypto.randomBytes(16).toString("base64");
    const request = (secure ? https : http).request({
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
      timeout: timeoutMs,
    });
    const fail = (message) => {
      request.destroy();
      reject(new Error(`CDP WebSocket failed: ${message} (${url})`));
    };
    request.on("timeout", () => fail(`handshake timed out after ${timeoutMs}ms`));
    request.on("error", (error) => fail(error.message));
    request.on("response", (response) => {
      response.resume();
      fail(`HTTP ${response.statusCode} instead of a WebSocket upgrade`);
    });
    request.on("upgrade", (response, socket, head) => {
      const expected = crypto.createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
      if (response.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        fail("invalid Sec-WebSocket-Accept in the handshake");
        return;
      }
      if (response.headers["sec-websocket-extensions"]) {
        socket.destroy();
        fail(`server negotiated unrequested extensions: ${response.headers["sec-websocket-extensions"]}`);
        return;
      }
      socket.setTimeout(0);
      resolve(new CdpWebSocket(socket, head, { maxMessageBytes }));
    });
    request.end();
  });
}
