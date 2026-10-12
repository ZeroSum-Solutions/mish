import { consumeRootCreationRecord, proveRecordedFreshRoot } from './root-freshness.js';
import {
  acquireExclusiveRootLock, acquireSharedRootLock, confirmRootSealOnDisk, consumeRootSeal, readRootSeal, sameRootSealFile,
  type RootLock, type RootSeal, type RootSealGate, type RootSealReading,
} from './root-seal.js';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { resolveProjectRelativePath } from '../../home-expansion.js';
import { acquireNativePlacementOwner, type NativeOwnerResult, type NativePlacementOwner } from './owner-binding.js';
import { PlacementProvenanceError, verifyPlacementOwnerProvenance, type PlacementHostFacts, type PlacementOwnerBindingInput } from './owner-provenance.js';
import { inspectOrdinaryTransition, type OrdinaryTransitionInspection } from './ordinary-transition.js';
import { PlacementBootstrapError } from './runtime-status.js';

/** Trusted constructor input keys. Consumed once and removed before any child inherits the environment. */
export const PLACEMENT_OWNER_ENV = Object.freeze({
  binding: 'OD_PLACEMENT_OWNER_BINDING', sha256: 'OD_PLACEMENT_OWNER_SHA256', provenance: 'OD_PLACEMENT_OWNER_PROVENANCE',
} as const);
/** The only measured cohort. Other hosts are positively outside it, not merely "unsupported". */
export const QUALIFIED_PLACEMENT_HOST = Object.freeze({ platform: 'darwin', arch: 'arm64', node: '24.16.0', osRelease: '25.5.0' });

export function currentPlacementHostFacts(): PlacementHostFacts {
  return { platform: process.platform, arch: process.arch, node: process.versions.node, osRelease: release(), mainThread: isMainThread };
}
export type PlacementBootstrapInput =
  | { kind: 'absent' }
  | { kind: 'supplied'; binding: PlacementOwnerBindingInput; provenancePath: string }
  | { kind: 'malformed' };
export function takePlacementBootstrapInput(env: NodeJS.ProcessEnv = process.env): PlacementBootstrapInput {
  const raw = { path: env[PLACEMENT_OWNER_ENV.binding], sha256: env[PLACEMENT_OWNER_ENV.sha256], provenance: env[PLACEMENT_OWNER_ENV.provenance] };
  for (const key of Object.values(PLACEMENT_OWNER_ENV)) delete env[key];
  const values = [raw.path, raw.sha256, raw.provenance];
  if (values.every(value => value === undefined)) return { kind: 'absent' };
  // Any supplied field is activation input: a partial or invalid selection is never "no input".
  const { path: binding, sha256, provenance } = raw;
  if (typeof binding !== 'string' || typeof sha256 !== 'string' || typeof provenance !== 'string') return { kind: 'malformed' };
  const exactAbsolute = (value: string) => path.isAbsolute(value) && path.normalize(value) === value;
  if (!exactAbsolute(binding) || !binding.endsWith('.node') || !exactAbsolute(provenance) || !/^[0-9a-f]{64}$/.test(sha256)) return { kind: 'malformed' };
  return { kind: 'supplied', binding: { path: binding, sha256 }, provenancePath: provenance };
}
export type PlacementHostCohort = { cohort: 'qualified' } | { cohort: 'outside'; fact: 'platform' | 'arch' | 'node' | 'os-release' } | { cohort: 'runtime-context'; fact: 'worker-thread' };
/** Independent of the native result tags; a worker thread on the measured host is not "outside". */
export function classifyPlacementHost(host: PlacementHostFacts): PlacementHostCohort {
  if (host.platform !== QUALIFIED_PLACEMENT_HOST.platform) return { cohort: 'outside', fact: 'platform' };
  if (host.arch !== QUALIFIED_PLACEMENT_HOST.arch) return { cohort: 'outside', fact: 'arch' };
  if (host.node !== QUALIFIED_PLACEMENT_HOST.node) return { cohort: 'outside', fact: 'node' };
  if (host.osRelease !== QUALIFIED_PLACEMENT_HOST.osRelease) return { cohort: 'outside', fact: 'os-release' };
  if (!host.mainThread) return { cohort: 'runtime-context', fact: 'worker-thread' };
  return { cohort: 'qualified' };
}
/** Lexical daemon data root (same rule as the server), without creating anything. */
export function lexicalDaemonDataRoot(env: NodeJS.ProcessEnv, projectRoot: string): string {
  const value = env.OD_DATA_DIR?.trim();
  return value ? resolveProjectRelativePath(value, projectRoot) : path.join(projectRoot, '.od');
}

/**
 * B4-1b: the predecessor's clean-shutdown seal as this boot found it
 * (root-seal.ts). `verified`: a genuine-shaped seal whose MAC verifies, whose
 * root state held before and after ownership, and which the database bytes
 * confirmed, all under the exclusive root lock, with a final root comparison
 * after the confirmation. The runtime confirms it again on the opened
 * database and marks it consumed. Absent on a root this boot created.
 */
/** How long an ordinary daemon waits for a coordinated boot to finish confirming its seal. */
export const ROOT_LOCK_WAIT_MS = 30_000;
export type RootSealEvidence = { kind: 'none' } | { kind: 'refused'; reason: RootSealGate } | { kind: 'verified'; seal: RootSeal };
export type PlacementBootstrap =
  | { mode: 'ordinary-uncoordinated'; reason: 'not-activated' | 'host-outside-cohort'; hostFact: string | null; host: PlacementHostFacts; transition: OrdinaryTransitionInspection;
    /** B4-1b: the shared root lock this ordinary daemon holds for its life (root-seal.ts); null where none applies. */
    rootLock?: RootLock | null }
  | { mode: 'coordinated'; host: PlacementHostFacts; owner: NativePlacementOwner; canonicalDataRoot: string; rootIdentity: { device: string; inode: string }; createdRoot: boolean; rootSeal?: RootSealEvidence; binding: PlacementOwnerBindingInput; provenanceSHA256: string; sequence: number };

/** Both readings must agree on one genuine seal file; anything else refuses with the first specific reason. */
function sealEvidence(before: RootSealReading, after: RootSealReading): RootSealEvidence {
  if (before.kind === 'refused') return { kind: 'refused', reason: before.reason };
  if (after.kind === 'refused') return { kind: 'refused', reason: after.reason };
  if (before.kind === 'absent' && after.kind === 'absent') return { kind: 'refused', reason: 'predecessor-seal-absent' };
  if (before.kind === 'sealed' && after.kind === 'sealed' && sameRootSealFile(before.file, after.file)
    && before.seal.mac === after.seal.mac) return { kind: 'verified', seal: after.seal };
  return { kind: 'refused', reason: 'predecessor-seal-invalid' }; // A seal that appeared, vanished or changed while this boot took ownership.
}

let ownerAcquisitions = 0;
let stagedForServerEvaluation: PlacementBootstrap | null = null;
/** Startup-scoped: the supported entrypoint stages its bootstrap immediately before importing the server module. */
export function stagePlacementBootstrapForServerEvaluation(bootstrap: PlacementBootstrap): void { stagedForServerEvaluation = bootstrap; }
/**
 * Called by the server module before its first eager filesystem effect. A
 * staged coordinated owner must still be held and qualified, and the data root
 * the module will use must still be the owned canonical root (same identity).
 * Nothing staged (direct importer) or an ordinary bootstrap checks nothing.
 */
export function assertStagedPlacementOwnerBeforeEagerInitialization(env: NodeJS.ProcessEnv = process.env): void {
  const staged = stagedForServerEvaluation;
  if (!staged || staged.mode !== 'coordinated') return;
  let state: { held: boolean; qualified: boolean } = { held: false, qualified: false };
  try { state = staged.owner.inspect(); } catch { /* unknown is not held */ }
  let identity: { device: string; inode: string } | null = null, resolved: string | null = null;
  try { resolved = realpathSync.native(env.OD_DATA_DIR ?? ''); identity = identityOf(lstatSync(resolved, { bigint: true })); } catch { /* lost */ }
  if (!state.held || !state.qualified || resolved !== staged.canonicalDataRoot || !identity
    || identity.device !== staged.rootIdentity.device || identity.inode !== staged.rootIdentity.inode) {
    throw new PlacementBootstrapError('owner-root-changed-before-eager-initialization');
  }
}
/** Coordinated acquisitions so far; the server module records this before its eager initialization. */
export function placementOwnerAcquisitions(): number { return ownerAcquisitions; }
/**
 * Only an owner acquired before the server module evaluated (and therefore
 * before its eager data-root initialization) may open the database.
 */
export function assertPlacementOwnedBeforeEagerInitialization(bootstrap: PlacementBootstrap, acquisitionsAtServerEvaluation: number): void {
  if (bootstrap.mode !== 'coordinated' || bootstrap.sequence <= acquisitionsAtServerEvaluation) return;
  bootstrap.owner.close();
  throw new PlacementBootstrapError('owner-after-eager-initialization');
}

const NATIVE_BINDING_FAILURES = new Set(['binding', 'binding-digest', 'binding-changed', 'binding-protocol', 'native-capability', 'binding-load']);
/** Classifies a native result; `unsupported` alone never selects ordinary fallback. */
export function classifyNativeOwnerFailure(result: Exclude<NativeOwnerResult, { kind: 'held' }>): PlacementBootstrapError {
  if (result.kind === 'busy') return new PlacementBootstrapError('owner-busy', 409);
  if (result.kind === 'conflict') return new PlacementBootstrapError(`owner-conflict:${result.reason}`);
  if (NATIVE_BINDING_FAILURES.has(result.reason)) return new PlacementBootstrapError(result.reason);
  if (result.reason === 'runtime') return new PlacementBootstrapError('native-runtime-disagreement');
  return new PlacementBootstrapError(`filesystem-unclassified:${result.reason}`);
}
const identityOf = (stat: { dev: bigint; ino: bigint }) => ({ device: String(stat.dev), inode: String(stat.ino) });

/**
 * Pre-import bootstrap. With no input: constructor-sourced `not-activated`.
 * With input on a host positively outside the measured cohort: ordinary. Both
 * ordinary cases run the C2a read-only journal pre-check; a global fence throws
 * (503) instead of starting, scoped fences start with those projects closed. On the measured
 * host the only filesystem effects before ownership are an idempotent mkdir of
 * the data-root directory itself and realpath; every failure throws before the
 * server module, eager initialization or database open.
 */
export function preparePlacementBootstrap(options: {
  env?: NodeJS.ProcessEnv; projectRoot: string; host?: PlacementHostFacts;
  acquire?: typeof acquireNativePlacementOwner;
  /** Ordinary mode: how long to wait for the root lock (default `ROOT_LOCK_WAIT_MS`). */
  rootLockWaitMs?: number;
  /** Largest database the seal confirmation copies (default `SEAL_CONFIRM_MAX_BYTES`). */
  sealConfirmMaxBytes?: number;
  /** Test seam: runs inside the seal window, after the second seal reading and before database confirmation. */
  hooks?: { beforeSealConfirmation?: () => void };
}): PlacementBootstrap {
  const env = options.env ?? process.env;
  const host = options.host ?? currentPlacementHostFacts();
  const input = takePlacementBootstrapInput(env);
  const ordinary = (reason: 'not-activated' | 'host-outside-cohort', hostFact: string | null): PlacementBootstrap => {
    const root = lexicalDaemonDataRoot(env, options.projectRoot);
    // B4-1b: before its first database touch an ordinary daemon takes the root lock shared and keeps it, so it never
    // opens the database while a coordinated boot verifies and confirms its predecessor's seal (root-seal.ts).
    const locked = acquireSharedRootLock(root, { waitMs: options.rootLockWaitMs ?? ROOT_LOCK_WAIT_MS });
    if (locked.kind === 'busy') throw new PlacementBootstrapError('transition-closed:root-seal-locked');
    const rootLock = locked.kind === 'held' ? locked.lock : null;
    const transition = inspectOrdinaryTransition(root);
    // A global C2a fence (unresolved launch, unreadable/ambiguous journal) refuses mutating startup here,
    // before the server module's eager initialization or any mutating database open. Scoped project fences and a
    // root without history start normally.
    if (transition.global) { rootLock?.release(); throw new PlacementBootstrapError(`transition-closed:${transition.global}`); }
    return { mode: 'ordinary-uncoordinated', reason, hostFact, host, transition, rootLock };
  };
  if (input.kind === 'absent') return ordinary('not-activated', null);
  if (input.kind === 'malformed') throw new PlacementBootstrapError('binding-input-malformed');
  const cohort = classifyPlacementHost(host);
  if (cohort.cohort === 'outside') return ordinary('host-outside-cohort', cohort.fact);
  if (cohort.cohort === 'runtime-context') throw new PlacementBootstrapError('runtime-worker-thread');

  let provenanceSHA256: string;
  try { provenanceSHA256 = verifyPlacementOwnerProvenance(input.provenancePath, input.binding, host).provenanceSHA256; }
  catch (error) { throw new PlacementBootstrapError(`provenance-${error instanceof PlacementProvenanceError ? error.reason : 'unverified'}`); }

  const lexical = lexicalDaemonDataRoot(env, options.projectRoot);
  let createdRoot = false;
  try { mkdirSync(lexical, { mode: 0o700 }); createdRoot = true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new PlacementBootstrapError('data-root-parent-missing');
    if (code !== 'EEXIST') throw new PlacementBootstrapError(`data-root-unavailable:${code ?? 'mkdir'}`);
  }
  // B4-1: an existing root counts as created by this boot only with a tools-dev creation record and a
  // still-pristine tree (root-freshness.ts), proven before ownership and again right after it.
  const recordedBeforeOwnership = createdRoot ? null : proveRecordedFreshRoot(lexical);
  let canonicalDataRoot: string, rootIdentity: { device: string; inode: string };
  try {
    canonicalDataRoot = realpathSync.native(lexical);
    const canonicalStat = lstatSync(canonicalDataRoot, { bigint: true }), lexicalStat = statSync(lexical, { bigint: true });
    if (!canonicalStat.isDirectory() || canonicalStat.dev !== lexicalStat.dev || canonicalStat.ino !== lexicalStat.ino) throw new Error('identity');
    rootIdentity = identityOf(canonicalStat);
  } catch { throw new PlacementBootstrapError('data-root-identity'); }
  // B4-1b: the root lock is held exclusively from the first seal reading through database confirmation; busy means
  // an ordinary daemon is using the root. A recorded fresh root is not touched before its freshness proof.
  let sealLock: RootLock | null = null, lockBusy = false;
  const takeSealLock = () => {
    const locked = acquireExclusiveRootLock(canonicalDataRoot, { create: true });
    if (locked.kind === 'held') sealLock = locked.lock; else if (locked.kind === 'busy') lockBusy = true;
  };
  // Every seal reading holds the verified file open; all are released once comparison and consumption are done.
  const sealReadings: RootSealReading[] = [];
  const readSeal = () => { const reading = readRootSeal(canonicalDataRoot); sealReadings.push(reading); return reading; };
  try {
    if (!createdRoot && !recordedBeforeOwnership) takeSealLock();
    // B4-1b: the predecessor's clean-shutdown seal, read before ownership and again right after it.
    const sealBeforeOwnership = createdRoot || recordedBeforeOwnership ? null : readSeal();

    const result = (options.acquire ?? acquireNativePlacementOwner)({ binding: input.binding, canonicalDataRoot });
    if (result.kind !== 'held') throw classifyNativeOwnerFailure(result);
    const owner = result.owner;
    const attested = owner.inspect();
    let current: { device: string; inode: string } | null = null;
    try { current = identityOf(lstatSync(canonicalDataRoot, { bigint: true })); } catch { /* unknown */ }
    if (!attested.held || !attested.qualified || !current || current.device !== rootIdentity.device || current.inode !== rootIdentity.inode
      || attested.rootIdentity?.device !== rootIdentity.device || attested.rootIdentity?.inode !== rootIdentity.inode) {
      owner.close();
      throw new PlacementBootstrapError('root-identity-changed');
    }
    if (recordedBeforeOwnership && recordedBeforeOwnership.device === rootIdentity.device && recordedBeforeOwnership.inode === rootIdentity.inode) {
      const after = proveRecordedFreshRoot(canonicalDataRoot, { ownerLockFromThisBoot: true });
      if (after && after.device === rootIdentity.device && after.inode === rootIdentity.inode && consumeRootCreationRecord(canonicalDataRoot)) createdRoot = true;
    }
    if (!sealLock && !lockBusy) takeSealLock(); // Fresh roots: the file exists from now on, for later boots and seals.
    let rootSeal: RootSealEvidence = { kind: 'none' };
    if (!createdRoot) {
      const after = readSeal();
      rootSeal = sealEvidence(sealBeforeOwnership ?? after, after);
      if (rootSeal.kind === 'verified') {
        if (lockBusy || !sealLock) rootSeal = { kind: 'refused', reason: 'predecessor-seal-root-changed' }; // Another daemon holds the root.
        else {
          options.hooks?.beforeSealConfirmation?.();
          const refused = confirmRootSealOnDisk(canonicalDataRoot, rootSeal.seal, options.sealConfirmMaxBytes !== undefined ? { maxBytes: options.sealConfirmMaxBytes } : {});
          // Final comparison under the lock: nothing touched the root while the seal was confirmed.
          const final = readSeal();
          if (refused) rootSeal = { kind: 'refused', reason: refused };
          else if (final.kind === 'refused') rootSeal = { kind: 'refused', reason: final.reason };
          else if (final.kind !== 'sealed' || after.kind !== 'sealed' || !sameRootSealFile(final.file, after.file)
            || final.seal.mac !== rootSeal.seal.mac) rootSeal = { kind: 'refused', reason: 'predecessor-seal-invalid' };
        }
      }
      // One-shot whatever the outcome: a seal never vouches for a later boot. Never through a symlink. A resource
      // limit (`unverifiable`) is not evidence against the seal, so that seal is left in place.
      if (rootSeal.kind !== 'refused' || rootSeal.reason !== 'predecessor-seal-unverifiable') {
        consumeRootSeal(canonicalDataRoot, after.kind === 'sealed' ? after.file : undefined);
      }
    }
    // The server derives every daemon data path from this owned canonical root.
    env.OD_DATA_DIR = canonicalDataRoot;
    return { mode: 'coordinated', host, owner, canonicalDataRoot, rootIdentity, createdRoot, rootSeal, binding: input.binding, provenanceSHA256, sequence: ++ownerAcquisitions };
  } finally {
    // Confirmation is complete; a daemon that opens the root from here on runs alongside this one (outside the claim).
    for (const reading of sealReadings) if (reading.kind === 'sealed') reading.file.release();
    (sealLock as RootLock | null)?.release();
  }
}

/** Immediately before the database opens: the server's root must be the owned, still-qualified root. */
export function assertPlacementOwnedBeforeDatabase(bootstrap: PlacementBootstrap, runtimeDataDir: string): void {
  if (bootstrap.mode !== 'coordinated') return;
  let resolved: string | null = null, identity: { device: string; inode: string } | null = null;
  try { resolved = realpathSync.native(runtimeDataDir); identity = identityOf(lstatSync(resolved, { bigint: true })); } catch { /* unknown */ }
  const state = bootstrap.owner.inspect();
  if (resolved !== bootstrap.canonicalDataRoot || !identity || identity.device !== bootstrap.rootIdentity.device || identity.inode !== bootstrap.rootIdentity.inode) throw new PlacementBootstrapError('data-root-mismatch');
  if (!state.held || !state.qualified) throw new PlacementBootstrapError('owner-lost');
}
