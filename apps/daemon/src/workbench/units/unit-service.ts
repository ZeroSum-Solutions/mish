import { createHash, randomBytes } from 'node:crypto';
import { load } from 'cheerio';
import {
  parseReusableUnitManifest, parseUnitSavePlan, WORKBENCH_UNIT_STANDALONE_TARGET_KINDS,
  type UnitInsertRequest, type CaptureRecord, type ReusableUnitManifest, type UnitSavePlan, type UnitSaveRequest, type WorkbenchDeclarationSurface,
} from '@mish/contracts';
import { analyzeCss, analyzeHtml, analyzeJs, emptyAnalysis, mergeAnalysis } from './unit-analysis.js';
import { isEditableSource, readUnitSourceFiles, UnitError, type UnitSourceFile } from './unit-files.js';
import { computeRights } from './unit-rights.js';
import { findSecrets, secretBearingFileName, textLike } from './secret-scan.js';
import type { PlacementProjectWrites } from '../placement/project-writes.js';
import { createUnitInsertion } from './unit-insert.js';
import { createUnitStore, unitObjectId } from './unit-store.js';
import { sniffRaster } from '../capture/image.js';
import { stripRasterMetadata } from '../capture/image-metadata.js';
import type { DraftUnitSource } from '../capture/draft-service.js';

export { UnitError } from './unit-files.js';

export type ThumbnailResult = { png: Buffer } | { unavailable: string };

export interface UnitServiceDeps {
  dataDir: string;
  projectWrites?: PlacementProjectWrites;
  /** Absolute root of a project the caller is already authorized for, or null when it does not exist. */
  projectRoot(projectId: string): string | null;
  /** True when these bytes were saved as a capture (captured third-party content). */
  isCapturedBytes(projectId: string, sha256: string): Promise<boolean>;
  readCapture(projectId: string, captureId: string): Promise<CaptureRecord | null>;
  /** Immutable revision owned by this principal; all source bytes are verified before returning. */
  readDraft?(principalId: string, draftId: string, revision: number): Promise<DraftUnitSource>;
  /** Render the unit entry from a staged copy of its stored files, isolated from the network and the daemon. */
  renderThumbnail(stagedRoot: string, entry: string): Promise<ThumbnailResult>;
  now?: () => Date;
}

type ProjectSource = Extract<UnitSaveRequest['source'], { kind: 'project' }>;
const BLOCKER_ORDER: UnitSavePlan['blockers'][number]['code'][] = [
  'entry-missing', 'root-not-found', 'entry-excluded', 'closure-incomplete', 'secret-detected', 'unpinned-dependency', 'exclusion-unacknowledged', 'rights-blocked',
];
const THUMBNAIL_TIMEOUT_MS = 60_000;

function roleFor(file: UnitSourceFile, entry: string | null): UnitSavePlan['files'][number]['role'] {
  if (file.path === entry) return 'entry';
  if (/(?:^|\/)(?:LICENSE|LICENCE|NOTICE|COPYING)(?:\.[A-Za-z]+)?$/u.test(file.path)) return 'notice';
  if (file.mediaType === 'text/html') return 'markup';
  if (file.mediaType === 'text/css') return 'style';
  if (file.mediaType === 'text/javascript') return 'script';
  return 'asset';
}

/**
 * AC-R14.3 reusable-unit save (html-css-js through the standalone
 * html-artifact/v1 adapter). Saving copies the user-selected project files
 * into daemon-owned storage with their rights and lineage. It never installs a
 * dependency, never writes the project and never keeps captured third-party
 * bytes without an explicit, path-scoped ownership declaration.
 */
export function createUnitService(deps: UnitServiceDeps) {
  const store = createUnitStore(deps.dataDir);
  const now = deps.now ?? (() => new Date());
  const insertion = createUnitInsertion({ dataDir: deps.dataDir, projectRoot: deps.projectRoot, store, ...(deps.projectWrites ? { projectWrites: deps.projectWrites } : {}), now });
  const locks = new Map<string, Promise<unknown>>();

  async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = locks.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(task);
    locks.set(key, run);
    try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
  }

  async function sourceFiles(request: UnitSaveRequest, principalId: string): Promise<{ source: ProjectSource; files: UnitSourceFile[]; draft?: DraftUnitSource }> {
    if (request.source.kind === 'project') {
      const root = deps.projectRoot(request.source.projectId);
      if (!root) throw new UnitError(404, 'project-not-found', 'No such project');
      return { source: request.source, files: await readUnitSourceFiles(root, request.source.paths) };
    }
    if (!deps.readDraft) throw new UnitError(422, 'unsupported-capability', 'This daemon has no capture-draft source adapter');
    const draft = await deps.readDraft(principalId, request.source.draftId, request.source.revision);
    const rootSelector = request.source.rootSelector;
    const files = draft.files.map(file => {
      if (file.mediaType !== 'text/html' || rootSelector === 'body' || rootSelector === 'html') return file;
      const $ = load(file.bytes.toString('utf8'));
      let selected;
      try { selected = $(rootSelector); } catch { throw new UnitError(422, 'root-not-found', 'Choose a valid CSS selector', [file.path]); }
      if (selected.length !== 1 || selected[0]?.type !== 'tag' || selected.is('head,script,style,meta,link,base')) throw new UnitError(422, 'root-not-found', 'Choose exactly one output region', [file.path]);
      const ownedScripts = new Set(selected.find('script').toArray());
      if ($('script').toArray().some(script => !ownedScripts.has(script))) throw new UnitError(422, 'region-script-dependency', 'This region depends on scripts outside its root. Save body as a page, or iterate to make the region self-contained before saving.', [file.path]);
      const markup = $.html(selected);
      $('body').html(markup);
      const bytes = Buffer.from($.html());
      return { ...file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    return { draft, files, source: { kind: 'project', projectId: draft.projectId, entry: 'index.html', paths: files.map(file => file.path), rootSelector, expectedHashes: Object.fromEntries(files.map(file => [file.path, file.sha256])) } };
  }

  async function inspect(request: UnitSaveRequest, principalId: string, surface: WorkbenchDeclarationSurface): Promise<{ plan: UnitSavePlan; files: UnitSourceFile[]; source: ProjectSource; draft?: DraftUnitSource }> {
    const { source, files, draft } = await sourceFiles(request, principalId);
    const htmlFiles = files.filter(file => file.mediaType === 'text/html').map(file => file.path);
    const entry = source.entry ?? (htmlFiles.length === 1 ? htmlFiles[0]! : null);
    const excluded = new Set(request.excludePaths ?? []);
    const blockers: UnitSavePlan['blockers'] = [];
    const warnings: string[] = [];

    const captured = new Map<string, boolean>();
    // Any listed file can be captured third-party content: a screenshot, or markup clipped from a page.
    for (const file of files) {
      // Raw hashes retain older capture identity. New captures strip metadata,
      // so compare the same normalized raster bytes for original project files.
      let matches = await deps.isCapturedBytes(source.projectId, file.sha256);
      if (!matches && sniffRaster(file.bytes)) {
        let normalized: string | undefined;
        try {
          normalized = createHash('sha256').update(stripRasterMetadata(file.bytes)).digest('hex');
        } catch { /* Invalid rasters cannot match a new sanitized capture; raw identity was checked above. */ }
        // An unavailable authoritative lookup must fail the operation.
        if (normalized !== undefined && normalized !== file.sha256) matches = await deps.isCapturedBytes(source.projectId, normalized);
      }
      captured.set(file.path, matches);
    }
    const declaredOwned = (relPath: string) => Boolean(request.rightsDeclaration?.scope?.paths?.includes(relPath) && ['user-owned', 'licensed'].includes(request.rightsDeclaration.basis));
    const proposedExclusions = files.filter(file => captured.get(file.path) && !declaredOwned(file.path));
    const unacknowledged = proposedExclusions.filter(file => !excluded.has(file.path)).map(file => file.path);
    const included = files.filter(file => !excluded.has(file.path) && !proposedExclusions.some(other => other.path === file.path));
    const excludedFiles: UnitSavePlan['excludedFiles'] = files
      .filter(file => !included.includes(file))
      .map(file => ({ path: file.path, sha256: file.sha256, reason: captured.get(file.path) && !declaredOwned(file.path) ? 'captured-third-party' as const : 'user-excluded' as const }));
    if (unacknowledged.length) blockers.push({ code: 'exclusion-unacknowledged', message: 'Captured third-party files are left out of the unit; acknowledge each exclusion, or declare that you own or license that exact file', paths: unacknowledged });

    let rootFound = false; let rootCandidates: string[] = [];
    const analysis = emptyAnalysis();
    if (!entry) blockers.push({ code: 'entry-missing', message: 'Name the entry HTML file; the selection has none or several', paths: htmlFiles });
    else if (files.some(file => file.path === entry) && !included.some(file => file.path === entry)) {
      blockers.push({ code: 'entry-excluded', message: 'The entry file is excluded (captured third-party markup or your exclusion); a unit needs its own entry', paths: [entry] });
    }
    for (const file of included) {
      // Every persisted file is checked, not only editable sources: a .env, JSON or YAML file is copied as-is.
      const scanned = textLike(file.bytes);
      const secrets = scanned === null ? [] : findSecrets(scanned);
      if (secrets.length) blockers.push({ code: 'secret-detected', message: `${file.path} contains what looks like a credential (${[...new Set(secrets.map(secret => `${secret.kind} on line ${secret.line}`))].slice(0, 5).join(', ')}); remove it before saving`, paths: [file.path] });
      else if (secretBearingFileName(file.path)) blockers.push({ code: 'secret-detected', message: `${file.path} is a secret-bearing file type (dotenv, private key or keystore); a unit never stores one`, paths: [file.path] });
      if (!isEditableSource(file.mediaType)) continue;
      const text = file.bytes.toString('utf8');
      if (file.mediaType === 'text/html') {
        const html = analyzeHtml(text, file.path, file.path === entry ? source.rootSelector : null);
        if (file.path === entry) {
          rootFound = html.rootFound; rootCandidates = html.rootCandidates;
          if (!html.rootFound) blockers.push({ code: 'root-not-found', message: html.rootError ?? `No element matches ${source.rootSelector} in ${entry}`, paths: [entry] });
        }
        mergeAnalysis(analysis, html);
      } else if (file.mediaType === 'text/css') mergeAnalysis(analysis, analyzeCss(text, file.path));
      else mergeAnalysis(analysis, analyzeJs(text, file.path));
    }
    if (entry && !files.some(file => file.path === entry)) blockers.push({ code: 'entry-missing', message: `${entry} is not among the listed files`, paths: [entry] });
    const listed = new Set(source.paths);
    const missingReferences = [...analysis.localRefs].filter(ref => !listed.has(ref)).sort();
    if (missingReferences.length) blockers.push({ code: 'closure-incomplete', message: 'The unit references local files that are not selected', paths: missingReferences.slice(0, 200) });
    if (analysis.unresolved.length) warnings.push(`References that cannot resolve inside the project are kept as written: ${analysis.unresolved.slice(0, 5).join(', ')}`.slice(0, 500));
    const unpinned = analysis.dependencies.filter(dep => dep.version === 'unpinned');
    if (unpinned.length) blockers.push({ code: 'unpinned-dependency', message: `${unpinned.map(dep => dep.url ?? dep.name).slice(0, 3).join(', ')} is not pinned to an exact version; a unit may not load unpinned remote code`.slice(0, 500), paths: [...new Set(unpinned.map(dep => dep.referencedFrom))] });
    if (analysis.dependencies.length) warnings.push('Dependencies are recorded for review; saving never installs them.');
    const referenced = new Set([...analysis.localRefs, ...(entry ? [entry] : [])]);
    const unreferenced = included.filter(file => !referenced.has(file.path) && file.mediaType !== 'text/html').map(file => file.path);
    if (unreferenced.length) warnings.push(`Selected but not referenced: ${unreferenced.slice(0, 5).join(', ')}`.slice(0, 500));

    const { rights, operationRights } = computeRights({ files: included.map(file => ({ path: file.path, captured: Boolean(captured.get(file.path)) })), declaration: request.rightsDeclaration, principalId, surface });
    const save = operationRights.find(right => right.operation === 'save-private-unit')!;
    if (save.decision !== 'allowed') blockers.push({ code: 'rights-blocked', message: save.reason ?? 'Saving a private unit is not permitted', paths: rights.files.filter(file => file.status === 'unknown' || file.status === 'reference-only').map(file => file.path) });

    blockers.sort((a, b) => BLOCKER_ORDER.indexOf(a.code) - BLOCKER_ORDER.indexOf(b.code));
    const plan = parseUnitSavePlan({
      schema: 'reusable-unit-plan/1', format: 'html-css-js', entry, rootSelector: source.rootSelector, rootFound, rootCandidates,
      files: files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.length, mediaType: file.mediaType, role: roleFor(file, entry), included: included.includes(file) })),
      excludedFiles, missingReferences: missingReferences.slice(0, 400),
      dependencies: analysis.dependencies.slice(0, 100),
      capabilities: [...analysis.capabilities].sort(),
      rights, operationRights, blockers, warnings: warnings.slice(0, 50),
    });
    return { plan, files, source, ...(draft ? { draft } : {}) };
  }

  async function plan(request: UnitSaveRequest, principalId: string, surface: WorkbenchDeclarationSurface = 'http'): Promise<UnitSavePlan> {
    return (await inspect(request, principalId, surface)).plan;
  }

  async function thumbnail(manifestFiles: Array<{ path: string; bytes: Buffer }>, entry: string, captureRecord: CaptureRecord | null): Promise<ReusableUnitManifest['thumbnail']> {
    const staged = await store.stage(manifestFiles);
    let result: ThumbnailResult;
    try {
      result = await Promise.race([
        deps.renderThumbnail(staged.dir, entry),
        new Promise<ThumbnailResult>(resolve => setTimeout(() => resolve({ unavailable: 'Rendering the thumbnail timed out' }), THUMBNAIL_TIMEOUT_MS).unref()),
      ]);
    } catch (error) {
      result = { unavailable: `Rendering the thumbnail failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}` };
    } finally { await staged.dispose(); }
    if ('png' in result) {
      const raster = sniffRaster(result.png);
      if (raster?.mediaType === 'image/png') {
        const sha256 = await store.putObject(result.png);
        return { source: 'rendered', assetId: unitObjectId(sha256), sha256, width: raster.width, height: raster.height };
      }
      result = { unavailable: 'The renderer did not return a PNG' };
    }
    if (captureRecord) return { source: 'capture', captureId: captureRecord.id, assetId: captureRecord.assetId };
    return { source: 'unavailable', reason: result.unavailable.slice(0, 500) || 'Thumbnail unavailable' };
  }

  async function save(request: UnitSaveRequest, principalId: string, idempotencyKey: string, surface: WorkbenchDeclarationSurface = 'http'): Promise<{ created: boolean; manifest: ReusableUnitManifest }> {
    if (request.source.kind === 'project' && !request.source.expectedHashes) throw new UnitError(422, 'expected-hashes-required', 'Saving needs the SHA-256 of every listed file from a plan');
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return serialized(`${principalId}\u0000${idempotencyKey}`, async () => {
      const prior = await store.findByKey(principalId, idempotencyKey);
      if (prior) {
        if (prior.digest !== digest) throw new UnitError(409, 'idempotency-conflict', 'This Idempotency-Key was used for a different save');
        const manifest = await store.readManifest(principalId, prior.unitId);
        if (!manifest) throw new UnitError(409, 'idempotency-conflict', 'The unit saved under this Idempotency-Key is no longer readable');
        return { created: false, manifest };
      }
      const { plan: inspected, files, source, draft } = await inspect(request, principalId, surface);
      const changed = files.filter(file => source.expectedHashes![file.path] !== file.sha256).map(file => file.path);
      if (changed.length) throw new UnitError(409, 'source-changed', 'Project files changed since they were reviewed; plan again', changed);
      const blocker = inspected.blockers[0];
      if (blocker) throw new UnitError(422, blocker.code, blocker.message, blocker.paths);
      if (draft && request.captureId && request.captureId !== draft.captureId) throw new UnitError(422, 'capture-lineage-mismatch', 'A draft must retain its original capture lineage');
      const captureId = draft?.captureId ?? request.captureId;
      const captureRecord = captureId ? await deps.readCapture(source.projectId, captureId) : null;
      if (captureId && !captureRecord) throw new UnitError(422, 'capture-unknown', 'The capture named as lineage does not exist in this project');
      for (const action of request.actions ?? []) {
        const entryFile = files.find(file => file.path === inspected.entry)!;
        let found = false;
        try { found = analyzeHtml(entryFile.bytes.toString('utf8'), entryFile.path, action.selector).rootFound; } catch { found = false; }
        if (!found) throw new UnitError(422, 'action-target-missing', `No element matches the action selector ${action.selector}`, [entryFile.path]);
      }

      const includedPaths = new Set(inspected.files.filter(file => file.included).map(file => file.path));
      const stored = files.filter(file => includedPaths.has(file.path));
      for (const file of stored) await store.putObject(file.bytes);
      const planned = new Map(inspected.files.map(file => [file.path, file]));
      const editable = stored.filter(file => planned.get(file.path)!.role !== 'asset');
      const assets = stored.filter(file => planned.get(file.path)!.role === 'asset');
      const manifest = parseReusableUnitManifest({
        schema: 'reusable-unit/1',
        unitId: `unit_${randomBytes(15).toString('base64url')}`,
        revision: 1,
        name: request.name, kind: request.kind, format: 'html-css-js', entry: inspected.entry, rootSelector: source.rootSelector,
        files: editable.map(file => ({ path: file.path, assetId: unitObjectId(file.sha256), sha256: file.sha256, mediaType: file.mediaType, role: planned.get(file.path)!.role })),
        assets: assets.map(file => ({ path: file.path, assetId: unitObjectId(file.sha256), sha256: file.sha256, role: file.mediaType.split('/')[0] || 'file' })),
        excludedFiles: inspected.excludedFiles,
        dependencies: inspected.dependencies,
        tokens: [...analyzeTokens(editable)],
        capabilities: inspected.capabilities,
        compatibility: { targetKinds: [...WORKBENCH_UNIT_STANDALONE_TARGET_KINDS], adapterVersion: 'html-artifact/v1', inlineAdapters: [] },
        actions: (request.actions ?? []).map(action => ({ ...action, verificationProbeId: null })),
        provenance: {
          ...(captureRecord ? { captureId: captureRecord.id, captureAssetId: captureRecord.assetId } : {}),
          ...(draft ? { draftRevisionId: draft.revisionId } : {}),
          projectId: source.projectId,
          projectSourceHashes: Object.fromEntries(stored.map(file => [file.path, file.sha256])),
          sources: captureRecord?.sourceUrl ? [captureRecord.sourceUrl] : [],
        },
        operationRights: inspected.operationRights,
        rights: inspected.rights,
        thumbnail: await thumbnail(stored.map(file => ({ path: file.path, bytes: file.bytes })), inspected.entry!, captureRecord),
        previewArtifactId: null,
        verificationBundleId: null,
        principalId,
        createdAt: now().toISOString(),
      });
      await store.saveManifest(manifest);
      await store.saveKey(principalId, idempotencyKey, manifest.unitId, digest);
      return { created: true, manifest };
    });
  }

  function analyzeTokens(files: UnitSourceFile[]): Array<{ name: string; fallback: string }> {
    const analysis = emptyAnalysis();
    for (const file of files) {
      const text = file.bytes.toString('utf8');
      if (file.mediaType === 'text/css') mergeAnalysis(analysis, analyzeCss(text, file.path));
      else if (file.mediaType === 'text/html') mergeAnalysis(analysis, analyzeHtml(text, file.path, null));
    }
    return [...analysis.tokens].slice(0, 200).map(([name, fallback]) => ({ name, fallback }));
  }

  async function show(principalId: string, unitId: string): Promise<ReusableUnitManifest> {
    const manifest = await store.readManifest(principalId, unitId);
    if (!manifest) throw new UnitError(404, 'unit-not-found', 'No such unit');
    return manifest;
  }

  async function file(principalId: string, unitId: string, relPath: string): Promise<{ bytes: Buffer; mediaType: string }> {
    const manifest = await show(principalId, unitId);
    const entry = [...manifest.files, ...manifest.assets.map(asset => ({ ...asset, mediaType: 'application/octet-stream' }))].find(item => item.path === relPath);
    if (!entry) throw new UnitError(404, 'unit-file-not-found', 'The unit has no such stored file');
    const bytes = await store.readObject(entry.sha256);
    if (!bytes) throw new UnitError(404, 'unit-file-missing', 'The stored bytes are missing');
    return { bytes, mediaType: entry.mediaType };
  }

  async function thumbnailBytes(principalId: string, unitId: string): Promise<Buffer> {
    const manifest = await show(principalId, unitId);
    if (manifest.thumbnail.source !== 'rendered') throw new UnitError(404, 'thumbnail-not-rendered', 'This unit has no rendered thumbnail');
    const bytes = await store.readObject(manifest.thumbnail.sha256);
    if (!bytes) throw new UnitError(404, 'unit-file-missing', 'The stored thumbnail is missing');
    return bytes;
  }

  return { ...insertion, insert: async (principal: string, unitId: string, request: UnitInsertRequest, key: string) => insertion.insert(principal, await show(principal, unitId), request, key), plan, save, list: (principalId: string) => store.list(principalId), show, file, thumbnail: thumbnailBytes };
}
export type UnitService = ReturnType<typeof createUnitService>;
