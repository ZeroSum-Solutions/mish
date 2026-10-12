import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import {
  assertPlacementOwnedBeforeDatabase, classifyNativeOwnerFailure, classifyPlacementHost, preparePlacementBootstrap,
  takePlacementBootstrapInput, PLACEMENT_OWNER_ENV, type PlacementBootstrap,
} from '../../../src/workbench/placement/owner-bootstrap.js';
import { OWNER_FILE_NAME } from '../../../src/workbench/placement/owner-binding.js';
import { PLACEMENT_ROOT_LOCK } from '../../../src/workbench/placement/root-seal.js';
import {
  PLACEMENT_OWNER_SOURCE_SHA256, parsePlacementOwnerProvenance, verifyPlacementOwnerProvenance,
} from '../../../src/workbench/placement/owner-provenance.js';
import { PlacementBootstrapError } from '../../../src/workbench/placement/runtime-status.js';
import { buildOwnerFixture, nativeSupported, ownerEnv, rootParent, TSX_ESM, type OwnerFixture } from './runtime-fixture.js';

const run = promisify(execFile);
const projectRoot = '/nonexistent-project-root-for-default-only';
const qualifiedHost = { platform: 'darwin', arch: 'arm64', node: '24.16.0', osRelease: '25.5.0', mainThread: true };
const held: PlacementBootstrap[] = [];
afterEach(() => { for (const b of held.splice(0)) if (b.mode === 'coordinated') b.owner.close(); });

describe('placement bootstrap input and host classification', () => {
  it('pins the tracked native source digest', async () => {
    const source = await readFile(new URL('../../../src/workbench/placement/owner-native.c', import.meta.url));
    expect(createHash('sha256').update(source).digest('hex')).toBe(PLACEMENT_OWNER_SOURCE_SHA256);
  });
  it('distinguishes absent input from a partial or invalid supplied selection, and consumes it', () => {
    const env: NodeJS.ProcessEnv = { KEEP: '1' };
    expect(takePlacementBootstrapInput(env)).toEqual({ kind: 'absent' });
    const partial: NodeJS.ProcessEnv = { [PLACEMENT_OWNER_ENV.binding]: '/x/owner.node' };
    expect(takePlacementBootstrapInput(partial)).toEqual({ kind: 'malformed' });
    expect(partial).toEqual({});
    for (const bad of [{ binding: 'relative.node', sha: 'a'.repeat(64), prov: '/p.json' }, { binding: '/x/owner.so', sha: 'a'.repeat(64), prov: '/p.json' }, { binding: '/x/owner.node', sha: 'A'.repeat(64), prov: '/p.json' }, { binding: '/x/../owner.node', sha: 'a'.repeat(64), prov: '/p.json' }]) {
      expect(takePlacementBootstrapInput({ [PLACEMENT_OWNER_ENV.binding]: bad.binding, [PLACEMENT_OWNER_ENV.sha256]: bad.sha, [PLACEMENT_OWNER_ENV.provenance]: bad.prov })).toEqual({ kind: 'malformed' });
    }
    const supplied: NodeJS.ProcessEnv = { [PLACEMENT_OWNER_ENV.binding]: '/x/owner.node', [PLACEMENT_OWNER_ENV.sha256]: 'a'.repeat(64), [PLACEMENT_OWNER_ENV.provenance]: '/x/p.json', KEEP: '1' };
    expect(takePlacementBootstrapInput(supplied)).toEqual({ kind: 'supplied', binding: { path: '/x/owner.node', sha256: 'a'.repeat(64) }, provenancePath: '/x/p.json' });
    expect(supplied).toEqual({ KEEP: '1' });
  });
  it('classifies the host independently; a worker thread is not outside the cohort (synthetic facts)', () => {
    expect(classifyPlacementHost(qualifiedHost)).toEqual({ cohort: 'qualified' });
    expect(classifyPlacementHost({ ...qualifiedHost, platform: 'linux' })).toEqual({ cohort: 'outside', fact: 'platform' });
    expect(classifyPlacementHost({ ...qualifiedHost, arch: 'x64' })).toEqual({ cohort: 'outside', fact: 'arch' });
    expect(classifyPlacementHost({ ...qualifiedHost, node: '24.15.0' })).toEqual({ cohort: 'outside', fact: 'node' });
    expect(classifyPlacementHost({ ...qualifiedHost, osRelease: '25.4.0' })).toEqual({ cohort: 'outside', fact: 'os-release' });
    expect(classifyPlacementHost({ ...qualifiedHost, mainThread: false })).toEqual({ cohort: 'runtime-context', fact: 'worker-thread' });
  });
  it('never maps native unsupported/load/digest/protocol/runtime results to ordinary fallback', () => {
    for (const reason of ['binding', 'binding-digest', 'binding-changed', 'binding-protocol', 'native-capability', 'binding-load']) {
      expect(classifyNativeOwnerFailure({ kind: 'unsupported', reason })).toMatchObject({ reason, status: 503 });
    }
    expect(classifyNativeOwnerFailure({ kind: 'unsupported', reason: 'runtime' }).reason).toBe('native-runtime-disagreement');
    expect(classifyNativeOwnerFailure({ kind: 'unsupported', reason: 'volume' }).reason).toBe('filesystem-unclassified:volume');
    expect(classifyNativeOwnerFailure({ kind: 'busy', reason: 'contended' })).toMatchObject({ reason: 'owner-busy', status: 409 });
    expect(classifyNativeOwnerFailure({ kind: 'conflict', reason: 'acl' }).reason).toBe('owner-conflict:acl');
  });
});

describe('placement bootstrap without native ownership', () => {
  it('no input is constructor-sourced not-activated and creates nothing', async () => {
    const parent = await (await import('node:fs/promises')).mkdtemp(join((await import('node:os')).tmpdir(), 'placement-noinput-'));
    const dataDir = join(parent, 'data');
    const result = preparePlacementBootstrap({ env: { OD_DATA_DIR: dataDir }, projectRoot, host: qualifiedHost });
    expect(result).toMatchObject({ mode: 'ordinary-uncoordinated', reason: 'not-activated', transition: { kind: 'no-database', global: null } });
    expect(existsSync(dataDir)).toBe(false);
  });
  it('a supplied malformed selection refuses before any data-root effect', async () => {
    const parent = await (await import('node:fs/promises')).mkdtemp(join((await import('node:os')).tmpdir(), 'placement-malformed-'));
    const dataDir = join(parent, 'data');
    expect(() => preparePlacementBootstrap({ env: { OD_DATA_DIR: dataDir, [PLACEMENT_OWNER_ENV.binding]: '/missing/owner.node' }, projectRoot, host: qualifiedHost }))
      .toThrowError(expect.objectContaining({ reason: 'binding-input-malformed' }));
    expect(existsSync(dataDir)).toBe(false);
  });
  it('a supplied selection on a host positively outside the cohort is ordinary (synthetic host facts)', async () => {
    const parent = await (await import('node:fs/promises')).mkdtemp(join((await import('node:os')).tmpdir(), 'placement-outside-'));
    const env = { OD_DATA_DIR: join(parent, 'data'), [PLACEMENT_OWNER_ENV.binding]: '/missing/owner.node', [PLACEMENT_OWNER_ENV.sha256]: 'a'.repeat(64), [PLACEMENT_OWNER_ENV.provenance]: '/missing/p.json' };
    const acquire = vi.fn();
    expect(preparePlacementBootstrap({ env, projectRoot, host: { ...qualifiedHost, arch: 'x64' }, acquire })).toMatchObject({ mode: 'ordinary-uncoordinated', reason: 'host-outside-cohort', hostFact: 'arch' });
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe.skipIf(!nativeSupported)('actual arm64 native placement bootstrap', () => {
  let fixture: OwnerFixture;
  beforeAll(async () => { fixture = await buildOwnerFixture('bootstrap'); }, 60_000);

  it('a supplied missing binding refuses before mkdir, realpath, ownership or any data-root effect', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const env = { ...ownerEnv(fixture, dataDir), [PLACEMENT_OWNER_ENV.binding]: join(fixture.evidence, 'absent.node') };
    expect(() => preparePlacementBootstrap({ env, projectRoot })).toThrowError(expect.objectContaining({ reason: 'provenance-binding-selection' }));
    expect(existsSync(dataDir)).toBe(false);
  });
  it('a provenance/binding pair whose bytes changed refuses natively as binding-digest, never ordinary', async () => {
    const copy = join(fixture.evidence, 'tampered.node'); await copyFile(fixture.binding.path, copy);
    const provenance = JSON.parse(await readFile(fixture.provenancePath, 'utf8'));
    provenance.binary.path = copy; const provenancePath = join(fixture.evidence, 'tampered.provenance.json');
    await writeFile(provenancePath, JSON.stringify(provenance)); await writeFile(copy, Buffer.concat([await readFile(copy), Buffer.from([0])]));
    const dataDir = join(await rootParent(fixture), 'data');
    expect(() => preparePlacementBootstrap({ env: { OD_DATA_DIR: dataDir, [PLACEMENT_OWNER_ENV.binding]: copy, [PLACEMENT_OWNER_ENV.sha256]: fixture.binding.sha256, [PLACEMENT_OWNER_ENV.provenance]: provenancePath }, projectRoot }))
      .toThrowError(expect.objectContaining({ reason: 'binding-digest' }));
  });
  it('rejects provenance whose source, runtime or selection does not match', async () => {
    const provenance = parsePlacementOwnerProvenance(JSON.parse(await readFile(fixture.provenancePath, 'utf8')));
    for (const [field, value, reason] of [['sourceSHA256', 'b'.repeat(64), 'source-digest'], ['node', '24.15.0', 'runtime-identity'], ['osRelease', '25.4.0', 'runtime-identity']] as const) {
      const path = join(fixture.evidence, `bad-${field}.json`); await writeFile(path, JSON.stringify({ ...provenance, [field]: value }));
      expect(() => verifyPlacementOwnerProvenance(path, fixture.binding, qualifiedHost)).toThrowError(expect.objectContaining({ reason }));
    }
    const extra = join(fixture.evidence, 'bad-extra.json'); await writeFile(extra, JSON.stringify({ ...provenance, extra: 1 }));
    expect(() => verifyPlacementOwnerProvenance(extra, fixture.binding, qualifiedHost)).toThrowError(expect.objectContaining({ reason: 'shape' }));
  });
  it('fresh root: only the root mkdir, the native lock and (B4-1b) the root lock precede the server; env carries the canonical root', async () => {
    const parent = await rootParent(fixture), aliasParent = join(fixture.evidence, `alias-${Date.now()}`);
    await symlink(parent, aliasParent);
    const env = ownerEnv(fixture, join(aliasParent, 'data'));
    const result = preparePlacementBootstrap({ env, projectRoot }); held.push(result);
    expect(result).toMatchObject({ mode: 'coordinated', createdRoot: true, canonicalDataRoot: join(parent, 'data') });
    expect(env.OD_DATA_DIR).toBe(join(parent, 'data'));
    expect(Object.values(PLACEMENT_OWNER_ENV).some(key => key in env)).toBe(false);
    expect(await readdir(join(parent, 'data'))).toEqual([OWNER_FILE_NAME, PLACEMENT_ROOT_LOCK]);
    expect((await lstat(join(parent, 'data'))).mode & 0o777).toBe(0o700);
    expect(() => assertPlacementOwnedBeforeDatabase(result, join(aliasParent, 'data'))).not.toThrow();
    expect(() => assertPlacementOwnedBeforeDatabase(result, parent)).toThrowError(expect.objectContaining({ reason: 'data-root-mismatch' }));
  });
  it('a second owner refuses with 409 before any database, in-process and cross-process', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const first = preparePlacementBootstrap({ env: ownerEnv(fixture, dataDir), projectRoot }); held.push(first);
    let refused: unknown; try { preparePlacementBootstrap({ env: ownerEnv(fixture, dataDir), projectRoot }); } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(PlacementBootstrapError); expect(refused).toMatchObject({ reason: 'owner-busy', status: 409 });
    const code = `const a=require(process.argv[1]);const r=a.acquire(process.argv[2]);if(r.owner)r.owner.close();process.stdout.write(r.status);`;
    expect((await run(process.execPath, ['-e', code, fixture.binding.path, dataDir], { env: {} })).stdout).toBe('busy');
    expect(await readdir(dataDir)).toEqual([OWNER_FILE_NAME, PLACEMENT_ROOT_LOCK]);
  });
  it('an existing non-private root is a filesystem conflict, never fallback', async () => {
    const dataDir = join(await rootParent(fixture), 'data'); await mkdir(dataDir, { mode: 0o755 });
    expect(() => preparePlacementBootstrap({ env: ownerEnv(fixture, dataDir), projectRoot })).toThrowError(expect.objectContaining({ reason: expect.stringMatching(/^owner-conflict:/) }));
  });
  it('a supplied binding on an actual worker thread of the measured host cannot fall back', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const module = pathToFileURL(new URL('../../../src/workbench/placement/owner-bootstrap.ts', import.meta.url).pathname).href;
    const tsxApi = pathToFileURL(TSX_ESM.replace(/index\.mjs$/, 'api/index.mjs')).href;
    const worker = new Worker(`import(${JSON.stringify(tsxApi)}).then(api => { api.register(); return import(${JSON.stringify(module)}); }).then(m => { try { const r = m.preparePlacementBootstrap({ env: ${JSON.stringify(ownerEnv(fixture, dataDir))}, projectRoot: '/x' }); require('node:worker_threads').parentPort.postMessage({ mode: r.mode }); } catch (e) { require('node:worker_threads').parentPort.postMessage({ reason: e.reason }); } });`,
      { eval: true });
    const message = await new Promise<unknown>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    await worker.terminate();
    expect(message).toEqual({ reason: 'runtime-worker-thread' });
    expect(existsSync(dataDir)).toBe(false);
  });
  /** Single owned process (no tsx CLI wrapper); exact fixture PID asserted. */
  async function evaluateServer(env: NodeJS.ProcessEnv, replace: boolean): Promise<Record<string, any>> {
    const child = spawn(process.execPath, ['--import', pathToFileURL(TSX_ESM).href, new URL('./server-evaluation-fixture.ts', import.meta.url).pathname, JSON.stringify({ env, replace })], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, OD_DAEMON_CLI_PATH: process.env.OD_DAEMON_CLI_PATH } });
    let out = ''; child.stdout!.on('data', d => { out += d; }); child.stderr!.resume();
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
    expect(code).toBe(0);
    const report = JSON.parse(out.trim().split('\n').at(-1)!); expect(report.fixturePid).toBe(child.pid);
    return report;
  }
  it('a root replaced after acquisition refuses before the server module performs any eager effect', async () => {
    const dataDir = join(await rootParent(fixture), 'data');
    const report = await evaluateServer(ownerEnv(fixture, dataDir) as Record<string, string>, true);
    expect(report).toMatchObject({ evaluated: false, reason: 'owner-root-changed-before-eager-initialization', rootEntries: [] });
    expect(await readdir(`${report.root}-retained`)).toEqual([OWNER_FILE_NAME, PLACEMENT_ROOT_LOCK]);
  }, 60_000);
  it('an unchanged owned root evaluates the server module normally', async () => {
    const report = await evaluateServer(ownerEnv(fixture, join(await rootParent(fixture), 'data')) as Record<string, string>, false);
    expect(report).toMatchObject({ evaluated: true });
    expect(report.rootEntries).toEqual(expect.arrayContaining([OWNER_FILE_NAME, 'projects']));
  }, 60_000);
});
