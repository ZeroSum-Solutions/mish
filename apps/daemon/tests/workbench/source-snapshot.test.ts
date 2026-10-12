import { afterEach, describe, expect, it } from 'vitest';
import { buildTrustedSourceSnapshot } from '../../src/workbench/source-snapshot.js';
import { snapshotFixture } from './source-snapshot-fixture.js';
const fixtures: ReturnType<typeof snapshotFixture>[] = [];
const setup = () => { const fixture = snapshotFixture(); fixtures.push(fixture); return fixture; };
afterEach(() => fixtures.splice(0).forEach(f => f.db.close()));
describe('inactive trusted source snapshot boundary', () => {
  it('builds an allowed snapshot only from rechecked bytes, provenance and current authority', async () => {
    const f = setup(); const result = await buildTrustedSourceSnapshot(f.store, f.request, f.deps);
    expect(result.decision.decision).toBe('allowed'); expect(result.authority.verifiedEvidenceRefs).toEqual(expect.arrayContaining(['acquired-proof', 'terms-proof', 'rights-proof', 'project-proof', 'notice-proof', 'licence-proof']));
  });
  it.each(['authentication', 'project', 'source', 'issuer', 'terms'] as const)('refuses missing current %s authority despite persisted allowance', async missing => {
    const f = setup();
    if (missing === 'authentication') f.deps.authenticate = async () => null;
    if (missing === 'project') f.deps.authorizeProject = async () => null;
    if (missing === 'source') f.deps.authorizeSource = async () => false;
    if (missing === 'issuer') f.deps.verifyAssessmentIssuer = async () => false;
    if (missing === 'terms') f.deps.verifyTerms = async () => false;
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/unverified/u);
  });
  it.each(['acquired', 'file', 'notice', 'closure', 'dependency', 'extra-file'] as const)('refuses changed actual %s bytes or closure', async fault => {
    const f = setup(); const original = await f.deps.inspectSource(f.admission, {} as never);
    if (fault === 'acquired') original!.acquiredBytes = Buffer.from('changed');
    if (fault === 'file') original!.files[0]!.bytes = Buffer.from('changed');
    if (fault === 'notice') original!.files[1]!.bytes = Buffer.from('changed');
    if (fault === 'closure') original!.closureDigest = 'f'.repeat(64);
    if (fault === 'dependency') original!.dependencies = [{ name: 'unexpected', version: '1.0.0', integrity: null, contentSha256: 'f'.repeat(64) }];
    if (fault === 'extra-file') original!.files.push({ path: 'extra', role: 'source', bytes: Buffer.from('extra') });
    f.deps.inspectSource = async () => original;
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/source-unverified/u);
  });
  it.each(['revoked', 'expired', 'contradictory', 'incomplete'] as const)('refuses evidence currently reported %s', async status => {
    const f = setup(); f.deps.verifyEvidence = async () => status;
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/evidence-unverified/u);
  });
  it('checks evidence lifetime even if the injected verifier mistakenly reports verified', async () => {
    const f = setup(); f.deps.now = () => 5000;
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/evidence-unverified/u);
  });
  it('rejects evidence proof bytes that do not match the stored binding hash', async () => {
    const f = setup(); f.deps.readEvidenceBytes = async () => Buffer.from('forged proof');
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/evidence-unverified/u);
  });
  it('rejects borrowing another principal evidence binding', async () => {
    const f = setup(); const row = f.store.read(f.admission.id).evidence.find(e => e.record.id === 'rights-proof')!;
    row.record.revision = 2; row.record.principalId = 'principal-b'; f.store.publish(row, 1);
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/evidence-unverified/u);
  });
  it('rejects a snapshot changed through a second publication during async verification', async () => {
    const f = setup(); f.deps.verifyAssessmentIssuer = async () => { const next = structuredClone(f.assessment); next.revision = 2; f.store.publish({ kind: 'assessment', admissionId: f.admission.id, record: next }, 1); return true; };
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/snapshot-changed/u);
  });
  it('rejects authority epoch changes while evidence is verified', async () => {
    const f = setup(); let epoch = 'before'; f.deps.authorityEpoch = async () => epoch; f.deps.verifyEvidence = async () => { epoch = 'after'; return 'verified'; };
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/snapshot-changed/u);
  });
  it('does not lose a separate current denial when another assessment permits use', async () => {
    const f = setup(); const deny = structuredClone(f.assessment); deny.id = 'separate-denial'; deny.operationRights[0]!.decision = 'blocked'; deny.operationRights[0]!.reason = 'Synthetic restriction.';
    f.store.publish({ kind: 'assessment', admissionId: f.admission.id, record: deny }, null);
    expect((await buildTrustedSourceSnapshot(f.store, f.request, f.deps)).decision.decision).toBe('blocked');
  });
  it('requires authoritative issuer approval of a revision that replaces a denial', async () => {
    const f = setup(); const deny = structuredClone(f.assessment); deny.revision = 2; deny.operationRights[0]!.decision = 'blocked'; deny.operationRights[0]!.reason = 'Prior restriction.';
    f.store.publish({ kind: 'assessment', admissionId: f.admission.id, record: deny }, 1);
    const next = structuredClone(f.assessment); next.revision = 3; f.store.publish({ kind: 'assessment', admissionId: f.admission.id, record: next }, 2);
    f.deps.verifyAssessmentIssuer = async (_row, history) => !history.some(row => row.record.operationRights.some(right => right.decision === 'blocked'));
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/issuer-unverified/u);
  });
  it('rejects a licence principal or connector derived from unrelated records', async () => {
    const f = setup(); const bindings = await f.deps.resolveBindings({} as never, {} as never);
    bindings.acquisitionLicensee!.connectorId = 'other-connector'; f.deps.resolveBindings = async () => bindings;
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/licence-unverified/u);
  });
  it('refuses rights proof scoped to another operation', async () => {
    const f = setup(); const row = f.store.read(f.admission.id).evidence.find(e => e.record.id === 'rights-proof')!;
    row.record.revision = 2; if (row.record.scope.kind === 'operation') row.record.scope.operations = ['private-backup']; f.store.publish(row, 1);
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/evidence-unverified/u);
  });
  it('checks store generation after the final async authentication callback', async () => {
    const f = setup(); let calls = 0;
    f.deps.authenticate = async () => { if (++calls === 2) { const next = structuredClone(f.assessment); next.revision = 2; f.store.publish({ kind: 'assessment', admissionId: f.admission.id, record: next }, 1); } return 'principal-a'; };
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/snapshot-changed/u);
  });
  it('checks expiry again after the final async authority callback', async () => {
    const f = setup(); let now = 1000; let calls = 0; f.deps.now = () => now;
    f.deps.authorityEpoch = async () => { if (++calls === 2) now = 5000; return 'same'; };
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/evidence-unverified/u);
  });
  it('accepts covered-client scope only with separate verified client evidence', async () => {
    const f = setup(); const row = f.store.read(f.admission.id).evidence.find(e => e.record.id === 'rights-proof')!;
    row.record.id = 'client-proof'; row.record.type = 'client'; f.store.publish(row, null);
    const bindings = await f.deps.resolveBindings({} as never, {} as never); bindings.projectUse = 'covered-client';
    bindings.clientCoverage = { principalId: 'principal-a', projectId: 'project-a', target: f.request.target, visibility: 'private', sourceSha256: f.admission.acquiredContent!.sha256,
      closureDigest: f.admission.closure.digest, termsSha256: f.assessment.terms!.sha256, termsVersion: f.assessment.terms!.version, evidenceRefs: ['client-proof'] };
    f.deps.resolveBindings = async () => bindings; expect((await buildTrustedSourceSnapshot(f.store, f.request, f.deps)).decision.decision).toBe('allowed');
    bindings.clientCoverage.projectId = 'project-b'; await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/rights-incomplete/u);
  });
  it.each(['project', 'target', 'audience', 'admission-revision'] as const)('rejects borrowed %s evidence scope', async fault => {
    const f = setup(); const row = f.store.read(f.admission.id).evidence.find(e => e.record.id === 'rights-proof')!; row.record.revision = 2;
    if (fault === 'admission-revision') row.record.admissionRevision = 2;
    if (row.record.scope.kind === 'operation') {
      if (fault === 'project') row.record.scope.projectId = 'project-b';
      if (fault === 'target') row.record.scope.targetProfileId = 'other-target';
      if (fault === 'audience') row.record.scope.visibility = 'reusable-distribution';
    }
    if (fault === 'admission-revision') { expect(() => f.store.publish(row, 1)).toThrow(/record-missing/u); return; }
    f.store.publish(row, 1); await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/evidence-unverified/u);
  });
  it('does not reuse an old terms proof after current terms and assessment metadata change', async () => {
    const f = setup(); const terms = f.store.read(f.admission.id).terms!; terms.record.revision = 2; terms.record.terms = { version: 'fixture-v2', sha256: 'f'.repeat(64) }; f.store.publish(terms, 1);
    const next = structuredClone(f.assessment); next.revision = 2; next.terms!.version = 'fixture-v2'; next.terms!.sha256 = 'f'.repeat(64); f.store.publish({ kind: 'assessment', admissionId: f.admission.id, record: next }, 1);
    const bindings = await f.deps.resolveBindings({} as never, {} as never); bindings.obligationReceipts[0]!.assessmentRevision = 2; bindings.obligationReceipts[0]!.termsSha256 = 'f'.repeat(64); f.deps.resolveBindings = async () => bindings;
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/evidence-unverified/u);
  });
  it('requires verified supersession before a narrowing head removes a prior principal restriction', async () => {
    const f = setup(); const deny = structuredClone(f.assessment); deny.id = 'moving-restriction'; deny.operationRights[0]!.decision = 'blocked'; deny.operationRights[0]!.reason = 'Old principal restriction.';
    f.store.publish({ kind: 'assessment', admissionId: f.admission.id, record: deny }, null);
    const moved = structuredClone(deny); moved.revision = 2; moved.authorityScope.principalId = 'principal-b'; moved.operationRights[0]!.scope.principalId = 'principal-b';
    f.store.publish({ kind: 'assessment', admissionId: f.admission.id, record: moved }, 1);
    f.deps.verifyAssessmentIssuer = async (row, history, context) => row.record.id !== 'moving-restriction' || !history.some(old => old.record.authorityScope.principalId === context.principalId);
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/issuer-unverified/u);
  });
  it('keeps caller permission lists out of the trusted dependency context', async () => {
    const f = setup(); const withClaims = { ...f.request, verifiedEvidenceRefs: ['forged'], principalId: 'principal-b' };
    f.deps.authorizeSource = async context => !Object.hasOwn(context, 'verifiedEvidenceRefs') && context.principalId === 'principal-a';
    expect((await buildTrustedSourceSnapshot(f.store, withClaims, f.deps)).decision.decision).toBe('allowed');
  });
  it('does not hide a same-resource denial under another admission envelope', async () => {
    const f = setup(); const deny = structuredClone(f.assessment); deny.id = 'foreign-envelope-denial'; deny.operationRights[0]!.decision = 'blocked'; deny.operationRights[0]!.reason = 'Same resource restriction.';
    f.store.publish({ kind: 'assessment', admissionId: 'other-admission', record: deny }, null);
    expect((await buildTrustedSourceSnapshot(f.store, f.request, f.deps)).decision.decision).toBe('blocked');
  });
  it('requires source supersession verification against immutable admission history', async () => {
    const f = setup(); const next = structuredClone(f.admission); next.revision = 2; next.implementationOrigin = 'owned'; f.store.publish({ kind: 'admission', record: next }, 1);
    const terms = f.store.read(f.admission.id).terms!; terms.record.revision = 2; terms.record.admissionRevision = 2; f.store.publish(terms, 1);
    for (const row of f.store.read(f.admission.id).evidence) { row.record.revision = 2; row.record.admissionRevision = 2; f.store.publish(row, 1); }
    f.deps.authorizeSource = async (_context, current, history) => current.implementationOrigin !== 'owned' || !history?.some(old => old.record.implementationOrigin === 'official');
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/source-unverified/u);
  });
  it('isolates mutable callback context from the checked caller scope', async () => {
    const f = setup(); const authorize = f.deps.authorizeProject;
    f.deps.authorizeProject = async context => { const result = await authorize(context); context.projectId = 'mutated-project'; return result; };
    expect((await buildTrustedSourceSnapshot(f.store, f.request, f.deps)).decision.decision).toBe('allowed');
  });
  it.each([true, false])('binds alias proof to the actual immutable same-resource admission: %s', async sameResource => {
    const f = setup(); const alias = structuredClone(f.admission); alias.id = 'alias-admission';
    if (!sameResource) alias.resourceRef.itemId = 'different-resource';
    f.store.publish({ kind: 'admission', record: alias }, null);
    const row = f.store.read(f.admission.id).evidence.find(e => e.record.id === 'project-proof')!;
    row.record.id = 'alias-project-proof'; row.record.admissionId = alias.id; f.store.publish(row, null);
    const authorize = f.deps.authorizeProject;
    f.deps.authorizeProject = async context => { const authorization = (await authorize(context))!; authorization.evidenceRefs = ['alias-project-proof']; return authorization; };
    if (sameResource) expect((await buildTrustedSourceSnapshot(f.store, f.request, f.deps)).decision.decision).toBe('allowed');
    else await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/evidence-unverified/u);
  });

  it('rejects alias evidence bound to a superseded admission revision', async () => {
    const f = setup(); const alias = structuredClone(f.admission); alias.id = 'alias-admission';
    f.store.publish({ kind: 'admission', record: alias }, null);
    const row = f.store.read(f.admission.id).evidence.find(e => e.record.id === 'project-proof')!;
    row.record.id = 'alias-project-proof'; row.record.admissionId = alias.id; f.store.publish(row, null);
    const next = structuredClone(alias); next.revision = 2; next.implementationOrigin = 'owned'; f.store.publish({ kind: 'admission', record: next }, 1);
    const authorize = f.deps.authorizeProject;
    f.deps.authorizeProject = async context => { const authorization = (await authorize(context))!; authorization.evidenceRefs = ['alias-project-proof']; return authorization; };
    await expect(buildTrustedSourceSnapshot(f.store, f.request, f.deps)).rejects.toThrow(/evidence-unverified/u);
  });

});
