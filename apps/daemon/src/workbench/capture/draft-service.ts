import { createHash, randomBytes } from 'node:crypto';
import { load } from 'cheerio';
import { parseCaptureDraftRevision, parseCaptureDraftModelOutput, type CaptureDraftRevision, type CaptureRecord, type CreateCaptureDraftRequest } from '@mish/contracts';
import type { CaptureService } from './capture-service.js';
import { createCaptureDraftStore } from './draft-store.js';
import { stripRasterMetadata } from './image-metadata.js';
import { analyzeHtml } from '../units/unit-analysis.js';
import { findSecrets } from '../units/secret-scan.js';
import { UnitError, type UnitSourceFile } from '../units/unit-files.js';

export interface CaptureDraftGenerator {
  modelId: string;
  available(): Promise<boolean>;
  generate(input: { capture: CaptureRecord; image: Buffer; prompt: string; currentHtml?: string }, signal: AbortSignal): Promise<{ html: string; assumptions: string[] }>;
}
export class CaptureDraftError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422 | 503, readonly code: string, message: string) { super(message); }
}
export interface DraftUnitSource { projectId: string; captureId: string; revisionId: string; files: UnitSourceFile[] }
export interface CaptureDraftServiceDeps { dataDir: string; captures: CaptureService; generator: CaptureDraftGenerator; timeoutMs?: number }
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
const HIDDEN = 'Hidden behavior is not recoverable from pixels; only explicitly requested actions are implemented.';

/** A self-contained draft cannot import captured rasters or fetch remote source bytes. */
function validateOutput(raw: unknown): { html: string; assumptions: string[] } {
  const output = parseCaptureDraftModelOutput(raw);
  const $ = load(output.html);
  if (!$('body').children().length || [output.html, ...output.assumptions].some(value => findSecrets(value).length)) throw new Error('invalid output');
  const analysis = analyzeHtml(output.html, 'index.html', 'body');
  if (analysis.localRefs.size || analysis.dependencies.length || analysis.unresolved.length) throw new Error('external output');
  // URLs in CSS, inline JS and markup are all untrusted. Drafts use authored SVG/CSS placeholders.
  // Inspect parsed markup so HTML entities cannot hide a data URL. The SVG
  // namespace is a type identifier, never a fetched resource. Encoded SVG data
  // URLs are refused too: they can conceal a captured raster inside an image.
  $('svg').removeAttr('xmlns');
  // URL parsing removes ASCII tabs and newlines, including decoded entities.
  // Cheerio re-encodes quotes when serializing inline handlers. Include the
  // decoded attribute values so bracket member access remains inspectable.
  const entries = $('*').toArray().flatMap(element => Object.entries($(element).attr() ?? {}));
  const attributes = entries.map(([, value]) => value);
  const markup = [$.html(), ...attributes].join(' ').replace(/[\t\r\n]/gu, '');
  const scripts = [...$('script').toArray().map(element => $(element).text()), ...entries.filter(([name]) => /^on/iu.test(name)).map(([, value]) => value)].join('\n');
  // Decode CSS escapes before checking resource URLs and imports.
  const css = [...$('style').toArray().map(element => $(element).text()), ...entries.filter(([name]) => name === 'style').map(([, value]) => value)].join('\n')
    .replace(/\\(?:([0-9a-f]{1,6})\s?|([^\r\n]))/giu, (_, hex: string | undefined, char: string | undefined) => {
      if (!hex) return char ?? '';
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
    });
  if (/\b(?:https?|file|ftp|data|javascript):/iu.test(markup + css)) throw new Error('external output');
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(|\bsendBeacon\b|\b(?:window|top|self|parent|globalThis)\s*(?:(?:\?\.)?\s*\[\s*["']open["']\s*\]|(?:\?\.|\.)\s*open\b)/iu.test(scripts)) throw new Error('external output');
  // The preview sandbox does not protect exported source. Refuse navigation
  // sinks even with relative targets, and scheme-relative URLs in JS/CSS/HTML.
  if (/\blocation\s*(?:=(?!=)|(?:\?\.)?\s*\[|(?:\?\.|\.)\s*(?:href|assign|replace)\b)|\[\s*["']location["']\s*\]/iu.test(scripts)) throw new Error('external output');
  const externalUrl = /(?:["'`(=]|^)\s*\/\/[^\s/"'`)]/iu;
  if (externalUrl.test(scripts) || externalUrl.test(css) || /@import\b/iu.test(css)
    || attributes.some(value => /^[\/\\]{2}/u.test(value.replace(/[\t\r\n]/gu, '').replace(/^[\u0000-\u0020]+/u, '')))) throw new Error('external output');
  if ($('base,iframe,object,embed,meta[http-equiv="refresh"],link').length) throw new Error('embedded resource');
  return { html: output.html, assumptions: [...new Set([...output.assumptions, HIDDEN])].slice(0, 32) };
}

/** AC-R14.2: daemon writes every request before generation; terminal revisions are never replaced. */
export function createCaptureDraftService(deps: CaptureDraftServiceDeps) {
  const store = createCaptureDraftStore(deps.dataDir);
  const jobs = new Map<string, { principal: string; done: Promise<void> }>();
  const locks = new Map<string, Promise<unknown>>();
  const jobKey = (principal: string, id: string, revision: number) => `${principal}\0${id}\0${revision}`;
  async function serialized<T>(principal: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(principal) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task); locks.set(principal, current);
    try { return await current; } finally { if (locks.get(principal) === current) locks.delete(principal); }
  }
  const failure = (record: CaptureDraftRevision, reason: string, message: string, recovery: string): CaptureDraftRevision => ({ ...record, html: null, outputSha256: null, status: 'failed', failure: { reason, message, recovery } });
  async function read(principal: string, projectId: string, id: string, revision: number): Promise<CaptureDraftRevision> {
    const record = await store.read(principal, id, revision);
    if (!record || record.projectId !== projectId) throw new CaptureDraftError(404, 'draft-not-found', 'No such capture draft revision');
    if (record.status !== 'pending' || jobs.has(jobKey(principal, id, revision))) return record;
    const interrupted = failure(record, 'draft-interrupted', 'Generation stopped before this revision was saved.', 'Create a new draft from the saved capture, or iterate on a ready revision.');
    await store.complete(principal, interrupted);
    return (await store.read(principal, id, revision))!;
  }
  async function generate(principal: string, record: CaptureDraftRevision, currentHtml?: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 180_000); timer.unref();
    try {
      if (!await deps.generator.available()) {
        await store.complete(principal, failure(record, 'draft-generator-unavailable', 'The Claude Code subscription lane is unavailable.', 'Install Claude Code and sign in to Max, then create a new draft.')); return;
      }
      const { record: capture, bytes: image } = await deps.captures.image(record.projectId, record.captureId);
      let raw;
      try { raw = await deps.generator.generate({ capture, image: stripRasterMetadata(image), prompt: record.prompt, ...(currentHtml ? { currentHtml } : {}) }, controller.signal); }
      catch { await store.complete(principal, failure(record, controller.signal.aborted ? 'draft-timeout' : 'draft-generation-failed', 'The draft generator did not finish.', 'Retry from this saved capture. Your earlier revisions are retained.')); return; }
      if (controller.signal.aborted) throw new Error('timeout');
      let output;
      try { output = validateOutput(raw); }
      catch { await store.complete(principal, failure(record, 'draft-output-invalid', 'The answer was not a self-contained editable draft.', 'Request a standalone draft with CSS or SVG placeholders and no imported assets, then retry.')); return; }
      await store.complete(principal, parseCaptureDraftRevision({ ...record, ...output, outputSha256: hash(output.html), status: 'ready' }));
    } catch { await store.complete(principal, failure(record, 'draft-generation-failed', 'The capture could not be used to finish this draft.', 'Check that the saved capture is still available, then retry.')); }
    finally { clearTimeout(timer); }
  }
  async function create(principal: string, request: CreateCaptureDraftRequest, idempotencyKey: string): Promise<{ created: boolean; draft: CaptureDraftRevision }> {
    if (findSecrets(request.prompt).length) throw new CaptureDraftError(422, 'draft-prompt-secret', 'Remove credentials from the draft instructions before generating.');
    return serialized(principal, async () => {
      const digest = hash(JSON.stringify(request));
      const key = await store.key(principal, idempotencyKey);
      if (key) {
        if (key.digest !== digest) throw new CaptureDraftError(409, 'idempotency-conflict', 'This key already names a different draft request');
        return { created: false, draft: await read(principal, request.projectId, key.draftId, key.revision) };
      }
      if ([...jobs.values()].filter(job => job.principal === principal).length >= 3) throw new CaptureDraftError(503, 'draft-capacity-reached', 'Three of your drafts are already generating; wait for one to finish');
      await deps.captures.image(request.projectId, request.captureId);
      let currentHtml: string | undefined;
      let draftId = `draft_${randomBytes(15).toString('base64url')}`;
      let revision = 1;
      if (request.parent) {
        const parent = await read(principal, request.projectId, request.parent.draftId, request.parent.revision);
        const revisions = await Promise.all((await store.revisions(principal, parent.draftId)).map(record => read(principal, request.projectId, record.draftId, record.revision)));
        const latest = revisions.at(-1)!;
        const latestReady = revisions.filter(record => record.status === 'ready').at(-1);
        if (parent.status !== 'ready' || latestReady?.revision !== parent.revision || latest.status === 'pending' || parent.captureId !== request.captureId) throw new CaptureDraftError(409, 'draft-revision-conflict', 'Iterate on the latest ready revision of this capture');
        if (latest.revision >= 500) throw new CaptureDraftError(422, 'draft-history-full', 'This draft has 500 revisions; create a new draft from the capture');
        draftId = parent.draftId; revision = latest.revision + 1; currentHtml = parent.html!;
      }
      const draft = parseCaptureDraftRevision({ schema: 'capture-draft/1', draftId, projectId: request.projectId, captureId: request.captureId, revision, parentRevision: request.parent?.revision ?? null,
        createdAt: new Date().toISOString(), status: 'pending', prompt: request.prompt, html: null, outputSha256: null, assumptions: [], failure: null,
        generator: { provider: 'claude-max', modelId: deps.generator.modelId, billingLane: 'max-subscription' } });
      const keyName = jobKey(principal, draftId, revision);
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      // Reserve before any awaited write can expose this request to polling.
      jobs.set(keyName, { principal, done });
      const release = () => { jobs.delete(keyName); finish(); };
      try {
        if (!await store.request(principal, draft)) throw new CaptureDraftError(409, 'draft-revision-conflict', 'This revision already exists');
        await store.saveKey(principal, idempotencyKey, { digest, draftId, revision });
        void generate(principal, draft, currentHtml).catch(() => undefined).finally(release);
      } catch (error) { release(); throw error; }
      return { created: true, draft };
    });
  }
  async function unitSource(principal: string, id: string, revision: number): Promise<DraftUnitSource> {
    const record = await store.read(principal, id, revision);
    if (!record) throw new UnitError(404, 'draft-not-found', 'No such draft revision');
    const ready = await read(principal, record.projectId, id, revision);
    if (ready.status !== 'ready') throw new UnitError(422, 'draft-not-ready', 'Only a ready draft revision can be saved as a unit');
    return { projectId: ready.projectId, captureId: ready.captureId, revisionId: `${id}:${revision}`, files: [{ path: 'index.html', bytes: Buffer.from(ready.html!), sha256: ready.outputSha256!, mediaType: 'text/html' }] };
  }
  return {
    create, read, unitSource,
    async projectId(principal: string, id: string, revision: number) { const record = await store.read(principal, id, revision); if (!record) throw new CaptureDraftError(404, 'draft-not-found', 'No such draft revision'); return record.projectId; },
    async list(principal: string, projectId: string) { return { drafts: await Promise.all((await store.list(principal, projectId)).map(record => read(principal, projectId, record.draftId, record.revision))) }; },
    async settled(principal: string, projectId: string, id: string, revision: number) { await jobs.get(jobKey(principal, id, revision))?.done; return read(principal, projectId, id, revision); },
  };
}
export type CaptureDraftService = ReturnType<typeof createCaptureDraftService>;
