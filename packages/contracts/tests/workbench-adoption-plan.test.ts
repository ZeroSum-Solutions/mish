import { describe, expect, it } from 'vitest';
import { parsePreparedAdoptionPlan, parseApplyAdoptionRequest, parsePrepareAdoptionRequest, isAdoptionPlanUnexpired } from '../src/api/workbench-adoption-plan.js';

const hash = 'a'.repeat(64);
const object = { device: '1', inode: '2', kind: 'file' as const };
const before = { kind: 'file' as const, sha256: hash, bytes: 7, identity: object };
const after = { sha256: 'b'.repeat(64), bytes: 9, blobId: 'prepared-app', role: 'entry' as const };
const fixture = () => structuredClone({
  schema: 'workbench-prepared-plan/1', id: 'plan-1', digest: hash,
  principalId: 'owner-1', projectId: 'project-1', projectRoot: { device: '1', inode: '3', volumeUUID: '12345678-1234-4234-8234-123456789abc' },
  adapter: { id: 'react-source', version: '1' }, target: { profileId: 'react18-tailwind4', entryPath: 'src/App.tsx', toolchainDigest: hash, dependencyDigest: hash, buildInputDigest: hash },
  source: { resourceRef: { sourceType: 'section' as const, sourceId: 'react-bits' as const, itemId: 'hero-16', revisionOrDigest: hash }, implementationOrigin: 'official' as const, admissionId: 'admission-1', admissionRevision: 1, acquiredSha256: hash, closureDigest: hash, terms: { version: '2.2', sha256: hash }, assessments: [{ id: 'assessment-1', revision: 1 }], rightsSnapshotDigest: hash },
  projectState: { contextRevision: 1, rubricRevision: 1 },
  readSetDigest: hash, writeSetDigest: hash,
  reads: [{ path: 'src/App.tsx', expected: before }, { path: 'src/Hero.tsx', expected: { kind: 'absent' as const } }],
  writes: [{ path: 'src/Hero.tsx', kind: 'create' as const, after: { ...after, blobId: 'prepared-hero', role: 'source' as const } }, { path: 'src/App.tsx', kind: 'replace' as const, after }],
  preparation: { preparedAt: '2026-10-04T03:00:00.000Z', expiresAt: '2026-10-04T03:15:00.000Z', outputDigest: hash, evidenceRefs: ['build-1', 'typecheck-1', 'preview-1'], commandPolicyDigest: hash, relocationEvidenceRefs: ['relocation-1'], pathQualification: { readSetDigest: hash, writeSetDigest: hash, evidenceRefs: ['actual-fs-1'] } },
  noticesDigest: hash,
});

describe('immutable stored adoption plan boundary', () => {
  it('retains actual entry replacement beside new component files', () => {
    const p = parsePreparedAdoptionPlan(fixture());
    expect(p.writes.map(w => [w.path, w.kind])).toEqual([['src/Hero.tsx', 'create'], ['src/App.tsx', 'replace']]);
    expect(p.reads[1]?.expected).toEqual({ kind: 'absent' });
  });
  it.each(['../App.tsx', '/App.tsx', 'src//App.tsx', 'src/./App.tsx', 'src\\App.tsx', 'C:/App.tsx', 'src/​App.tsx'])('rejects noncanonical path %j', path => {
    const p = fixture(); p.writes[0]!.path = path; p.reads[1]!.path = path; expect(() => parsePreparedAdoptionPlan(p)).toThrow();
  });
  it('refuses replace without exact existing byte and filesystem identity', () => {
    const p = fixture(); p.reads[0]!.expected = { kind: 'absent' } as never; expect(() => parsePreparedAdoptionPlan(p)).toThrow();
  });
  it('refuses create with an existing source or a missing declared read', () => {
    const p = fixture(); p.reads.pop(); expect(() => parsePreparedAdoptionPlan(p)).toThrow();
    const q = fixture(); q.reads[1]!.expected = before; expect(() => parsePreparedAdoptionPlan(q)).toThrow();
  });
  it('never treats a missing or unknown hash as absence', () => {
    const p = fixture(); delete (p.reads[0]!.expected as Partial<typeof before>).sha256; expect(() => parsePreparedAdoptionPlan(p)).toThrow();
    const q = fixture(); Object.assign(q.reads[1]!.expected, { sha256: null }); expect(() => parsePreparedAdoptionPlan(q)).toThrow();
  });
  it('refuses duplicate and file-prefix destinations', () => {
    const p = fixture(); p.writes.splice(1, 0, p.writes[0]!); expect(() => parsePreparedAdoptionPlan(p)).toThrow();
    const q = fixture(); q.writes[0]!.path = 'src'; q.reads[1]!.path = 'src'; expect(() => parsePreparedAdoptionPlan(q)).toThrow();
  });
  it('requires all entry writes to be last and each declared read unique', () => {
    const p = fixture(); p.writes.reverse(); expect(() => parsePreparedAdoptionPlan(p)).toThrow();
    const q = fixture(); q.reads.push(q.reads[0]!); expect(() => parsePreparedAdoptionPlan(q)).toThrow();
  });
  it('bounds cumulative output and retained preimages separately', () => {
    const p = fixture(); p.writes.forEach(w => { w.after.bytes = 20 * 1024 * 1024; }); expect(() => parsePreparedAdoptionPlan(p)).toThrow();
    const q = fixture(); q.reads[0]!.expected = { ...before, bytes: 32 * 1024 * 1024 + 1 }; expect(() => parsePreparedAdoptionPlan(q)).toThrow();
  });
  it('admits exact byte bounds and refuses the 257th written file', () => {
    const p = fixture(); p.writes[0]!.after.bytes = 32 * 1024 * 1024 - 9; expect(parsePreparedAdoptionPlan(p).writes).toHaveLength(2);
    const q = fixture(); q.writes = Array.from({ length: 255 }, (_, i) => ({ ...q.writes[0]!, path: `new-${i}.tsx` }));
    q.reads = q.writes.map(w => ({ path: w.path, expected: { kind: 'absent' as const } }));
    q.writes.push(fixture().writes[1]!); q.reads.push(fixture().reads[0]!);
    expect(parsePreparedAdoptionPlan(q).writes).toHaveLength(256);
    q.writes.splice(255, 0, { ...q.writes[0]!, path: 'new-256.tsx' }); q.reads.push({ path: 'new-256.tsx', expected: { kind: 'absent' } });
    expect(() => parsePreparedAdoptionPlan(q)).toThrow();
  });
  it.each([0, 899999, 900001, -900000])('requires exactly fifteen minutes after preparation, got %d ms', span => {
    const p = fixture(); p.preparation.expiresAt = new Date(Date.parse(p.preparation.preparedAt) + span).toISOString(); expect(() => parsePreparedAdoptionPlan(p)).toThrow();
  });
  it('requires actual preparation and relocation evidence identifiers', () => {
    const p = fixture(); p.preparation.evidenceRefs = []; expect(() => parsePreparedAdoptionPlan(p)).toThrow();
    const q = fixture(); q.preparation.relocationEvidenceRefs = []; expect(() => parsePreparedAdoptionPlan(q)).toThrow();
  });
  it('rejects duplicated assessment IDs and invalid revisions', () => {
    const p = fixture(); p.source.assessments.push(p.source.assessments[0]!); expect(() => parsePreparedAdoptionPlan(p)).toThrow();
    const q = fixture(); q.source.admissionRevision = 0; expect(() => parsePreparedAdoptionPlan(q)).toThrow();
    const r = fixture(); r.projectState.contextRevision = -1; expect(() => parsePreparedAdoptionPlan(r)).toThrow();
  });
  it('accepts owned-source absent terms without allowing extra permission assertions', () => {
    const p = fixture(); p.source.terms = null as never; p.source.implementationOrigin = 'owned' as never; p.source.resourceRef = { sourceType: 'genui' as never, sourceId: 'genui' as never, itemId: 'owned-card', revisionOrDigest: hash }; expect(parsePreparedAdoptionPlan(p).source.terms).toBeNull();
    const q = fixture(); Object.assign(q, { allowed: true }); expect(() => parsePreparedAdoptionPlan(q)).toThrow();
  });
  it('refuses a create-only or newly created entry substitute', () => {
    const p = fixture(); p.writes = [p.writes[0]!]; expect(() => parsePreparedAdoptionPlan(p)).toThrow();
    const q = fixture(); q.writes[1]!.kind = 'create' as never; q.reads[0]!.expected = { kind: 'absent' } as never;
    expect(() => parsePreparedAdoptionPlan(q)).toThrow();
  });
  it.each(['node_modules/react/index.js', '.git/hooks/post-checkout', 'src/NODE_MODULES/foo.ts', 'src/node_moduleſ/react/index.js'])('refuses protected destination %s', path => {
    const p = fixture(); p.writes[0]!.path = path; p.reads[1]!.path = path; expect(() => parsePreparedAdoptionPlan(p)).toThrow();
  });
  it('refuses contradictory byte descriptors for the same prepared blob', () => {
    const p = fixture(); p.writes[1]!.after.blobId = p.writes[0]!.after.blobId; p.writes[1]!.after.bytes = 10;
    expect(() => parsePreparedAdoptionPlan(p)).toThrow();
  });
  it('requires canonical millisecond timestamps', () => {
    const p = fixture(); p.preparation.preparedAt = '2026-10-04T03:00:00Z'; p.preparation.expiresAt = '2026-10-04T03:15:00Z';
    expect(() => parsePreparedAdoptionPlan(p)).toThrow();
  });
  it('requires qualification evidence consistent with the declared set digests', () => {
    const p = fixture(); p.preparation.pathQualification.readSetDigest = 'c'.repeat(64); expect(() => parsePreparedAdoptionPlan(p)).toThrow();
    const r = fixture(); r.preparation.pathQualification.writeSetDigest = 'd'.repeat(64); expect(() => parsePreparedAdoptionPlan(r)).toThrow();
    const q = fixture(); q.preparation.pathQualification.evidenceRefs = []; expect(() => parsePreparedAdoptionPlan(q)).toThrow();
  });
  it.each([201, 2000])('retains the verified exact terms version at %d characters', length => {
    const p = fixture(); p.source.terms.version = 'v'.repeat(length);
    expect(parsePreparedAdoptionPlan(p).source.terms?.version).toBe(p.source.terms.version);
  });
  it('refuses oversized or control-bearing terms versions', () => {
    for (const version of ['v'.repeat(2001), 'v\u0000', 'v\u200b']) {
      const p = fixture(); p.source.terms.version = version;
      expect(() => parsePreparedAdoptionPlan(p)).toThrow();
    }
  });
  it('refuses missing terms for an officially acquired source', () => {
    const p = fixture(); p.source.terms = null as never; expect(() => parsePreparedAdoptionPlan(p)).toThrow();
  });
  it('binds the entry write to the actual target entry rather than its role label', () => {
    const p = fixture(); p.target.entryPath = 'src/AnotherApp.tsx'; expect(() => parsePreparedAdoptionPlan(p)).toThrow();
  });
  it('preserves revision zero as explicit absent context and rubric', () => {
    const p = fixture(); p.projectState = { contextRevision: 0, rubricRevision: 0 }; expect(parsePreparedAdoptionPlan(p).projectState).toEqual({ contextRevision: 0, rubricRevision: 0 });
  });
  it('rejects two existing entry replacements', () => {
    const p = fixture(); p.writes.push({ ...p.writes[1]!, path: 'src/AnotherApp.tsx' });
    p.reads.push({ path: 'src/AnotherApp.tsx', expected: { ...before, identity: { ...object, inode: '5' } } });
    expect(() => parsePreparedAdoptionPlan(p)).toThrow();
  });
  it('detects file-prefix conflicts even with an intervening dotted sibling', () => {
    const p = fixture(); p.reads.push({ path: 'foo', expected: before }, { path: 'foo.other', expected: before }, { path: 'foo/bar', expected: before });
    expect(() => parsePreparedAdoptionPlan(p)).toThrow();
  });
  it('checks the trusted clock at expiry without implying current authority', () => {
    const p = parsePreparedAdoptionPlan(fixture());
    expect(isAdoptionPlanUnexpired(p, Date.parse('2026-10-04T03:14:59.999Z'))).toBe(true);
    for (const t of ['2026-10-04T03:15:00.000Z', '2026-10-04T02:59:59.999Z']) expect(isAdoptionPlanUnexpired(p, Date.parse(t))).toBe(false);
    expect(isAdoptionPlanUnexpired(p, Number.NaN)).toBe(false);
  });
});
describe('apply only identifies the server-owned prepared plan', () => {
  it('accepts the plan ID and digest without submitting arbitrary writes', () => {
    expect(parseApplyAdoptionRequest({ planId: 'plan-1', planDigest: hash })).toEqual({ planId: 'plan-1', planDigest: hash });
  });
  it.each([{ writes: [] }, { principalId: 'someone-else' }, { allowed: true }, { expectedRights: 'allowed' }])('rejects client authority or file payload %j', extra => {
    expect(() => parseApplyAdoptionRequest({ planId: 'plan-1', planDigest: hash, ...extra })).toThrow();
  });
});
describe('prepare draft refuses restricted write paths at the request boundary', () => {
  const draft = (extra: string) => ({
    projectId: 'project-1', entryPath: 'src/App.tsx', source: { implementationOrigin: 'owned' },
    writes: [{ path: extra, role: 'source', contentBase64: '' }, { path: 'src/App.tsx', role: 'entry', contentBase64: '' }],
  });
  it('accepts an ordinary source path', () => { expect(() => parsePrepareAdoptionRequest(draft('src/Hero.tsx'))).not.toThrow(); });
  it.each(['.git/config', 'node_modules/pkg/index.js', 'src/NODE_MODULES/x.js', 'a/.GIT/HEAD'])('rejects %j', p => {
    expect(() => parsePrepareAdoptionRequest(draft(p))).toThrow(/separate capability/);
  });
});
