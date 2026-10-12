import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProjectRubric, parseProjectRubricDraft, WORKBENCH_MANDATORY_CRITERION_IDS } from '../src/api/workbench-context.js';
import { verificationBundleSchema, WORKBENCH_MECHANICAL_PARAMETER_TYPES, WORKBENCH_REVIEW_EGRESS_SCHEMA } from '../src/api/workbench-review.js';

// AC-R06 preamble (B4-2b): motion checks are an opt-in mechanical parameter.
// The captain decision keeps them out of the mandatory criteria, and every
// record written before the parameter existed must still parse unchanged.

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures/workbench-review-pre-motion', name), 'utf8'));
const provenance = { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner declaration' } as const;
const motionCheck = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  checkId: 'motion', kind: 'mechanical', required: false, severity: 'medium', requiredBasis: null, provenance,
  parameters: { type: 'motion', ...parameters }, evidenceTypes: ['probe'], sourceCriteria: [], ...extra,
});

describe('motion mechanical parameter (opt-in)', () => {
  it('is an additive parameter type and never a mandatory criterion', () => {
    expect(WORKBENCH_MECHANICAL_PARAMETER_TYPES).toEqual(['cta', 'contrast', 'console-resources', 'overflow', 'keyboard-focus', 'document-semantics', 'motion']);
    expect(WORKBENCH_MANDATORY_CRITERION_IDS).toEqual(['core.declared-actions', 'core.text-contrast', 'core.console-resources', 'core.responsive-overflow', 'core.keyboard-focus', 'core.document-semantics']);
  });

  it('defaults every motion requirement on at 375 and 1440 CSS px only', () => {
    const draft = parseProjectRubricDraft({ contextRevision: 1, checks: [motionCheck({})] });
    expect(draft.checks[0]!.parameters).toEqual({ type: 'motion', requirePauseControl: true, requireReducedMotionFallback: true, requireLivePreferenceChange: true, viewports: [375, 1440] });
  });

  it('lets a rubric list more motion widths, never fewer than 375 and 1440', () => {
    const more = parseProjectRubricDraft({ contextRevision: 1, checks: [motionCheck({ viewports: [320, 375, 768, 1440, 1920] })] });
    const parameters = more.checks[0]!.parameters;
    expect('viewports' in parameters ? parameters.viewports : null).toEqual([320, 375, 768, 1440, 1920]);
    for (const viewports of [[375], [1440], [320, 768], [375, 1440, 1440], []]) {
      expect(() => parseProjectRubricDraft({ contextRevision: 1, checks: [motionCheck({ viewports })] }), JSON.stringify(viewports)).toThrow();
    }
  });

  it('accepts a project-accepted required motion check with some requirements off', () => {
    const draft = parseProjectRubricDraft({ contextRevision: 1, checks: [motionCheck({ requireLivePreferenceChange: false, viewports: [320, 375, 768, 1440, 1920] }, {
      required: true, severity: 'high', requiredBasis: { type: 'project-acceptance', requirementId: 'motion-policy', rationale: 'The carousel must honour reduced motion' },
    })] });
    expect(draft.checks[0]).toMatchObject({ required: true, parameters: { requirePauseControl: true, requireReducedMotionFallback: true, requireLivePreferenceChange: false } });
  });

  it('refuses a motion check that requires nothing, claims a mandatory basis, or carries unknown fields', () => {
    expect(() => parseProjectRubricDraft({ contextRevision: 1, checks: [motionCheck({ requirePauseControl: false, requireReducedMotionFallback: false, requireLivePreferenceChange: false })] })).toThrow(/at least one motion requirement/);
    for (const criterionId of WORKBENCH_MANDATORY_CRITERION_IDS) {
      expect(() => parseProjectRubricDraft({ contextRevision: 1, checks: [motionCheck({}, { required: true, severity: 'high', requiredBasis: { type: 'mandatory', criterionId } })] }), criterionId).toThrow();
    }
    expect(() => parseProjectRubricDraft({ contextRevision: 1, checks: [motionCheck({ targets: [{ type: 'selector', selector: '.carousel' }] })] })).toThrow();
    expect(() => parseProjectRubricDraft({ contextRevision: 1, checks: [motionCheck({ continuousAfterMs: 1000 })] })).toThrow();
  });

  it('records a motion result in a bundle as a non-mandatory parameter type', () => {
    const bundle = fixture('bundle.json');
    const withMotion = {
      ...bundle,
      results: [...bundle.results, { checkId: 'motion', criterionId: null, parameterType: 'motion', synthesized: false, required: true, severity: 'high', outcome: 'fail', reason: '320px: No keyboard-reachable control pauses, stops or hides the moving content', evidenceIds: [] }],
      outcome: 'failed',
    };
    expect(verificationBundleSchema.parse(withMotion).results.at(-1)).toMatchObject({ parameterType: 'motion', outcome: 'fail' });
  });
});

describe('records written before the motion parameter', () => {
  it('parse unchanged: a stored bundle and a stored rubric record', () => {
    const bundle = fixture('bundle.json');
    const rubric = fixture('rubric.json');
    expect(bundle.results.map((result: { parameterType: string }) => result.parameterType)).not.toContain('motion');
    expect(verificationBundleSchema.parse(bundle)).toEqual(bundle);
    expect(parseProjectRubric(rubric)).toEqual(rubric);
  });
});

describe('motion egress evidence (allowed-host requests made by motion reloads)', () => {
  const digest = 'c'.repeat(64);
  const limits = { maxRequests: 200, maxBytes: 1, maxResponseBytes: 1, requestTimeoutMs: 1, maxRedirects: 5 };
  const fetched = { origin: 'https://cdn.example.com', pathDepth: 1, pathDepthCapped: false, pathQuerySha256: 'd'.repeat(64), queryLength: 3, host: 'cdn.example.com', resourceType: 'Script', outcome: 'fetched', reason: null, resolvedAddress: '93.184.215.14', status: 200, bytes: 10, sha256: digest, durationMs: 4, redirects: [] };
  const section = (extra: Record<string, unknown> = {}) => ({ schema: WORKBENCH_REVIEW_EGRESS_SCHEMA, allowHosts: ['cdn.example.com'], limits, fetches: [fetched], requests: 1, bytes: 10, exhausted: null, digest, ...extra });
  const withSections = (motionEgress: unknown, egress: unknown = { ...section(), fetches: [], requests: 0, bytes: 0 }) => ({ ...fixture('bundle.json'), egress, motionEgress });

  it('uses the egress/3 record shape: a path-free location, never the URL path or query', () => {
    expect(verificationBundleSchema.safeParse(withSections(section({ fetches: [{ ...fetched, url: 'https://cdn.example.com/carousel.js?k=secret' }] }))).success).toBe(false);
    expect(verificationBundleSchema.safeParse(withSections(section({ schema: 'workbench-review-egress/1' }))).success).toBe(false);
  });

  it('is recorded in its own section with the same record shape as the main egress', () => {
    const parsed = verificationBundleSchema.parse(withSections(section()));
    expect(parsed.motionEgress).toEqual(section());
    expect(parsed.egress?.fetches).toEqual([]);
  });

  it('never blocks a passed run: an exhausted motion egress budget leaves the outcome to the motion check', () => {
    expect(verificationBundleSchema.parse(withSections(section({ exhausted: { template: 'egress.requestLimit', params: [{ kind: 'number', value: 200 }] } }))).outcome).toBe('passed');
  });

  it('uses the run allow-list and refuses a fetch outside it', () => {
    expect(verificationBundleSchema.safeParse(withSections(section({ fetches: [{ ...fetched, host: 'evil.example.com' }] }))).success).toBe(false);
    expect(verificationBundleSchema.safeParse(withSections(section({ allowHosts: ['other.example.com'], fetches: [] }))).success).toBe(false);
  });

  it('is absent from bundles written before it existed', () => {
    expect(verificationBundleSchema.parse(fixture('bundle.json'))).not.toHaveProperty('motionEgress');
  });
});
