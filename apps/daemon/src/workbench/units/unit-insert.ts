import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { parseUnitInsertReceipt, WORKBENCH_UNIT_INSERT_ID_PATTERN, type ReusableUnitManifest, type UnitInsertReceipt, type UnitInsertRequest, type UnitUndoInsertRequest } from '@open-design/contracts';
import { relocateUnitSource } from './unit-relocation.js';
import { UnitError } from './unit-files.js';
import type { PlacementProjectWrites, PlacementFinalIO } from '../placement/project-writes.js';
import type { UnitStore } from './unit-store.js';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export class UnitInsertInterrupted extends Error {
  constructor(readonly receipt: UnitInsertReceipt, readonly failure: unknown) { super(`Insertion ${receipt.insertId} is incomplete; undo its added files`); }
}

export class UnitInsertEditedConflict extends UnitError {
  constructor(paths: string[]) { super(409, 'insert-conflict', 'Inserted files were edited; no files were removed. Confirm discardEdits to back up and remove them', paths); }
}

type Record = { receipt: UnitInsertReceipt; root: string; rootDev: number; rootIno: number; keyDigest: string; requestDigest: string; addedPaths: string[]; directories: string[]; pendingEffect: { path: string; kind: 'file' | 'directory' } | null };

/** AC-R14.4. Each insertion owns a fresh directory; persisted receipts survive daemon restart. */
export function createUnitInsertion(deps: { dataDir: string; projectRoot(id: string): string | null; store: UnitStore; projectWrites?: PlacementProjectWrites; now(): Date }) {
  const records = (principal: string) => path.join(deps.dataDir, 'workbench-unit-inserts', digest(principal));
  const recordPath = (principal: string, id: string) => {
    if (!WORKBENCH_UNIT_INSERT_ID_PATTERN.test(id)) throw new UnitError(404, 'insert-not-found', 'No such insertion');
    return path.join(records(principal), `${id}.json`);
  };
  const locks = new Map<string, Promise<unknown>>();
  async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = locks.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(task); locks.set(key, run);
    try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
  }
  async function projectWrite<T>(projectId: string, task: (guard?: PlacementFinalIO) => Promise<T>): Promise<T> {
    return serialized(`project:${projectId}`, () => deps.projectWrites ? deps.projectWrites.run(projectId, task) : task());
  }
  async function publish(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  }
  async function read(principal: string, id: string): Promise<Record> {
    let raw: string;
    try { raw = await readFile(recordPath(principal, id), 'utf8'); }
    catch (error) { if (missing(error)) throw new UnitError(404, 'insert-not-found', 'No such insertion'); throw error; }
    const value = JSON.parse(raw) as Record;
    if (!value || typeof value !== 'object') throw new UnitError(409, 'insert-conflict', 'The insertion removal record is invalid');
    value.receipt = parseUnitInsertReceipt(value.receipt);
    if (!Array.isArray(value.addedPaths) || value.addedPaths.some(file => !value.receipt.files.some(item => item.path === file)) || !Array.isArray(value.directories) || value.directories.some(dir => dir !== value.receipt.directory && !value.receipt.files.some(file => file.path.startsWith(`${dir}/`)))) throw new UnitError(409, 'insert-conflict', 'The insertion removal record is invalid');
    if (value.pendingEffect && (value.pendingEffect.kind !== 'file' && value.pendingEffect.kind !== 'directory' || (value.pendingEffect.kind === 'file' ? !value.receipt.files.some(file => file.path === value.pendingEffect!.path) : value.pendingEffect.path !== value.receipt.directory && !value.receipt.files.some(file => file.path.startsWith(`${value.pendingEffect!.path}/`))))) throw new UnitError(409, 'insert-conflict', 'The pending insertion path is invalid');
    if (value.receipt.insertId !== id || value.receipt.unit.principalId !== principal) throw new UnitError(404, 'insert-not-found', 'No such insertion');
    return value;
  }
  async function boundRoot(record: Record): Promise<string> {
    const root = deps.projectRoot(record.receipt.projectId);
    if (!root) throw new UnitError(404, 'project-not-found', 'No such project');
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(root) !== record.root || info.dev !== record.rootDev || info.ino !== record.rootIno) throw new UnitError(409, 'insert-conflict', 'The target project directory changed; no files were removed');
    return record.root;
  }
  /** No symlink traversal, including parent directories. Missing paths are safe for an idempotent undo. */
  async function check(root: string, relative: string, file: boolean): Promise<boolean> {
    let current = root;
    const segments = relative.split('/');
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]!);
      let info;
      try { info = await lstat(current); } catch (error) { if (missing(error)) return false; throw error; }
      if (info.isSymbolicLink() || (i < segments.length - 1 || !file ? !info.isDirectory() : !info.isFile())) throw new UnitError(409, 'unsafe-path', 'An inserted path changed type; no symlinks are followed', [relative]);
    }
    return true;
  }
  function permitted(unit: ReusableUnitManifest, principal: string, projectId: string) {
    const paths = [...unit.files, ...unit.assets].map(file => file.path);
    const statuses = new Set(['redistributable', 'incorporation-only', 'private-use-only']);
    const grant = unit.operationRights.find(right => right.operation === 'reuse-private-project');
    if (!statuses.has(unit.rights.status) || paths.some(file => !unit.rights.files.some(right => right.path === file && statuses.has(right.status))) || !grant || grant.decision !== 'allowed' || grant.scope.principalId !== principal || grant.scope.visibility !== 'private' || (grant.scope.projectScope !== 'any-authorized' && !(grant.scope.projectScope === 'listed' && grant.scope.projectIds.includes(projectId))) || grant.scope.targetScope !== 'any') throw new UnitError(403, 'rights-blocked', 'The saved unit does not permit reuse of every file in this private project');
    // Non-notice obligations require an adapter that can actually satisfy them.
    if (grant.obligations.some(obligation => obligation.kind !== 'notice')) throw new UnitError(403, 'rights-blocked', 'This unit has rights obligations that standalone insertion cannot satisfy');
  }
  async function insert(principal: string, unit: ReusableUnitManifest, request: UnitInsertRequest, key: string): Promise<{ created: boolean; receipt: UnitInsertReceipt }> {
    if (request.mode !== 'standalone-artifact' || unit.format !== 'html-css-js') throw new UnitError(422, 'unsupported-target-format', 'Inline primary-content embedding is a tracked gap (B-029); only standalone HTML/CSS/JS artifacts are supported');
    if (unit.provenance.projectId === request.projectId) throw new UnitError(422, 'same-project', 'Choose a second project; the source project stays unchanged');
    permitted(unit, principal, request.projectId);
    return serialized(`${principal}:key:${key}`, () => projectWrite(request.projectId, async guard => {
      const keyDigest = digest(key), requestDigest = digest(JSON.stringify({ unitId: unit.unitId, revision: unit.revision, ...request }));
      const keyPath = path.join(records(principal), 'keys', `${keyDigest}.json`);
      let prior: { insertId: string } | null = null;
      try { prior = JSON.parse(await readFile(keyPath, 'utf8')) as { insertId: string }; } catch (error) { if (!missing(error)) throw error; }
      if (prior) {
        const previous = await read(principal, prior.insertId);
        if (previous.requestDigest !== requestDigest) throw new UnitError(409, 'idempotency-conflict', 'This key belongs to a different insertion');
        if (previous.receipt.status === 'inserting' || previous.receipt.status === 'undoing') throw new UnitInsertInterrupted(previous.receipt, new UnitError(409, 'insert-incomplete', `An unfinished insertion can be undone with ${previous.receipt.insertId}`));
        return { created: false, receipt: previous.receipt };
      }
      const projectRoot = deps.projectRoot(request.projectId);
      if (!projectRoot) throw new UnitError(404, 'project-not-found', 'No such project');
      let rootInfo;
      // A project can be registered (it has an id and a resolvable root path)
      // before its directory is ever materialized on disk — e.g. created via
      // POST /api/projects with no file written and no run started yet. That
      // is a normal, recoverable state, not a server fault, so it gets its
      // own typed refusal instead of surfacing the ENOENT as an opaque 500.
      try { rootInfo = await lstat(projectRoot); }
      catch (error) { if (missing(error)) throw new UnitError(404, 'project-directory-missing', 'The destination project has no directory yet; add a file or start a run in it first'); throw error; }
      const root = await realpath(projectRoot);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new UnitError(422, 'unsafe-path', 'The project root must be a real directory');
      const source = unit.provenance.projectId ? deps.projectRoot(unit.provenance.projectId) : null;
      if (source && [await realpath(source)].some(sourceRoot => sourceRoot === root || root.startsWith(`${sourceRoot}${path.sep}`) || sourceRoot.startsWith(`${root}${path.sep}`))) throw new UnitError(422, 'same-project', 'Source and destination project directories overlap');
      const suffix = randomBytes(15).toString('base64url'), insertId = `insert_${suffix}`, directory = `unit-insert-${suffix}`;
      const files: Array<{ path: string; bytes: Buffer }> = [];
      const seen = new Set<string>(['unit-lineage.json']);
      const carried = new Set([...unit.files, ...unit.assets].map(file => file.path));
      for (const file of [...unit.files, ...unit.assets]) {
        if (seen.has(file.path)) throw new UnitError(422, 'insert-conflict', 'Duplicate or reserved unit path', [file.path]);
        seen.add(file.path);
        const bytes = await deps.store.readObject(file.sha256);
        if (!bytes) throw new UnitError(409, 'unit-file-missing', 'Stored unit bytes failed verification', [file.path]);
        files.push({ path: `${directory}/${file.path}`, bytes: relocateUnitSource(bytes, file.path, carried) });
      }
      files.push({ path: `${directory}/unit-lineage.json`, bytes: Buffer.from(JSON.stringify({
        schema: 'unit-insert-lineage/1', insertId,
        source: { unitId: unit.unitId, revision: unit.revision, ...(unit.provenance.projectId ? { projectRef: digest(`${principal}:${unit.provenance.projectId}`) } : {}), captureId: unit.provenance.captureId ?? null, draftRevisionId: unit.provenance.draftRevisionId ?? null },
        files: [...unit.files, ...unit.assets].map(file => ({ path: file.path, sha256: file.sha256 })),
        dependencies: unit.dependencies, actions: unit.actions,
        rights: { status: unit.rights.status, basis: unit.rights.basis, notices: unit.rights.notices, evidenceDigests: unit.rights.evidenceRefs.map(digest) },
        dependenciesInstalled: false, actionVerification: 'not-run',
      }, null, 2)) });
      const receipt = parseUnitInsertReceipt({ schema: 'unit-insert/1', insertId, projectId: request.projectId, mode: 'standalone-artifact', status: 'inserting', directory, entryPath: `${directory}/${unit.entry}`, files: files.map(file => ({ path: file.path, sha256: digest(file.bytes) })), unit, actionVerification: 'not-run', dependenciesInstalled: false, createdAt: deps.now().toISOString(), undoneAt: null });
      const record: Record = { receipt, root, rootDev: rootInfo.dev, rootIno: rootInfo.ino, keyDigest, requestDigest, addedPaths: [], directories: [], pendingEffect: null };
      await publish(recordPath(principal, insertId), record);
      await publish(keyPath, { insertId });
      try {
        // Exclusive directory creation prevents overwriting any project file.
        record.pendingEffect = { path: directory, kind: 'directory' }; await publish(recordPath(principal, insertId), record);
        guard?.assertCurrent();
        await mkdir(path.join(root, directory), { mode: 0o700 });
        record.directories.push(directory); record.pendingEffect = null; await publish(recordPath(principal, insertId), record);
        for (const file of files) {
          await boundRoot(record);
          const parents = file.path.split('/').slice(0, -1);
          for (let i = 1; i <= parents.length; i++) {
            const parent = parents.slice(0, i).join('/');
            if (!await check(root, parent, false)) {
              record.pendingEffect = { path: parent, kind: 'directory' }; await publish(recordPath(principal, insertId), record);
              guard?.assertCurrent(); await mkdir(path.join(root, parent), { mode: 0o700 });
              record.directories.push(parent); record.pendingEffect = null; await publish(recordPath(principal, insertId), record);
            }
          }
          record.pendingEffect = { path: file.path, kind: 'file' }; await publish(recordPath(principal, insertId), record);
          guard?.assertCurrent();
          const handle = await open(path.join(root, file.path), 'wx', 0o600);
          try {
            record.addedPaths.push(file.path); record.pendingEffect = null; await publish(recordPath(principal, insertId), record);
            guard?.assertCurrent(); await handle.writeFile(file.bytes);
          } finally { await handle.close(); }
        }
        receipt.status = 'inserted'; await publish(recordPath(principal, insertId), record);
        return { created: true, receipt };
      } catch (error) { throw new UnitInsertInterrupted(receipt, error); }
    }));
  }
  async function undoInsert(principal: string, id: string, options: UnitUndoInsertRequest = {}): Promise<UnitInsertReceipt> {
    const initial = await read(principal, id);
    return projectWrite(initial.receipt.projectId, async guard => {
      const record = await read(principal, id), receipt = record.receipt;
      if (receipt.status === 'undone') return receipt;
      const root = await boundRoot(record);
      // A crash between creation and journal completion is ambiguous. Never call it undone.
      if (record.pendingEffect && await check(root, record.pendingEffect.path, record.pendingEffect.kind === 'file')) throw new UnitError(409, 'insert-conflict', 'An interrupted filesystem effect could not be proven owned; retain it for recovery', [record.pendingEffect.path]);
      record.pendingEffect = null;
      // Validate and hash the entire set before any deletion or journal state change.
      const removal = receipt.files.filter(file => record.addedPaths.includes(file.path));
      const observed = new Map<string, Buffer>();
      const edited: string[] = [];
      for (const file of removal) {
        if (!await check(root, file.path, true)) continue;
        const handle = await open(path.join(root, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!(await handle.stat()).isFile()) throw new UnitError(409, 'unsafe-path', 'An inserted path changed type', [file.path]);
          const bytes = await handle.readFile(); observed.set(file.path, bytes);
          if (digest(bytes) !== file.sha256) edited.push(file.path);
        } finally { await handle.close(); }
      }
      if (edited.length && options.discardEdits !== true) throw new UnitInsertEditedConflict(edited);
      if (edited.length) {
        const recoveryPath = `.od-undo/${id}`;
        // A fresh attempt preserves earlier recovery copies after interruptions/retries.
        const attempt = `${recoveryPath}/${randomUUID()}`;
        for (const relative of ['.od-undo', recoveryPath, attempt]) {
          await boundRoot(record);
          if (!await check(root, relative, false)) { guard?.assertCurrent(); await mkdir(path.join(root, relative), { mode: 0o700 }); }
        }
        for (const file of edited) {
          const backup = `${attempt}/${file}`;
          const segments = backup.split('/').slice(0, -1);
          for (let i = 1; i <= segments.length; i++) {
            const relative = segments.slice(0, i).join('/');
            await boundRoot(record);
            if (!await check(root, relative, false)) { guard?.assertCurrent(); await mkdir(path.join(root, relative), { mode: 0o700 }); }
          }
          await boundRoot(record); guard?.assertCurrent();
          const handle = await open(path.join(root, backup), 'wx', 0o600);
          try { await handle.writeFile(observed.get(file)!); await handle.sync(); }
          finally { await handle.close(); }
        }
        receipt.recoveryPath = recoveryPath;
        await publish(recordPath(principal, id), record);
      }
      // Refuse concurrent changes before starting removal; backups must match removed bytes.
      for (const file of removal) {
        await boundRoot(record);
        if (!await check(root, file.path, true)) continue;
        if (!observed.has(file.path) || digest(await readFile(path.join(root, file.path))) !== digest(observed.get(file.path)!)) throw new UnitError(409, 'insert-conflict', 'Inserted files changed during undo; retry before removing anything', [file.path]);
      }
      receipt.status = 'undoing'; await publish(recordPath(principal, id), record);
      for (const file of removal) {
        await boundRoot(record);
        if (await check(root, file.path, true)) {
          if (!observed.has(file.path) || digest(await readFile(path.join(root, file.path))) !== digest(observed.get(file.path)!)) throw new UnitError(409, 'insert-conflict', 'An inserted file changed during removal; retain it for recovery', [file.path]);
          guard?.assertCurrent(); await unlink(path.join(root, file.path));
        }
      }
      const directories = new Set<string>(record.directories);
      for (const dir of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
        await boundRoot(record);
        if (!await check(root, dir, false)) continue;
        try { guard?.assertCurrent(); await rmdir(path.join(root, dir)); } catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
      receipt.status = 'undone'; receipt.undoneAt = deps.now().toISOString(); await publish(recordPath(principal, id), record);
      return receipt;
    });
  }
  async function listInsertions(principal: string, unitId: string): Promise<UnitInsertReceipt[]> {
    let names: string[];
    try { names = await readdir(records(principal)); } catch (error) { if (missing(error)) return []; throw error; }
    const found: UnitInsertReceipt[] = [];
    for (const name of names) {
      const id = name.replace(/\.json$/u, '');
      if (!WORKBENCH_UNIT_INSERT_ID_PATTERN.test(id)) continue;
      try {
        const record = await read(principal, id);
        if (record.receipt.unit.unitId === unitId) found.push(record.receipt);
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof UnitError) && !(error instanceof Error && error.name === 'ZodError')) throw error;
        console.warn(`[unit-insert] Skipping corrupt insertion record ${id}`);
      }
    }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  }
  return { insert, undoInsert, listInsertions, insertion: async (principal: string, id: string) => (await read(principal, id)).receipt };
}
