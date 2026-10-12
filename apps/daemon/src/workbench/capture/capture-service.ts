import { createHash, randomBytes } from 'node:crypto';
import {
  WORKBENCH_CAPTURE_MAX_BYTES, type CaptureImportMetadata, type CaptureList, type CaptureRecord, type CaptureView, type WorkbenchDeclarationSurface,
} from '@open-design/contracts';
import { sniffRaster } from './image.js';
import { stripRasterMetadata } from './image-metadata.js';
import { redactSourceUrl } from './source-url.js';
import { createCaptureStore } from './capture-store.js';

/** Where capture bytes live. Production stores them as owned Library image assets. */
export interface CaptureBytesPort {
  put(input: { bytes: Buffer; mediaType: string; projectId: string }): Promise<{ assetId: string }>;
  /** Null when the bytes were removed later (for example a Library delete). */
  read(assetId: string): Promise<Buffer | null>;
  /** Cheap availability check for listings; without it the bytes are read and hashed. */
  has?(assetId: string, contentHash: string): Promise<boolean>;
}

export class CaptureError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 410 | 413 | 415 | 422, readonly code: string, message: string) { super(message); }
}

const PAGE_SIZE = 50;
/** Tolerance for compositor rounding between CSS pixels × scale and image pixels. */
const SCALE_SLACK = 2;
const PERMISSION: Record<CaptureRecord['captureMode'], CaptureRecord['capturePermission']> = {
  'native-page': 'desktop-host-user-action',
  'native-region': 'desktop-host-user-action',
  upload: 'user-supplied-file',
  paste: 'user-supplied-file',
  'screen-share': 'browser-display-media',
};

export interface CaptureServiceDeps {
  dataDir: string;
  bytes: CaptureBytesPort;
  now?: () => Date;
}

/**
 * AC-R14.1 capture persistence. Bytes come only from the request body (the
 * user's host compositor, file or granted screen frame); this service never
 * fetches a URL. A record is written once and never changed.
 */
export function createCaptureService(deps: CaptureServiceDeps) {
  const store = createCaptureStore(deps.dataDir);
  const now = deps.now ?? (() => new Date());
  const locks = new Map<string, Promise<unknown>>();
  // Records are immutable and only this service creates them, so a per-project
  // hash index built once from disk stays correct for the daemon's lifetime.
  const hashIndex = new Map<string, Promise<Set<string>>>();
  const hashesFor = (projectId: string) => {
    let index = hashIndex.get(projectId);
    if (!index) { index = store.list(projectId).then(records => new Set(records.map(record => record.contentHash))); hashIndex.set(projectId, index); }
    return index;
  };

  function view(record: CaptureRecord, bytesAvailable: boolean): CaptureView {
    return { capture: record, bytesAvailable, imageUrl: `/api/workbench/captures/${record.id}/image?projectId=${encodeURIComponent(record.projectId)}` };
  }
  async function available(record: CaptureRecord): Promise<boolean> {
    if (deps.bytes.has) return deps.bytes.has(record.assetId, record.contentHash);
    const bytes = await deps.bytes.read(record.assetId);
    return bytes !== null && createHash('sha256').update(bytes).digest('hex') === record.contentHash;
  }

  function validate(metadata: CaptureImportMetadata, body: Buffer, declaredType: string) {
    if (body.length === 0) throw new CaptureError(400, 'empty-body', 'Send the captured image bytes as the request body');
    if (body.length > WORKBENCH_CAPTURE_MAX_BYTES) throw new CaptureError(413, 'capture-too-large', `A capture is at most ${WORKBENCH_CAPTURE_MAX_BYTES} bytes`);
    const raster = sniffRaster(body);
    if (!raster) throw new CaptureError(422, 'not-a-raster-image', 'The body is not a PNG, JPEG or WebP image');
    if (raster.mediaType !== declaredType) throw new CaptureError(422, 'media-type-mismatch', `The bytes are ${raster.mediaType}, not ${declaredType}`);
    const expected = metadata.region ?? metadata.frame;
    if (Math.abs(raster.width - expected.width) > 1 || Math.abs(raster.height - expected.height) > 1) {
      throw new CaptureError(422, metadata.region ? 'region-scale-mismatch' : 'frame-size-mismatch', `The image is ${raster.width}×${raster.height} pixels but the ${metadata.region ? 'region' : 'frame'} declares ${expected.width}×${expected.height}`);
    }
    if (metadata.viewport) {
      const { width, height, deviceScaleFactor: scale } = metadata.viewport;
      if (Math.abs(width * scale - metadata.frame.width) > SCALE_SLACK || Math.abs(height * scale - metadata.frame.height) > SCALE_SLACK) {
        throw new CaptureError(422, 'viewport-scale-mismatch', 'The frame must equal the viewport times its device scale factor');
      }
    }
    return raster;
  }

  async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = locks.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(task);
    locks.set(key, run);
    try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
  }

  async function importCapture(input: { metadata: CaptureImportMetadata; body: Buffer; mediaType: string; idempotencyKey: string; surface: WorkbenchDeclarationSurface }): Promise<{ created: boolean; view: CaptureView }> {
    const raster = validate(input.metadata, input.body, input.mediaType);
    let body: Buffer;
    try { body = stripRasterMetadata(input.body); }
    catch { throw new CaptureError(422, 'invalid-image-container', 'The image metadata could not be safely removed; export a fresh PNG, JPEG or WebP and retry'); }
    const contentHash = createHash('sha256').update(body).digest('hex');
    const digest = createHash('sha256').update(JSON.stringify({ metadata: input.metadata, contentHash })).digest('hex');
    const { projectId } = input.metadata;
    return serialized(`${projectId}\u0000${input.idempotencyKey}`, async () => {
      const prior = await store.findByKey(projectId, input.idempotencyKey);
      if (prior) {
        if (prior.digest !== digest) throw new CaptureError(409, 'idempotency-conflict', 'This Idempotency-Key was used for a different capture');
        const record = await store.read(projectId, prior.captureId);
        if (!record) throw new CaptureError(409, 'idempotency-conflict', 'The capture for this Idempotency-Key is no longer readable');
        return { created: false, view: view(record, await available(record)) };
      }
      if (input.metadata.parentCaptureId && !await store.read(projectId, input.metadata.parentCaptureId)) {
        throw new CaptureError(422, 'parent-capture-unknown', 'The parent capture does not exist in this project');
      }
      const { assetId } = await deps.bytes.put({ bytes: body, mediaType: raster.mediaType, projectId });
      const source = redactSourceUrl(input.metadata.sourceUrl);
      const record: CaptureRecord = {
        schema: 'workbench-capture/1',
        id: `cap_${randomBytes(15).toString('base64url')}`,
        assetId, projectId,
        captureMode: input.metadata.captureMode,
        sourceUrl: source.sourceUrl,
        sourceUrlRedacted: source.redacted,
        sourceTitle: input.metadata.sourceTitle ?? null,
        viewport: input.metadata.viewport ?? null,
        frame: input.metadata.frame,
        region: input.metadata.region ?? null,
        image: { mediaType: raster.mediaType, width: raster.width, height: raster.height, bytes: body.length },
        contentHash,
        capturePermission: PERMISSION[input.metadata.captureMode],
        rightsDeclaration: input.metadata.rightsDeclaration ?? null,
        rightsDeclaredVia: input.metadata.rightsDeclaration ? input.surface : null,
        parentCaptureId: input.metadata.parentCaptureId ?? null,
        createdAt: now().toISOString(),
      };
      await store.save(record);
      await store.saveKey(projectId, input.idempotencyKey, record.id, digest);
      (await hashesFor(projectId)).add(contentHash);
      return { created: true, view: view(record, true) };
    });
  }

  async function list(projectId: string, cursor?: string): Promise<CaptureList> {
    const offset = cursor === undefined ? 0 : Number(/^o([0-9]{1,6})$/u.exec(cursor)?.[1] ?? Number.NaN);
    if (!Number.isInteger(offset) || offset < 0) throw new CaptureError(400, 'cursor-invalid', 'Unknown cursor');
    const records = await store.list(projectId);
    const page = records.slice(offset, offset + PAGE_SIZE);
    const captures = await Promise.all(page.map(async record => view(record, await available(record))));
    return { projectId, captures, nextCursor: offset + PAGE_SIZE < records.length ? `o${offset + PAGE_SIZE}` : null };
  }

  async function read(projectId: string, captureId: string): Promise<CaptureRecord | null> { return store.read(projectId, captureId); }

  async function show(projectId: string, captureId: string): Promise<CaptureView> {
    const record = await store.read(projectId, captureId);
    if (!record) throw new CaptureError(404, 'capture-not-found', 'No such capture in this project');
    return view(record, await available(record));
  }

  async function image(projectId: string, captureId: string): Promise<{ record: CaptureRecord; bytes: Buffer }> {
    const record = await store.read(projectId, captureId);
    if (!record) throw new CaptureError(404, 'capture-not-found', 'No such capture in this project');
    const bytes = await deps.bytes.read(record.assetId);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== record.contentHash) throw new CaptureError(410, 'capture-bytes-removed', 'The captured image bytes were removed; the record remains');
    return { record, bytes };
  }

  /** True when bytes with this hash were saved as a capture in the project (captured third-party content). */
  async function hasContentHash(projectId: string, contentHash: string): Promise<boolean> {
    return (await hashesFor(projectId)).has(contentHash);
  }

  return { import: importCapture, list, read, show, image, hasContentHash };
}
export type CaptureService = ReturnType<typeof createCaptureService>;
