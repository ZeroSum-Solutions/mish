import { parseRightsAssessment, type OperationRight, type RightsAssessment } from '@mish/contracts';
import { assertOwnerAcceptedPrincipal, LOCAL_OWNER_PRINCIPAL } from './source-records.js';

/**
 * AC-R18.6 / G38: the Aceternity RightsAssessment.
 *
 * Devin's owner decision of 2026-10-09 (relayed by the Mishh Orchestrator session to the
 * captain): the repository is private, licences
 * are ignored for now and nothing waits on a licence answer. Every private operation is
 * therefore admitted under the `owner-accepted-private-use` basis with that dated
 * citation. Public redistribution is outside private use and stays blocked. The
 * licence, terms and pricing-FAQ clauses retrieved on 2026-10-09 stay attached as
 * metadata (exact licence digest, clause IDs), so a later licence review starts from
 * them. The grant runs to the local owner principal only. New item bytes or a repaired
 * copy stop matching and need a new assessment. Pro material is out of scope and
 * nothing was purchased. Quotes, retrieval digests and the decision: the evidence file.
 */
export const ACETERNITY_RIGHTS_EVIDENCE = 'docs/plans/2026-10-02-design-workbench/evidence/aceternity/free-tier-rights-assessment.json';
/** Evidence ID of the dated owner decision, recorded in the evidence file. */
export const OWNER_DECISION_EVIDENCE = 'owner-decision-2026-10-09:private-use';
export const ACETERNITY_OWNER_DECISION = Object.freeze({
  decidedAt: '2026-10-09', decidedBy: 'owner',
  citation: 'Devin\'s owner decision of 2026-10-09, relayed by the Mishh Orchestrator session to the captain: the repository is private, licences are ignored for now and nothing may wait on a licence answer; Aceternity operations are admitted for private use.',
});

const LICENCE_SHA256 = 'd0f63e88cade96e1619944762903c465813f23da0a851de088e85c3e33276088';
const PRINCIPAL = LOCAL_OWNER_PRINCIPAL;
const RETRIEVAL = (page: string) => `aceternity-terms-2026-10-09:${page}`;
const PAGES = { licence: RETRIEVAL('licence'), terms: RETRIEVAL('terms'), pricing: RETRIEVAL('pricing') } as const;

type Scope = OperationRight['scope'];
const scope = (projectScope: Scope['projectScope'], visibility: Scope['visibility']): Scope => ({
  projectScope, targetScope: 'any', principalId: PRINCIPAL, projectIds: [], targetProfileIds: [], visibility,
});
const OWNER = 'Admitted for private use under owner decision 2026-10-09 (private repository; licences ignored for now).';
const allowed = (operation: OperationRight['operation'], projectScope: Scope['projectScope'], visibility: Scope['visibility'], metadata: string): OperationRight => ({
  operation, decision: 'allowed', scope: scope(projectScope, visibility), evidenceRefs: [OWNER_DECISION_EVIDENCE], obligations: [],
  reason: `${OWNER} Published-licence metadata: ${metadata}`,
});

function operationRights(): OperationRight[] {
  return [
    allowed('host-preview', 'unbound', 'private', 'silent on builder preview hosting (licence#permitted.create-end-products); site terms restrict copying (terms#you-must-not).'),
    allowed('incorporate-project', 'any-authorized', 'private', 'end products for yourself or clients (licence#permitted.create-end-products), modification (licence#permitted.modification), free tier usable in commercial projects (pricing#faq.is-aceternity-ui-free).'),
    allowed('export-application', 'any-authorized', 'finished-application', 'end products may be distributed (licence#permitted.distribution; licence#sample-end-products; pricing#faq.commercial-projects), not as a template product (licence#prohibited.template-creation).'),
    {
      operation: 'redistribute-unit', decision: 'blocked', scope: scope('unbound', 'reusable-distribution'), evidenceRefs: [OWNER_DECISION_EVIDENCE], obligations: [],
      reason: 'Public redistribution is outside the private-use owner decision 2026-10-09. Published-licence metadata: no re-distribution of source files (licence#prohibited.re-distribution), no marketplace distribution (licence#prohibited.marketplace), no competing component library (pricing#faq.commercial-projects), site terms forbid redistribution (terms#you-must-not).',
    },
    allowed('save-private-unit', 'unbound', 'private', 'multi-use in projects (licence#permitted.multi-use); site terms restrict copying (terms#you-must-not).'),
    allowed('reuse-private-project', 'any-authorized', 'private', 'multi-use in various projects (licence#permitted.multi-use; licence#permitted.create-end-products).'),
    allowed('private-backup', 'unbound', 'private', 'licence grant to use the Item (licence#license-grant); site terms restrict copying (terms#you-must-not).'),
    allowed('cache-source-content', 'unbound', 'private', 'not a named use; site terms restrict copying (terms#you-must-not).'),
    allowed('derive-from-reference', 'unbound', 'private', 'modification of the Item (licence#permitted.modification); AI generation is not addressed; the paid plan advertises AI-ready prompts (pricing#paid.ai-ready-prompts).'),
  ];
}

interface AssessedItem { itemId: string; registrySha256: string; componentSha256: string }
const ITEMS: readonly AssessedItem[] = [
  { itemId: 'bento-grid', registrySha256: '9d988ea63b4209b65e386aa26dba37005d67667e122184c8905b6d31eda32482', componentSha256: 'a3cdb12c2f3183385859da768cd5a66a4024dd017230fb278b8f2d2acf85c730' },
  { itemId: 'card-hover-effect', registrySha256: '6f9451d50fdce14344c0fbab29f8f47ac29bd11d11dc11fb95f3fc94bce271af', componentSha256: 'af736705935d3cda78f5ec03d23c808ed52e881902f0d03180b194a9cf67c309' },
  { itemId: 'tabs', registrySha256: 'a0f2d1eb503190ec2e53ee5887a9b33d7c94e3f6d6548f07afd0a79ef0effcaa', componentSha256: '0d34660aeb2d49d912b1216343bf7a86edf6dc2e0eb097ad53c30068e6950a71' },
];
const SHARED_CLAUSES = [
  'licence#overview', 'licence#license-grant', 'licence#permitted.create-end-products', 'licence#permitted.distribution',
  'licence#permitted.modification', 'licence#permitted.multi-use', 'licence#prohibited.re-distribution', 'licence#prohibited.marketplace',
  'licence#prohibited.template-creation', 'licence#sample-end-products', 'licence#additional.ownership',
  'terms#license', 'terms#you-must-not', 'pricing#faq.is-aceternity-ui-free', 'pricing#faq.commercial-projects', 'pricing#paid.ai-ready-prompts',
];

/** Parsed at load: a malformed record fails the daemon start, never a request. */
export const ACETERNITY_FREE_RIGHTS_ASSESSMENTS: readonly RightsAssessment[] = Object.freeze(ITEMS.map(item => assertOwnerAcceptedPrincipal(parseRightsAssessment({
  schema: 'rights-assessment/1', id: `aceternity-free-rights:${item.itemId}`, revision: 1,
  source: {
    ref: { sourceType: 'reference', sourceId: 'aceternity', itemId: item.itemId, revisionOrDigest: `sha256:${item.registrySha256}` },
    // No SourceAdmission closure exists yet; the registry document is the closure as delivered.
    // An admission whose computed closure digest differs will not match this record.
    contentSha256: item.componentSha256, closureDigest: item.registrySha256, fileScope: 'all', filePaths: [],
  },
  terms: {
    version: 'Aceternity License at https://ui.aceternity.com/licence (undated; retrieved 2026-10-09T01:27:55Z)', sha256: LICENCE_SHA256,
    canonicalUrl: 'https://ui.aceternity.com/licence', clauseRefs: [...SHARED_CLAUSES, `component#${item.itemId}.ld-json-license`],
  },
  acquisitionMode: 'project-fetch',
  evaluator: { id: 'owner-source-curator.r18-aceternity-rights', role: 'source-curator', basis: 'owner-accepted-private-use' },
  ownerDecision: { ...ACETERNITY_OWNER_DECISION },
  authorityScope: { kind: 'source-management', principalId: PRINCIPAL },
  evidenceRefs: [OWNER_DECISION_EVIDENCE, PAGES.licence, PAGES.terms, PAGES.pricing, RETRIEVAL(`component-${item.itemId}`)],
  evaluatedAt: '2026-10-09T02:30:00.000Z',
  operationRights: operationRights(),
}))));

export function aceternityAssessmentFor(itemId: string): RightsAssessment {
  const record = ACETERNITY_FREE_RIGHTS_ASSESSMENTS.find(entry => entry.source.ref.itemId === itemId);
  if (!record) throw new Error(`No Aceternity RightsAssessment for ${itemId}`);
  return record;
}

/** The operations an Aceternity catalogue apply needs. */
export const ACETERNITY_APPLY_OPERATIONS: readonly OperationRight['operation'][] = ['host-preview', 'incorporate-project', 'save-private-unit', 'reuse-private-project'];
/** True when every operation apply needs is allowed. */
export const aceternityApplyAllowed = (rights: readonly Pick<OperationRight, 'operation' | 'decision'>[]): boolean =>
  ACETERNITY_APPLY_OPERATIONS.every(operation => rights.some(right => right.operation === operation && right.decision === 'allowed'));
/** Reusing a saved unit in another private project: reuse itself, and the incorporation it implies. */
export const ACETERNITY_REUSE_OPERATIONS: readonly OperationRight['operation'][] = ['reuse-private-project', 'incorporate-project'];
export const aceternityReuseAllowed = (rights: readonly Pick<OperationRight, 'operation' | 'decision'>[]): boolean =>
  ACETERNITY_REUSE_OPERATIONS.every(operation => rights.some(right => right.operation === operation && right.decision === 'allowed'));
