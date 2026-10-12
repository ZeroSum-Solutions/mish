import type { ApiErrorCode } from '@open-design/contracts';
import { PlacementCoordinationError } from './write-coordinator.js';
import { PlacementCapabilityError } from './project-registry.js';
import type { PlacementHostFacts } from './owner-provenance.js';

export type PlacementMode = 'ordinary-uncoordinated' | 'coordinated-closed' | 'coordinated-open';
export type { PlacementHostFacts } from './owner-provenance.js';

/** Pre-ownership refusal. Thrown before the server module, eager initialization or mutating DB open. */
export class PlacementBootstrapError extends Error {
  constructor(readonly reason: string, readonly status: 409 | 503 = 503) {
    super(`Placement bootstrap refused mutating startup: ${reason}`); this.name = 'PlacementBootstrapError';
  }
}

/** Adoption stays closed in Q1 for every mode; these name the remaining gates. */
export const PLACEMENT_ACTIVATION_GATES = Object.freeze([
  'controlled-writers-unmigrated', 'project-subprocess-drain-unmigrated', 'source-authority-executor-preparer',
  'preview-edit-wire-unfrozen', 'hero-proof-missing',
] as const);

/** Internal-only daemon status. Not an HTTP DTO; no UI or compiled CLI surface. */
/**
 * B4-1b: how this boot excludes an unrecorded predecessor. `created`: this
 * boot created the data root; `sealed`: the owned database confirmed the
 * predecessor's clean-shutdown seal (`generation`); `unproven`: neither, with
 * the typed `predecessor-seal-*` reason.
 */
export interface PlacementPredecessorProof { proof: 'created' | 'sealed' | 'unproven'; generation: number | null; reason: string | null }
export interface PlacementRuntimeStatus {
  schema: 'mishmash.placement-runtime-status/v1';
  mode: PlacementMode; reason: string;
  host: PlacementHostFacts;
  binding: { sha256: string; provenanceSHA256: string } | null;
  dataRoot: { canonical: string; identity: { device: string; inode: string }; createdThisBoot: boolean; predecessor: PlacementPredecessorProof } | null;
  incarnationId: string | null;
  recovery: {
    global: 'clear' | 'blocked' | 'not-applicable'; unresolvedLaunches: readonly string[];
    /** Latest exact-fact collection per prior launch, including any named limit (e.g. Darwin tree completeness). */
    priorLaunches: ReadonlyArray<{ launchId: string; state: string; limit?: string }>;
    blockedGateKeys: readonly string[]; blockedProjectIds: readonly string[];
  };
  transition: { kind: string; global: string | null; fencedProjectRoots: readonly string[]; fencedProjectIds: readonly string[]; sidecars: unknown } | null;
  registry: { epoch: number; registrations: number; unavailableProjects: readonly string[] } | null;
  /** `executor`: the coordinated prepare/apply/undo executor is wired; the named gates still bound its claims. */
  activation: { adoption: 'closed' | 'executor'; gates: readonly string[] };
}

export interface PlacementHttpMapping {
  status: 409 | 422 | 503; code: ApiErrorCode; message: string; retryable: boolean;
  /** `gates`: the named activation gates of a refused adoption capability. */
  details: { kind: 'placement'; reason: string; gates?: string[] };
}
/**
 * HTTP-boundary mapping with existing envelope codes. Busy/scope changes are
 * 409, unavailable qualification or recovery 503, unsupported adoption 422.
 * Legacy success/error DTOs are not widened; the reason travels in details.
 */
export function mapPlacementFailure(error: unknown): PlacementHttpMapping | null {
  const map = (status: PlacementHttpMapping['status'], code: ApiErrorCode, reason: string, message: string, retryable: boolean): PlacementHttpMapping =>
    ({ status, code, message, retryable, details: { kind: 'placement', reason } });
  if (error instanceof PlacementCapabilityError) return map(422, 'VALIDATION_FAILED', 'unsupported-capability', error.message, false);
  if (error instanceof PlacementBootstrapError) return map(error.status, error.status === 409 ? 'CONFLICT' : 'UPSTREAM_UNAVAILABLE', error.reason, error.message, true);
  if (error instanceof PlacementCoordinationError) {
    switch (error.code) {
      case 'OWNER_UNQUALIFIED': case 'OWNER_RECOVERING': case 'PROJECT_RECOVERING': case 'ADMISSION_CLOSED':
        return map(503, 'UPSTREAM_UNAVAILABLE', error.code, error.message, true);
      case 'RUN_SCOPE_CHANGED': case 'COORDINATOR_BUSY':
        return map(409, 'CONFLICT', error.code, error.message, true);
      default: return null;
    }
  }
  return null;
}
/** Adoption/placement capability refusal (422) whenever no executor is wired, preserving caller selections. */
export function placementAdoptionUnavailable(status: PlacementRuntimeStatus): PlacementHttpMapping {
  const mapped = mapPlacementFailure(new PlacementCapabilityError(`Adoption is unavailable (${status.mode}: ${status.activation.gates.join(', ')})`))!;
  return { ...mapped, details: { ...mapped.details, gates: [...status.activation.gates] } };
}
