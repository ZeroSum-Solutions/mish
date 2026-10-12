import { describe, expect, it } from 'vitest';
import { FILE_UPLOAD_MAX_BYTES } from '../src/api/files.js';
import { parseCreateIntakeBatchRequest, parseIntakeBatchSnapshot, parseAttachIntakeRequest, parseClearIntakeRequest } from '../src/api/workbench-intake.js';
const id = '11111111-1111-4111-8111-111111111111';
const file = { clientFileId: id, order: 0, filename: 'hello.bin', size: 3 };
const batch = { intakeBatchId: id, destination: { kind: 'pending' }, files: [file] };
describe('durable intake boundary', () => {
  it('shares the inclusive 200 MiB ceiling and keeps oversized siblings for individual refusal', () => {
    expect(FILE_UPLOAD_MAX_BYTES).toBe(209715200);
    expect(parseCreateIntakeBatchRequest({ ...batch, files: [{ ...file, size: FILE_UPLOAD_MAX_BYTES + 1 }] }).files[0]!.size).toBe(FILE_UPLOAD_MAX_BYTES + 1);
  });
  it('accepts frozen project root or explicit safe folder', () => {
    expect(parseCreateIntakeBatchRequest({ ...batch, destination: { kind: 'project', projectId: 'p', dir: 'images/photos' } }).destination).toEqual({ kind: 'project', projectId: 'p', dir: 'images/photos' });
    for (const dir of ['../escape', '/absolute', 'C:/x', 'a\\b', 'a/../b', './x', 'a//b', 'a\0b', 'a\nb']) expect(() => parseCreateIntakeBatchRequest({ ...batch, destination: { kind: 'project', projectId: 'p', dir } })).toThrow();
  });
  it('rejects duplicate identities, duplicate ordering, untrusted fields, and invalid bounds', () => {
    for (const input of [{ ...batch, files: [] }, { ...batch, files: [file, file] }, { ...batch, files: [{ ...file, size: -1 }] }, { ...batch, files: [{ ...file, size: 1.5 }] }, { ...batch, path: '/native' }, { ...batch, destination: { kind: 'pending', projectId: 'p' } }]) expect(() => parseCreateIntakeBatchRequest(input)).toThrow();
  });
  it('preserves ordinary basenames and refuses path-bearing or control-character names', () => {
    for (const filename of ['family photo.jpg', '你好 résumé.bin']) expect(parseCreateIntakeBatchRequest({ ...batch, files: [{ ...file, filename }] }).files[0]!.filename).toBe(filename);
    for (const filename of ['../x', '/x', 'a/b', 'a\\b', 'C:x', '.', '..', 'x\0y', 'x\ny']) expect(() => parseCreateIntakeBatchRequest({ ...batch, files: [{ ...file, filename }] })).toThrow();
  });
  it('does not use observational revision as a mutation precondition', () => {
    expect(parseAttachIntakeRequest({ projectId: 'p', conversationId: 'c' })).toEqual({ projectId: 'p', conversationId: 'c' });
    expect(parseClearIntakeRequest({})).toEqual({});
    expect(() => parseAttachIntakeRequest({ projectId: 'p', conversationId: 'c', expectedRevision: 1 })).toThrow();
  });
  it('rejects persisted uploading state and private paths in a snapshot', () => {
    const snapshot = { ...batch, revision: 1, createdAt: 1, updatedAt: 1, files: [{ clientFileId: id, order: 0, descriptor: file, state: 'queued', retryable: true, hasSuccessfulAttachment: false }] };
    expect(parseIntakeBatchSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseIntakeBatchSnapshot({ ...snapshot, files: [{ ...snapshot.files[0], state: 'uploading' }] })).toThrow();
    expect(() => parseIntakeBatchSnapshot({ ...snapshot, files: [{ ...snapshot.files[0], absPath: '/private' }] })).toThrow();
  });
});

it('requires the authoritative descriptor on every recovery state and matching outcome identity', () => {
  const descriptor = { ...file, declaredMime: 'application/octet-stream', relativePath: 'folder/hello.bin' };
  const snapshot = { intakeBatchId: id, destination: { kind: 'pending' }, revision: 1, createdAt: 1, updatedAt: 1 };
  for (const state of ['queued', 'failed', 'cancelled', 'needs-reselection', 'cleared']) {
    const outcome = { clientFileId: id, order: 0, descriptor, state, retryable: true, hasSuccessfulAttachment: false };
    expect(parseIntakeBatchSnapshot({ ...snapshot, files: [outcome] }).files[0]!.descriptor).toEqual(descriptor);
    expect(() => parseIntakeBatchSnapshot({ ...snapshot, files: [{ ...outcome, descriptor: undefined }] })).toThrow();
    expect(() => parseIntakeBatchSnapshot({ ...snapshot, files: [{ ...outcome, descriptor: { ...descriptor, order: 1 } }] })).toThrow();
    expect(() => parseIntakeBatchSnapshot({ ...snapshot, files: [{ ...outcome, descriptor: { ...descriptor, clientFileId: '22222222-2222-4222-8222-222222222222' } }] })).toThrow();
  }
});

it('requires a boolean persisted attachment-completion fact without exposing target authority', () => {
  const snapshot = { intakeBatchId: id, destination: { kind: 'pending' }, revision: 1, createdAt: 1, updatedAt: 1 };
  const outcome = { clientFileId: id, order: 0, descriptor: file, state: 'cleared', retryable: false };
  for (const hasSuccessfulAttachment of [false, true]) expect(parseIntakeBatchSnapshot({ ...snapshot, files: [{ ...outcome, hasSuccessfulAttachment }] }).files[0]!.hasSuccessfulAttachment).toBe(hasSuccessfulAttachment);
  expect(() => parseIntakeBatchSnapshot({ ...snapshot, files: [outcome] })).toThrow();
  expect(() => parseIntakeBatchSnapshot({ ...snapshot, files: [{ ...outcome, hasSuccessfulAttachment: 'true' }] })).toThrow();
  expect(() => parseIntakeBatchSnapshot({ ...snapshot, files: [{ ...outcome, hasSuccessfulAttachment: true, attachmentProjectId: 'forged' }] })).toThrow();
});


it('accepts the non-retryable unsupported destination refusal as a typed intake outcome', () => {
  const snapshot = { intakeBatchId: id, destination: { kind: 'pending' }, revision: 1, createdAt: 1, updatedAt: 1, files: [{ clientFileId: id, order: 0, descriptor: file, state: 'stored', retryable: false, hasSuccessfulAttachment: false, stored: { assetId: 'asset', contentHash: '0'.repeat(64), size: 3, filename: file.filename, detectedMime: 'application/octet-stream', kind: 'file', downloadUrl: '/api/workbench/intake/download' }, error: { code: 'intake-destination-unsupported', message: 'Select a supported project destination', retryable: false } }] };
  expect(parseIntakeBatchSnapshot(snapshot).files[0]!.error).toEqual(snapshot.files[0]!.error);
});
