import { describe, expect, it } from 'vitest';
import {
  parsePreparePreviewRequest, parseAdoptionDraft, parseEditAdoptionDraftRequest,
  parsePreparationReceipt, parsePreviewLease, parseWorkbenchPreviewOperation,
  parseUndoAdoptionRequest, isPreviewLeaseActive, isPreviewLeaseBoundToReceipt,
} from '../src/api/workbench-preview-operation.js';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);

describe('Producer envelope compatibility', () => {
  const operation = (status: string) => ({
    id: 'operation-1', kind: 'prepare-preview', projectId: 'project-1', revision: 0,
    inputDigest: hash, status, stage: status, attempt: 1, resultRefs: [],
    createdAt: '2026-10-04T03:00:00.000Z', updatedAt: '2026-10-04T03:00:01.000Z',
    cancellationRequested: false, recovery: 'clear',
  });

  it.each(['queued', 'running', 'done'])('accepts absent optional error fields for %s', status => {
    const parsed = parseWorkbenchPreviewOperation(operation(status));
    expect(parsed.status).toBe(status);
    expect(parsed.error).toBeUndefined();
    expect(parsed.interruptReason).toBeUndefined();
  });
  it.each(['failed', 'interrupted'])('still requires its cause when %s', status => {
    expect(() => parseWorkbenchPreviewOperation(operation(status))).toThrow();
  });
  it.each(['', ' field '])('preserves the shared validation issue path %j', path => {
    const parsed = parseWorkbenchPreviewOperation({
      ...operation('failed'),
      error: { code: 'VALIDATION_FAILED', message: 'Invalid input', details: {
        kind: 'validation', issues: [{ path, message: 'Required', code: 'invalid_type' }],
      } },
      interruptReason: null,
    });
    expect(parsed.error?.details).toEqual({
      kind: 'validation', issues: [{ path, message: 'Required', code: 'invalid_type' }],
    });
  });
  it.each(['field\u0000', 'field\n'])('rejects a control character in issue path %j', path => {
    expect(() => parseWorkbenchPreviewOperation({
      ...operation('failed'), interruptReason: null,
      error: { code: 'VALIDATION_FAILED', message: 'Invalid input', details: {
        kind: 'validation', issues: [{ path, message: 'Required' }],
      } },
    })).toThrow();
  });
});

describe('PreparePreviewRequest', () => {
  const fixture = () => ({ projectId: 'project-1', refKey: 'AbC123_-xyz', targetProfileId: 'react18-tailwind4', entryPath: 'src/App.tsx', instruction: 'Replace the hero section.' });
  it('accepts the golden request with and without an instruction', () => {
    expect(parsePreparePreviewRequest(fixture())).toEqual(fixture());
    const { instruction, ...rest } = fixture();
    expect(parsePreparePreviewRequest(rest)).toEqual(rest);
  });
  it.each(['../App.tsx', '/App.tsx', 'src/App.tsx\\', 'C:/App.tsx'])('rejects noncanonical entry path %j', entryPath => {
    expect(() => parsePreparePreviewRequest({ ...fixture(), entryPath })).toThrow();
  });
  it.each(['refkey with spaces', 'refkey/with/slash', ''])('rejects a non-opaque refKey %j', refKey => {
    expect(() => parsePreparePreviewRequest({ ...fixture(), refKey })).toThrow();
  });
  it('rejects client-asserted authority or rights fields', () => {
    expect(() => parsePreparePreviewRequest({ ...fixture(), principalId: 'someone' })).toThrow();
    expect(() => parsePreparePreviewRequest({ ...fixture(), allowed: true })).toThrow();
  });
  it('bounds the instruction length without treating it as executable policy', () => {
    expect(() => parsePreparePreviewRequest({ ...fixture(), instruction: 'x'.repeat(4001) })).toThrow();
  });
});

describe('AdoptionDraft', () => {
  const fixture = () => ({
    id: 'draft-1', revision: 1, projectId: 'project-1',
    resourceRef: { sourceType: 'section' as const, sourceId: 'react-bits' as const, itemId: 'hero-16', revisionOrDigest: hash },
    sourceBindingDigest: hash, targetBindingDigest: hash,
    files: [{ path: 'src/App.tsx', sha256: hash, bytes: 10, editable: true }],
    state: 'prepared' as const,
    capabilities: [{ id: 'host-preview', available: true, reason: null }],
    evidenceRefs: ['build-1'],
  });
  it('accepts the golden draft', () => {
    expect(parseAdoptionDraft(fixture()).state).toBe('prepared');
  });
  it('rejects a server-only authority field smuggled by the client', () => {
    expect(() => parseAdoptionDraft({ ...fixture(), principalId: 'owner-1' })).toThrow();
    expect(() => parseAdoptionDraft({ ...fixture(), authorityEpoch: 1 })).toThrow();
  });
  it('rejects duplicate file paths and duplicate capability ids', () => {
    const p = fixture(); p.files.push(p.files[0]!); expect(() => parseAdoptionDraft(p)).toThrow();
    const q = fixture(); q.capabilities.push(q.capabilities[0]!); expect(() => parseAdoptionDraft(q)).toThrow();
  });
  it('names the current plan and preview lease by opaque id only', () => {
    const p = { ...fixture(), plan: { id: 'plan-1', digest: hash, expiresAt: '2026-10-04T03:15:00.000Z' }, preview: { leaseId: 'lease-1', state: 'active' as const } };
    expect(parseAdoptionDraft(p).plan?.id).toBe('plan-1');
    expect(parseAdoptionDraft(p).preview?.state).toBe('active');
  });
  it('rejects an unknown draft or lease state', () => {
    expect(() => parseAdoptionDraft({ ...fixture(), state: 'adopted' })).toThrow();
    expect(() => parseAdoptionDraft({ ...fixture(), preview: { leaseId: 'lease-1', state: 'applied' } })).toThrow();
  });
});

describe('EditAdoptionDraftRequest', () => {
  const fixture = () => ({ expectedRevision: 1, edits: [{ path: 'src/App.tsx', expectedSha256: hash, content: 'export default function App() {}' }] });
  it('accepts the golden edit', () => {
    expect(parseEditAdoptionDraftRequest(fixture()).edits).toHaveLength(1);
  });
  it('rejects duplicate edit paths', () => {
    const p = fixture(); p.edits.push(p.edits[0]!); expect(() => parseEditAdoptionDraftRequest(p)).toThrow();
  });
  it('rejects a traversal path and an oversized edit', () => {
    const p = fixture(); p.edits[0]!.path = '../App.tsx'; expect(() => parseEditAdoptionDraftRequest(p)).toThrow();
    const q = fixture(); q.edits[0]!.content = 'x'.repeat(32 * 1024 * 1024 + 1); expect(() => parseEditAdoptionDraftRequest(q)).toThrow();
  });
  it('rejects a revision below one and a client-asserted new file', () => {
    expect(() => parseEditAdoptionDraftRequest({ ...fixture(), expectedRevision: 0 })).toThrow();
    const p = fixture(); (p as { newFile?: unknown }).newFile = { path: 'src/New.tsx' }; expect(() => parseEditAdoptionDraftRequest(p)).toThrow();
  });
});

describe('PreparationReceipt', () => {
  const fixture = () => ({
    id: 'receipt-1', draftId: 'draft-1', revision: 1, digest: hash, projectId: 'project-1',
    targetBindingDigest: hash, sourceBindingDigest: hash, outputDigest: hash,
    evidenceRefs: ['build-1'], preparedAt: '2026-10-04T03:00:00.000Z', expiresAt: '2026-10-04T03:15:00.000Z',
  });
  it('accepts the golden receipt', () => {
    expect(parsePreparationReceipt(fixture()).draftId).toBe('draft-1');
  });
  it('omits principal, authority epoch and source-snapshot generation from the public shape', () => {
    expect(() => parsePreparationReceipt({ ...fixture(), principalId: 'owner-1' })).toThrow();
    expect(() => parsePreparationReceipt({ ...fixture(), authorityEpoch: 1 })).toThrow();
    expect(() => parsePreparationReceipt({ ...fixture(), sourceSnapshotGeneration: 1 })).toThrow();
  });
  it('requires strict expiry after preparation', () => {
    const p = fixture(); p.expiresAt = p.preparedAt; expect(() => parsePreparationReceipt(p)).toThrow();
    const q = fixture(); q.expiresAt = '2026-10-04T02:59:59.999Z'; expect(() => parsePreparationReceipt(q)).toThrow();
  });
});

describe('PreviewLease', () => {
  const fixture = () => ({
    id: 'lease-1', draftId: 'draft-1', revision: 1, preparationDigest: hash, outputDigest: hash,
    entryAssetId: 'asset-entry', assets: [{ id: 'asset-entry', sha256: hash, bytes: 100, mime: 'application/octet-stream' }],
    expiresAt: '2026-10-04T03:10:00.000Z', state: 'active' as const,
  });
  it('accepts the golden lease', () => {
    expect(parsePreviewLease(fixture()).state).toBe('active');
  });
  it('is an identifier, not a bearer credential: no principal/project/authority field is accepted', () => {
    expect(() => parsePreviewLease({ ...fixture(), principalId: 'owner-1' })).toThrow();
    expect(() => parsePreviewLease({ ...fixture(), projectId: 'project-1' })).toThrow();
    expect(() => parsePreviewLease({ ...fixture(), authorityEpoch: 1 })).toThrow();
    expect(() => parsePreviewLease({ ...fixture(), manifest: {} })).toThrow();
  });
  it('requires the entry asset to be declared among the lease assets', () => {
    const p = fixture(); p.entryAssetId = 'missing-asset'; expect(() => parsePreviewLease(p)).toThrow();
  });
  it('rejects duplicate asset ids and a non-declared mime', () => {
    const p = fixture(); p.assets.push(p.assets[0]!); expect(() => parsePreviewLease(p)).toThrow();
    const q = fixture(); q.assets[0]!.mime = 'text/html; charset=utf-8'; expect(() => parsePreviewLease(q)).toThrow();
  });
  it('checks active state and expiry together, never one alone', () => {
    const lease = parsePreviewLease(fixture());
    expect(isPreviewLeaseActive(lease, Date.parse('2026-10-04T03:09:59.999Z'))).toBe(true);
    expect(isPreviewLeaseActive(lease, Date.parse('2026-10-04T03:10:00.000Z'))).toBe(false);
    expect(isPreviewLeaseActive({ ...lease, state: 'revoked' }, Date.parse('2026-10-04T03:00:00.000Z'))).toBe(false);
  });
  it('binds to its exact preparation receipt and refuses to outlive it', () => {
    const lease = parsePreviewLease(fixture());
    const receipt = parsePreparationReceipt({
      id: 'receipt-1', draftId: 'draft-1', revision: 1, digest: hash, projectId: 'project-1',
      targetBindingDigest: hash, sourceBindingDigest: hash, outputDigest: hash,
      evidenceRefs: ['build-1'], preparedAt: '2026-10-04T03:00:00.000Z', expiresAt: '2026-10-04T03:15:00.000Z',
    });
    expect(isPreviewLeaseBoundToReceipt(lease, receipt)).toBe(true);
    expect(isPreviewLeaseBoundToReceipt({ ...lease, draftId: 'draft-2' }, receipt)).toBe(false);
    expect(isPreviewLeaseBoundToReceipt({ ...lease, preparationDigest: otherHash }, receipt)).toBe(false);
    expect(isPreviewLeaseBoundToReceipt({ ...lease, expiresAt: '2026-10-04T03:16:00.000Z' }, receipt)).toBe(false);
  });
});

describe('WorkbenchPreviewOperation projection', () => {
  const fixture = () => ({
    id: 'operation-1', kind: 'prepare-preview' as const, projectId: 'project-1', revision: 1, inputDigest: hash,
    status: 'running' as const, stage: 'preparing', attempt: 1, resultRefs: [],
    error: null, interruptReason: null, createdAt: '2026-10-04T03:00:00.000Z', updatedAt: '2026-10-04T03:00:01.000Z',
    cancellationRequested: false, recovery: 'clear' as const,
  });
  it('accepts the golden running operation', () => {
    expect(parseWorkbenchPreviewOperation(fixture()).status).toBe('running');
  });
  it('requires an interrupt reason exactly when interrupted', () => {
    const p = fixture(); (p as { status: string }).status = 'interrupted'; expect(() => parseWorkbenchPreviewOperation(p)).toThrow();
    const q = { ...fixture(), status: 'interrupted' as const, interruptReason: 'timeout' as const };
    expect(parseWorkbenchPreviewOperation(q).interruptReason).toBe('timeout');
    const r = { ...fixture(), interruptReason: 'timeout' as const };
    expect(() => parseWorkbenchPreviewOperation(r)).toThrow();
  });
  it('requires an error exactly when failed', () => {
    const p = fixture(); (p as { status: string }).status = 'failed'; expect(() => parseWorkbenchPreviewOperation(p)).toThrow();
    const q = { ...fixture(), status: 'failed' as const, error: { code: 'CONFLICT' as const, message: 'stale plan' } };
    expect(parseWorkbenchPreviewOperation(q).error?.code).toBe('CONFLICT');
  });
  it('rejects an update timestamp before creation', () => {
    const p = fixture(); p.updatedAt = '2026-10-04T02:59:59.999Z'; expect(() => parseWorkbenchPreviewOperation(p)).toThrow();
  });
  it('rejects an unknown operation kind or status', () => {
    expect(() => parseWorkbenchPreviewOperation({ ...fixture(), kind: 'adoption-delete' })).toThrow();
    expect(() => parseWorkbenchPreviewOperation({ ...fixture(), status: 'succeeded' })).toThrow();
  });
});

describe('UndoAdoptionRequest', () => {
  it('accepts the applied operation id, revision and receipt digest only', () => {
    expect(parseUndoAdoptionRequest({ appliedOperationId: 'operation-1', expectedOperationRevision: 1, expectedReceiptDigest: hash }))
      .toEqual({ appliedOperationId: 'operation-1', expectedOperationRevision: 1, expectedReceiptDigest: hash });
  });
  it.each([{ paths: ['src/App.tsx'] }, { principalId: 'someone-else' }, { allowed: true }])('rejects client authority or path payload %j', extra => {
    expect(() => parseUndoAdoptionRequest({ appliedOperationId: 'operation-1', expectedOperationRevision: 1, expectedReceiptDigest: hash, ...extra })).toThrow();
  });
});

describe('Q3 correction regressions (root-confirmed independent review)', () => {
  const operationAt = (status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted') => ({
    id: 'operation-1', kind: 'adoption-apply' as const, projectId: 'project-1', revision: 4,
    inputDigest: hash, status, stage: status, attempt: 1, resultRefs: [],
    error: status === 'failed' ? { code: 'CONFLICT' as const, message: 'stale' } : null,
    interruptReason: status === 'interrupted' ? 'timeout' as const : null,
    createdAt: '2026-10-04T03:00:00.000Z', updatedAt: '2026-10-04T03:00:01.000Z',
    cancellationRequested: false, recovery: 'clear' as const,
  });

  it('BLOCK: accepts a queued apply/undo operation at the journal-assigned revision zero', () => {
    const op = {
      id: 'operation-1', kind: 'adoption-apply' as const, projectId: 'project-1', revision: 0,
      inputDigest: hash, status: 'queued' as const, stage: 'queued', attempt: 1, resultRefs: [],
      error: null, interruptReason: null, createdAt: '2026-10-04T03:00:00.000Z', updatedAt: '2026-10-04T03:00:00.000Z',
      cancellationRequested: false, recovery: 'clear' as const,
    };
    expect(parseWorkbenchPreviewOperation(op).revision).toBe(0);
  });
  it('BLOCK: accepts expectedOperationRevision zero on an undo request', () => {
    expect(parseUndoAdoptionRequest({ appliedOperationId: 'operation-1', expectedOperationRevision: 0, expectedReceiptDigest: hash }).expectedOperationRevision).toBe(0);
  });
  it('still rejects a draft, plan or receipt revision below one', () => {
    expect(() => parseAdoptionDraft({
      id: 'draft-1', revision: 0, projectId: 'project-1',
      resourceRef: { sourceType: 'section' as const, sourceId: 'react-bits' as const, itemId: 'hero-16', revisionOrDigest: hash },
      sourceBindingDigest: hash, targetBindingDigest: hash, files: [], state: 'selected' as const, capabilities: [], evidenceRefs: ['build-1'],
    })).toThrow();
  });

  it('BLOCK: refuses to bind a lease whose revision or output digest does not match the receipt', () => {
    const receipt = parsePreparationReceipt({
      id: 'receipt-1', draftId: 'draft-1', revision: 1, digest: hash, projectId: 'project-1',
      targetBindingDigest: hash, sourceBindingDigest: hash, outputDigest: hash, evidenceRefs: ['build-1'],
      preparedAt: '2026-10-04T03:00:00.000Z', expiresAt: '2026-10-04T03:15:00.000Z',
    });
    const lease = parsePreviewLease({
      id: 'lease-1', draftId: 'draft-1', revision: 2, preparationDigest: hash, outputDigest: otherHash,
      entryAssetId: 'entry', assets: [{ id: 'entry', sha256: otherHash, bytes: 100, mime: 'application/octet-stream' }],
      expiresAt: '2026-10-04T03:10:00.000Z', state: 'active' as const,
    });
    expect(isPreviewLeaseBoundToReceipt(lease, receipt)).toBe(false);
    expect(isPreviewLeaseBoundToReceipt({ ...lease, revision: 1, outputDigest: hash }, receipt)).toBe(true);
  });

  it('BLOCK: accepts a bounded typed details object only on a failed operation', () => {
    const failed = { ...operationAt('failed'), error: { code: 'CONFLICT' as const, message: 'stale plan', details: { currentRevision: 3, nextSteps: ['Reprepare'] } } };
    expect(parseWorkbenchPreviewOperation(failed).error?.details).toEqual({ currentRevision: 3, nextSteps: ['Reprepare'] });
  });
  it('WARN: rejects a non-null error on any non-failed status', () => {
    const done = { ...operationAt('done'), error: { code: 'CONFLICT' as const, message: 'stale' } };
    expect(() => parseWorkbenchPreviewOperation(done)).toThrow();
    const queued = { ...operationAt('queued'), error: { code: 'CONFLICT' as const, message: 'stale' } };
    expect(() => parseWorkbenchPreviewOperation(queued)).toThrow();
    expect(parseWorkbenchPreviewOperation(operationAt('done')).status).toBe('done');
  });

  it('WARN: rejects an edited draft that retains its invalidated plan or an active preview lease', () => {
    const draft = {
      id: 'draft-1', revision: 2, parentRevision: 1, projectId: 'project-1',
      resourceRef: { sourceType: 'section' as const, sourceId: 'react-bits' as const, itemId: 'hero-16', revisionOrDigest: hash },
      sourceBindingDigest: hash, targetBindingDigest: hash, files: [], state: 'needs-preparation' as const,
      capabilities: [], evidenceRefs: ['build-1'],
      plan: { id: 'old-plan', digest: hash, expiresAt: '2026-10-04T03:15:00.000Z' },
      preview: { leaseId: 'old-lease', state: 'active' as const },
    };
    expect(() => parseAdoptionDraft(draft)).toThrow();
    const { plan: _droppedPlan, ...withoutPlan } = draft;
    expect(() => parseAdoptionDraft(withoutPlan)).toThrow();
    const cleared = { ...withoutPlan, preview: { leaseId: 'old-lease', state: 'revoked' as const } };
    expect(parseAdoptionDraft(cleared).state).toBe('needs-preparation');
  });

  it('WARN: accepts an existing W1-sized canonical refKey rather than a narrower invented cap', () => {
    const refKey = Buffer.from(JSON.stringify([1, 'section', 'react-bits', 'x'.repeat(1000), 'y'.repeat(1000)])).toString('base64url');
    expect(parsePreparePreviewRequest({ projectId: 'project-1', refKey, targetProfileId: 'react18-tailwind4', entryPath: 'src/App.tsx' }).refKey).toBe(refKey);
  });

  it('WARN: bounds preparation receipt expiry to at most fifteen minutes after preparation', () => {
    const base = { id: 'receipt-2', draftId: 'draft-1', revision: 1, digest: hash, projectId: 'project-1', targetBindingDigest: hash, sourceBindingDigest: hash, outputDigest: hash, evidenceRefs: ['build-1'], preparedAt: '2026-10-04T03:00:00.000Z' };
    expect(() => parsePreparationReceipt({ ...base, expiresAt: '2027-10-04T03:00:00.000Z' })).toThrow();
    expect(parsePreparationReceipt({ ...base, expiresAt: '2026-10-04T03:15:00.000Z' }).expiresAt).toBe('2026-10-04T03:15:00.000Z');
    expect(() => parsePreparationReceipt({ ...base, expiresAt: '2026-10-04T03:15:00.001Z' })).toThrow();
  });

  it('WARN: bounds AdoptionDraft.resourceRef identity fields like the accepted prepared-plan contract', () => {
    const draft = {
      id: 'draft-1', revision: 1, projectId: 'project-1',
      resourceRef: { sourceType: 'section' as const, sourceId: 'react-bits' as const, itemId: 'x'.repeat(5000), revisionOrDigest: hash },
      sourceBindingDigest: hash, targetBindingDigest: hash, files: [], state: 'selected' as const, capabilities: [], evidenceRefs: ['build-1'],
    };
    expect(() => parseAdoptionDraft(draft)).toThrow();
    const ok = { ...draft, resourceRef: { ...draft.resourceRef, itemId: 'x'.repeat(1000) } };
    expect(parseAdoptionDraft(ok).resourceRef.itemId).toHaveLength(1000);
  });
});

describe('Q3 second correction regressions (root-approved error projection + 3 WARNs)', () => {
  const failedOperation = (details?: unknown) => ({
    id: 'op-1', kind: 'adoption-apply' as const, projectId: 'project-1', revision: 2,
    inputDigest: hash, status: 'failed' as const, stage: 'failed', attempt: 1, resultRefs: [],
    interruptReason: null, createdAt: '2026-10-04T03:00:00.000Z', updatedAt: '2026-10-04T03:00:01.000Z',
    cancellationRequested: false, recovery: 'blocked' as const,
    error: { code: 'UPSTREAM_UNAVAILABLE' as const, message: 'Recovery is closed', ...(details === undefined ? {} : { details }) },
  });

  it('BLOCK: accepts the current placement mapper shape {kind:"placement",reason}', () => {
    const parsed = parseWorkbenchPreviewOperation(failedOperation({ kind: 'placement', reason: 'OWNER_RECOVERING' }));
    expect(parsed.error?.details).toEqual({ kind: 'placement', reason: 'OWNER_RECOVERING' });
  });
  it('BLOCK: accepts a placement detail carrying the optional operationId/currentRevision/nextSteps/capability', () => {
    const details = { kind: 'placement' as const, reason: 'RUN_SCOPE_CHANGED', operationId: 'op-1', currentRevision: 3, nextSteps: ['Retry'], capability: 'adoption' };
    expect(parseWorkbenchPreviewOperation(failedOperation(details)).error?.details).toEqual(details);
  });
  it('BLOCK: accepts the shared validation detail shape matching ApiValidationErrorDetails', () => {
    const details = { kind: 'validation' as const, issues: [{ path: 'projectId', message: 'Required', code: 'invalid_type' }] };
    expect(parseWorkbenchPreviewOperation(failedOperation(details)).error?.details).toEqual(details);
  });
  it('BLOCK: accepts an untagged action/refusal detail (operationId without a kind)', () => {
    const details = { reason: 'recovery-required', operationId: 'op-1' };
    expect(parseWorkbenchPreviewOperation(failedOperation(details)).error?.details).toEqual(details);
  });
  it('rejects an empty untagged action/refusal detail with no meaningful field', () => {
    expect(() => parseWorkbenchPreviewOperation(failedOperation({}))).toThrow();
  });
  it('still rejects an unsealed generic gate key: the recovery-gate producer contract remains explicitly unfrozen', () => {
    expect(() => parseWorkbenchPreviewOperation(failedOperation({ reason: 'recovery-required', gate: 'prior-launch-drainage' }))).toThrow();
  });
  it('still rejects unknown/private keys inside any details variant', () => {
    expect(() => parseWorkbenchPreviewOperation(failedOperation({ kind: 'placement', reason: 'OWNER_RECOVERING', principalId: 'owner-1' }))).toThrow();
    expect(() => parseWorkbenchPreviewOperation(failedOperation({ kind: 'validation', issues: [{ path: 'x', message: 'y' }], rootPath: '/etc' }))).toThrow();
  });

  it('WARN: rejects a selected draft that carries an Apply plan or an active preview lease', () => {
    const base = {
      id: 'draft-1', revision: 2, projectId: 'project-1',
      resourceRef: { sourceType: 'section' as const, sourceId: 'react-bits' as const, itemId: 'hero-16', revisionOrDigest: hash },
      sourceBindingDigest: hash, targetBindingDigest: hash, files: [], capabilities: [],
      evidenceRefs: ['selection-1'], state: 'selected' as const,
    };
    expect(parseAdoptionDraft(base).state).toBe('selected');
    expect(() => parseAdoptionDraft({ ...base, plan: { id: 'plan-1', digest: hash, expiresAt: '2026-10-04T03:15:00.000Z' } })).toThrow();
    expect(() => parseAdoptionDraft({ ...base, preview: { leaseId: 'lease-1', state: 'active' as const } })).toThrow();
    expect(parseAdoptionDraft({ ...base, preview: { leaseId: 'lease-1', state: 'revoked' as const } }).preview?.state).toBe('revoked');
  });
  it('does not ban a historical plan on a failed draft: no accepted lifecycle evidence requires it', () => {
    const failedDraft = {
      id: 'draft-1', revision: 3, projectId: 'project-1',
      resourceRef: { sourceType: 'section' as const, sourceId: 'react-bits' as const, itemId: 'hero-16', revisionOrDigest: hash },
      sourceBindingDigest: hash, targetBindingDigest: hash, files: [], capabilities: [],
      evidenceRefs: ['selection-1'], state: 'failed' as const,
      plan: { id: 'plan-1', digest: hash, expiresAt: '2026-10-04T03:15:00.000Z' },
    };
    expect(parseAdoptionDraft(failedDraft).state).toBe('failed');
  });
  it('does not ban a done operation carrying a later conflict recovery: journal status and recovery are separate', () => {
    const done = {
      id: 'op-1', kind: 'adoption-apply' as const, projectId: 'project-1', revision: 5,
      inputDigest: hash, status: 'done' as const, stage: 'complete', attempt: 1, resultRefs: [],
      error: null, interruptReason: null, createdAt: '2026-10-04T03:00:00.000Z', updatedAt: '2026-10-04T03:00:01.000Z',
      cancellationRequested: false, recovery: 'conflict' as const,
    };
    expect(parseWorkbenchPreviewOperation(done).recovery).toBe('conflict');
  });

  it('WARN: requires a strictly older parentRevision when present', () => {
    const base = {
      id: 'draft-1', revision: 2, projectId: 'project-1',
      resourceRef: { sourceType: 'section' as const, sourceId: 'react-bits' as const, itemId: 'hero-16', revisionOrDigest: hash },
      sourceBindingDigest: hash, targetBindingDigest: hash, files: [], capabilities: [],
      evidenceRefs: ['selection-1'], state: 'selected' as const,
    };
    expect(() => parseAdoptionDraft({ ...base, parentRevision: 3 })).toThrow();
    expect(() => parseAdoptionDraft({ ...base, parentRevision: 2 })).toThrow();
    expect(parseAdoptionDraft({ ...base, parentRevision: 1 }).parentRevision).toBe(1);
  });

  it('WARN: bounds aggregate edited content to 32 MiB of UTF-8 bytes using pure JS counting', () => {
    const under = { expectedRevision: 1, edits: Array.from({ length: 2 }, (_, i) => ({ path: `src/file-${i}.tsx`, expectedSha256: hash, content: 'x'.repeat(1_000_000) })) };
    expect(parseEditAdoptionDraftRequest(under).edits).toHaveLength(2);
    const over = { expectedRevision: 1, edits: Array.from({ length: 34 }, (_, i) => ({ path: `src/file-${i}.tsx`, expectedSha256: hash, content: 'x'.repeat(1_000_000) })) };
    expect(() => parseEditAdoptionDraftRequest(over)).toThrow();
    const exact = { expectedRevision: 1, edits: [{ path: 'src/file.tsx', expectedSha256: hash, content: 'x'.repeat(32 * 1024 * 1024) }] };
    expect(parseEditAdoptionDraftRequest(exact).edits).toHaveLength(1);
    const overByOne = { expectedRevision: 1, edits: [{ path: 'src/file.tsx', expectedSha256: hash, content: 'x'.repeat(32 * 1024 * 1024 + 1) }] };
    expect(() => parseEditAdoptionDraftRequest(overByOne)).toThrow();
    const multiByte = { expectedRevision: 1, edits: [{ path: 'src/file.tsx', expectedSha256: hash, content: 'é'.repeat(16 * 1024 * 1024 + 1) }] };
    expect(() => parseEditAdoptionDraftRequest(multiByte)).toThrow();
  });

  it('WARN: rejects a structurally overlapping file-prefix pair in draft files, while allowing valid siblings', () => {
    const base = {
      id: 'draft-1', revision: 1, projectId: 'project-1',
      resourceRef: { sourceType: 'section' as const, sourceId: 'react-bits' as const, itemId: 'hero-16', revisionOrDigest: hash },
      sourceBindingDigest: hash, targetBindingDigest: hash, capabilities: [],
      evidenceRefs: ['selection-1'], state: 'selected' as const,
    };
    expect(() => parseAdoptionDraft({ ...base, files: [
      { path: 'src/App.tsx', sha256: hash, bytes: 10, editable: true },
      { path: 'src/App.tsx/extra', sha256: hash, bytes: 10, editable: true },
    ] })).toThrow();
    expect(parseAdoptionDraft({ ...base, files: [
      { path: 'src/App.tsx', sha256: hash, bytes: 10, editable: true },
      { path: 'src/App.tsx.bak', sha256: hash, bytes: 10, editable: true },
      { path: 'src/App.tsx2.tsx', sha256: hash, bytes: 10, editable: true },
    ] }).files).toHaveLength(3);
  });
  it('WARN: rejects a structurally overlapping file-prefix pair in edit requests, without inventing a package/lock ban', () => {
    expect(() => parseEditAdoptionDraftRequest({ expectedRevision: 1, edits: [
      { path: 'src/App.tsx', expectedSha256: hash, content: 'a' },
      { path: 'src/App.tsx/extra', expectedSha256: hash, content: 'b' },
    ] })).toThrow();
    expect(parseEditAdoptionDraftRequest({ expectedRevision: 1, edits: [
      { path: 'package.json', expectedSha256: hash, content: '{}' },
      { path: 'package-lock.json', expectedSha256: hash, content: '{}' },
    ] }).edits).toHaveLength(2);
  });
});
