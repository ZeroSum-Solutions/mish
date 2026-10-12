import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { JournalLaunch, PlacementJournal, ProcessIdentity } from './journal.js';
import type { PlacementWriteCoordinator, RunDrainPermit, RunPermit } from './write-coordinator.js';

export const PLACEMENT_LAUNCH_HANDSHAKE_ENV = 'OD_PLACEMENT_LAUNCH_HANDSHAKE';
/**
 * Named external limit on darwin-arm64: the process table is only sampled. An
 * owned intermediate that forks, leaves its group/session (setsid/setpgid)
 * and exits between samples is unattributable, and no kernel subreaper or
 * descendant-tracking facility is used. Same-boot owned-tree completeness is
 * therefore never certified by the sampled inventory.
 */
export const DARWIN_SAMPLED_TREE_LIMIT = 'darwin-owned-tree-completeness-unproven';

export interface ProcessTableEntry { pid: number; ppid: number; pgid: number; startToken: string; zombie: boolean }
export type ProcessTable = { kind: 'table'; entries: readonly ProcessTableEntry[] } | { kind: 'unknown'; reason: string };
/** Trusted host observation boundary. It reports facts; it never infers exit or drainage. */
export interface PlacementProcessInspector {
  bootId(): string;
  /** One full process-table snapshot. */
  table(): ProcessTable;
}
/** Exact per-process identity used for owned descendants (root launches carry the full journal tuple). */
export interface OwnedProcess { pid: number; startToken: string; via: 'ppid' | 'pgid' }
/** Proof that no unobserved owned process exists beyond the exactly known inventory. */
export interface PlacementTreeCompleteness {
  prove(input: { launchId: string; identity: ProcessIdentity; members: readonly OwnedProcess[] }): { kind: 'complete'; evidence: Record<string, unknown> } | { kind: 'unproven'; limit: string };
}
/** The only provider on this platform: completeness is never certified. */
export const darwinSampledTreeCompleteness: PlacementTreeCompleteness = Object.freeze({ prove: () => ({ kind: 'unproven' as const, limit: DARWIN_SAMPLED_TREE_LIMIT }) });

const PS = '/bin/ps', SYSCTL = '/usr/sbin/sysctl';
const psEnv = { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' };
/** Darwin inspector: `kern.bootsessionuuid` and one `ps` snapshot with UTC start time (one-second resolution). */
export function createDarwinProcessInspector(): PlacementProcessInspector {
  let boot: string | null = null;
  return {
    bootId() {
      if (boot) return boot;
      const value = execFileSync(SYSCTL, ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', env: psEnv }).trim();
      if (!/^[A-Fa-f0-9-]{36}$/.test(value)) throw new Error('Boot session identity unavailable');
      return (boot = value);
    },
    table() {
      let out: string;
      try { out = execFileSync(PS, ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8', env: psEnv, maxBuffer: 32 * 1024 * 1024 }); }
      catch { return { kind: 'unknown', reason: 'ps-failed' }; }
      const entries: ProcessTableEntry[] = [];
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        const started = m ? Date.parse(`${m[5]} UTC`) : NaN;
        if (!m || !Number.isFinite(started)) return { kind: 'unknown', reason: 'ps-unparsed' };
        entries.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), startToken: `ps-lstart-${started / 1000}`, zombie: m[4]!.startsWith('Z') });
      }
      return entries.length ? { kind: 'table', entries } : { kind: 'unknown', reason: 'ps-empty' };
    },
  };
}
type Presence = { kind: 'present'; entry: ProcessTableEntry } | { kind: 'absent' } | { kind: 'unknown'; reason: string };
/** Exact pid+birth match only; a reused PID with another birth is the exact identity's absence. */
function presence(table: ProcessTable, pid: number, startToken: string): Presence {
  if (table.kind === 'unknown') return { kind: 'unknown', reason: table.reason };
  const entry = table.entries.find(item => item.pid === pid);
  return entry && entry.startToken === startToken ? { kind: 'present', entry } : { kind: 'absent' };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  return JSON.stringify(value);
}
export type LaunchFact = 'spawn' | 'exit' | 'drain' | 'member' | 'member-exit';
/** Retains the exact observation a journal fact digest refers to, before the fact commits. */
export function retainLaunchObservation(db: Database.Database, launchId: string, fact: LaunchFact, observation: Record<string, unknown>): string {
  const body = canonicalJson({ launchId, fact, ...observation });
  const digest = createHash('sha256').update(body).digest('hex');
  db.prepare('INSERT OR IGNORE INTO placement_launch_observations VALUES (?,?,?,?)').run(digest, launchId, fact, body);
  return digest;
}
/** Durable exact owned-descendant inventory for one launch (retained member observations). */
export function readOwnedMembers(db: Database.Database, launchId: string): { members: OwnedProcess[]; settled: Set<string> } {
  const rows = db.prepare("SELECT fact, observation_json FROM placement_launch_observations WHERE launch_id=? AND fact IN ('member','member-exit')").all(launchId) as { fact: string; observation_json: string }[];
  const members: OwnedProcess[] = [], settled = new Set<string>();
  for (const row of rows) {
    const value = JSON.parse(row.observation_json) as { member: OwnedProcess };
    if (row.fact === 'member') members.push(value.member); else settled.add(memberKey(value.member));
  }
  return { members, settled };
}
const memberKey = (member: Pick<OwnedProcess, 'pid' | 'startToken'>) => `${member.pid}:${member.startToken}`;

export type PlacementTreeState =
  | { state: 'drained' }
  | { state: 'pending'; rootPresent: boolean; liveMembers: readonly OwnedProcess[] }
  | { state: 'unproven'; limit: string; members: readonly OwnedProcess[] }
  | { state: 'unknown'; reason: string };
export interface PlacementLaunchRequest { launchId?: string; kind: 'child' | 'helper'; projectRoots: readonly string[]; operationId?: string; command: string; args?: readonly string[] }
/** One coordinator child ticket plus one durable launch intent; identity, exit, inventory and drainage are separate facts. */
export interface PlacementLaunchHandle {
  readonly launchId: string; readonly handshakeId: string;
  /** Environment the caller must give the spawned process-group leader. */
  readonly env: Readonly<Record<string, string>>;
  /** Call synchronously right after spawn returns a PID; the leader must own its process group (`detached`). */
  observeSpawn(pid: number): ProcessIdentity;
  /** Records newly visible owned descendants by exact identity; call while the tree is live. */
  sample(): readonly OwnedProcess[];
  /** After the parent observed actual exit/close; refuses while the exact root identity remains present. */
  recordExit(status: { code: number | null; signal: string | null }): void;
  /** Drainage needs root exit, every known member settled and a completeness proof; only then the ticket confirms. */
  observeDrain(): PlacementTreeState;
}
export class PlacementSupervisorError extends Error {
  constructor(readonly code: 'SPAWN_UNOBSERVED' | 'GROUP_UNOWNED' | 'EXIT_UNPROVEN' | 'INVENTORY_UNKNOWN' | 'STATE', message: string) { super(message); this.name = 'PlacementSupervisorError'; }
}

/**
 * Current-incarnation supervisor adapter. It never clears a launch from PID
 * absence alone, never records a no-spawn resolution, and never forwards a
 * native ownership descriptor. A spawn failure after the durable intent keeps
 * the ticket and the data root's next-boot recovery closed.
 */
export class PlacementLaunchSupervisor {
  readonly #db: Database.Database; readonly #journal: PlacementJournal; readonly #inspector: PlacementProcessInspector;
  readonly #coordinator: PlacementWriteCoordinator; readonly #completeness: PlacementTreeCompleteness;
  constructor(options: { db: Database.Database; journal: PlacementJournal; inspector: PlacementProcessInspector; coordinator: PlacementWriteCoordinator; completeness?: PlacementTreeCompleteness }) {
    this.#db = options.db; this.#journal = options.journal; this.#inspector = options.inspector; this.#coordinator = options.coordinator;
    this.#completeness = options.completeness ?? darwinSampledTreeCompleteness;
  }
  beginLaunch(permit: RunPermit, request: PlacementLaunchRequest): PlacementLaunchHandle {
    const ticket = this.#coordinator.registerRunDrain(permit, 'child');
    const launchId = request.launchId ?? `launch-${randomUUID()}`;
    const handshakeId = `handshake-${randomUUID()}`;
    const intentDigest = createHash('sha256').update(canonicalJson({ launchId, kind: request.kind, projectRoots: [...request.projectRoots].sort(), operationId: request.operationId, command: request.command, args: request.args ?? [], handshakeId, group: 'leader' })).digest('hex');
    try {
      const { created } = this.#journal.recordLaunchIntent({ launchId, kind: request.kind, projectRoots: request.projectRoots, intentDigest, ...(request.operationId === undefined ? {} : { operationId: request.operationId }) });
      if (!created) throw new PlacementSupervisorError('STATE', 'Existing launch intent never authorizes another spawn');
    } catch (error) {
      // Nothing durable was committed and nothing was spawned by this adapter.
      if (!(error instanceof PlacementSupervisorError)) this.#coordinator.confirmRunDrain(ticket);
      throw error;
    }
    return this.#handle(launchId, handshakeId, ticket);
  }
  #handle(launchId: string, handshakeId: string, ticket: RunDrainPermit): PlacementLaunchHandle {
    let identity: ProcessIdentity | null = null, exited = false, drained = false;
    const db = this.#db, inspector = this.#inspector;
    const sample = (): readonly OwnedProcess[] => {
      if (!identity) throw new PlacementSupervisorError('STATE', 'Inventory requires an observed spawn');
      const table = inspector.table();
      if (table.kind === 'unknown') throw new PlacementSupervisorError('INVENTORY_UNKNOWN', table.reason);
      return attributeMembers(db, launchId, identity, table);
    };
    const handle: PlacementLaunchHandle = {
      launchId, handshakeId, env: Object.freeze({ [PLACEMENT_LAUNCH_HANDSHAKE_ENV]: handshakeId }),
      observeSpawn: (pid) => {
        if (identity) throw new PlacementSupervisorError('STATE', 'Spawn already observed');
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new PlacementSupervisorError('SPAWN_UNOBSERVED', 'No spawned PID to observe');
        const table = inspector.table();
        const entry = table.kind === 'table' ? table.entries.find(item => item.pid === pid) : undefined;
        if (!entry) throw new PlacementSupervisorError('SPAWN_UNOBSERVED', 'Spawned identity could not be observed');
        if (entry.pgid !== pid) throw new PlacementSupervisorError('GROUP_UNOWNED', 'Launch must lead its own process group');
        const next: ProcessIdentity = { pid, bootId: inspector.bootId(), startToken: entry.startToken, handshakeId };
        this.#journal.observeLaunch(launchId, next, retainLaunchObservation(db, launchId, 'spawn', { identity: next, entry, basis: 'parent-spawn' }));
        identity = next; return next;
      },
      sample,
      recordExit: (status) => {
        if (!identity) throw new PlacementSupervisorError('STATE', 'Exit requires an observed spawn');
        if (exited) return;
        const table = inspector.table();
        const seen = presence(table, identity.pid, identity.startToken);
        if (seen.kind === 'unknown' || (seen.kind === 'present' && !seen.entry.zombie)) throw new PlacementSupervisorError('EXIT_UNPROVEN', 'Exact identity is still present or unobservable');
        if (table.kind === 'table') attributeMembers(db, launchId, identity, table); // Last chance to see members of the exiting root.
        this.#journal.recordLaunchExit(launchId, identity, retainLaunchObservation(db, launchId, 'exit', { identity, status, observed: seen, basis: 'parent-exit' }));
        exited = true;
      },
      observeDrain: () => {
        if (drained) return { state: 'drained' };
        if (!identity) return { state: 'pending', rootPresent: false, liveMembers: [] };
        const decision = decideTree(db, launchId, identity, inspector.table(), this.#completeness, exited);
        if (decision.state !== 'drained') return decision;
        this.#journal.recordLaunchDrain(launchId, identity, decision.digest);
        this.#coordinator.confirmRunDrain(ticket); drained = true;
        return { state: 'drained' };
      },
    };
    return Object.freeze(handle);
  }
}

/** Adds every process whose parent is a live owned process, or that stays in the root's group, by exact identity. */
function attributeMembers(db: Database.Database, launchId: string, identity: ProcessIdentity, table: Extract<ProcessTable, { kind: 'table' }>): readonly OwnedProcess[] {
  const { members } = readOwnedMembers(db, launchId);
  const known = new Set(members.map(memberKey));
  const owned = new Set<number>();
  if (presence(table, identity.pid, identity.startToken).kind === 'present') owned.add(identity.pid);
  for (const member of members) if (presence(table, member.pid, member.startToken).kind === 'present') owned.add(member.pid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of table.entries) {
      if (owned.has(entry.pid)) continue;
      // A reused root PID leading an unrelated group is over-attributed: that only fences more.
      const via = owned.has(entry.ppid) ? 'ppid' : entry.pgid === identity.pid ? 'pgid' : null;
      if (!via) continue;
      owned.add(entry.pid); grew = true;
      const member: OwnedProcess = { pid: entry.pid, startToken: entry.startToken, via };
      if (!known.has(memberKey(member))) { known.add(memberKey(member)); retainLaunchObservation(db, launchId, 'member', { member, parent: entry.ppid, pgid: entry.pgid }); members.push(member); }
    }
  }
  return members;
}

/**
 * Exit and drainage stay separate. Drainage requires the exact root identity
 * gone, every exactly known member settled, and a completeness proof. The
 * Darwin sampled provider never supplies one on the same boot.
 */
function decideTree(db: Database.Database, launchId: string, identity: ProcessIdentity, table: ProcessTable, completeness: PlacementTreeCompleteness, exited: boolean):
  Exclude<PlacementTreeState, { state: 'drained' }> | { state: 'drained'; digest: string } {
  if (table.kind === 'unknown') return { state: 'unknown', reason: table.reason };
  const members = attributeMembers(db, launchId, identity, table);
  const rootPresent = presence(table, identity.pid, identity.startToken).kind === 'present';
  const liveMembers = members.filter(member => presence(table, member.pid, member.startToken).kind === 'present');
  for (const member of members) if (!liveMembers.includes(member)) retainLaunchObservation(db, launchId, 'member-exit', { member, basis: 'exact-identity-absent' });
  if (rootPresent || !exited || liveMembers.length) return { state: 'pending', rootPresent, liveMembers };
  const proof = completeness.prove({ launchId, identity, members });
  if (proof.kind !== 'complete') return { state: 'unproven', limit: proof.limit, members };
  return { state: 'drained', digest: retainLaunchObservation(db, launchId, 'drain', { identity, members, completeness: proof.evidence, basis: 'exact-tree-settled' }) };
}

export interface PriorLaunchRecovery { launchId: string; state: 'drained' | 'live' | 'pending-drain' | 'drain-unproven' | 'unknown-spawn' | 'unobservable'; limit?: string }
/**
 * Fresh exact observations for prior-incarnation launches. A changed boot
 * session proves the whole prior tree gone. On the same boot, exit needs the
 * exact root identity absent, and drainage needs every retained member
 * settled plus a completeness proof (never supplied by the Darwin sampler).
 * Unknown spawn identity, live identities or an unobservable host stay unresolved.
 */
export function collectPriorLaunchRecovery(db: Database.Database, journal: PlacementJournal, inspector: PlacementProcessInspector, completeness: PlacementTreeCompleteness = darwinSampledTreeCompleteness): readonly PriorLaunchRecovery[] {
  const results: PriorLaunchRecovery[] = [];
  const currentBoot = inspector.bootId();
  for (const launch of journal.readLaunches()) {
    if (launch.incarnationId === journal.incarnationId || launch.drainDigest) continue;
    results.push({ launchId: launch.launchId, ...recoverLaunch(db, journal, inspector, completeness, launch, currentBoot) });
  }
  return results;
}
function recoverLaunch(db: Database.Database, journal: PlacementJournal, inspector: PlacementProcessInspector, completeness: PlacementTreeCompleteness, launch: JournalLaunch, currentBoot: string): Omit<PriorLaunchRecovery, 'launchId'> {
  const identity = launch.identity;
  if (!identity) return { state: 'unknown-spawn' };
  if (identity.bootId !== currentBoot) {
    // Every process of a previous boot session is gone, including any untracked descendant.
    const basis = { basis: 'boot-session-changed', recordedBootId: identity.bootId, currentBootId: currentBoot };
    if (!launch.exitDigest) journal.recordLaunchExit(launch.launchId, identity, retainLaunchObservation(db, launch.launchId, 'exit', { identity, ...basis }));
    journal.recordLaunchDrain(launch.launchId, identity, retainLaunchObservation(db, launch.launchId, 'drain', { identity, ...basis }));
    return { state: 'drained' };
  }
  const table = inspector.table();
  const root = presence(table, identity.pid, identity.startToken);
  if (root.kind === 'unknown') return { state: 'unobservable' };
  if (root.kind === 'present') return { state: 'live' };
  if (!launch.exitDigest) journal.recordLaunchExit(launch.launchId, identity, retainLaunchObservation(db, launch.launchId, 'exit', { identity, observed: 'exact-identity-absent', basis: 'same-boot-absence' }));
  const decision = decideTree(db, launch.launchId, identity, table, completeness, true);
  if (decision.state === 'pending') return { state: 'pending-drain' };
  if (decision.state === 'unknown') return { state: 'unobservable' };
  if (decision.state === 'unproven') return { state: 'drain-unproven', limit: decision.limit };
  journal.recordLaunchDrain(launch.launchId, identity, decision.digest);
  return { state: 'drained' };
}
