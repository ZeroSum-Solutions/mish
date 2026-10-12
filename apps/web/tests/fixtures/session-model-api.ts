import {
  parsePutSessionModel, parseSessionModelSnapshot,
  type PutSessionModel, type SessionModelSnapshot, type WorkspaceCollabContext,
} from '@mish/contracts';
import { workspaceAccountScopedCacheKey } from '../../src/collab/workspace-identity';

// Component fixtures keep the real session controller/save preflight in place.
// This only replaces the daemon model-record boundary, not run admission.
const snapshots = new Map<string, SessionModelSnapshot>();
export function resetSessionModelApiFixture(): void { snapshots.clear(); }
function key(sessionId: string, projectId: string, context?: WorkspaceCollabContext | null): string {
  return JSON.stringify([workspaceAccountScopedCacheKey(context), projectId, sessionId]);
}
export async function getSessionModelFixture(sessionId: string, projectId: string, context?: WorkspaceCollabContext | null): Promise<SessionModelSnapshot> {
  return parseSessionModelSnapshot(snapshots.get(key(sessionId, projectId, context)) ?? { sessionId, projectId, revision: 0, choice: null, updatedAt: 0 });
}
export async function putSessionModelFixture(sessionId: string, projectId: string, input: PutSessionModel, context?: WorkspaceCollabContext | null): Promise<SessionModelSnapshot> {
  const parsed = parsePutSessionModel(input);
  // Compare and write without yielding, matching the daemon's atomic revision check.
  const prior = snapshots.get(key(sessionId, projectId, context)) ?? { revision: 0 };
  if (prior.revision !== parsed.expectedRevision) throw Object.assign(new Error('session-model-conflict'), { status: 409 });
  const { expectedRevision, ...choice } = parsed;
  const snapshot = parseSessionModelSnapshot({ sessionId, projectId, revision: expectedRevision + 1, choice, updatedAt: 1 });
  snapshots.set(key(sessionId, projectId, context), snapshot);
  return snapshot;
}
