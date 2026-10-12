import { parsePreparedAdoptionPlan, type PrepareAdoptionRequest, type PreparedAdoptionPlan, type ResourceRef } from '@mish/contracts';
import { sha256, type StoredBlob } from './adoption-files.js';

/** Deterministic JSON (sorted keys) for every digest the trusted manager recomputes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('JSON value required');
  return encoded;
}
export const digestOf = (value: unknown) => sha256(canonicalJson(value));
/** Recomputed plan digest: every field except the digest itself. */
export function planDigest(plan: Omit<PreparedAdoptionPlan, 'digest'> | PreparedAdoptionPlan): string {
  const { digest: _ignored, ...rest } = plan as PreparedAdoptionPlan;
  return digestOf(rest);
}

export type ObservedExpectation = PreparedAdoptionPlan['reads'][number]['expected'];
type Role = PrepareAdoptionRequest['writes'][number]['role'];
/** Contract publication order: new closure, then source/style replacements, package/lock, entry last. */
const order = (role: Role, kind: 'create' | 'replace') => role === 'entry' ? 3 : role === 'package' || role === 'lock' ? 2 : kind === 'create' ? 0 : 1;

/** Owned drafts carry owner-declared provenance only; this is not catalogue rights evidence. */
export const OWNER_DECLARED_POLICY = 'owner-declared/1';
export const NO_COMMAND_POLICY = 'regular-files-no-commands/1';
/** Catalogue admissions carry the source's exact terms and notice files; set only by trusted daemon code. */
export const CATALOGUE_ADMISSION_POLICY = 'catalogue-admission/1';

/**
 * A trusted catalogue admission for a non-owned source. It never comes from
 * request JSON: the catalogue adoption manager builds it from the resolved
 * source and its rights record. `notices` names the draft's notice writes.
 */
export interface SourceAdmission {
  resourceRef: ResourceRef;
  implementationOrigin: 'official' | 'adapted' | 'owned';
  terms: { version: string; text: string };
  notices: readonly string[];
  /** Where the catalogue bytes came from; recorded in the plan and read by the apply-time re-check. */
  origin?: NonNullable<PreparedAdoptionPlan['source']['origin']>;
}

export interface PlanInput {
  id: string; principalId: string; draft: PrepareAdoptionRequest;
  projectRoot: PreparedAdoptionPlan['projectRoot'];
  /** Current observation of every draft write path (same order as the draft). */
  observed: ReadonlyMap<string, ObservedExpectation>;
  outputs: ReadonlyMap<string, StoredBlob>;
  /** Exact package/lock observations folded into the dependency digest. */
  dependencyObservations: Readonly<Record<string, ObservedExpectation>>;
  preparedAt: number;
  /** Present only for a catalogue-admitted, non-owned source. */
  admission?: SourceAdmission;
}
/**
 * Builds and strictly validates a version-1 plan from fresh observations. The
 * plan binds the exact read expectations it was prepared against, so any later
 * external edit is a read-set conflict at apply time.
 */
export function buildPreparedPlan(input: PlanInput): PreparedAdoptionPlan {
  const { draft } = input;
  const writes = draft.writes.map((w, index) => {
    const before = input.observed.get(w.path); const blob = input.outputs.get(w.path);
    if (!before || !blob) throw new Error('Every draft write requires an observation and a stored output');
    const kind = before.kind === 'absent' ? 'create' as const : 'replace' as const;
    return { index, role: w.role, write: { path: w.path, kind, after: { sha256: blob.sha256, bytes: blob.byteLength, blobId: blob.blobId, role: w.role } } };
  }).sort((a, b) => order(a.role, a.write.kind) - order(b.role, b.write.kind) || a.index - b.index).map(entry => entry.write);
  const reads = draft.writes.map(w => ({ path: w.path, expected: input.observed.get(w.path)! }));
  const readSetDigest = digestOf(reads), writeSetDigest = digestOf(writes);
  const closureDigest = digestOf(writes.map(w => ({ path: w.path, sha256: w.after.sha256, role: w.after.role })));
  const adapter = draft.adapter ?? { id: 'regular-files', version: '1' };
  const evidence = `observation-${readSetDigest.slice(0, 32)}`;
  const preparedAt = new Date(input.preparedAt);
  const unsigned: Omit<PreparedAdoptionPlan, 'digest'> = {
    schema: 'workbench-prepared-plan/1', id: input.id, principalId: input.principalId, projectId: draft.projectId,
    projectRoot: input.projectRoot, adapter,
    target: {
      profileId: adapter.id, entryPath: draft.entryPath, toolchainDigest: digestOf({ adapter, commands: NO_COMMAND_POLICY }),
      dependencyDigest: digestOf(input.dependencyObservations), buildInputDigest: digestOf({ reads, writes }),
    },
    source: input.admission ? admittedSource(input.admission, input.principalId, draft.projectId, closureDigest) : {
      resourceRef: draft.source.resourceRef ?? { sourceType: 'library', sourceId: 'library', itemId: 'owned-draft', revisionOrDigest: closureDigest },
      implementationOrigin: draft.source.implementationOrigin, admissionId: `owner-declared-${closureDigest.slice(0, 32)}`, admissionRevision: 1,
      acquiredSha256: closureDigest, closureDigest, terms: null, assessments: [{ id: 'owner-declared', revision: 1 }],
      rightsSnapshotDigest: digestOf({ policy: OWNER_DECLARED_POLICY, principalId: input.principalId, projectId: draft.projectId, closureDigest }),
    },
    projectState: { contextRevision: 0, rubricRevision: 0 },
    readSetDigest, writeSetDigest, reads, writes,
    preparation: {
      preparedAt: preparedAt.toISOString(), expiresAt: new Date(input.preparedAt + 15 * 60 * 1000).toISOString(),
      outputDigest: digestOf(writes.map(w => w.after)), evidenceRefs: [evidence], commandPolicyDigest: sha256(NO_COMMAND_POLICY),
      relocationEvidenceRefs: [evidence], pathQualification: { readSetDigest, writeSetDigest, evidenceRefs: [`path-qualification-${readSetDigest.slice(0, 32)}`] },
    },
    noticesDigest: digestOf(input.admission ? writes.filter(w => input.admission!.notices.includes(w.path)).map(w => ({ path: w.path, sha256: w.after.sha256 })) : []),
  };
  return parsePreparedAdoptionPlan({ ...unsigned, digest: planDigest(unsigned) });
}

/** Source fields for a catalogue admission: exact terms digest, the admitted ref and a rights snapshot bound to this closure. */
function admittedSource(admission: SourceAdmission, principalId: string, projectId: string, closureDigest: string): PreparedAdoptionPlan['source'] {
  const terms = { version: admission.terms.version, sha256: sha256(admission.terms.text) };
  const rightsSnapshotDigest = digestOf({ policy: CATALOGUE_ADMISSION_POLICY, resourceRef: admission.resourceRef, terms, notices: [...admission.notices], principalId, projectId, closureDigest });
  return {
    resourceRef: admission.resourceRef, implementationOrigin: admission.implementationOrigin,
    admissionId: `catalogue-${digestOf(admission.resourceRef).slice(0, 32)}`, admissionRevision: 1,
    acquiredSha256: closureDigest, closureDigest, terms, assessments: [{ id: 'catalogue-rights', revision: 1 }], rightsSnapshotDigest,
    ...(admission.origin ? { origin: admission.origin } : {}),
  };
}
