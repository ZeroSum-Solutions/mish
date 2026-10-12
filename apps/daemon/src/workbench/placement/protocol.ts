/** Internal, bounded native protocol. These observations are never placement receipts. */
export interface ParentIdentity { device: string; inode: string; volumeUUID: string }
export interface ObjectIdentity { device: string; inode: string; kind: 'file' | 'directory' }
export interface ObjectObservation { device: string; inode: string; kind: 'file' | 'directory' | 'symlink' | 'other'; size: string; mode: number; links: number; flags: number }
export const REASONS = ['none', 'protocol', 'runtime', 'volume', 'parent', 'source', 'alias', 'occupied', 'observation', 'rename', 'orphan', 'descriptor'] as const;
export interface PlacementReply {
  version: 1; invocationId: string; status: 'qualified' | 'conflict' | 'unsupported' | 'moved' | 'unknown';
  reason: typeof REASONS[number]; errno: number;
  sourceParent: ParentIdentity | null; targetParent: ParentIdentity | null;
  sourceBefore: ObjectObservation | null; targetBefore: ObjectObservation | null;
  sourceAfter: ObjectObservation | null; targetAfter: ObjectObservation | null;
}
export function validPlacementName(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\/\u0000-\u001f\u007f]/u.test(value)) return false;
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= 255 && bytes.toString('utf8') === value;
}
export function validDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
}
export function validUUID(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) && value !== '00000000-0000-0000-0000-000000000000';
}
function record(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function keys(v: Record<string, unknown>, expected: string[]): boolean { return Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k)); }
function uint(v: unknown): boolean { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 4294967295; }
export function validParent(v: unknown): v is ParentIdentity {
  return record(v) && keys(v, ['device', 'inode', 'volumeUUID']) && validDecimal(v.device) && validDecimal(v.inode) && validUUID(v.volumeUUID);
}
function object(v: unknown): v is ObjectObservation {
  return record(v) && keys(v, ['device', 'inode', 'kind', 'size', 'mode', 'links', 'flags']) && validDecimal(v.device) && validDecimal(v.inode) && validDecimal(v.size) && typeof v.kind === 'string' && ['file', 'directory', 'symlink', 'other'].includes(v.kind) && uint(v.mode) && uint(v.links) && uint(v.flags);
}
export function parsePlacementReply(body: string, invocationId: string): PlacementReply | null {
  if (Buffer.byteLength(body) > 8192) return null;
  let v: unknown; try { v = JSON.parse(body); } catch { return null; }
  // Canonical helper output also rejects duplicate JSON keys and trailing records.
  if (JSON.stringify(v) !== body.trim() || !record(v) || !keys(v, ['version', 'invocationId', 'status', 'reason', 'errno', 'sourceParent', 'targetParent', 'sourceBefore', 'targetBefore', 'sourceAfter', 'targetAfter'])) return null;
  if (v.version !== 1 || !validUUID(v.invocationId) || v.invocationId !== invocationId || typeof v.status !== 'string' || !['qualified', 'conflict', 'unsupported', 'moved', 'unknown'].includes(v.status) || !REASONS.some(r => r === v.reason) || !uint(v.errno)) return null;
  if (![v.sourceParent, v.targetParent].every(p => p === null || validParent(p)) || ![v.sourceBefore, v.targetBefore, v.sourceAfter, v.targetAfter].every(p => p === null || object(p))) return null;
  if ((v.status === 'moved' || v.status === 'qualified') && (v.reason !== 'none' || v.errno !== 0)) return null;
  if (v.status === 'conflict' && v.reason === 'rename' && v.errno !== 17) return null; // Qualified Darwin EEXIST.
  return v as unknown as PlacementReply;
}
export function sameObject(a: Pick<ObjectObservation, 'device' | 'inode' | 'kind'> | null, b: ObjectIdentity): boolean { return a !== null && a.device === b.device && a.inode === b.inode && a.kind === b.kind; }
export function sameParent(a: ParentIdentity | null, b: ParentIdentity): boolean { return a !== null && a.device === b.device && a.inode === b.inode && a.volumeUUID === b.volumeUUID; }
