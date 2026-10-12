import { parseSessionModelSnapshot, type SessionModelSnapshot, type ChatRequest } from '@mish/contracts';
export interface SessionModelRequest {
  snapshot: SessionModelSnapshot;
  reasoning: string | null;
  serviceTier: string | null;
  byokMediaDefaults?: ChatRequest['byokMediaDefaults'];
  attempted: boolean;
}
function key(projectId: string, sessionId: string, requestId: string, scope: string): string {
  return `od:session-model-request:${scope}:${projectId}:${sessionId}:${requestId}`;
}
function publicMediaDefaults(input: unknown): ChatRequest['byokMediaDefaults'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const values = input as Record<string, unknown>;
  return Object.fromEntries(['imageModel', 'videoModel', 'speechModel', 'speechVoice'].flatMap(name => typeof values[name] === 'string' ? [[name, values[name]]] : []));
}
/** Public caller facts for a retry; transient credentials never enter this record. */
export function readSessionModelRequest(projectId: string, sessionId: string, requestId: string, scope: string, storage?: Pick<Storage, 'getItem'>): SessionModelRequest | null {
  try {
    const raw = (storage ?? window.sessionStorage).getItem(key(projectId, sessionId, requestId, scope));
    if (!raw) return null;
    const input = JSON.parse(raw) as SessionModelRequest;
    const snapshot = parseSessionModelSnapshot(input.snapshot);
    if (!snapshot.choice || snapshot.projectId !== projectId || snapshot.sessionId !== sessionId || typeof input.attempted !== 'boolean') return null;
    if ((input.reasoning !== null && typeof input.reasoning !== 'string') || (input.serviceTier !== null && typeof input.serviceTier !== 'string')) return null;
    return { snapshot, reasoning: input.reasoning, serviceTier: input.serviceTier, attempted: input.attempted,
      ...(input.byokMediaDefaults ? { byokMediaDefaults: publicMediaDefaults(input.byokMediaDefaults) } : {}) };
  } catch { return null; }
}
export function saveSessionModelRequest(record: SessionModelRequest, requestId: string, scope: string, storage?: Pick<Storage, 'setItem'>): void {
  const snapshot = parseSessionModelSnapshot(record.snapshot);
  (storage ?? window.sessionStorage).setItem(key(snapshot.projectId, snapshot.sessionId, requestId, scope), JSON.stringify({ snapshot, reasoning: record.reasoning, serviceTier: record.serviceTier, attempted: record.attempted, ...(record.byokMediaDefaults ? { byokMediaDefaults: publicMediaDefaults(record.byokMediaDefaults) } : {}) }));
}
export function homeHandoffClientRequestId(projectId: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < projectId.length; index += 1) {
    hash ^= BigInt(projectId.charCodeAt(index)); hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `home-auto-send-${hash.toString(36).padStart(13, '0')}`;
}
