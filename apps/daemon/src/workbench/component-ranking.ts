import { COMPONENT_TOKEN_AXES, type ComponentApplyBlocker, type ComponentFit, type ComponentRanking, type ProjectDesignContext, type ResourceCandidate, type ResourceRef } from '@open-design/contracts';
import { compareVersions, parseVersion, rangeLowerBound } from './adoption/installed-packages.js';
import { checkDependencies } from './adoption/dependency-report.js';
import { compareResourceTitles } from './context-ranking.js';

export type ComponentKitApproval = 'approved' | 'unapproved' | 'unverified';
/** V05 supplies a fresh, revision-bound approval decision; ranking never invents approval. */
export type ComponentKitApprovalResolver = (ref: ResourceRef) => Promise<ComponentKitApproval>;
export interface ComponentKitFacts { sourceId: ResourceRef['sourceId']; approval: ComponentKitApproval; id: string; revisionOrDigest: string; axes: Record<typeof COMPONENT_TOKEN_AXES[number], boolean>; tokens?: readonly string[] | undefined }
export interface ComponentTargetFacts { verified: boolean; target: 'html' | 'react' | null; targets?: readonly ('html' | 'react')[]; dependencyDigest: string; adapterSources?: readonly string[]; packages?: Record<string, string> }
export interface ComponentProjectFacts { projectId: string; contextRevision: number; rubricRevision: number; rubricCurrent: boolean; rubricHasRequiredChecks?: boolean }
export interface ComponentRankingOptions {
  projectFacts?: ComponentProjectFacts | null;
  kit: ComponentKitFacts | null; target: ComponentTargetFacts | null; context: ProjectDesignContext | null;
  requestedKitId?: string | undefined; requestedKitSourceId?: ResourceRef['sourceId'] | undefined; showAll?: boolean; useProjectContext?: boolean; mode?: 'rank' | 'list';
}
const categories = new Set<ResourceCandidate['category']>(['component', 'block', 'section', 'layout', 'cta-pattern', 'ui-kit', 'template', 'motion']);
export const isPickerComponent = (item: ResourceCandidate): boolean => categories.has(item.category);
const conversionSections: Record<string, readonly string[]> = {
  booking: ['booking-availability', 'cta-band'], contact: ['contact-form', 'cta-band', 'location-map-hours'],
  call: ['contact-form', 'cta-band', 'location-map-hours'], signup: ['newsletter-waitlist', 'cta-band'],
  subscribe: ['newsletter-waitlist', 'cta-band'], purchase: ['product-grid', 'pricing', 'cta-band'], download: ['cta-band'],
};
/** D17: target/adapter compatibility and admission only. Existing adoption owns rights and file validation. */
export function componentApplyGate(item: ResourceCandidate, observedTarget: ComponentTargetFacts | null, _context: ProjectDesignContext | null, _projectFacts?: ComponentProjectFacts | null): ComponentApplyBlocker[] {
  const target = observedTarget && item.componentAdapter === 'html-artifact/v1' ? { ...observedTarget, verified: true, target: 'html' as const, targets: ['html' as const] } : observedTarget;
  const blockers: ComponentApplyBlocker[] = [];
  const matchingTarget = (target?.targets ?? (target?.target ? [target.target] : [])).find(value => item.compatibility.targets.includes(value));
  if (!target?.verified || !target.target) blockers.push('target-unverified');
  else if (!matchingTarget) blockers.push('target-incompatible');
  if (matchingTarget === 'react' && !target?.adapterSources?.includes(item.ref.sourceId)) blockers.push('adapter-unverified');
  const dependencies = (item.targetDependencies ?? []).filter(dependency => dependency.scope === 'project');
  if (dependencies.length) {
    const checked = checkDependencies(dependencies.filter(dependency => !/^>=\s*\d+(?:\.\d+){0,2}$/u.test(dependency.range)), target?.packages ? { dependencies: target.packages } : null);
    const belowMinimum = dependencies.some(dependency => {
      const lower = rangeLowerBound(dependency.range), installed = parseVersion(target?.packages?.[dependency.name] ?? '');
      return dependency.range !== '*' && (!lower || !installed || compareVersions(installed, lower) < 0);
    });
    if (belowMinimum || checked.missing.length || checked.incompatible.length) blockers.push('dependencies-unverified');
  }
  // D17: discovery-time compatibility can be unverified; the actual target/adapter
  // and the existing preparer establish compatibility. Acceptance is informational.
  if (item.compatibility.state === 'unsupported') blockers.push('adapter-unverified');
  if (item.admissionStage !== 'admitted' || ['needs-repair', 'reference-only', 'unavailable'].includes(item.readiness)) blockers.push('admission-unverified');
  return [...new Set(blockers)];
}
function fit(item: ResourceCandidate, options: ComponentRankingOptions): ComponentFit {
  const { kit, context } = options;
  const compatibilityBlockers = componentApplyGate(item, options.target, context, options.projectFacts);
  const blockers: ComponentApplyBlocker[] = [...compatibilityBlockers, ...((kit && kit.approval !== 'approved' || !kit && options.requestedKitId) ? ['kit-unapproved' as const] : [])];
  const reasons: ComponentFit['reasons'] = blockers.map(fact => ({ code: 'apply-blocked', fact }));
  let score = 0, unknown = !kit, fixed = false;
  if (!kit) reasons.push({ code: 'kit-unknown', fact: options.requestedKitId ?? 'active-kit' });
  const evidence = item.componentTokenEvidence?.sourceRevisionOrDigest === item.ref.revisionOrDigest ? item.componentTokenEvidence : null;
  for (const axis of COMPONENT_TOKEN_AXES) {
    const bindings = evidence?.bindings?.[axis];
    const bindingsKnown = !bindings || (bindings.length > 0 && bindings.every(name => kit?.tokens?.includes(name)));
    const observed = evidence?.[axis] ?? 'unknown';
    const state = kit?.axes[axis] && (observed !== 'adaptable' || bindingsKnown) ? observed : 'unknown';
    reasons.push({ code: state === 'adaptable' ? 'token-adaptable' : state === 'fixed' ? 'token-fixed' : 'token-unknown', fact: axis });
    if (state === 'adaptable') score += 10;
    else if (state === 'fixed') fixed = true;
    else unknown = true;
  }
  if (options.useProjectContext !== false && context) {
    // Only a saved, explicit fact can contribute goal points. Inferred style/brand prose never does.
    context.conversions.forEach((conversion, index) => {
      const explicit = ['kind', 'role'].every(field => context.factSources.some(fact => fact.fieldPath === `/conversions/${index}/${field}` && fact.origin === 'user-confirmed'));
      if (explicit && item.sectionKind && conversionSections[conversion.kind]?.includes(item.sectionKind)) {
        const primary = conversion.role === 'primary'; score += primary ? 100 : 50;
        reasons.push({ code: primary ? 'primary-conversion' : 'secondary-conversion', fact: `${conversion.id}:${conversion.kind}` });
      }
    });
    if (context.spineCode && Array.isArray(item.spineAffinities) && item.spineAffinities.includes(context.spineCode)
      && context.factSources.some(fact => fact.fieldPath === '/spineCode' && fact.origin === 'user-confirmed')) {
      score += 20; reasons.push({ code: 'spine', fact: context.spineCode });
    }
  }
  const mismatch = fixed || item.rightsStatus === 'restricted' || blockers.some(reason => ['target-incompatible', 'motion-constraint'].includes(reason));
  return { version: 'kit-components/1', kitId: kit?.id ?? options.requestedKitId ?? null, kitSourceId: kit?.sourceId ?? options.requestedKitSourceId ?? null, acceptance: !item.acceptanceEvidence ? 'pending' : item.acceptanceEvidence.sourceDigest !== item.ref.revisionOrDigest ? 'stale' : item.acceptanceEvidence.passed ? 'passed' : 'failed', kitRevisionOrDigest: kit?.revisionOrDigest ?? null,
    status: !kit ? 'unknown' : mismatch ? 'mismatch' : unknown || compatibilityBlockers.length ? 'unknown' : 'fits', score, reasons, apply: { allowed: blockers.length === 0, blockers } };
}
/** Pure deterministic ranking. No model, network, acquisitions, installs or credentials. */
export function rankKitComponents(items: readonly ResourceCandidate[], options: ComponentRankingOptions): { items: ResourceCandidate[]; hidden: number; reason: ComponentRanking['reason'] } {
  const annotated = items.map(item => ({ ...item, componentFit: fit(item, options) }));
  // Without a verified kit, inspection falls back to local results with honest unknown fit.
  const visible = options.showAll || !options.kit ? annotated : annotated.filter(item => item.componentFit.status === 'fits');
  visible.sort((a, b) => {
    const score = options.mode === 'list' ? 0 : Number(b.componentFit.apply.allowed) - Number(a.componentFit.apply.allowed) || b.componentFit.score - a.componentFit.score;
    return score || compareResourceTitles(a, b);
  });
  return { items: visible, hidden: annotated.length - visible.length,
    reason: !options.kit ? options.requestedKitId ? 'kit-unavailable' : 'kit-absent' : !options.target?.verified ? 'target-unverified' : !visible.length ? 'no-kit-fits' : null };
}
