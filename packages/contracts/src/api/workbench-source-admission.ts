import { z } from 'zod';
import { resourceRefSchema } from './workbench-resource-ref.js';

/** Stored server records only. Parsing proves shape, never authority or actual evidence. */
export const SOURCE_OPERATIONS = [
  'host-preview', 'incorporate-project', 'export-application', 'redistribute-unit',
  'save-private-unit', 'reuse-private-project', 'private-backup', 'cache-source-content', 'derive-from-reference',
] as const;
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const text = z.string().min(1).max(2000).refine(value => !/[\p{Cc}]/u.test(value));
const identityText = text.refine(value => !/[\p{Cf}]/u.test(value), 'Invalid format character in identity');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = integer.min(1);
const relativePath = z.string().min(1).max(1000).refine(value =>
  !/[\p{Cc}\p{Cf}\\]/u.test(value) && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a normalized project-relative path');
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const evidenceRefs = z.array(id).max(100).refine(unique, 'Duplicate evidence references');
const sourceRef = resourceRefSchema.superRefine((value, ctx) => {
  for (const key of ['itemId', 'revisionOrDigest'] as const) {
    if (value[key].length > 1000 || /[\p{Cc}\p{Cf}]/u.test(value[key])) ctx.addIssue({ code: 'custom', path: [key], message: 'Invalid bounded resource identity' });
  }
});
const acquisitionMode = z.enum(['reference-link', 'licensed-mcp', 'project-fetch', 'bundled-catalogue']);
const dependencyName = z.string().min(1).max(214).regex(/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const dependencyVersion = z.string().max(200).regex(semver).refine(value =>
  (value.match(semver)?.[4]?.split('.') ?? []).every(part => !/^0\d+$/u.test(part)), 'Noncanonical numeric prerelease');
// Retain legacy npm SHA-1 metadata, but it cannot qualify byte-pinned technical evidence.
const integrityToken = /^(?:sha1-[A-Za-z0-9+/]{26}[AEIMQUYcgkosw048]=|sha256-[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{85}[AQgw]==)$/u;
const registryIntegrity = z.string().min(1).max(1000).refine(value => value.split(' ').every(token => integrityToken.test(token)), 'Invalid registry integrity digest');
const hasStrongIntegrity = (value: string | null): boolean => value !== null && value.split(' ').some(token => /^sha(?:256|384|512)-/u.test(token));
const scopeSchema = z.object({
  projectScope: z.enum(['listed', 'any-authorized', 'unbound']),
  targetScope: z.enum(['listed', 'any']),
  principalId: id, projectIds: z.array(id).max(100).refine(unique),
  targetProfileIds: z.array(id).max(100).refine(unique),
  visibility: z.enum(['private', 'finished-application', 'reusable-distribution']),
}).strict();
export const operationRightSchema = z.object({
  operation: z.enum(SOURCE_OPERATIONS), decision: z.enum(['allowed', 'blocked', 'unknown']), scope: scopeSchema,
  evidenceRefs, obligations: z.array(z.object({ id, kind: z.enum(['notice', 'attribution', 'principal', 'target', 'other']), description: text }).strict()).max(100),
  reason: text.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.scope.projectScope === 'listed') !== (value.scope.projectIds.length > 0)) ctx.addIssue({ code: 'custom', path: ['scope', 'projectIds'], message: 'Listed projects require IDs; other project scopes require an empty list' });
  if ((value.scope.targetScope === 'listed') !== (value.scope.targetProfileIds.length > 0)) ctx.addIssue({ code: 'custom', path: ['scope', 'targetProfileIds'], message: 'Listed targets require IDs; any-target scope requires an empty list' });
  if (value.scope.projectScope === 'unbound' && ['incorporate-project', 'reuse-private-project', 'export-application'].includes(value.operation)) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'This operation requires a project-bound scope' });
  if (value.decision === 'allowed' && value.evidenceRefs.length === 0) ctx.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'Allowed rights require evidence references' });
  if (value.decision !== 'allowed' && value.reason === null) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Unknown or blocked rights require a reason' });
  if (!unique(value.obligations.map(item => item.id))) ctx.addIssue({ code: 'custom', path: ['obligations'], message: 'Duplicate obligation identity' });
  const requiredVisibility = value.operation === 'export-application' ? 'finished-application'
    : value.operation === 'redistribute-unit' ? 'reusable-distribution'
      : ['save-private-unit', 'reuse-private-project', 'private-backup', 'cache-source-content'].includes(value.operation) ? 'private' : null;
  if (requiredVisibility && value.scope.visibility !== requiredVisibility) ctx.addIssue({ code: 'custom', path: ['scope', 'visibility'], message: 'Scope does not match this operation' });
});
const sourceAdmissionSchema = z.object({
  schema: z.literal('source-admission/1'), id, revision, resourceRef: sourceRef,
  acquiredContent: z.object({ sha256, bytes: integer }).strict().nullable(),
  implementationOrigin: z.enum(['official', 'owned', 'adapted', 'unknown']),
  acquisition: z.object({ mode: acquisitionMode, connectorId: id.nullable(), evidenceRefs }).strict(),
  target: z.object({ profileId: id, nativeFormat: identityText, styleRuntime: z.enum(['css', 'tailwind4', 'styled-components', 'none', 'unknown']) }).strict(),
  closure: z.object({
    digest: sha256,
    files: z.array(z.object({ path: relativePath, sha256, bytes: integer, role: z.enum(['source', 'asset', 'style', 'notice', 'package', 'lock']) }).strict()).max(256),
    dependencies: z.array(z.object({
      name: dependencyName,
      version: dependencyVersion.nullable(), integrity: registryIntegrity.nullable(),
      contentSha256: sha256.nullable(),
    }).strict()).max(256),
    unresolved: z.array(z.object({ kind: z.enum(['source', 'dependency', 'asset', 'style', 'notice']), id, reason: text }).strict()).max(256),
  }).strict(),
  stages: z.array(z.object({
    stage: z.enum(['inventoried', 'rights-assessed', 'source-compatible', 'preview-verified', 'adoption-verified', 'rubric-passed']),
    status: z.enum(['pending', 'passed', 'failed', 'inconclusive']), sourceDigest: sha256.nullable(), evidenceRefs,
  }).strict()).max(6),
}).strict().superRefine((value, ctx) => {
  if (value.acquisition.mode === 'licensed-mcp' && (!value.acquisition.connectorId || !value.acquisition.evidenceRefs.length)) ctx.addIssue({ code: 'custom', path: ['acquisition'], message: 'Licensed acquisition requires its existing connector binding and evidence' });
  if (!unique(value.closure.files.map(file => file.path))) ctx.addIssue({ code: 'custom', path: ['closure', 'files'], message: 'Duplicate closure path' });
  const paths = new Set(value.closure.files.map(file => file.path));
  for (const path of paths) {
    const parts = path.split('/');
    for (let count = 1; count < parts.length; count++) {
      if (paths.has(parts.slice(0, count).join('/'))) ctx.addIssue({ code: 'custom', path: ['closure', 'files'], message: 'File and descendant paths overlap' });
    }
  }
  if (!unique(value.closure.dependencies.map(item => item.name))) ctx.addIssue({ code: 'custom', path: ['closure', 'dependencies'], message: 'Duplicate dependency identity' });
  if (!unique(value.closure.unresolved.map(item => JSON.stringify([item.kind, item.id])))) ctx.addIssue({ code: 'custom', path: ['closure', 'unresolved'], message: 'Duplicate unresolved input' });
  if (!unique(value.stages.map(item => item.stage))) ctx.addIssue({ code: 'custom', path: ['stages'], message: 'Duplicate admission stage' });
  for (const [index, item] of value.stages.entries()) {
    if (item.status === 'passed' && (!value.acquiredContent || item.sourceDigest !== value.acquiredContent.sha256 || item.evidenceRefs.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['stages', index], message: 'Passed evidence requires the current acquired digest and evidence references' });
    }
    if (item.status === 'passed' && ['source-compatible', 'preview-verified', 'adoption-verified'].includes(item.stage)
      && (value.closure.files.length === 0 || value.closure.unresolved.length > 0 || value.closure.dependencies.some(dependency =>
        dependency.version === null || (dependency.contentSha256 === null && !hasStrongIntegrity(dependency.integrity))))) {
      ctx.addIssue({ code: 'custom', path: ['stages', index], message: 'Passed technical evidence requires complete source and dependency inputs' });
    }
  }
});
const authorityScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source-management'), principalId: id }).strict(),
  z.object({ kind: z.literal('project'), principalId: id, projectId: id }).strict(),
]);
/** A citation locator, never network permission or proof that DNS resolves publicly. */
const termsCitationUrl = z.string().max(2000)
  .regex(/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s?#\\]*)?$/u, 'Expected an HTTPS terms citation without credentials or query')
  .refine(value => {
    const port = value.match(/^https:\/\/[^/:]+:(\d+)/u)?.[1];
    return !/[\p{Cc}\p{Cf}]/u.test(value) && (port === undefined || /^[1-9]\d*$/u.test(port) && Number(port) <= 65535);
  }, 'Invalid citation control character or port');
/** Rights bases. `owner-accepted-private-use` records the owner's dated decision to use a source privately without waiting on a licence answer. */
export const RIGHTS_BASES = ['published-license', 'specific-grant', 'owned-source-evidence', 'owner-accepted-private-use'] as const;
/** The dated owner decision an `owner-accepted-private-use` assessment cites. */
const ownerDecisionSchema = z.object({
  decidedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a calendar date (YYYY-MM-DD)'), decidedBy: id, citation: text,
}).strict();
const rightsAssessmentSchema = z.object({
  schema: z.literal('rights-assessment/1'), id, revision,
  source: z.object({ ref: sourceRef, contentSha256: sha256, closureDigest: sha256, fileScope: z.enum(['all', 'listed']), filePaths: z.array(relativePath).max(256).refine(unique) }).strict(),
  terms: z.object({ version: identityText, sha256, canonicalUrl: termsCitationUrl.nullable(), clauseRefs: z.array(identityText).min(1).max(100).refine(unique) }).strict().nullable(),
  acquisitionMode, evaluator: z.object({ id, role: z.enum(['source-curator', 'project-owner', 'rights-reviewer']), basis: z.enum(RIGHTS_BASES) }).strict(),
  ownerDecision: ownerDecisionSchema.optional(),
  authorityScope: authorityScopeSchema, evidenceRefs: evidenceRefs.refine(values => values.length > 0, 'Assessment requires evidence'),
  evaluatedAt: z.string().datetime(), operationRights: z.array(operationRightSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const ownerAccepted = value.evaluator.basis === 'owner-accepted-private-use';
  if (!ownerAccepted && value.evaluator.basis !== 'owned-source-evidence' && value.terms === null) ctx.addIssue({ code: 'custom', path: ['terms'], message: 'Published or specific grants require exact terms evidence' });
  if (ownerAccepted !== (value.ownerDecision !== undefined)) ctx.addIssue({ code: 'custom', path: ['ownerDecision'], message: 'An owner decision is cited exactly when the basis is owner-accepted private use' });
  if (ownerAccepted && value.authorityScope.kind !== 'source-management') ctx.addIssue({ code: 'custom', path: ['authorityScope'], message: 'Only the owner-authorized source manager records owner-accepted private use' });
  if (ownerAccepted && value.operationRights.some(right => right.decision === 'allowed' && (right.operation === 'redistribute-unit' || right.scope.visibility === 'reusable-distribution'))) {
    ctx.addIssue({ code: 'custom', path: ['operationRights'], message: 'Owner-accepted private use cannot allow public redistribution' });
  }
  if ((value.evaluator.role === 'project-owner') !== (value.authorityScope.kind === 'project')) ctx.addIssue({ code: 'custom', path: ['authorityScope'], message: 'Evaluator role and authority scope must match' });
  if ((value.source.fileScope === 'listed') !== (value.source.filePaths.length > 0)) ctx.addIssue({ code: 'custom', path: ['source', 'filePaths'], message: 'File scope must distinguish all files from a nonempty selected list' });
  for (const [index, right] of value.operationRights.entries()) {
    if (right.scope.principalId !== value.authorityScope.principalId) ctx.addIssue({ code: 'custom', path: ['operationRights', index, 'scope'], message: 'Operation principal must match assessment authority' });
    if (value.authorityScope.kind === 'project' && (right.scope.projectScope !== 'listed' || right.scope.projectIds.length !== 1 || right.scope.projectIds[0] !== value.authorityScope.projectId)) {
      ctx.addIssue({ code: 'custom', path: ['operationRights', index, 'scope'], message: 'Project-owner assessment cannot widen project scope' });
    }
    if (right.evidenceRefs.some(ref => !value.evidenceRefs.includes(ref))) ctx.addIssue({ code: 'custom', path: ['operationRights', index, 'evidenceRefs'], message: 'Operation evidence must be in the assessment evidence set' });
  }
  // Restrictions can overlap allowances. Consumers must intersect all applicable
  // records, giving blocked/unknown precedence; visibility never grants an operation.
  // Unbound matches only a request without a project. Any-authorized still needs
  // current server project authority; any-target is explicit, never an empty-list guess.
  if (!unique(value.operationRights.map(right => JSON.stringify([
    right.operation, right.scope.principalId, right.scope.projectScope,
    [...right.scope.projectIds].sort(), right.scope.targetScope, [...right.scope.targetProfileIds].sort(), right.scope.visibility,
  ])))) ctx.addIssue({ code: 'custom', path: ['operationRights'], message: 'Duplicate operation scope' });
});

export type SourceAdmission = z.infer<typeof sourceAdmissionSchema>;
export type OperationRight = z.infer<typeof operationRightSchema>;
export type RightsAssessment = z.infer<typeof rightsAssessmentSchema>;
export function parseSourceAdmission(input: unknown): SourceAdmission { return sourceAdmissionSchema.parse(input); }
export function parseRightsAssessment(input: unknown): RightsAssessment { return rightsAssessmentSchema.parse(input); }
