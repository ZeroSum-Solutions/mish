import { WORKBENCH_ADOPTION_EXECUTOR_ENV, WORKBENCH_ADOPTION_HELPER_LAYOUT, WORKBENCH_ADOPTION_HELPER_RECORD_SCHEMA } from '@open-design/contracts';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import type { PlacementAdoptionExecutor } from './adoption-executor.js';
import { placementRuntimeQualified, type Helper } from './driver.js';
import { placementRootsOverlap } from './project-registry.js';

/**
 * B4-1 adoption-executor provisioning, phase A (see ADOPTION.md). Two explicit
 * opt-ins, both off by default: the process-level `OD_PLACEMENT_ADOPTION_EXECUTOR=1`
 * (set by `tools-dev --placement-adoption-executor`) and the user's Settings →
 * Labs switch (`placementAdoptionExecutor` in app-config). The daemon never
 * builds, downloads or searches for the helper: it verifies the binary the
 * development build left in the data-root-derived tool directory against the
 * digest recorded at build time. Every refusal is a named gate; there is no
 * fallback mover.
 *
 * Trust root (phase A): every check here is an integrity and staleness check
 * whose trust root is "anything running as the daemon user". The record, the
 * binary and the tool directory are writable by that user, so a process
 * running as that user can rebuild both consistently. Real provenance (a
 * code-signing team-ID pin, or a reproducible rebuild inside the daemon) is
 * phase B.
 */
export const PLACEMENT_ADOPTION_EXECUTOR_ENV = WORKBENCH_ADOPTION_EXECUTOR_ENV;
/**
 * Pinned digest of the tracked `native.c`. A sibling test recomputes it from
 * the file, so a helper source change must restate it explicitly. This is a
 * staleness check (the record claims a build of the current source), not
 * provenance: the record is written by the same user the daemon runs as.
 */
export const PLACEMENT_HELPER_SOURCE_SHA256 = 'd253bda9048b78fa3c5746358c766e03b8fc272afdfc1f205223d1b85e1a21ef';
export const PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA = WORKBENCH_ADOPTION_HELPER_RECORD_SCHEMA;
/** Path segments under the resolved daemon data root; one constant in `packages/contracts` (tools-dev keeps a pinned copy). */
export const PLACEMENT_ADOPTION_LAYOUT = WORKBENCH_ADOPTION_HELPER_LAYOUT;

export type AdoptionGate =
  | 'adoption-executor-unprovisioned' | 'adoption-opt-in-env-off' | 'adoption-opt-in-labs-off' | `adoption-host-unsupported:${string}`
  | 'adoption-helper-missing' | 'adoption-helper-record-invalid' | 'adoption-helper-source-unpinned' | 'adoption-helper-digest-mismatch'
  | 'adoption-tool-dir-unsafe' | 'adoption-tool-dir-ancestor-unsafe' | 'adoption-tool-dir-overlaps-project' | 'adoption-tool-dir-inside-project'
  | 'adoption-work-root-cross-volume' | 'adoption-work-root-unavailable' | 'adoption-work-root-outside-data-root'
  | 'adoption-executor-construction-failed';
/** `toolRoot` is the data-root directory that holds the tool directory and the work root; no project root may overlap it. */
export type AdoptionProvisioned = { kind: 'provisioned'; optIn: true; helper: Helper; workRoot: string; toolRoot?: string };
export type AdoptionProvisioning = AdoptionProvisioned | { kind: 'refused'; optIn: boolean; gates: readonly string[] };
export interface AdoptionHost { platform: string; arch: string; release?: string }

export class AdoptionProvisioningError extends Error {
  constructor(readonly gate: AdoptionGate) { super(`Adoption executor provisioning refused: ${gate}`); this.name = 'AdoptionProvisioningError'; }
}

/** Reads the process-level opt-in and removes it, so agent subprocesses never inherit it. Only the exact value `1` opts in. */
export function takeAdoptionOptIn(env: NodeJS.ProcessEnv): boolean {
  const value = env[PLACEMENT_ADOPTION_EXECUTOR_ENV];
  delete env[PLACEMENT_ADOPTION_EXECUTOR_ENV];
  return value === '1';
}
/** The driver's own runtime qualification (darwin, arm64, the measured OS release); never a looser rule. */
export function adoptionHostSupported(host: AdoptionHost): boolean {
  return placementRuntimeQualified({ platform: host.platform, arch: host.arch, release: host.release ?? release() });
}
function hostGate(host: AdoptionHost): string {
  const base = `adoption-host-unsupported:${host.platform}-${host.arch}`;
  return host.platform === 'darwin' && host.arch === 'arm64' ? `${base}-${host.release ?? release()}` : base;
}
/**
 * The Settings → Labs switch (B4-1 BLOCK 2). The daemon has no trusted
 * per-request owner identity on its loopback API: workspace identity is a
 * header the caller chooses, the desktop secret exists only in desktop builds
 * and gates only folder import, and `OD_API_TOKEN` is shared by every
 * authorized caller. So the switch is not an authority to open anything. The
 * owner's authority is the process opt-in, set by whoever starts the daemon.
 * The switch can only close: an absent or `true` value leaves the decision to
 * the process opt-in; a stored `false` closes the executor at once and the
 * closure latches for the life of the process, so no later write (from any
 * caller, with or without workspace headers) reopens it. Reopening takes the
 * owner restarting the daemon with the opt-in while the switch is not off.
 * An unreadable switch reads as off.
 */
export function createAdoptionLabsSwitch(read: () => boolean | undefined | null): { allowsOpen(): boolean } {
  let closed = false;
  const observe = () => {
    if (closed) return;
    try { if (read() === false) closed = true; } catch { closed = true; }
  };
  observe();
  return { allowsOpen: () => { observe(); return !closed; } };
}
/**
 * Every reason the executor is closed when it is not provisioned or not
 * exposed, the Labs switch included. Shared by ordinary mode, the no-journal
 * coordinated case and the exposure.
 */
export function closedAdoptionGates(refusal: readonly string[], labsOn: boolean): string[] {
  return ['adoption-executor-unprovisioned', ...refusal, ...(labsOn ? [] : ['adoption-opt-in-labs-off'])];
}
export function adoptionHelperPaths(canonicalDataRoot: string) {
  const toolDir = path.join(canonicalDataRoot, ...PLACEMENT_ADOPTION_LAYOUT.toolDir);
  return {
    parent: path.join(canonicalDataRoot, PLACEMENT_ADOPTION_LAYOUT.toolDir[0]),
    toolDir, binary: path.join(toolDir, PLACEMENT_ADOPTION_LAYOUT.binary), record: path.join(toolDir, PLACEMENT_ADOPTION_LAYOUT.record),
    workRoot: path.join(canonicalDataRoot, ...PLACEMENT_ADOPTION_LAYOUT.workRoot),
  };
}

// Darwin O_NOFOLLOW_ANY (as in driver.ts): no symlink anywhere in the named path.
const NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_HELPER_BYTES = 64 * 1024 * 1024;
const refuse = (gate: AdoptionGate): never => { throw new AdoptionProvisioningError(gate); };
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);
/** Owned by this user and not writable by group or others: project content and other users cannot replace it. */
function private_(stat: { uid: number; mode: number }): boolean { return stat.uid === currentUid() && (stat.mode & 0o022) === 0; }

/**
 * Every ancestor from the filesystem root down to (excluding) `directory`
 * must be a real directory owned by root or the daemon user, and not writable
 * by group or others unless sticky (as the system temp directory is): nobody
 * else can rename the tool directory away and put another in its place.
 */
function checkAncestors(directory: string): void {
  const uid = currentUid();
  let current = path.dirname(directory);
  for (;;) {
    let stat;
    try { stat = lstatSync(current); } catch { return refuse('adoption-tool-dir-ancestor-unsafe'); }
    const writableByOthers = (stat.mode & 0o022) !== 0;
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) || (writableByOthers && (stat.mode & 0o1000) === 0)) refuse('adoption-tool-dir-ancestor-unsafe');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function checkDirectory(directory: string): void {
  let stat;
  try { stat = lstatSync(directory); } catch (error) { return refuse((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'adoption-helper-missing' : 'adoption-tool-dir-unsafe'); }
  if (!stat.isDirectory() || !private_(stat)) refuse('adoption-tool-dir-unsafe');
}
/** One descriptor: no symlink, a private regular file, bounded size; identity and bytes from the same open. */
function readPrivateFile(file: string, maxBytes: number, requireExecutable: boolean): Buffer {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW_ANY); }
  catch (error) { return refuse((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'adoption-helper-missing' : 'adoption-tool-dir-unsafe'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !private_(stat) || stat.nlink !== 1 || (requireExecutable && (stat.mode & 0o100) === 0)) refuse('adoption-tool-dir-unsafe');
    if (stat.size > maxBytes) refuse(requireExecutable ? 'adoption-tool-dir-unsafe' : 'adoption-helper-record-invalid');
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    for (let read = -1; read !== 0 && length < bytes.length;) { read = readSync(fd, bytes, length, bytes.length - length, length); length += read; }
    if (length !== stat.size) refuse('adoption-tool-dir-unsafe');
    // The name must still be this object (no swap between open and read).
    const named = lstatSync(file);
    if (!named.isFile() || named.ino !== stat.ino || named.dev !== stat.dev) refuse('adoption-tool-dir-unsafe');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

interface HelperRecord { binary: { name: string; sha256: string }; sourceSHA256: string }
const hex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\u0000');
const exact = (value: unknown, names: readonly string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
/** Strict closed-shape parser for the build-time record; no defaults, no tolerated extra fields. */
function parseHelperRecord(bytes: Buffer): HelperRecord {
  let input: unknown;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { return refuse('adoption-helper-record-invalid'); }
  if (!exact(input, ['schema', 'binary', 'sourceSHA256', 'platform', 'arch', 'compiler', 'command', 'buildReceipt'])) return refuse('adoption-helper-record-invalid');
  const binary = input.binary;
  if (input.schema !== PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA || !exact(binary, ['name', 'sha256']) || binary.name !== PLACEMENT_ADOPTION_LAYOUT.binary || !hex(binary.sha256)
    || !hex(input.sourceSHA256) || input.platform !== 'darwin' || input.arch !== 'arm64' || !text(input.compiler) || !text(input.buildReceipt)
    || !Array.isArray(input.command) || input.command.length === 0 || !input.command.every(text)) return refuse('adoption-helper-record-invalid');
  return { binary: { name: binary.name, sha256: binary.sha256 }, sourceSHA256: input.sourceSHA256 };
}
const physical = (root: string): string => { try { return realpathSync.native(root); } catch { return path.resolve(root); } };

/**
 * Resolve the executor inputs for one daemon boot. The caller passes the
 * resolved daemon data root and every current project root (managed root and
 * imported `baseDir`s); the tool directory and work root must not overlap any
 * of them. Nothing here creates, builds or repairs anything.
 */
export function resolveAdoptionProvisioning(input: {
  optIn: boolean; dataRoot: string; projectRoots: readonly string[]; host?: AdoptionHost;
}): AdoptionProvisioning {
  if (!input.optIn) return { kind: 'refused', optIn: false, gates: ['adoption-opt-in-env-off'] };
  const host = input.host ?? { platform: process.platform, arch: process.arch, release: release() };
  if (!adoptionHostSupported(host)) return { kind: 'refused', optIn: true, gates: [hostGate(host)] };
  try {
    let canonical: string;
    try { canonical = realpathSync.native(input.dataRoot); } catch { return refuse('adoption-helper-missing'); }
    const paths = adoptionHelperPaths(canonical);
    if (input.projectRoots.some(root => placementRootsOverlap(physical(root), paths.parent))) refuse('adoption-tool-dir-overlaps-project');
    checkDirectory(paths.parent); checkDirectory(paths.toolDir);
    checkAncestors(paths.parent);
    const record = parseHelperRecord(readPrivateFile(paths.record, MAX_RECORD_BYTES, false));
    if (record.sourceSHA256 !== PLACEMENT_HELPER_SOURCE_SHA256) refuse('adoption-helper-source-unpinned');
    const binary = readPrivateFile(paths.binary, MAX_HELPER_BYTES, true);
    // The trusted digest is the build-time record's; the binary only has to match it.
    // The driver re-hashes it from a no-follow descriptor and re-checks its identity before every spawn.
    if (createHash('sha256').update(binary).digest('hex') !== record.binary.sha256) refuse('adoption-helper-digest-mismatch');
    return { kind: 'provisioned', optIn: true, helper: { path: paths.binary, sha256: record.binary.sha256 }, workRoot: paths.workRoot, toolRoot: paths.parent };
  } catch (error) {
    if (error instanceof AdoptionProvisioningError) return { kind: 'refused', optIn: true, gates: [error.gate] };
    return { kind: 'refused', optIn: true, gates: ['adoption-tool-dir-unsafe'] };
  }
}

const deviceOf = (canonical: string) => String(lstatSync(canonical, { bigint: true }).dev);
/** The nearest existing ancestor (inclusive): the device the work root will be created on. */
function nearestExisting(target: string): string {
  let current = path.resolve(target);
  for (;;) {
    try { lstatSync(current); return realpathSync.native(current); }
    catch { const parent = path.dirname(current); if (parent === current) return current; current = parent; }
  }
}
/**
 * Containment (WARN): the work root must be a strict descendant of the
 * canonical data root, reached through real directories only. Every existing
 * component below the data root is checked with `lstat`, so a symlinked
 * `placement` or `adoption-work` is refused before anything follows it.
 */
function workRootContainmentGate(workRoot: string, dataRoot: string): AdoptionGate | null {
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync.native(dataRoot); } catch { return 'adoption-work-root-unavailable'; }
  const lexical = path.resolve(workRoot);
  const lexicalRoot = path.resolve(dataRoot);
  const base = lexical.startsWith(canonicalRoot + path.sep) ? canonicalRoot : lexical.startsWith(lexicalRoot + path.sep) ? lexicalRoot : null;
  if (!base) return 'adoption-work-root-outside-data-root';
  let current = base;
  for (const segment of path.relative(base, lexical).split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') return 'adoption-work-root-outside-data-root';
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory()) return 'adoption-work-root-outside-data-root';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; // Created later, privately, by prepareAdoptionWorkRoot.
      return 'adoption-work-root-unavailable';
    }
  }
  return null;
}
/** Non-mutating readiness check (containment, then volume); `prepareAdoptionWorkRoot` repeats both on the created directory. */
export function adoptionWorkRootVolumeGate(input: { workRoot: string; projectsDir: string; dataRoot?: string; observeDevice?: (canonical: string) => string }): AdoptionGate | null {
  if (input.dataRoot) { const contained = workRootContainmentGate(input.workRoot, input.dataRoot); if (contained) return contained; }
  const device = input.observeDevice ?? deviceOf;
  try { return device(nearestExisting(input.workRoot)) === device(realpathSync.native(input.projectsDir)) ? null : 'adoption-work-root-cross-volume'; }
  catch { return 'adoption-work-root-unavailable'; }
}
/**
 * Create (privately) and canonicalize the work root that holds `blobs/`,
 * `staging/` and `retention/`. Movements are same-volume renames, so the work
 * root must share a device with the managed projects root.
 */
export function prepareAdoptionWorkRoot(input: { workRoot: string; projectsDir: string; dataRoot: string; observeDevice?: (canonical: string) => string }): string {
  const before = workRootContainmentGate(input.workRoot, input.dataRoot);
  if (before) refuse(before);
  let workRoot: string, managed: string, canonicalRoot: string;
  try {
    mkdirSync(input.workRoot, { recursive: true, mode: 0o700 });
    workRoot = realpathSync.native(input.workRoot); managed = realpathSync.native(input.projectsDir); canonicalRoot = realpathSync.native(input.dataRoot);
    const stat = lstatSync(input.workRoot);
    if (!stat.isDirectory() || !private_(stat)) throw new Error('work root');
  } catch { return refuse('adoption-work-root-unavailable'); }
  // After creation: still no symlink on the way, and the real path is strictly inside the canonical data root.
  const after = workRootContainmentGate(input.workRoot, input.dataRoot);
  if (after) refuse(after);
  if (!workRoot.startsWith(canonicalRoot + path.sep)) refuse('adoption-work-root-outside-data-root');
  const device = input.observeDevice ?? deviceOf;
  if (device(workRoot) !== device(managed)) refuse('adoption-work-root-cross-volume');
  return workRoot;
}

/**
 * The executor as the routes see it. Readiness (`ready()`, `gates()`) is
 * computed without filesystem effects, so status never constructs anything.
 * The executor itself is constructed lazily, once, on the first `current()`
 * while ready. The Labs switch is read on every access and takes effect
 * without a restart. Two refusals latch for the life of the process: a
 * construction refusal, and a project root that overlaps the tool directory
 * or work root (`adoption-tool-dir-inside-project`), checked on every access
 * against the current project roots, so a later import or registration closes
 * the executor until restart.
 */
export class AdoptionExposure {
  #built: PlacementAdoptionExecutor | null = null;
  #failure: string | null = null;
  constructor(private readonly input: {
    provisioning: AdoptionProvisioning;
    enabled: () => boolean;
    build: (provisioned: AdoptionProvisioned) => PlacementAdoptionExecutor;
    /** Current managed and imported project roots; any overlap with the guarded roots latches the executor closed. */
    projectRoots?: () => readonly string[];
    /** Managed projects root, for the non-mutating work-root volume readiness check. */
    projectsDir?: string;
    /** Canonical daemon data root, for the work-root containment readiness check. */
    dataRoot?: string;
    /**
     * Fixed reasons that keep the executor closed for this process, e.g.
     * `legacy-predecessor-unproven` when the data root was not created (or
     * proven fresh) by this boot (RUNTIME.md "Legacy and mixed-mode roots").
     */
    blocked?: readonly string[];
  }) {}
  #enabled(): boolean { try { return this.input.enabled() === true; } catch { return false; } }
  /** Latches `adoption-tool-dir-inside-project` when a current project root overlaps a guarded root. */
  #checkProjectOverlap(provisioned: AdoptionProvisioned): void {
    if (this.#failure || !this.input.projectRoots) return;
    const guarded = [provisioned.toolRoot, provisioned.workRoot].filter((root): root is string => typeof root === 'string').map(physical);
    let roots: readonly string[];
    try { roots = this.input.projectRoots(); } catch { this.#failure = 'adoption-tool-dir-inside-project'; return; }
    if (roots.some(root => guarded.some(guard => placementRootsOverlap(physical(root), guard)))) this.#failure = 'adoption-tool-dir-inside-project';
  }
  /** Reasons it is closed right now; empty when `current()` would open (or has opened) the executor. */
  #closed(): string[] {
    const provisioning = this.input.provisioning;
    const labsOn = this.#enabled();
    if (provisioning.kind !== 'provisioned') return closedAdoptionGates([...provisioning.gates, ...(this.input.blocked ?? [])], labsOn);
    if (this.input.blocked?.length) return closedAdoptionGates([...this.input.blocked], labsOn);
    this.#checkProjectOverlap(provisioning);
    if (this.#failure) return ['adoption-executor-unprovisioned', this.#failure];
    if (!labsOn) return closedAdoptionGates([], false);
    if (!this.#built && this.input.projectsDir) {
      const volume = adoptionWorkRootVolumeGate({ workRoot: provisioning.workRoot, projectsDir: this.input.projectsDir, ...(this.input.dataRoot ? { dataRoot: this.input.dataRoot } : {}) });
      if (volume) return ['adoption-executor-unprovisioned', volume];
    }
    return [];
  }
  ready(): boolean { return this.#closed().length === 0; }
  gates(): string[] { return this.#closed(); }
  current(): PlacementAdoptionExecutor | null {
    const provisioning = this.input.provisioning;
    if (provisioning.kind !== 'provisioned' || this.#closed().length) return null;
    if (!this.#built) {
      try { this.#built = this.input.build(provisioning); }
      catch (error) { this.#failure = error instanceof AdoptionProvisioningError ? error.gate : 'adoption-executor-construction-failed'; return null; }
    }
    return this.#built;
  }
}
