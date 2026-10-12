// AC-R01.3 (W2 intake contract): any file class is stored and downloadable,
// opaque files carry the readability label, the 200 MiB per-file limit is
// shown on the new Library intake path while siblings succeed, and dropped
// HTML/SVG stay inert through the raw and download byte routes.
import express from 'express';
import Database from 'better-sqlite3';
import { FILE_UPLOAD_MAX_BYTES, LIBRARY_UPLOAD_MAX_BYTES, parseIntakeBatchSnapshot, parseIntakeFilePutResponse, type ApiErrorResponse } from '@open-design/contracts';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLibrary } from '../../src/library-store.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { requireLocalDaemonRequest } from '../../src/http/local-daemon-request.js';
import { registerWorkbenchIntakeRoutes, type RegisterWorkbenchIntakeRoutesDeps } from '../../src/routes/workbench-intake.js';
import { registerLibraryRoutes, type RegisterLibraryRoutesDeps } from '../../src/routes/library.js';
import { INTAKE_SIZE_EXCEEDED_MESSAGE, OPAQUE_INTAKE_NOTICE, intakeReadabilityNotice } from '../../src/workbench/intake-policy.js';
import { cleanupIntakeRoots, ordinaryIntakeAuthority } from './intake-placement-fixture.js';

let server: Server | undefined, root: string | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  cleanupIntakeRoots();
});

async function boot() {
  root = await mkdtemp(path.join(tmpdir(), 'intake-matrix-'));
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateLibrary(db);
  const app = express(); app.use(express.json());
  const paths = { LIBRARY_DIR: path.join(root, 'library'), PROJECTS_DIR: path.join(root, 'projects') };
  registerWorkbenchIntakeRoutes(app, { db, http: { sendApiError }, paths, projectStore: { getProject: (_db: unknown, id: string) => ({ id, metadata: {} }) }, conversations: { getConversation: () => ({ projectId: 'p' }) }, authorizeProjectRequest: async () => true, intakeWriteAuthority: ordinaryIntakeAuthority() } as unknown as RegisterWorkbenchIntakeRoutesDeps);
  registerLibraryRoutes(app, { db, http: { sendApiError, requireLocalDaemonRequest }, paths, projectStore: {}, projectFiles: {}, conversations: {}, auth: {} } as unknown as RegisterLibraryRoutesDeps);
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type Entry = { filename: string; bytes: Buffer };
async function drop(url: string, entries: Entry[], declaredSizes: Record<number, number> = {}) {
  const manifest = { intakeBatchId: randomUUID(), destination: { kind: 'pending' as const }, files: entries.map((entry, order) => ({ clientFileId: randomUUID(), order, filename: entry.filename, size: declaredSizes[order] ?? entry.bytes.length })) };
  const created = await fetch(`${url}/api/workbench/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest) });
  expect(created.status).toBe(200);
  const fileUrl = (index: number) => `${url}/api/workbench/intake/${manifest.intakeBatchId}/files/${manifest.files[index]!.clientFileId}`;
  const put = (index: number) => fetch(fileUrl(index), { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: entries[index]!.bytes });
  return { manifest, snapshot: parseIntakeBatchSnapshot(await created.json()), fileUrl, put };
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** RFC 5987 `filename*` decoded back to the original name. */
function dispositionFilename(header: string | null): string | undefined {
  const match = /filename\*=UTF-8''([^;]+)/.exec(header ?? '');
  return match ? decodeURIComponent(match[1]!) : undefined;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=', 'base64');
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n')]);
const TEXT = Buffer.from('Brief: héllo wörld, 你好.\n');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2'), Buffer.alloc(8)]);
const ZIP = Buffer.concat([Buffer.from('PK'), Buffer.from([3, 4, 20, 0, 0, 0, 8, 0]), Buffer.alloc(22, 0x9c)]);
const UNKNOWN = Buffer.from([0xff, 0x00, 0x1f, 0x11, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
const MATRIX: (Entry & { kind: string; opaque: boolean })[] = [
  { filename: 'Brand Photo é.png', bytes: PNG, kind: 'image', opaque: false },
  { filename: 'My Résumé (final).pdf', bytes: PDF, kind: 'file', opaque: true },
  { filename: 'notes 笔记.txt', bytes: TEXT, kind: 'text', opaque: false },
  { filename: 'clip — teaser.mp4', bytes: MP4, kind: 'video', opaque: false },
  { filename: 'Archive ü 2026.zip', bytes: ZIP, kind: 'file', opaque: true },
  { filename: 'blob 🎲 data', bytes: UNKNOWN, kind: 'file', opaque: true },
];

describe('AC-R01.3 file-class matrix', () => {
  it('stores image, PDF, text, video, ZIP and unknown binary with spaced/non-ASCII names, byte-exact and downloadable', async () => {
    const url = await boot();
    const { put, fileUrl } = await drop(url, MATRIX);
    for (let index = 0; index < MATRIX.length; index++) {
      const entry = MATRIX[index]!;
      const response = await put(index); expect(response.status, entry.filename).toBe(200);
      const stored = parseIntakeFilePutResponse(await response.json()).file;
      expect(stored.state, entry.filename).toBe('stored');
      expect(stored.stored, entry.filename).toMatchObject({ filename: entry.filename, kind: entry.kind, size: entry.bytes.length, contentHash: sha256(entry.bytes) });
      expect(intakeReadabilityNotice(stored), entry.filename).toBe(entry.opaque ? OPAQUE_INTAKE_NOTICE : undefined);
      const download = await fetch(`${fileUrl(index)}/download`);
      expect(download.status, entry.filename).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()), entry.filename).toEqual(entry.bytes);
      expect(download.headers.get('content-disposition'), entry.filename).toMatch(/^attachment;/);
      expect(dispositionFilename(download.headers.get('content-disposition')), entry.filename).toBe(entry.filename);
      // The ASCII fallback never carries a raw non-ASCII byte or a quote that could break the header.
      expect(/filename="([\x20-\x7e]*)"/.exec(download.headers.get('content-disposition')!)?.[1], entry.filename).not.toMatch(/["\\]/);
    }
  });
  it('uses the exact contract label text for opaque files', () => {
    expect(OPAQUE_INTAKE_NOTICE).toBe('Stored; contents cannot be read by this model.');
  });
});

describe('AC-R01.3 200 MiB per file on the new Library intake path', () => {
  it('rejects an oversize file per file with the limit shown while siblings, including one above the legacy Library upload limit, succeed', async () => {
    const url = await boot();
    const small = Buffer.from('sibling'), aboveLegacy = Buffer.alloc(LIBRARY_UPLOAD_MAX_BYTES + 1024, 0x61);
    const { snapshot, put } = await drop(url, [{ filename: 'huge render.mov', bytes: Buffer.alloc(0) }, { filename: 'small.txt', bytes: small }, { filename: 'big text.txt', bytes: aboveLegacy }], { 0: FILE_UPLOAD_MAX_BYTES + 1 });
    expect(snapshot.destination).toEqual({ kind: 'pending' });
    expect(snapshot.files[0]).toMatchObject({ state: 'failed', retryable: false, error: { code: 'intake-size-exceeded', message: INTAKE_SIZE_EXCEEDED_MESSAGE } });
    expect(INTAKE_SIZE_EXCEEDED_MESSAGE).toBe('File exceeds the 200 MiB per-file limit');
    const refused = await put(0); expect(refused.status).toBe(413);
    expect(((await refused.json()) as ApiErrorResponse).error).toMatchObject({ code: 'intake-size-exceeded', message: INTAKE_SIZE_EXCEEDED_MESSAGE });
    for (const index of [1, 2]) {
      const response = await put(index); expect(response.status).toBe(200);
      expect(parseIntakeFilePutResponse(await response.json()).file).toMatchObject({ state: 'stored' });
    }
  });
  it('refuses a declared Content-Length above the limit before reading the body, with the limit shown', async () => {
    const url = await boot();
    const { fileUrl, put } = await drop(url, [{ filename: 'liar.bin', bytes: Buffer.from('abc') }, { filename: 'sibling.bin', bytes: Buffer.from('abc') }]);
    const target = new URL(fileUrl(0));
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(target, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(FILE_UPLOAD_MAX_BYTES + 1) } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }); req.destroy(); });
      });
      req.on('error', reject); req.write('abc');
    });
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body).error).toMatchObject({ code: 'intake-size-exceeded', message: INTAKE_SIZE_EXCEEDED_MESSAGE });
    expect((await put(1)).status).toBe(200);
  });
});

describe('AC-R01.3 dropped HTML and SVG are inert through raw and download', () => {
  const HTML = '<!doctype html><html><body><script>window.parent.postMessage("html-ran","*")</script></body></html>';
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.parent.postMessage("svg-ran","*")</script><rect width="1" height="1"/></svg>';
  it.each([['animation one.html', HTML, 'html'], ['logo é.svg', SVG, 'image']])('keeps %s inert on both byte routes', async (filename, source, kind) => {
    const url = await boot();
    const bytes = Buffer.from(source);
    const { put, fileUrl } = await drop(url, [{ filename, bytes }]);
    const stored = parseIntakeFilePutResponse(await (await put(0)).json()).file.stored!;
    expect(stored.kind).toBe(kind);

    const download = await fetch(`${fileUrl(0)}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-security-policy')).toBe('sandbox');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);

    const raw = await fetch(`${url}/api/library/assets/${stored.assetId}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    // `sandbox` with no `allow-scripts` token: a top-level navigation to the bytes never runs script.
    expect(raw.headers.get('content-security-policy')).toBe('sandbox');
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(bytes);
  });
});
