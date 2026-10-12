import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { release } from 'node:os';
import { isMainThread } from 'node:worker_threads';
import { validDecimal } from './protocol.js';
export const OWNER_FILE_NAME = '.daemon-placement-owner.lock';
interface Identity { device: string; inode: string }
export interface OwnerAttestation { held: boolean; qualified: boolean; reason: string; errno: number; rootIdentity: Identity | null; ownerIdentity: Identity | null }
export interface NativePlacementOwner { readonly canonicalDataRoot: string; inspect(): OwnerAttestation; close(): void }
export type NativeOwnerResult = { kind: 'held'; owner: NativePlacementOwner } | { kind: 'busy' | 'unsupported' | 'conflict'; reason: string; errno?: number };
interface NativeOwner { inspect(): unknown; close(): void }
interface NativeModule { capability(): unknown; acquire(root: string): unknown }
const require = createRequire(import.meta.url);
const modules = new Map<string, { hash: string; native: NativeModule }>();
function record(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function exact(v: Record<string, unknown>, names: string[]): boolean { return Object.getOwnPropertyNames(v).length === names.length && names.every(n => Object.hasOwn(v, n)); }
function identity(v: unknown): v is Identity { return record(v) && exact(v, ['device', 'inode']) && validDecimal(v.device) && validDecimal(v.inode); }
function attestation(v: unknown): v is OwnerAttestation {
  return record(v) && exact(v, ['held', 'qualified', 'reason', 'errno', 'rootIdentity', 'ownerIdentity']) && typeof v.errno === 'number' && Number.isSafeInteger(v.errno) && v.errno >= 0 && typeof v.held === 'boolean' && typeof v.qualified === 'boolean' && (!v.qualified || v.held) && typeof v.reason === 'string' && /^[a-z-]{1,64}$/.test(v.reason) && [v.rootIdentity, v.ownerIdentity].every(i => i === null || identity(i));
}
function canonicalRoot(path: string): boolean { return typeof path === 'string' && isAbsolute(path) && normalize(path) === path && !/[\u0000-\u001f\u007f]/u.test(path) && Buffer.from(path).toString() === path; }
const invalidObservation = (): OwnerAttestation => ({ held: false, qualified: false, reason: 'native-observation', errno: 0, rootIdentity: null, ownerIdentity: null });
export function acquireNativePlacementOwner(input: { binding: { path: string; sha256: string }; canonicalDataRoot: string }): NativeOwnerResult {
  if (!canonicalRoot(input.canonicalDataRoot)) return { kind: 'conflict', reason: 'canonical-root' };
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node !== '24.16.0' || release() !== '25.5.0' || !isMainThread) return { kind: 'unsupported', reason: 'runtime' };
  const path = input.binding.path, hash = input.binding.sha256;
  if (!isAbsolute(path) || !path.endsWith('.node') || !/^[0-9a-f]{64}$/.test(hash)) return { kind: 'unsupported', reason: 'binding' };
  let native: NativeModule;
  try {
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== hash) return { kind: 'unsupported', reason: 'binding-digest' };
    const prior = modules.get(path);
    if (prior && prior.hash !== hash) return { kind: 'unsupported', reason: 'binding-changed' };
    if (prior) native = prior.native;
    else {
      const loaded: unknown = require(path);
      if (!record(loaded) || !exact(loaded, ['acquire', 'capability']) || typeof loaded.acquire !== 'function' || typeof loaded.capability !== 'function') return { kind: 'unsupported', reason: 'binding-protocol' };
      native = loaded as unknown as NativeModule;
      const cap = native.capability();
      if (!record(cap) || !exact(cap, ['version', 'status', 'reason', 'errno']) || cap.version !== 1 || cap.status !== 'supported' || cap.reason !== 'none' || cap.errno !== 0) return { kind: 'unsupported', reason: 'native-capability' };
      modules.set(path, { hash, native });
    }
    const result = native.acquire(input.canonicalDataRoot);
    if (!record(result) || result.version !== 1 || typeof result.reason !== 'string' || !/^[a-z-]{1,64}$/.test(result.reason) || typeof result.errno !== 'number' || !Number.isSafeInteger(result.errno) || result.errno < 0) return { kind: 'unsupported', reason: 'binding-protocol' };
    if (result.status !== 'owned') {
      if (!exact(result, ['version', 'status', 'reason', 'errno']) || typeof result.status !== 'string' || !['busy', 'unsupported', 'conflict'].includes(result.status)) return { kind: 'unsupported', reason: 'binding-protocol' };
      return { kind: result.status as 'busy' | 'unsupported' | 'conflict', reason: result.reason, errno: result.errno };
    }
    const handle = result.owner;
    if (!exact(result, ['version', 'status', 'reason', 'errno', 'owner']) || result.reason !== 'none' || result.errno !== 0 || !record(handle) || !exact(handle, ['inspect', 'close']) || typeof handle.inspect !== 'function' || typeof handle.close !== 'function') { if(record(handle) && typeof handle.close === 'function') (handle as unknown as NativeOwner).close(); return { kind: 'unsupported', reason: 'binding-protocol' }; }
    const owner = handle as unknown as NativeOwner;
    let closed = false, tainted = false, lastHeld = true;
    const inspect = (): OwnerAttestation => {
      try {
        const value = owner.inspect(); // Keep the actual native receiver intact.
        if (!attestation(value) || value.reason === 'protocol') { tainted = true; return { ...invalidObservation(), held: lastHeld }; }
        lastHeld = value.held;
        if (!value.qualified) tainted = true;
        return { ...value, qualified: !closed && !tainted && value.qualified };
      } catch { tainted = true; return { ...invalidObservation(), held: lastHeld }; }
    };
    const initial = inspect();
    if (!initial.held || !initial.qualified) { owner.close(); const after=owner.inspect(); return { kind: 'conflict', reason: !attestation(after) || after.held ? 'close-uncertain' : initial.reason, errno: !attestation(after) ? 0 : after.held ? after.errno : initial.errno }; }
    return { kind: 'held', owner: Object.freeze({ canonicalDataRoot: input.canonicalDataRoot, inspect, close: () => { closed = true; owner.close(); } }) };
  } catch { return { kind: 'unsupported', reason: 'binding-load' }; }
}
