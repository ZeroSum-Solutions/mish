import { describe, expect, it } from 'vitest';
import { rankKitComponents as rank, componentApplyGate as gate } from '../../src/workbench/component-ranking.js';
import { candidate, savedContext, booking } from './context-ranking-fixture.js';
import type { ResourceCandidate } from '@mish/contracts';

const projectFacts = { projectId: 'p', contextRevision: 1, rubricRevision: 1, rubricCurrent: true };
const rankKitComponents: typeof rank = (items, options) => rank(items, { projectFacts, ...options });
const componentApplyGate: typeof gate = (item, target, context, facts = projectFacts) => gate(item, target, context, facts);
const kit = { sourceId: 'design-systems' as const, approval: 'approved' as const, id: 'clinic', revisionOrDigest: 'kit-v1', axes: { color: true, radius: true, type: true } };
const target = { verified: true, target: 'html' as const, dependencyDigest: 'target-v1' };
const component = (id: string, overrides: Partial<ResourceCandidate> = {}) => candidate(id, {
  category: 'component', admissionStage: 'admitted', needDecision: 'justified',
  rightsStatus: 'permitted', operationGrants: [{ operation: 'incorporation', state: 'permitted', reason: null }],
  compatibility: { nativeFormat: 'html', targets: ['html'], state: 'compatible', reason: null },
  acceptanceEvidence: { sourceDigest: 'v1', receiptId: 'admission:clinic', passed: true },
  componentAdmissionEvidence: { profileId: 'clinic-html', projectId: 'p', sourceRevisionOrDigest: 'v1', contextRevision: 1, rubricRevision: 1 },
  componentTokenEvidence: { sourceRevisionOrDigest: 'v1', evidenceRef: 'observed:tokens', color: 'adaptable', radius: 'adaptable', type: 'adaptable' },
  ...overrides,
});
const context = savedContext({ conversions: [booking], constraints: [{ id: 'no-motion', kind: 'motion', value: 'none' }] });

describe('V06 / D6 / AC-R05.1/.2/.4, AC-R18.2/.3', () => {
  it('defaults to active-kit fits; Show all exposes unknown/rejected entries without changing Apply eligibility', () => {
    const items = [component('fit', { motionMetadata: { state: 'static', basis: 'declared', field: 'fixture', sourceRevisionOrDigest: 'v1' } }), component('unknown', { componentTokenEvidence: undefined }), component('wrong-target', { compatibility: { nativeFormat: 'svelte', targets: ['svelte'], state: 'unsupported', reason: 'No adapter' } })];
    const fits = rankKitComponents(items, { kit, target, context });
    expect(fits.items.map(item => item.ref.itemId)).toEqual(['fit']);
    const all = rankKitComponents(items, { kit, target, context, showAll: true });
    expect(all.items).toHaveLength(3);
    expect(all.items.find(item => item.ref.itemId === 'unknown')?.componentFit?.status).toBe('unknown');
    expect(all.items.find(item => item.ref.itemId === 'wrong-target')?.componentFit?.apply.allowed).toBe(false);
    expect(all.items.find(item => item.ref.itemId === 'fit')?.componentFit?.apply).toEqual(fits.items[0]?.componentFit?.apply);
  });
  it('ranks explicit conversion goals, token adaptation and constraints deterministically with recorded reasons', () => {
    const items = [component('a'), component('b', { sectionKind: 'booking-availability' }), component('c', { componentTokenEvidence: { sourceRevisionOrDigest: 'v1', evidenceRef: 'fixed', color: 'fixed', radius: 'fixed', type: 'fixed' } })];
    const options = { kit, target, context, showAll: true };
    expect(rankKitComponents(items, options).items.map(item => item.ref.itemId)).toEqual(['b', 'a', 'c']);
    expect(rankKitComponents([...items].reverse(), options)).toEqual(rankKitComponents(items, options));
    expect(rankKitComponents(items, options).items[0]?.componentFit?.reasons).toContainEqual({ code: 'primary-conversion', fact: 'book:booking' });
  });
  it('keeps constraints informational for Apply per D17', () => {
    const animated = component('animated', { motionMetadata: { state: 'animated', basis: 'declared', field: 'fixture', sourceRevisionOrDigest: 'v1' } });
    expect(rankKitComponents([animated], { kit, target, context, useProjectContext: false, showAll: true }).items[0]?.componentFit?.apply).toEqual({ allowed: true, blockers: [] });
  });
  it('fails closed on admission, rights, stale evidence, unverified target and unsupported adapters', () => {
    expect(componentApplyGate(component('a', { admissionStage: 'discovered' }), target, context)).toContain('admission-unverified');
    expect(componentApplyGate(component('a', { acceptanceEvidence: undefined }), target, context)).not.toContain('admission-unverified');
    expect(componentApplyGate(component('a', { rightsStatus: 'restricted' }), target, context)).toEqual([]);
    expect(componentApplyGate(component('a'), { ...target, verified: false }, context)).toContain('target-unverified');
    expect(componentApplyGate(component('a', { compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unsupported', reason: null } }), target, context)).toContain('adapter-unverified');
  });
  it('labels missing kit/target or stale token evidence unknown, and retains a lexical/local inspection fallback', () => {
    const result = rankKitComponents([component('local', { componentTokenEvidence: { sourceRevisionOrDigest: 'old', evidenceRef: 'old', color: 'adaptable', radius: 'adaptable', type: 'adaptable' } })], { kit: null, target: null, context: null });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.componentFit?.status).toBe('unknown');
    expect(result.items[0]?.componentFit?.apply.allowed).toBe(false);
    expect(result.reason).toBe('kit-absent');
  });
  it('never scores inferred goal facts as explicit facts', () => {
    const inferred = savedContext({ conversions: [booking] });
    inferred.factSources.forEach(fact => { fact.origin = 'inferred'; fact.confidence = 0.8; });
    expect(rankKitComponents([component('b', { sectionKind: 'booking-availability' })], { kit, target, context: inferred, showAll: true }).items[0]?.componentFit?.reasons.some(reason => reason.code === 'primary-conversion')).toBe(false);
  });
});
it('does not offer a React component without its source-specific adapter receipt or installed dependencies', () => {
  const item = component('react-unit', { compatibility: { nativeFormat: 'tsx', targets: ['react'], state: 'compatible', reason: null }, targetDependencies: [{ name: 'styled-components', range: '^5.3.11', scope: 'project' }] });
  const react = { ...target, target: 'react' as const };
  expect(componentApplyGate(item, react, null)).toEqual(['adapter-unverified', 'dependencies-unverified']);
  expect(componentApplyGate(item, { ...react, adapterSources: ['sections'], packages: { 'styled-components': '5.3.11' } }, null)).toEqual([]);
});
it('does not promote project evidence freshness into an additional Apply gate', () => {
  const item = component('admitted');
  expect(componentApplyGate(item, target, context, { ...projectFacts, rubricRevision: 2 })).toEqual([]);
  expect(componentApplyGate(item, target, context, { ...projectFacts, contextRevision: 2, rubricCurrent: false })).toEqual([]);
  expect(componentApplyGate(item, target, context, { ...projectFacts, projectId: 'other' })).toEqual([]);
});
it('rejects installed packages below the adapter minimum within the same major', () => {
  const item = component('minimum', { targetDependencies: [{ name: 'styled-components', range: '^5.3.11', scope: 'project' }] });
  expect(componentApplyGate(item, { ...target, packages: { 'styled-components': '5.0.0' } }, context)).toContain('dependencies-unverified');
});
it('accepts existing source receipts without inventing a mandatory new admission store', () => {
  const item = component('existing-source', { componentAdmissionEvidence: undefined });
  const absentRubric = { ...projectFacts, rubricRevision: 0, rubricCurrent: false };
  expect(componentApplyGate(item, target, null, absentRubric)).toEqual([]);
  expect(componentApplyGate(item, target, null, { ...projectFacts, rubricHasRequiredChecks: true })).toEqual([]);
  expect(componentApplyGate(component('project-profile'), target, null, { ...projectFacts, rubricHasRequiredChecks: true })).toEqual([]);
});
it('does not infer active-kit token bindings from the presence of unrelated colour/radius/type tokens', () => {
  const item = component('bound', { componentTokenEvidence: { sourceRevisionOrDigest: 'v1', evidenceRef: 'source-css', color: 'adaptable', radius: 'adaptable', type: 'adaptable', bindings: { color: ['--fg'], radius: ['--radius'], type: ['--font'] } } });
  expect(rankKitComponents([item], { kit, target, context: null, showAll: true }).items[0]?.componentFit?.status).toBe('unknown');
  expect(rankKitComponents([item], { kit: { ...kit, tokens: ['--fg', '--radius', '--font'] }, target, context: null }).items[0]?.componentFit?.status).toBe('fits');
});

it('retains fixed observations with empty binding arrays from the source observer', () => {
  const fixed = component('fixed', { componentTokenEvidence: { sourceRevisionOrDigest: 'v1', evidenceRef: 'source-css', color: 'fixed', radius: 'fixed', type: 'fixed', bindings: { color: [], radius: [], type: [] } } });
  expect(rankKitComponents([fixed], { kit, target, context: null, showAll: true }).items[0]?.componentFit?.status).toBe('mismatch');
});
it('does not require a new profile for free-text constraints per D17', () => {
  const constraints = savedContext({ constraints: [{ id: 'accessible', kind: 'accessibility', value: 'WCAG AA' }] });
  const facts = { ...projectFacts, rubricRevision: 0, rubricCurrent: false };
  const admitted = component('profile', { componentAdmissionEvidence: { profileId: 'accessibility', projectId: 'p', sourceRevisionOrDigest: 'v1', contextRevision: 1, rubricRevision: 0 } });
  expect(componentApplyGate(admitted, target, constraints, facts)).toEqual([]);
  expect(componentApplyGate(component('unknown', { componentAdmissionEvidence: undefined }), target, constraints, facts)).toEqual([]);
  expect(componentApplyGate(admitted, target, constraints, { ...facts, contextRevision: 2 })).toEqual([]);
});
it('uses the existing catalog title comparator and stable identity for ties and list order', () => {
  const items = [component('z', { title: 'Zulu' }), component('b', { title: 'Alpha' }), component('a', { title: 'Alpha' })];
  for (const mode of ['rank', 'list'] as const) {
    const options = { kit, target, context: null, showAll: true, mode };
    expect(rankKitComponents(items, options).items.map(item => item.ref.itemId)).toEqual(['a', 'b', 'z']);
    expect(rankKitComponents([...items].reverse(), options)).toEqual(rankKitComponents(items, options));
  }
});

it.each([undefined, { sourceDigest: 'v1', receiptId: 'failed', passed: false }, { sourceDigest: 'old', receiptId: 'stale', passed: true }])('D17: acceptance evidence is informational, not an Apply requirement (%j)', acceptanceEvidence => {
  const item = component('existing', { acceptanceEvidence, componentAdmissionEvidence: undefined, needDecision: 'not-assessed', compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unverified', reason: 'Prepare validates the adapter' } });
  expect(componentApplyGate(item, target, context)).toEqual([]);
});
it('D17: saved constraints and rubric evidence do not introduce new Apply gates', () => {
  const item = component('existing', { componentAdmissionEvidence: undefined });
  expect(componentApplyGate(item, target, context, { ...projectFacts, rubricCurrent: false, rubricHasRequiredChecks: true })).toEqual([]);
});
it('V05: an unapproved kit can rank as a fit but cannot be an Apply target', () => {
  const result = rankKitComponents([component('existing')], { kit: { ...kit, sourceId: 'design-systems', approval: 'unapproved' }, target, context: null });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.componentFit?.status).toBe('fits');
  expect(result.items[0]?.componentFit?.apply).toEqual({ allowed: false, blockers: ['kit-unapproved'] });
});
