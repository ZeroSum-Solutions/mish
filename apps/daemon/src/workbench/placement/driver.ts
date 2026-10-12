import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { release } from 'node:os';
import { parsePlacementReply, sameObject, sameParent, validDecimal, validParent, validPlacementName, type ObjectIdentity, type ParentIdentity, type PlacementReply } from './protocol.js';

export interface Helper { path: string; sha256: string }
/**
 * Test seam only: runs after the helper was verified and immediately before
 * the pre-spawn identity re-check, so a swap in that window is observable.
 */
export interface DriverHooks { beforeSpawn?(command: string): Promise<void> | void }
export interface Location { parent: { path: string; identity: ParentIdentity }; name: string }
export interface MoveRequest { helper: Helper; source: Location; target: Location; expectedSource: ObjectIdentity; hooks?: DriverHooks }
export interface HelperExit { pid: number | null; exited: true; exitCode: number | null; signal: string | null }
type Failure = { kind: 'unsupported' | 'conflict'; reason: string; mutation: 'none' };
export type MoveResult =
  | { kind: 'observed-move'; invocationId: string; observation: PlacementReply; child: HelperExit; contentVerification: 'required' }
  | { kind: 'conflict'; invocationId: string; reason: string; mutation: 'none' | 'possible'; observation: PlacementReply | null; child: HelperExit | null }
  | { kind: 'unknown-result'; invocationId: string; reason: string; mutation: 'possible'; observation: PlacementReply | null; child: HelperExit | null };
export interface ReadyMove {
  kind: 'ready'; observation: PlacementReply;
  execute(afterDurableIntent: (intent: { invocationId: string }) => Promise<void>): Promise<MoveResult>;
  close(): Promise<void>;
}
// Darwin O_NOFOLLOW_ANY, pinned to the qualified SDK/host. Do not weaken to leaf-only O_NOFOLLOW.
const NOFOLLOW_ANY = 0x20000000;
/** The measured runtime the helper protocol is qualified on. Provisioning reports the same rule as its host gate. */
export function placementRuntimeQualified(host: { platform: string; arch: string; release: string } = { platform: process.platform, arch: process.arch, release: release() }): boolean {
  return host.platform === 'darwin' && host.arch === 'arm64' && host.release === '25.5.0';
}
const runtimeQualified = () => placementRuntimeQualified();
const fail = (kind: Failure['kind'], reason: string): Failure => ({ kind, reason, mutation: 'none' });
/** Identity of the verified helper object; the pre-spawn check compares the named binary against it. */
interface HelperIdentity { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
/**
 * Hashes the helper from one descriptor opened with `O_NOFOLLOW_ANY` (no
 * symlink anywhere in the path) and returns that object's identity when the
 * bytes match the recorded digest. The name is re-checked to still be the
 * same object after reading.
 */
async function verifiedHelper(helper: Helper): Promise<HelperIdentity | null> {
  if (!isAbsolute(helper.path) || !/^[0-9a-f]{64}$/.test(helper.sha256)) return null;
  let handle: FileHandle | undefined;
  try {
    handle = await open(helper.path, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW_ANY);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return null;
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes.length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return null;
    if (createHash('sha256').update(bytes).digest('hex') !== helper.sha256) return null;
    const identity: HelperIdentity = { dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs };
    return await namedHelperIs(helper.path, identity) ? identity : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); }
}
async function namedHelperIs(path: string, identity: HelperIdentity): Promise<boolean> {
  try {
    const named = await lstat(path, { bigint: true });
    return named.isFile() && named.dev === identity.dev && named.ino === identity.ino && named.size === identity.size && named.mtimeNs === identity.mtimeNs && named.ctimeNs === identity.ctimeNs;
  } catch { return false; }
}
const trustedHelper = async (helper: Helper): Promise<boolean> => (await verifiedHelper(helper)) !== null;
async function openParent(path: string): Promise<FileHandle> {
  if (!isAbsolute(path)) throw new Error('Absolute parent required');
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW_ANY);
}
async function openPair(source: string, target: string): Promise<[FileHandle, FileHandle]> {
  const s = await openParent(source);
  try { return [s, await openParent(target)]; } catch (error) { await s.close(); throw error; }
}
async function namedParentMatches(path: string, expected: ParentIdentity): Promise<boolean> {
  let handle: FileHandle | undefined, matches = false;
  try {
    handle = await openParent(path); const stat = await handle.stat({ bigint: true });
    matches = stat.isDirectory() && stat.dev.toString() === expected.device && stat.ino.toString() === expected.inode;
  } catch { /* Missing or unsafe named binding. */ }
  try { await handle?.close(); } catch { matches = false; }
  return matches;
}
async function heldParentsMatch(handles: [FileHandle, FileHandle], input: MoveRequest): Promise<boolean> {
  try {
    const parents = [input.source.parent.identity, input.target.parent.identity];
    const stats = await Promise.all(handles.map(h => h.stat({ bigint: true })));
    return stats.every((st, i) => st.isDirectory() && st.dev.toString() === parents[i]!.device && st.ino.toString() === parents[i]!.inode);
  } catch { return false; }
}
async function bindingsMatch(input: MoveRequest): Promise<boolean> {
  return (await namedParentMatches(input.source.parent.path, input.source.parent.identity)) && (await namedParentMatches(input.target.parent.path, input.target.parent.identity));
}
/**
 * Only these two directory descriptors enter stdio. An owner descriptor is
 * never accepted. Immediately before spawning, the named helper must still be
 * the verified object; otherwise nothing is spawned (`helperChanged`).
 */
async function invoke(helper: Helper, command: string, id: string, handles: [FileHandle, FileHandle], suffix: string[], hooks?: DriverHooks) {
  const verified = await verifiedHelper(helper);
  if (verified) await hooks?.beforeSpawn?.(command);
  if (!verified || !await namedHelperIs(helper.path, verified)) return { reply: null, child: null, helperChanged: true as const };
  return new Promise<{ reply: PlacementReply | null; child: HelperExit; helperChanged?: undefined }>(resolve => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(helper.path, [command, '1', id, String(process.pid), '3', '4', ...suffix], { stdio: ['ignore', 'pipe', 'pipe', handles[0].fd, handles[1].fd], env: {} }); }
    catch { resolve({ reply: null, child: { pid: null, exited: true, exitCode: null, signal: null } }); return; }
    let output = '', bytes = 0, invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill('SIGKILL'); }, 15000);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8192) { invalid = true; child.kill('SIGKILL'); } else output += chunk.toString('utf8');
    });
    // Drain but never publish uncontrolled diagnostics or inherited environment.
    child.stderr?.resume();
    child.on('error', () => { invalid = true; });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ reply: !invalid && exitCode === 0 && signal === null ? parsePlacementReply(output, id) : null, child: { pid: child.pid ?? null, exited: true, exitCode, signal } });
    });
  });
}
export async function inspectPlacementParents(input: { helper: Helper; sourceParentPath: string; targetParentPath: string; hooks?: DriverHooks }): Promise<{ kind: 'qualified'; sourceParent: ParentIdentity; targetParent: ParentIdentity } | Failure> {
  if (!runtimeQualified() || !await trustedHelper(input.helper)) return fail('unsupported', 'runtime-or-helper');
  let handles: [FileHandle, FileHandle];
  try { handles = await openPair(input.sourceParentPath, input.targetParentPath); } catch { return fail('conflict', 'parent-path'); }
  try {
    const invoked = await invoke(input.helper, 'inspect-parents', randomUUID(), handles, [], input.hooks);
    if (invoked.helperChanged) return fail('unsupported', 'helper-changed');
    const { reply } = invoked;
    if (reply?.status === 'qualified' && reply.sourceParent && reply.targetParent) return { kind: 'qualified', sourceParent: reply.sourceParent, targetParent: reply.targetParent };
    return fail(reply?.status === 'unsupported' ? 'unsupported' : 'conflict', reply?.reason ?? 'helper-observation');
  } finally { await Promise.allSettled(handles.map(h => h.close())); }
}
export async function prepareExclusiveMove(input: MoveRequest): Promise<ReadyMove | Failure> {
  // Freeze caller-owned inputs before awaiting. No mutable authority/identity references survive.
  const { hooks, ...cloneable } = input;
  const request: MoveRequest = structuredClone(cloneable);
  if (!validPlacementName(request.source.name) || !validPlacementName(request.target.name) || !validParent(request.source.parent.identity) || !validParent(request.target.parent.identity) || !validDecimal(request.expectedSource.device) || !validDecimal(request.expectedSource.inode) || !['file', 'directory'].includes(request.expectedSource.kind)) return fail('conflict', 'protocol');
  if (!runtimeQualified() || !await trustedHelper(request.helper)) return fail('unsupported', 'runtime-or-helper');
  let handles: [FileHandle, FileHandle];
  try { handles = await openPair(request.source.parent.path, request.target.parent.path); } catch { return fail('conflict', 'parent-path'); }
  let retained = false;
  try {
    const inspected = await invoke(request.helper, 'inspect', randomUUID(), handles, [request.source.name, request.target.name], hooks);
    if (inspected.helperChanged) return fail('unsupported', 'helper-changed');
    const observation = inspected.reply;
    if (!observation || observation.status !== 'qualified') return fail(observation?.status === 'unsupported' ? 'unsupported' : 'conflict', observation?.reason ?? 'helper-observation');
    if (!sameParent(observation.sourceParent, request.source.parent.identity) || !sameParent(observation.targetParent, request.target.parent.identity) || !sameObject(observation.sourceBefore, request.expectedSource) || observation.targetBefore !== null || !await bindingsMatch(request)) return fail('conflict', 'identity-or-binding');
    if (!await heldParentsMatch(handles, request)) return fail('conflict', 'held-parent-identity');
    retained = true;
    let used = false, closed = false;
    let pending: Promise<MoveResult> | undefined;
    let closing: Promise<void> | undefined;
    const execute = (intent: (value: { invocationId: string }) => Promise<void>): Promise<MoveResult> => {
      if (used || closed) return Promise.reject(new Error('Prepared movement is one-shot and must remain open'));
      used = true;
      const id = randomUUID();
      let knownChild: HelperExit | null = null;
      pending = (async (): Promise<MoveResult> => {
        const noMove = (reason: string): MoveResult => ({ kind: 'conflict', invocationId: id, reason, mutation: 'none', observation: null, child: null });
        if (!await trustedHelper(request.helper) || !await heldParentsMatch(handles, request) || !await bindingsMatch(request)) return noMove('helper-or-parent-changed');
        try { await intent({ invocationId: id }); } catch { return noMove('intent-failed'); }
        // The callback may yield for journal I/O. Re-resolve both named parents afterwards.
        if (!await trustedHelper(request.helper) || !await heldParentsMatch(handles, request) || !await bindingsMatch(request)) return noMove('helper-or-parent-changed-after-intent');
        const args = [request.source.name, request.target.name, request.source.parent.identity.device, request.source.parent.identity.inode, request.source.parent.identity.volumeUUID, request.target.parent.identity.device, request.target.parent.identity.inode, request.target.parent.identity.volumeUUID, request.expectedSource.device, request.expectedSource.inode, request.expectedSource.kind];
        const result = await invoke(request.helper, 'move', id, handles, args, hooks);
        // Nothing was spawned: the helper changed after verification.
        if (result.helperChanged) return noMove('helper-changed-before-spawn');
        knownChild = result.child;
        const reply = result.reply;
        if (!reply) return { kind: 'unknown-result', invocationId: id, reason: 'helper-transport', mutation: 'possible', observation: null, child: result.child };
        // Post-intent refusal is not an unsupported/no-attempt public response.
        if (reply.status === 'conflict' || reply.status === 'unsupported') return { kind: 'conflict', invocationId: id, reason: reply.reason, mutation: reply.status === 'conflict' ? 'none' : 'possible', observation: reply, child: result.child };
        if (reply.status !== 'moved') return { kind: 'unknown-result', invocationId: id, reason: reply.reason, mutation: 'possible', observation: reply, child: result.child };
        if (!sameParent(reply.sourceParent, request.source.parent.identity) || !sameParent(reply.targetParent, request.target.parent.identity) || !sameObject(reply.sourceBefore, request.expectedSource) || reply.targetBefore !== null || reply.sourceAfter !== null || !sameObject(reply.targetAfter, request.expectedSource) || !reply.targetAfter || (reply.targetAfter.kind === 'file' && reply.targetAfter.links !== 1) || (reply.targetAfter.flags & 0x40060006) !== 0 || !await bindingsMatch(request)) return { kind: 'conflict', invocationId: id, reason: 'post-move-identity-or-binding', mutation: 'possible', observation: reply, child: result.child };
        return { kind: 'observed-move', invocationId: id, observation: reply, child: result.child, contentVerification: 'required' };
      })().catch((): MoveResult => ({ kind: 'unknown-result', invocationId: id, reason: 'driver-exception', mutation: 'possible', observation: null, child: knownChild }));
      return pending;
    };
    return { kind: 'ready', observation, execute, close() {
      closed = true;
      closing ??= (async () => { try { await pending?.catch(() => undefined); } finally { await Promise.allSettled(handles.map(h => h.close())); } })();
      return closing;
    } };
  } finally { if (!retained) await Promise.allSettled(handles.map(h => h.close())); }
}
