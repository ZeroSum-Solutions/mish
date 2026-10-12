import path from 'node:path';
import {
  RESOURCE_SOURCE_IDS, parseCatalogueAdoptionRequest, parseCatalogueSaveRequest, parsePrepareAdoptionRequest,
  type CatalogueAdoptionReport, type CatalogueSavedUnit, type CatalogueAdoptionResponse, type CatalogueReplacementReview, type CatalogueTargetRefusal, type CatalogueTargetReport, type PreparedAdoptionPlan, type PrepareAdoptionRequest, type ResourceRef,
} from '@mish/contracts';
import { resourceRefKey } from '../context-ranking.js';
import { AdoptionError, type PlacementAdoptionExecutor } from '../placement/adoption-executor.js';
import { sha256 } from '../placement/adoption-files.js';
import { digestOf, type SourceAdmission } from '../placement/adoption-plan.js';
import type { CatalogueHelper, CatalogueMaterial, CatalogueMaterialSource } from './catalogue-material.js';
import { checkDependencies } from './dependency-report.js';
import { checkReactTarget, detectProjectTarget, type ProjectTargetContext } from '../targets/react/detect.js';
import { compareVersions, parseVersion, rangeLowerBound, type InstalledPackage } from './installed-packages.js';
import { checkG02ReactReceipt, g02CoveredReactMajors, type ReactReceiptCheck } from '../targets/react/receipt.js';
import { SavedUnitError, savedUnitView, type CatalogueSavedUnitStore, type SavedUnitRecord } from './saved-units.js';
import { lineDiff } from './replacement-diff.js';

export type { CatalogueMaterialSource } from './catalogue-material.js';

/** A typed adoption refusal that also carries what the user must see (dependency list, diff, current ref). */
export class CatalogueAdoptionError extends AdoptionError {
  constructor(status: 404 | 409 | 422, reason: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(status, reason, message);
    this.name = 'CatalogueAdoptionError';
  }
}
export interface CatalogueAdoptionDeps {
  /** `installedPackages` is optional: without it the React target and dependency minimums fail closed. */
  executor: Pick<PlacementAdoptionExecutor, 'prepare' | 'observe' | 'view' | 'readPlan'> & Partial<Pick<PlacementAdoptionExecutor, 'installedPackages'>>;
  /** Admitted catalogue sources. A source without an entry here stays reference-only. */
  materials: readonly CatalogueMaterialSource[];
  /**
   * G02 receipt gates per target adapter, given the resolved target. The
   * `react-source/v1` default is the committed production receipt and admits
   * only the React majors it covers; otherwise React apply refuses with 422
   * `target-receipt-pending`.
   */
  targetReceipts?: Partial<Record<'react-source/v1', (target: CatalogueTargetReport, sourceId: ResourceRef['sourceId']) => ReactReceiptCheck>>;
  /** React majors a validating receipt covers, reported with a refusal. Defaults to the committed receipt's. */
  coveredReactMajors?: (sourceId?: ResourceRef['sourceId']) => number[];
  /** W4 private saved units. Omitted: save and saved-unit prepare refuse 422 `saved-units-unprovisioned`. */
  savedUnits?: CatalogueSavedUnitStore;
}
const UNIT_ROLES = ['source', 'style', 'asset'] as const;
type UnitFile = { path: string; role: typeof UNIT_ROLES[number]; bytes: Buffer };
/** Directories from the target directory up to the project root (''), nearest first. */
function ancestorDirs(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    out.push(current);
    if (current === '') return out;
    const parent = path.posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
}
const inDir = (dir: string, name: string) => dir ? `${dir}/${name}` : name;
/** Longest common directory of project-relative paths ('' for the root). */
function commonDir(paths: readonly string[]): string {
  const parts = paths.map(p => path.posix.dirname(p).split('/').filter(part => part && part !== '.'));
  const first = parts[0] ?? [];
  let length = first.length;
  for (const other of parts) { let i = 0; while (i < length && other[i] === first[i]) i++; length = i; }
  return first.slice(0, length).join('/');
}
const SOURCE_TYPES: readonly ResourceRef['sourceType'][] = ['library', 'plugin', 'section', 'genui', 'font', 'skill', 'reference'];

/** Same canonical key as discovery; anything else is unknown, never guessed. */
export function decodeRefKey(key: string): ResourceRef {
  try {
    const value: unknown = JSON.parse(Buffer.from(key, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1 || !value.slice(1).every(part => typeof part === 'string' && part.length > 0)) throw new Error('shape');
    const ref = { sourceType: value[1], sourceId: value[2], itemId: value[3], revisionOrDigest: value[4] } as ResourceRef;
    if (!SOURCE_TYPES.includes(ref.sourceType) || !(RESOURCE_SOURCE_IDS as readonly string[]).includes(ref.sourceId) || resourceRefKey(ref) !== key) throw new Error('identity');
    return ref;
  } catch {
    throw new CatalogueAdoptionError(404, 'resource-ref-unknown', 'Resource reference is unknown or malformed; search again');
  }
}

/** The source file behind Copy code, available even when the placement executor is closed. */
export async function catalogueCodeForRef(key: string, materials: readonly CatalogueMaterialSource[]): Promise<string> {
  const ref = decodeRefKey(key);
  const source = materials.find(candidate => candidate.sourceId === ref.sourceId);
  if (!source) throw new CatalogueAdoptionError(422, 'reference-only', 'This source has no copyable code');
  const material = await source.materialize(ref.itemId);
  if (!material || material.ref.sourceType !== ref.sourceType || material.ref.sourceId !== ref.sourceId
    || material.ref.itemId !== ref.itemId || material.ref.revisionOrDigest !== ref.revisionOrDigest) {
    throw new CatalogueAdoptionError(409, 'resource-ref-stale', 'The source changed; inspect it again');
  }
  if (material.rights.status !== 'permitted') throw new CatalogueAdoptionError(422, 'reference-only', 'This source cannot be copied');
  const sourceFiles = material.files.filter(file => file.role === 'source');
  if (sourceFiles.length > 1) throw new CatalogueAdoptionError(422, 'multiple-source-files', 'This item has several code files; Copy code cannot provide a complete copy');
  const main = sourceFiles[0];
  if (!main) throw new CatalogueAdoptionError(422, 'no-files', 'This source has no copyable code');
  return main.bytes.toString('utf8');
}

/** A one-line marker in the entry's own comment syntax: the declared output of apply, removed exactly by undo. */
function adoptionMarker(entryPath: string, material: CatalogueMaterial, files: readonly string[]): string {
  const text = `od:adopted ${material.ref.sourceId}/${material.ref.itemId} ${material.ref.revisionOrDigest} files: ${files.join(', ')}`;
  const extension = path.posix.extname(entryPath).toLowerCase();
  if (['.html', '.htm', '.svg', '.xml', '.md', '.vue', '.svelte'].includes(extension)) return `<!-- ${text} -->`;
  if (['.css', '.scss', '.less'].includes(extension)) return `/* ${text} */`;
  return `// ${text}`;
}
const joinTarget = (targetDir: string, relative: string) => targetDir ? `${targetDir}/${relative}` : relative;

/**
 * AC-R04.3/AC-R04.4: prepares an F5 plan from one catalogue reference.
 * Order of gates: admitted source → permitted rights → current revision →
 * licence notice → saved unit identity (when reusing a saved unit) → target
 * adapter on the nearest package.json → target receipt → declared
 * dependencies → reviewed replacement. Every gate
 * refuses before anything is stored or written. Apply, readback and undo are
 * the executor's own operations; reuse in a second project is a second
 * prepare with its own plan, preimages and undo.
 */
export class CatalogueAdoptionManager {
  readonly #deps: CatalogueAdoptionDeps;
  constructor(deps: CatalogueAdoptionDeps) { this.#deps = deps; }

  async prepare(principalId: string, input: unknown): Promise<CatalogueAdoptionResponse> {
    const request = parseCatalogueAdoptionRequest(input);
    const ref = decodeRefKey(request.refKey);
    const material = await this.#admittedMaterial(ref, principalId);
    const saved = request.savedUnitId ? this.#savedUnitFor(principalId, request.savedUnitId, ref) : null;
    // W2: a reused unit's runtime assets are always the material's pinned bytes, whatever the record holds.
    const unitFiles: readonly { path: string; role: CatalogueMaterial['files'][number]['role']; bytes: Buffer }[] = saved ? pinAssets(saved.files, material) : material.files;
    const targetDir = request.targetDir ?? path.posix.dirname(request.entryPath).replace(/^\.$/u, '');
    const itemFiles = unitFiles.map(file => ({ ...file, path: joinTarget(targetDir, file.path) }));
    const anchor = itemFiles[0] ? path.posix.dirname(itemFiles[0].path).replace(/^\.$/u, '') : targetDir;
    const noticePath = joinTarget(anchor, `NOTICE.${material.ref.sourceId}-${material.ref.itemId}.md`);
    // G38: alias-imported helpers (Aceternity's `cn`) are supplied only when the project lacks them.
    const helpers = (material.helpers ?? []).map(helper => ({ helper, candidates: [helper.path, ...helper.alternatePaths].map(relative => joinTarget(targetDir, relative)) }));
    // W2: the nearest package.json from the target directory decides, bounded by the project root.
    const manifestDirs = ancestorDirs(targetDir);
    const observed = await this.#deps.executor.observe(request.projectId, [
      ...itemFiles.map(f => f.path), ...helpers.flatMap(h => h.candidates), noticePath, request.entryPath,
      ...manifestDirs.flatMap(dir => [inDir(dir, 'package.json'), inDir(dir, 'tsconfig.json')]),
    ]);
    // A reused saved unit can already carry the helper (it was written by the first apply and saved with the unit);
    // that copy counts as the project's module and is checked the same way, never written twice.
    const planned = new Map(itemFiles.map(file => [file.path, file.bytes] as const));
    const supplied = helpers.flatMap(({ helper, candidates }) => supplyHelper(helper, candidates, observed, planned));
    const files = [...itemFiles, ...supplied.map(({ helper, path: helperPath }) => ({ path: helperPath, role: 'source' as const, bytes: helper.bytes }))];
    // The notice is built from the bytes this plan writes (for GSAP: the runtime files and their hashes), plus any supplied helper.
    const noticeText = material.noticeFor ? material.noticeFor(unitFiles) : material.rights.notice;
    const notice = Buffer.from(renderNotice(material, noticeText, saved, supplied.map(entry => entry.helper)));
    const manifestDir = manifestDirs.find(dir => observed.get(inDir(dir, 'package.json'))) ?? '';
    // Bound into the plan: every nearer package.json (absent), the gate's manifest, its lockfiles and tsconfig.json.
    const dependencyPaths = [
      ...manifestDirs.slice(0, manifestDirs.indexOf(manifestDir)).map(dir => inDir(dir, 'package.json')),
      ...['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json'].map(name => inDir(manifestDir, name)),
    ];
    const manifest = parseManifest(observed.get(inDir(manifestDir, 'package.json')) ?? null);
    const tsconfig = !!observed.get(inDir(manifestDir, 'tsconfig.json'));
    // G02: the target gate runs before the dependency gate, so a React unit offered to a
    // Vue project is told it is the wrong target, not asked to install React packages.
    // Sol B5/6 BLOCK: the React adapter reads what is installed under the gate's manifest, not the declared range.
    const installed = material.target === 'react-source/v1' ? await this.#installed(request.projectId, manifestDir, ['react', 'react-dom']) : null;
    const target = material.target ? resolveTarget(material.target, manifest, tsconfig, installed ? { react: installed.get('react')!, reactDom: installed.get('react-dom')! } : undefined) : undefined;
    if (target?.adapter === 'react-source/v1') {
      const receipt = (this.#deps.targetReceipts?.['react-source/v1'] ?? ((resolved: CatalogueTargetReport, sourceId: ResourceRef['sourceId']) => checkG02ReactReceipt(resolved.reactMajor, sourceId)))(target, material.ref.sourceId);
      if (!receipt.ok) {
        const covered = (this.#deps.coveredReactMajors ?? g02CoveredReactMajors)(material.ref.sourceId);
        // Only GSAP recipes have an HTML artifact of the same unit to offer meanwhile.
        const meanwhile = material.ref.sourceId === 'gsap' ? '. Use the HTML artifact of this recipe meanwhile' : '';
        const message = receipt.reason === 'react-major-uncovered'
          ? `No validated production receipt covers React ${target.reactMajor} yet (covered: ${covered.length ? covered.map(major => `React ${major}`).join(', ') : 'none'}); nothing was written${meanwhile}`
          : `The React target adapter has no validated production receipt yet; nothing was written${meanwhile}`;
        throw new CatalogueAdoptionError(422, 'target-receipt-pending', message,
          { adapter: 'react-source/v1', receiptReason: receipt.reason, reactMajor: target.reactMajor, coveredReactMajors: covered });
      }
    }
    const declared = [...material.packageDependencies, ...supplied.flatMap(entry => entry.helper.packageDependencies)];
    const dependencies = checkDependencies(declared, manifest);
    if (dependencies.missing.length || dependencies.incompatible.length) {
      throw new CatalogueAdoptionError(422, 'dependencies-unsatisfied', 'Install or align the listed packages, then apply again; nothing was written',
        { missing: dependencies.missing, incompatible: dependencies.incompatible });
    }
    if (material.dependencyMajors?.length) await this.#requireCoveredMajors(request.projectId, manifestDir, manifest, material.dependencyMajors);
    if (material.dependencyMinimums?.length) await this.#requireMinimums(request.projectId, manifestDir, manifest, material.dependencyMinimums);
    // Every file this plan would replace is reviewed first, the generated notice included:
    // a notice whose project bytes differ (user-edited, or an older revision's) is never overwritten unseen.
    this.#requireReviewedReplacement(request, material.ref, [...files, { path: noticePath, bytes: notice }], observed);

    const entry = observed.get(request.entryPath);
    if (!entry) throw new AdoptionError(422, 'entry-must-exist', `The entry must be an existing project file: ${request.entryPath}`);
    const marker = adoptionMarker(request.entryPath, material, files.map(f => f.path));
    const entryText = entry.toString('utf8');
    const nextEntry = entryText.includes(marker) ? entry : Buffer.from(`${entryText}${entryText.endsWith('\n') || entryText === '' ? '' : '\n'}${marker}\n`);

    const draft: PrepareAdoptionRequest = parsePrepareAdoptionRequest({
      projectId: request.projectId, entryPath: request.entryPath,
      adapter: { id: 'catalogue-files', version: '1' },
      source: { implementationOrigin: material.origin, resourceRef: material.ref },
      writes: [
        ...files.map(f => ({ path: f.path, role: f.role, contentBase64: f.bytes.toString('base64') })),
        { path: noticePath, role: 'notice', contentBase64: notice.toString('base64') },
        { path: request.entryPath, role: 'entry', contentBase64: nextEntry.toString('base64') },
      ],
    });
    const admission: SourceAdmission = {
      resourceRef: material.ref, implementationOrigin: material.origin,
      terms: { version: material.rights.licence, text: noticeText }, notices: [noticePath],
      // The plan records where its bytes came from; the apply-time re-check reads it.
      origin: saved
        ? { kind: 'saved-unit', savedUnitId: saved.id, recordDigest: saved.id, resourceRef: saved.ref, assessedRevision: saved.ref.revisionOrDigest }
        : { kind: 'source', resourceRef: material.ref, assessedRevision: material.ref.revisionOrDigest },
    };
    // The manifest the target and dependency gates used is bound into the plan, so an edit there before apply is refused.
    const plan = await this.#deps.executor.prepare(principalId, draft, admission, { dependencyPaths });
    const catalogue: CatalogueAdoptionReport = {
      refKey: resourceRefKey(material.ref),
      identity: { sourceId: material.ref.sourceId, itemId: material.ref.itemId, title: material.title, packageName: material.rights.packageName, sourceUrl: material.rights.sourceUrl, licence: material.rights.licence },
      files: draft.writes.map(w => ({ path: w.path, role: w.role })),
      notices: [noticePath],
      dependencies: { satisfied: dependencies.satisfied },
      ...(target ? { target } : {}),
    };
    return { plan, catalogue };
  }

  /**
   * Sol B5/6 WARN: a same-major range is not enough (`gsap ^3.0.0` against a
   * recipe needing 3.15). The version installed under the gate's manifest
   * must be resolvable and reach each minimum, and so must the lower bound of
   * the declared range (when it is a plain semver range), or prepare refuses
   * 422 `dependency-below-minimum` before anything is stored.
   */
  async #requireMinimums(projectId: string, manifestDir: string, manifest: Record<string, unknown> | null, minimums: readonly { name: string; minimum: string }[]): Promise<void> {
    const installed = await this.#installed(projectId, manifestDir, minimums.map(item => item.name));
    const declaredOf = (name: string): string | null => {
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const entries = manifest?.[section];
        if (entries && typeof entries === 'object' && !Array.isArray(entries) && typeof (entries as Record<string, unknown>)[name] === 'string') return (entries as Record<string, string>)[name]!;
      }
      return null;
    };
    const below = minimums.flatMap(({ name, minimum }) => {
      const floor = parseVersion(minimum);
      const declared = declaredOf(name);
      const found = installed.get(name);
      const version = found?.state === 'resolved' ? found.version : null;
      const resolved = version ? parseVersion(version) : null;
      const lower = declared === null ? null : rangeLowerBound(declared);
      const short = !floor || !resolved || compareVersions(resolved, floor) < 0 || (lower !== null && compareVersions(lower, floor) < 0);
      return short ? [{ name, minimum, declared, installed: version }] : [];
    });
    if (below.length) {
      throw new CatalogueAdoptionError(422, 'dependency-below-minimum',
        `${below.map(item => `${item.name} needs ${item.minimum} or newer (declared ${item.declared ?? 'nothing'}, installed ${item.installed ?? 'nothing resolvable'})`).join('; ')}; raise the declared range and install, then apply again; nothing was written`,
        { belowMinimum: below });
    }
  }

  /**
   * AC-R17: each listed package must be installed under the gate's manifest at
   * a major the target receipt covers. An installed different major (for
   * example styled-components 6 under a `^5` declaration), or no resolvable
   * install, refuses 422 `dependency-major-uncovered` before anything is stored.
   */
  async #requireCoveredMajors(projectId: string, manifestDir: string, manifest: Record<string, unknown> | null, rules: readonly { name: string; majors: readonly number[] }[]): Promise<void> {
    const installed = await this.#installed(projectId, manifestDir, rules.map(rule => rule.name));
    const declaredOf = (name: string): string | null => {
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const entries = manifest?.[section];
        if (entries && typeof entries === 'object' && !Array.isArray(entries) && typeof (entries as Record<string, unknown>)[name] === 'string') return (entries as Record<string, string>)[name]!;
      }
      return null;
    };
    const uncovered = rules.flatMap(({ name, majors }) => {
      const found = installed.get(name);
      if (found?.state === 'resolved' && majors.includes(found.major)) return [];
      return [{ name, coveredMajors: [...majors], declared: declaredOf(name), installed: found?.state === 'resolved' ? found.version : null }];
    });
    if (uncovered.length) {
      throw new CatalogueAdoptionError(422, 'dependency-major-uncovered',
        `${uncovered.map(item => `${item.name} must be installed at major ${item.coveredMajors.join(' or ')} (installed ${item.installed ?? 'nothing resolvable'})`).join('; ')}; no receipt covers anything else, nothing was written`,
        { uncovered });
    }
  }

  /** Installed package versions under the project root; `unreadable` for each when the executor has no such capability. */
  async #installed(projectId: string, fromDir: string, names: readonly string[]): Promise<Map<string, InstalledPackage>> {
    if (this.#deps.executor.installedPackages) return this.#deps.executor.installedPackages(projectId, fromDir, names);
    return new Map(names.map(name => [name, { state: 'unreadable', reason: 'io' } as const]));
  }

  /**
   * W4: saves the unit an apply wrote, as it is now in that project (edits
   * included), for private reuse by the same principal. Only unit files
   * (source, style, asset) are saved; the notice and entry marker are
   * regenerated on reuse. The apply must be done and not undone.
   */
  async save(principalId: string, input: unknown): Promise<CatalogueSavedUnit> {
    const request = parseCatalogueSaveRequest(input);
    const store = this.#savedUnitStore();
    const operation = this.#deps.executor.view(principalId, request.operationId);
    if (operation.projectId !== request.projectId) throw new CatalogueAdoptionError(409, 'operation-project-mismatch', 'The operation belongs to another project');
    if (operation.kind !== 'apply' || operation.state !== 'done' || operation.undoneBy) {
      throw new CatalogueAdoptionError(409, 'operation-not-applied', 'Only a completed, not undone apply can be saved for reuse');
    }
    const plan = this.#deps.executor.readPlan(principalId, operation.planId);
    const ref = plan.source.resourceRef;
    const source = ref ? this.#deps.materials.find(candidate => candidate.sourceId === ref.sourceId) : undefined;
    if (!ref || !source) throw new CatalogueAdoptionError(422, 'not-a-catalogue-unit', 'This operation did not apply a catalogue unit');
    const writes = plan.writes.filter(write => (UNIT_ROLES as readonly string[]).includes(write.after.role));
    if (writes.length === 0) throw new CatalogueAdoptionError(422, 'not-a-catalogue-unit', 'This operation wrote no unit files');
    const observed = await this.#deps.executor.observe(request.projectId, writes.map(write => write.path));
    const base = commonDir(writes.map(write => write.path));
    const files: UnitFile[] = writes.map(write => {
      const bytes = observed.get(write.path);
      if (!bytes) throw new CatalogueAdoptionError(409, 'unit-file-missing', `An applied unit file is no longer in the project: ${write.path}`);
      return { path: base ? write.path.slice(base.length + 1) : write.path, role: write.after.role as UnitFile['role'], bytes };
    });
    const material = await source.materialize(ref.itemId);
    // W2: a runtime asset must still be the material's pinned bytes; an edited runtime is never saved for reuse.
    for (const file of files.filter(entry => entry.role === 'asset')) {
      const pinned = material?.files.find(entry => entry.role === 'asset' && entry.path === file.path);
      if (!pinned || !pinned.bytes.equals(file.bytes)) {
        throw new CatalogueAdoptionError(409, 'runtime-asset-modified', `A runtime file differs from the pinned bytes and cannot be saved for reuse: ${file.path}`, { path: file.path });
      }
    }
    const record = store.save({
      principalId, ref, title: material?.title ?? ref.itemId, ...(material?.target ? { target: material.target } : {}),
      sourceProjectId: request.projectId, sourceOperationId: request.operationId, files,
    });
    return savedUnitView(record, resourceRefKey(record.ref));
  }

  /** The principal's saved units for one catalogue reference (any revision of the same item). */
  listSaved(principalId: string, refKey: string): CatalogueSavedUnit[] {
    const ref = decodeRefKey(refKey);
    return this.#savedUnitStore().list(principalId, ref).map(entry => savedUnitView(entry, resourceRefKey(entry.ref)));
  }

  /** Sol B5/6: removes one of the caller's saved units; anyone else's ID (or an unknown one) is 404. */
  deleteSaved(principalId: string, id: string): { deleted: string } {
    if (!this.#savedUnitStore().remove(principalId, id)) throw new CatalogueAdoptionError(404, 'saved-unit-unknown', 'Saved unit not found');
    return { deleted: id };
  }

  /** The project a saved unit came from, so the route can re-check read access to it before reuse. */
  savedUnitSource(principalId: string, id: string): { sourceProjectId: string } | null {
    const record = this.#savedUnitStore().read(principalId, id);
    return record ? { sourceProjectId: record.sourceProjectId } : null;
  }

  /** A saved-unit origin must name an intact record of the plan's principal, for the plan's catalogue item. */
  #requireSavedOrigin(principalId: string, origin: Extract<NonNullable<PreparedAdoptionPlan['source']['origin']>, { kind: 'saved-unit' }>, ref: ResourceRef): void {
    const unmatched = () => new CatalogueAdoptionError(409, 'saved-unit-origin-unmatched', 'The plan names a saved unit that does not match a saved record; prepare again from the saved unit');
    let record: SavedUnitRecord | null;
    // read() recomputes the whole-record digest; a damaged or swapped record is refused there.
    try { record = this.#savedUnitStore().read(principalId, origin.savedUnitId); } catch (error) {
      if (error instanceof SavedUnitError && error.reason === 'saved-unit-corrupt') throw unmatched();
      throw error;
    }
    const sameItem = (a: ResourceRef, b: ResourceRef) => a.sourceType === b.sourceType && a.sourceId === b.sourceId && a.itemId === b.itemId;
    if (!record || record.id !== origin.recordDigest || !sameItem(record.ref, origin.resourceRef) || record.ref.revisionOrDigest !== origin.resourceRef.revisionOrDigest
      || origin.assessedRevision !== origin.resourceRef.revisionOrDigest || !sameItem(origin.resourceRef, ref)) throw unmatched();
  }

  #savedUnitStore(): CatalogueSavedUnitStore {
    if (!this.#deps.savedUnits) throw new CatalogueAdoptionError(422, 'saved-units-unprovisioned', 'Saved units are not provisioned in this daemon');
    return this.#deps.savedUnits;
  }

  #savedUnitFor(principalId: string, id: string, ref: ResourceRef): SavedUnitRecord {
    const record = this.#savedUnitStore().read(principalId, id);
    if (!record) throw new CatalogueAdoptionError(404, 'saved-unit-unknown', 'Saved unit not found');
    if (record.ref.sourceId !== ref.sourceId || record.ref.itemId !== ref.itemId || record.ref.sourceType !== ref.sourceType) {
      throw new CatalogueAdoptionError(409, 'saved-unit-ref-mismatch', 'The saved unit belongs to another catalogue item');
    }
    return record;
  }

  /**
   * Apply-time re-check of a catalogue plan (G38 review round 2): the material source
   * that prepared it must still admit the item with the same bytes and rights. A plan
   * from a source this preparer does not carry is left to the route gate. Throws the
   * typed refusal before the executor runs, so nothing is written.
   */
  async recheck(plan: PreparedAdoptionPlan): Promise<void> {
    const ref = plan.source.resourceRef;
    const source = this.#deps.materials.find(candidate => candidate.sourceId === ref.sourceId);
    if (plan.source.origin?.kind === 'saved-unit') {
      // Reuse of a saved (possibly edited) unit: the record must still be the principal's,
      // intact and of this item; the source's decision must still allow private reuse.
      // Its bytes are the user's copy, so they are never compared with the assessed component.
      this.#requireSavedOrigin(plan.principalId, plan.source.origin, ref);
      const refusal = source?.recheckReuse ? await source.recheckReuse(ref) : null;
      if (refusal) throw new CatalogueAdoptionError(refusal.status, refusal.reason, refusal.message);
      return;
    }
    if (!source?.recheck) return;
    const refusal = await source.recheck(ref, plan.writes.map(write => ({ path: write.path, role: write.after.role, sha256: write.after.sha256 })));
    if (refusal) throw new CatalogueAdoptionError(refusal.status, refusal.reason, refusal.message);
  }

  /** Only an admitted source with permitted rights, a licence notice and the requested current revision. */
  async #admittedMaterial(ref: ResourceRef, principalId: string): Promise<CatalogueMaterial> {
    const source = this.#deps.materials.find(candidate => candidate.sourceId === ref.sourceId);
    const referenceOnly = () => new CatalogueAdoptionError(422, 'reference-only', 'This source is reference-only for adoption; a listing or screenshot is not an applied component');
    if (!source) throw referenceOnly();
    const material = await source.materialize(ref.itemId, { principalId });
    if (!material || material.ref.sourceId !== ref.sourceId || material.ref.itemId !== ref.itemId || material.ref.sourceType !== ref.sourceType) {
      throw new CatalogueAdoptionError(404, 'resource-ref-unknown', 'Resource is unavailable or unknown; search again');
    }
    if (material.rights.status !== 'permitted') throw referenceOnly();
    if (material.ref.revisionOrDigest !== ref.revisionOrDigest) {
      throw new CatalogueAdoptionError(409, 'resource-ref-stale', 'The source changed since it was inspected; inspect the current revision', { currentRefKey: resourceRefKey(material.ref) });
    }
    if (!material.rights.notice.trim()) throw new CatalogueAdoptionError(422, 'notice-missing', 'A sourced item must carry its licence notice with every applied file set');
    if (material.files.length === 0) throw new CatalogueAdoptionError(422, 'no-files', 'The source declares no files to apply');
    return material;
  }

  /**
   * AC-R04.3: existing project bytes that differ from the incoming bytes are
   * never replaced unseen. The caller gets the diff and a digest of exactly
   * that review; only a request carrying the same digest proceeds.
   */
  #requireReviewedReplacement(request: { projectId: string; acceptReplacement?: string | undefined }, ref: ResourceRef, outputs: readonly { path: string; bytes: Buffer }[], observed: ReadonlyMap<string, Buffer | null>): void {
    const changed = outputs.flatMap(output => {
      const current = observed.get(output.path);
      return current && !current.equals(output.bytes) ? [{ path: output.path, current, incoming: output.bytes }] : [];
    });
    if (changed.length === 0) return;
    const files = changed.map(file => ({ path: file.path, currentSha256: sha256(file.current), incomingSha256: sha256(file.incoming) }));
    const replacementDigest = digestOf({ projectId: request.projectId, ref, files });
    if (request.acceptReplacement === replacementDigest) return;
    const review: CatalogueReplacementReview = { replacementDigest, files: changed.map((file, index) => ({ ...files[index]!, diff: lineDiff(file.current, file.incoming) })) };
    throw new CatalogueAdoptionError(409, 'replacement-review-required', 'Project files differ from the incoming source; review the diff and accept it to replace them', { review });
  }
}

/**
 * G02 target adapters. `html-artifact/v1` is a standalone unit and fits any
 * project; `react-source/v1` requires the project's own manifest to declare
 * React 17+ and react-dom. A mismatch is a typed 422 naming what was detected;
 * the unit is never converted to another framework.
 */
function resolveTarget(adapter: CatalogueTargetReport['adapter'], manifest: Record<string, unknown> | null, tsconfig: boolean, installed?: ProjectTargetContext['installed']): CatalogueTargetReport {
  if (adapter === 'html-artifact/v1') {
    const profile = detectProjectTarget(manifest, { tsconfig });
    return { adapter, framework: profile.framework, reactMajor: profile.reactMajor, typescript: profile.typescript, styleRuntime: profile.styleRuntime, dependencyDigest: profile.dependencyDigest };
  }
  const check = checkReactTarget(manifest, { tsconfig, ...(installed ? { installed } : {}) });
  if (!check.ok) {
    const refusal: CatalogueTargetRefusal = { adapter, targetReason: check.reason, detected: { framework: check.profile.framework, reactMajor: check.profile.reactMajor } };
    throw new CatalogueAdoptionError(422, 'target-incompatible', check.message, { ...refusal });
  }
  const { profile } = check;
  return { adapter, framework: profile.framework, reactMajor: profile.reactMajor, typescript: profile.typescript, styleRuntime: profile.styleRuntime, dependencyDigest: profile.dependencyDigest };
}

function parseManifest(bytes: Buffer | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new CatalogueAdoptionError(422, 'package-manifest-unreadable', 'The project package.json is not a JSON object; fix it before applying');
}

/** Runtime assets come from the material's pinned files by path; an asset the material does not pin is refused. */
function pinAssets(files: readonly UnitFile[], material: CatalogueMaterial): UnitFile[] {
  return files.map(file => {
    if (file.role !== 'asset') return file;
    const pinned = material.files.find(entry => entry.role === 'asset' && entry.path === file.path);
    if (!pinned) throw new CatalogueAdoptionError(409, 'runtime-asset-unpinned', `The saved unit carries a runtime file the source does not pin: ${file.path}`, { path: file.path });
    return { ...file, bytes: pinned.bytes };
  });
}

/** Escapes a JavaScript identifier for use in a regular expression. */
const identifierPattern = (name: string) => name.replace(/[$]/gu, '\\$');
/** True when module text visibly exports `name` (declaration or export list). */
function exportsName(text: string, name: string): boolean {
  const id = identifierPattern(name);
  return new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${id}\\b`, 'u').test(text)
    || new RegExp(`export\\s*\\{[^}]*\\b${id}\\b[^}]*\\}`, 'u').test(text);
}

/**
 * A helper is written only when no candidate module exists. An existing module is
 * the project's own and is never replaced: it must export the name the item imports,
 * or apply is refused (422 `helper-conflict`) before anything is stored or written.
 */
function supplyHelper(helper: CatalogueHelper, candidates: readonly string[], observed: ReadonlyMap<string, Buffer | null>, planned: ReadonlyMap<string, Buffer> = new Map()): { helper: CatalogueHelper; path: string }[] {
  const bytesOf = (candidate: string) => planned.get(candidate) ?? observed.get(candidate) ?? null;
  const existing = candidates.find(candidate => bytesOf(candidate));
  if (!existing) return [{ helper, path: candidates[0]! }];
  if (exportsName(bytesOf(existing)!.toString('utf8'), helper.exportName)) return [];
  throw new CatalogueAdoptionError(422, 'helper-conflict', `The project's ${existing} does not export ${helper.exportName}; add it or remove the file, then apply again; nothing was written`,
    { path: existing, export: helper.exportName });
}

function renderNotice(material: CatalogueMaterial, noticeText: string, saved: SavedUnitRecord | null = null, helpers: readonly CatalogueHelper[] = []): string {
  return [
    `# ${material.title} (${material.rights.packageName})`,
    '',
    `- Source: ${material.rights.sourceUrl}`,
    `- Catalogue reference: ${material.ref.sourceId}/${material.ref.itemId} at ${material.ref.revisionOrDigest}`,
    `- Licence: ${material.rights.licence}`,
    ...(saved ? [`- Saved unit ${saved.id}: a modified copy saved from project ${saved.sourceProjectId} (catalogue revision ${saved.ref.revisionOrDigest})`] : []),
    '',
    noticeText.trim(),
    '',
    ...helpers.flatMap(helper => [`## Supplied helper: ${helper.path}`, '', helper.notice.trim(), '']),
  ].join('\n');
}
