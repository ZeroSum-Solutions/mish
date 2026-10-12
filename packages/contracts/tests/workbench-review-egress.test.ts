import { describe, expect, it } from 'vitest';
import {
  reviewConsoleEvidenceSchema, reviewEgressEvidenceSchema, reviewEgressHostProblem, reviewEgressPolicySchema, runMechanicalReviewRequestSchema, startReviewRunRequestSchema,
  verificationBundleSchema, WORKBENCH_REVIEW_EGRESS_LIMITS, WORKBENCH_REVIEW_PREVIEW_HOST,
} from '../src/api/workbench-review.js';

// AC-R06.2 external-resource pages (B4-2): the per-run egress allow-list is
// opt-in, exact-host only and refuses anything that could reach a private
// network before the daemon ever resolves it.

describe('review egress allow-list host rules', () => {
  it('accepts exact public hostnames, with an explicit port when given, and the page own origin', () => {
    for (const host of ['fonts.example.com', 'cdn.jsdelivr.net', 'cdn.example.com:8443', 'xn--bcher-kva.de', WORKBENCH_REVIEW_PREVIEW_HOST]) {
      expect(reviewEgressHostProblem(host), host).toBeNull();
    }
  });

  it.each([
    ['', 'empty'],
    ['*.example.com', 'wildcard'],
    ['cdn.*.com', 'wildcard'],
    ['https://cdn.example.com', 'scheme-or-path'],
    ['cdn.example.com/fonts', 'scheme-or-path'],
    ['user@cdn.example.com', 'scheme-or-path'],
    [' cdn.example.com', 'scheme-or-path'],
    ['93.184.215.14', 'ip-literal'],
    ['127.0.0.1:8080', 'ip-literal'],
    ['0x7f.0.0.1', 'ip-literal'],
    ['[::1]', 'ip-literal'],
    ['fe80::1', 'ip-literal'],
    ['localhost', 'special-use'],
    ['admin.localhost', 'special-use'],
    ['printer.local', 'special-use'],
    ['metadata.google.internal', 'special-use'],
    ['router.home.arpa', 'special-use'],
    [`${WORKBENCH_REVIEW_PREVIEW_HOST}:8080`, 'special-use'],
    ['intranet', 'invalid-hostname'],
    ['bad_host.example.com', 'invalid-hostname'],
    ['-bad.example.com', 'invalid-hostname'],
    ['bücher.de', 'invalid-hostname'],
    ['cdn.example.com:0', 'invalid-port'],
    ['cdn.example.com:65536', 'invalid-port'],
    ['cdn.example.com:443x', 'invalid-port'],
    // N5: ports Chrome itself refuses to fetch (net::ERR_UNSAFE_PORT).
    ['cdn.example.com:22', 'restricted-port'],
    ['cdn.example.com:6000', 'restricted-port'],
    ['cdn.example.com:10080', 'restricted-port'],
  ])('refuses %j as %s', (host, problem) => {
    expect(reviewEgressHostProblem(host)).toBe(problem);
  });

  it('normalizes case, refuses duplicates and caps the number of hosts per run', () => {
    expect(reviewEgressPolicySchema.parse({ allowHosts: ['CDN.Example.com'] })).toEqual({ allowHosts: ['cdn.example.com'] });
    expect(reviewEgressPolicySchema.safeParse({ allowHosts: ['cdn.example.com', 'CDN.example.com'] }).success).toBe(false);
    const many = Array.from({ length: WORKBENCH_REVIEW_EGRESS_LIMITS.maxHosts + 1 }, (_, index) => `h${index}.example.com`);
    expect(reviewEgressPolicySchema.safeParse({ allowHosts: many }).success).toBe(false);
    expect(reviewEgressPolicySchema.safeParse({ allowHosts: ['*.example.com'] }).success).toBe(false);
    expect(reviewEgressPolicySchema.safeParse({ allowHosts: [], extra: true }).success).toBe(false);
  });

  it('is an optional per-run sibling on both review requests; omitting it keeps the request unchanged (default-deny)', () => {
    expect(runMechanicalReviewRequestSchema.parse({})).toEqual({ entry: 'index.html' });
    expect(runMechanicalReviewRequestSchema.parse({ egress: { allowHosts: ['fonts.example.com'] } })).toEqual({ entry: 'index.html', egress: { allowHosts: ['fonts.example.com'] } });
    expect(runMechanicalReviewRequestSchema.safeParse({ egress: { allowHosts: ['10.0.0.1'] } }).success).toBe(false);
    const start = { projectId: 'p', snapshot: { entry: 'index.html' }, rubricRevision: 0 };
    expect(startReviewRunRequestSchema.parse(start)).not.toHaveProperty('egress');
    expect(startReviewRunRequestSchema.parse({ ...start, egress: { allowHosts: ['fonts.example.com'] } }).egress).toEqual({ allowHosts: ['fonts.example.com'] });
    expect(startReviewRunRequestSchema.safeParse({ ...start, egress: { allowHosts: ['localhost'] } }).success).toBe(false);
  });
});

describe('egress evidence in a verification bundle', () => {
  const at = '2026-10-07T10:00:00.000Z';
  const digest = 'b'.repeat(64);
  const mandatory = ['core.declared-actions', 'core.text-contrast', 'core.console-resources', 'core.responsive-overflow', 'core.keyboard-focus', 'core.document-semantics'];
  const fetched = { origin: 'https://fonts.example.com', pathDepth: 1, pathDepthCapped: false, pathQuerySha256: digest, queryLength: 0, host: 'fonts.example.com', resourceType: 'Font', outcome: 'fetched', reason: null, resolvedAddress: '93.184.215.14', status: 200, bytes: 10, sha256: digest, durationMs: 4, redirects: [] };
  function bundle(egress: unknown, outcome: 'passed' | 'inconclusive' = 'passed') {
    return {
      schema: 'workbench-verification-bundle/1', id: 'rv_1', projectId: 'p', entry: 'index.html', sourceHashes: [], contextRevision: 0, rubricRevision: 0,
      previewOrigin: `http://${WORKBENCH_REVIEW_PREVIEW_HOST}`, environment: { worker: 'cdp-chromium', browserVersion: 'x', runnerVersion: 'mechanical/1' },
      viewports: [320], startedAt: at, endedAt: at,
      results: mandatory.map(id => ({ checkId: id, criterionId: id, parameterType: 'cta', synthesized: true, required: true, severity: 'high', outcome: outcome === 'passed' ? 'pass' : 'inconclusive', reason: 'r', evidenceIds: [] })),
      evidence: [], unresolvedRequiredChecks: [], outcome, conformanceNote: 'n', egress,
    };
  }
  const limits = { maxRequests: 200, maxBytes: 1, maxResponseBytes: 1, requestTimeoutMs: 1, maxRedirects: 5 };

  it('records every allowed fetch with its resolved address, status, bytes, digest and timing', () => {
    const egress = { schema: 'workbench-review-egress/3', allowHosts: ['fonts.example.com'], limits, fetches: [fetched], requests: 1, bytes: 10, exhausted: null, digest };
    expect(verificationBundleSchema.parse(bundle(egress)).egress).toEqual(egress);
  });

  it('refuses a fetch from a host outside the frozen allow-list, a fetched record without an address, and a passed run that exhausted its budget', () => {
    const base = { schema: 'workbench-review-egress/3', allowHosts: ['fonts.example.com'], limits, requests: 1, bytes: 10, exhausted: null, digest };
    expect(verificationBundleSchema.safeParse(bundle({ ...base, fetches: [{ ...fetched, host: 'evil.example.com' }] })).success).toBe(false);
    expect(verificationBundleSchema.safeParse(bundle({ ...base, fetches: [{ ...fetched, resolvedAddress: null }] })).success).toBe(false);
    expect(verificationBundleSchema.safeParse(bundle({ ...base, fetches: [{ ...fetched, outcome: 'refused', reason: null }] })).success).toBe(false);
    expect(verificationBundleSchema.safeParse(bundle({ ...base, fetches: [fetched], exhausted: 'The review reached its egress limit' })).success).toBe(false);
    expect(verificationBundleSchema.safeParse(bundle({ ...base, fetches: [fetched], exhausted: 'The review reached its egress limit' }, 'inconclusive')).success).toBe(true);
    expect(verificationBundleSchema.safeParse(bundle({ ...base, allowHosts: [], fetches: [fetched] })).success).toBe(false);
    // Sol round 3 (egress records v2): an external URL is origin + path depth + digest of path and query; a raw URL or path is refused.
    expect(verificationBundleSchema.safeParse(bundle({ ...base, fetches: [{ ...fetched, url: 'https://fonts.example.com/a.woff2' }] })).success).toBe(false);
    expect(verificationBundleSchema.safeParse(bundle({ ...base, fetches: [{ ...fetched, origin: 'https://fonts.example.com/a.woff2' }] })).success).toBe(false);
    expect(verificationBundleSchema.safeParse(bundle({ ...base, fetches: [{ ...fetched, redirects: [{ origin: 'https://fonts.example.com', pathDepth: 1, pathDepthCapped: false, pathQuerySha256: digest, status: 302, resolvedAddress: '93.184.215.14' }] }] })).success).toBe(true);
    const { schema: _schema, ...unversioned } = base;
    expect(verificationBundleSchema.safeParse(bundle({ ...unversioned, fetches: [fetched] })).success).toBe(false);
  });

  it('still parses bundles written before the allow-list existed', () => {
    const { egress: _egress, ...legacy } = bundle(undefined);
    expect(verificationBundleSchema.parse(legacy)).not.toHaveProperty('egress');
  });
});

describe('Sol round 4: egress records v3 and console evidence v1', () => {
  const digest = 'f'.repeat(64);
  const record = { origin: 'https://fonts.example.com', pathDepth: 1, pathDepthCapped: false, pathQuerySha256: digest, queryLength: 0, host: 'fonts.example.com', resourceType: 'Font', outcome: 'fetched', reason: null, resolvedAddress: '93.184.215.14', status: 200, bytes: 10, sha256: digest, durationMs: 4, redirects: [] };
  const evidence = (fetches: unknown[]) => ({ schema: 'workbench-review-egress/3', allowHosts: ['fonts.example.com'], limits: { maxRequests: 1, maxBytes: 1, maxResponseBytes: 1, requestTimeoutMs: 1, maxRedirects: 5 }, fetches, requests: 1, bytes: 10, exhausted: null, digest });

  it('caps a deep path at 200 segments and says so, instead of refusing the record', () => {
    expect(reviewEgressEvidenceSchema.safeParse(evidence([record])).success).toBe(true);
    expect(reviewEgressEvidenceSchema.safeParse(evidence([{ ...record, pathDepth: 201 }])).success).toBe(false);
    expect(reviewEgressEvidenceSchema.safeParse(evidence([{ ...record, pathDepth: 200, pathDepthCapped: true }])).success).toBe(true);
    expect(reviewEgressEvidenceSchema.safeParse(evidence([{ ...record, pathDepth: 5, pathDepthCapped: true }])).success).toBe(false);
    expect(reviewEgressEvidenceSchema.safeParse({ ...evidence([record]), schema: 'workbench-review-egress/2' }).success).toBe(false);
  });

  it('console evidence keeps kind, count, length, digest and a redacted source location, never a message body', () => {
    const entry = { id: 'console-0123456789ab', kind: 'exception', level: 'error', count: 2, length: 42, sha256: digest, source: { origin: 'http://project.od-review.localhost', path: '/app.js', pathQuerySha256: null, line: 12, column: 5 }, viewports: [320, 375] };
    const consoleEvidence = { schema: 'workbench-review-console/1', entries: [entry] };
    expect(reviewConsoleEvidenceSchema.parse(consoleEvidence)).toEqual(consoleEvidence);
    expect(reviewConsoleEvidenceSchema.safeParse({ ...consoleEvidence, entries: [{ ...entry, text: 'TypeError: SECRET' }] }).success).toBe(false);
    // An external source keeps no path: origin plus a digest of path and query.
    expect(reviewConsoleEvidenceSchema.safeParse({ ...consoleEvidence, entries: [{ ...entry, source: { origin: 'https://cdn.example.com', path: '/reset/SECRET.js', pathQuerySha256: null, line: 1, column: 1 } }] }).success).toBe(false);
    expect(reviewConsoleEvidenceSchema.safeParse({ ...consoleEvidence, entries: [{ ...entry, source: { origin: 'https://cdn.example.com', path: null, pathQuerySha256: digest, line: 1, column: 1 } }] }).success).toBe(true);
    expect(reviewConsoleEvidenceSchema.safeParse({ ...consoleEvidence, entries: [{ ...entry, source: { origin: 'https://cdn.example.com/reset/SECRET', path: null, pathQuerySha256: digest, line: 1, column: 1 } }] }).success).toBe(false);
  });
});

describe('Sol round 5: egress evidence /2 stays readable beside /3', () => {
  const digest = 'f'.repeat(64);
  const v2Record = { origin: 'https://fonts.example.com', pathDepth: 1, pathQuerySha256: digest, queryLength: 0, host: 'fonts.example.com', resourceType: 'Font', outcome: 'fetched', reason: null, resolvedAddress: '93.184.215.14', status: 200, bytes: 10, sha256: digest, durationMs: 4, redirects: [{ origin: 'https://fonts.example.com', pathDepth: 1, pathQuerySha256: digest, status: 302, resolvedAddress: '93.184.215.14' }] };
  const evidence = (schema: string, fetches: unknown[]) => ({ schema, allowHosts: ['fonts.example.com'], limits: { maxRequests: 1, maxBytes: 1, maxResponseBytes: 1, requestTimeoutMs: 1, maxRedirects: 5 }, fetches, requests: 1, bytes: 10, exhausted: null, digest });
  it('reads /2 strictly, reads /3 strictly, and never mixes their record shapes', () => {
    expect(reviewEgressEvidenceSchema.safeParse(evidence('workbench-review-egress/2', [v2Record])).success).toBe(true);
    expect(reviewEgressEvidenceSchema.safeParse(evidence('workbench-review-egress/2', [{ ...v2Record, pathDepthCapped: false }])).success).toBe(false);
    expect(reviewEgressEvidenceSchema.safeParse(evidence('workbench-review-egress/3', [v2Record])).success).toBe(false);
    expect(reviewEgressEvidenceSchema.safeParse(evidence('workbench-review-egress/3', [{ ...v2Record, pathDepthCapped: false, redirects: [{ ...v2Record.redirects[0], pathDepthCapped: false }] }])).success).toBe(true);
    expect(reviewEgressEvidenceSchema.safeParse(evidence('workbench-review-egress/1', [])).success).toBe(false);
  });
});

describe('captain addendum: the unversioned v1 egress section stays readable', () => {
  const digest = 'f'.repeat(64);
  const v1Record = { url: 'https://fonts.example.com/a.woff2', host: 'fonts.example.com', resourceType: 'Font', outcome: 'fetched', reason: null, resolvedAddress: '93.184.215.14', status: 200, bytes: 10, sha256: digest, durationMs: 4, redirects: [] };
  const evidence = (fetches: unknown[]) => ({ allowHosts: ['fonts.example.com'], limits: { maxRequests: 1, maxBytes: 1, maxResponseBytes: 1, requestTimeoutMs: 1, maxRedirects: 5 }, fetches, requests: 1, bytes: 10, exhausted: null, digest });
  it('reads both v1 variants strictly and refuses mixed shapes', () => {
    expect(reviewEgressEvidenceSchema.safeParse(evidence([v1Record])).success).toBe(true);
    expect(reviewEgressEvidenceSchema.safeParse(evidence([{ ...v1Record, queryLength: 3, querySha256: digest }])).success).toBe(true);
    expect(reviewEgressEvidenceSchema.safeParse(evidence([{ ...v1Record, queryLength: 3 }])).success).toBe(false);
    expect(reviewEgressEvidenceSchema.safeParse(evidence([{ ...v1Record, pathDepth: 1 }])).success).toBe(false);
    expect(reviewEgressEvidenceSchema.safeParse(evidence([{ ...v1Record, host: 'evil.example.com' }])).success).toBe(false);
  });
});
