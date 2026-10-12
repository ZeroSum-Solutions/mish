import { createHash } from 'node:crypto';
import {
  SOURCE_OPERATIONS, SUPPORTED_ADOPTION_TARGETS,
  type NativeFormatRefusalDetails, type OperationRightsRefusalDetails, type ResourceCandidate, type ResourceRef, type ResourceSourceIdentity,
} from '@mish/contracts';
import { ACETERNITY_APPLY_OPERATIONS, ACETERNITY_RIGHTS_EVIDENCE, aceternityApplyAllowed, aceternityAssessmentFor } from './aceternity-rights.js';
import { resourceRefKey } from './context-ranking.js';
import type { ResourceSourceAdapter } from './resources.js';

/**
 * AC-R18.6–AC-R18.8 frozen source entries. Every value comes from a committed
 * evaluation receipt (cited per source); nothing here was fetched at runtime.
 *
 * - Candidates 44 svelte-animations, 45 cnblocks and 46 animations are reference
 *   links: native Svelte material with no HTML/React target, need deferred (G24).
 *   cnblocks identity is collection-scoped (`normal|mist|veil/<item>`) and its
 *   revision is the pinned commit plus that collection registry's SHA-256.
 * - Aceternity is a priority `project-fetch` source through the shadcn registry
 *   route; its operation rights come from its RightsAssessment (G38,
 *   aceternity-rights.ts): owner-accepted private use since 2026-10-09. Apply runs
 *   through the catalogue (aceternity-material.ts), which fetches and verifies the
 *   registry bytes and supplies the pinned shadcn `cn` helper when a project lacks
 *   it. Repairs and acceptance receipts are still pending.
 *
 * Only inspected items are indexed; the status line states how many registry
 * entries remain unindexed rather than implying a complete roster.
 */
const WB = 'docs/plans/2026-10-02-design-workbench';
const TRIO_EVALUATION = 'docs/plans/2026-10-03-cnblocks-source-trio-evaluation.md';
const SVELTE_EVALUATION = 'docs/plans/2026-10-03-svelte-animations-evaluation.md';
const TRIO_INTEGRITY = `${WB}/evidence/cnblocks-trio/carry-forward-integrity.json`;
const CNBLOCKS_MANIFEST = `${WB}/evidence/cnblocks-trio/source-manifest.json`;
const CNBLOCKS_REGISTRY = `${WB}/evidence/cnblocks-trio/registry-and-mcp-observations.json`;
const ACETERNITY_EVALUATION = 'docs/plans/2026-10-03-aceternity-evaluation.md';
const ACETERNITY_MANIFEST = `${WB}/evidence/aceternity/registry-manifest.json`;

type TrioSourceId = 'svelte-animations' | 'cnblocks' | 'animations';
interface TrioItem { itemId: string; title: string; path: string; sha256: string; category: ResourceCandidate['category']; successor?: string; collection?: 'normal' | 'mist' | 'veil' }
interface TrioSource { sourceId: TrioSourceId; candidate: string; repository: string; commit: string; summary: string; evidenceRefs: string[]; items: TrioItem[]; statusReason: string }

const NEED_REASON = 'Reference-only under G24: no named project need, no Svelte target scope and no measured benefit over existing HTML/React sources; future admission needs per-item rights, build and adoption proof.';
const TARGET_REASON = 'Native Svelte 5 source; accepted targets are HTML/CSS/JS and React (G02). No Svelte target adapter exists and relabeling a rendered page is not editable source.';
const NEXT_GATE = 'G24: named project need, explicitly scoped Svelte target support, then per-item provenance/rights, build and UI/API/od adoption proof';

const CNBLOCKS_REGISTRY_SHA = {
  normal: 'e6d047e76284ce4a8a35b05729d3a8e696e02f6b788526fa67a40a67a86792b0',
  mist: 'b14f12d53b3bdddb464c9b60dc63d8892842022fa3d47055588e28271e38278c',
  veil: '4c152d5298fe2b9992983fcb484bd323c1f9b0b9955c1e0d96cac6b8a2f050b7',
} as const;
const CNBLOCKS_REGISTRY_FILE = { normal: 'registry.json', mist: 'mist-registry.json', veil: 'veil-registry.json' } as const;

export const TRIO_SOURCES: readonly TrioSource[] = Object.freeze([
  {
    sourceId: 'svelte-animations', candidate: '44', repository: 'SikandarJODD/svelte-animations', commit: '74a6e2c0973c284005a69a013c28c7259842e34f',
    summary: 'Older Svelte 4 effect translations; the author links candidate 46 as its successor.',
    evidenceRefs: [SVELTE_EVALUATION, TRIO_INTEGRITY],
    statusReason: 'Reference-only (candidate 44): 5 inspected component files indexed; the remaining repository is not indexed.',
    items: [
      { itemId: 'aceternity-ui/bento-grid', title: 'Bento Grid (Aceternity translation)', path: 'src/lib/aceternity-ui/components/BentoGrid/BentoGrid.svelte', sha256: '8ed636a679b925e0253988c2e232932230a21241d193ca107fb75f4230aed456', category: 'layout' },
      { itemId: 'aceternity-ui/card-hover-effect', title: 'Card Hover Effect (Aceternity translation)', path: 'src/lib/aceternity-ui/components/card-hover-effect/CardHoverEffect.svelte', sha256: 'a7fc6973f0ef13c2dbd348e8dac31b58344a827f5c2da34065e630e220e84443', category: 'component' },
      { itemId: 'luxe/animated-tabs', title: 'Animated Tabs (Luxe translation)', path: 'src/lib/luxe/animatedTabs/AnimatedTabs.svelte', sha256: '94916970ce86fc9436a0ce5dededfcef6cfb97b4e812bdb7ea043cf3f47cae2f', category: 'component', successor: 'luxe/animated-tabs' },
      { itemId: 'luxe/card-hover-effect', title: 'Card Hover Effect (Luxe translation)', path: 'src/lib/luxe/cards/CardHoverEffect.svelte', sha256: '660cca55083ddd9627f61c381faf1824505e0b8baac00a59a88da6c61a68c2f0', category: 'component' },
      { itemId: 'magicui/bento-grid', title: 'Bento Grid (Magic UI translation)', path: 'src/lib/magicui/components/BentoGrid/BentoGrid.svelte', sha256: 'e5c75bb5a5d3547a44ee6e3469eae641061f0c95597a51c61f6d09a3cf42da28', category: 'layout', successor: 'magic/bento-grid' },
    ],
  },
  {
    sourceId: 'cnblocks', candidate: '45', repository: 'SikandarJODD/cnblocks', commit: '81c7209fc9696bd7823911a4b9d076f657202ef4',
    summary: 'Svelte 5 marketing blocks in Normal, Mist and Veil collections; repeated names are distinct collection items.',
    evidenceRefs: [TRIO_EVALUATION, CNBLOCKS_MANIFEST, CNBLOCKS_REGISTRY],
    statusReason: 'Reference-only (candidate 45): 7 inspected collection items indexed of 222 registry entries (Normal 98, Mist 60, Veil 64); the rest are not indexed.',
    items: [
      { itemId: 'normal/hero-one', collection: 'normal', title: 'Hero one (Normal)', path: CNBLOCKS_REGISTRY_FILE.normal, sha256: CNBLOCKS_REGISTRY_SHA.normal, category: 'section' },
      { itemId: 'mist/hero-one', collection: 'mist', title: 'Hero one (Mist)', path: CNBLOCKS_REGISTRY_FILE.mist, sha256: CNBLOCKS_REGISTRY_SHA.mist, category: 'section' },
      { itemId: 'veil/hero-one', collection: 'veil', title: 'Hero one (Veil)', path: 'src/lib/components/veil/hero/hero-one.svelte', sha256: '5de5784f9d94c56a9f60ff6051a563ba21b948ebfe0f44f3eae286c82aed1f04', category: 'section' },
      { itemId: 'veil/contact-one', collection: 'veil', title: 'Contact one (Veil)', path: 'src/lib/components/veil/contact/contact-one.svelte', sha256: 'fe0c7b3c02526d81fafa82f9f3853a52f4b0f1dc6a3d5a1d98ece5371f1f6be4', category: 'section' },
      { itemId: 'veil/call-to-action-one', collection: 'veil', title: 'Call to action one (Veil)', path: 'src/lib/components/veil/call-to-action/call-to-action-one.svelte', sha256: '0bacc4018ee48b7cab5f845a9b66bb1169929860ca2cea45c8dcfd91e8ab34f2', category: 'section' },
      { itemId: 'veil/features-one', collection: 'veil', title: 'Features one (Veil)', path: 'src/lib/components/veil/features/features-one.svelte', sha256: '61b9764d2b010352325e01f6fb6a6cb9df50809187753c491dfd436d6b265fd4', category: 'section' },
      { itemId: 'veil/header-one', collection: 'veil', title: 'Header one (Veil)', path: 'src/lib/components/veil/header/header-one.svelte', sha256: '5082218afea16b57843ba5ef112c42db451045fb81aae8c3e99a5dca7718eb74', category: 'section' },
    ],
  },
  {
    sourceId: 'animations', candidate: '46', repository: 'SikandarJODD/animations', commit: 'c0e5d02b35caf88bb09bd72a3e9c49031e1657ea',
    summary: 'Newer Svelte 5 effects; the preferred future Svelte effects investigation over candidate 44.',
    evidenceRefs: [TRIO_EVALUATION, TRIO_INTEGRITY],
    statusReason: 'Reference-only (candidate 46): 3 inspected component files indexed; the remaining repository is not indexed.',
    items: [
      { itemId: 'luxe/animated-tabs', title: 'Animated Tabs (Luxe, Svelte 5)', path: 'src/lib/components/luxe/animated-tabs/animated-tabs.svelte', sha256: '912142fb4a12cea121ade4cd48fcf6b239395143827a40581509d998cf32d135', category: 'component' },
      { itemId: 'magic/bento-grid', title: 'Bento Grid (Magic, Svelte 5)', path: 'src/lib/components/magic/bento-grid/bento-grid.svelte', sha256: '691ab05b772d0bc0d74b565eb73a3a5ab0dd80d3ed9b107932902d333f7f6905', category: 'layout' },
      { itemId: 'magic/marquee', title: 'Marquee (Magic, Svelte 5)', path: 'src/lib/components/magic/marquee/marquee.svelte', sha256: '76a9c0a0e874d7f3f370d0475bb7b8661313987d53f1c88aa1585cff56aed40d', category: 'component' },
    ],
  },
]);

const trioRef = (source: TrioSource, item: TrioItem): ResourceRef => ({
  sourceType: 'reference', sourceId: source.sourceId, itemId: item.itemId,
  revisionOrDigest: `${source.commit}:sha256:${item.collection ? CNBLOCKS_REGISTRY_SHA[item.collection] : item.sha256}`,
});

function trioCandidate(source: TrioSource, item: TrioItem): ResourceCandidate {
  const repositoryUrl = `https://github.com/${source.repository}`;
  const identity: ResourceSourceIdentity = {
    repositoryUrl, commit: source.commit, registryLocator: null, contentSha256: item.sha256, acquisitionMode: 'reference-link',
    documentedConnector: source.sourceId === 'cnblocks' ? { name: 'jsrepo MCP (generic, documented by cnblocks)', state: 'documented-unexecuted', evidenceRef: CNBLOCKS_REGISTRY } : null,
    operationRights: [], nextGate: NEXT_GATE, evidenceRefs: source.evidenceRefs,
  };
  const successor = item.successor ? TRIO_SOURCES.find(entry => entry.sourceId === 'animations')!.items.find(entry => entry.itemId === item.successor) : undefined;
  return {
    ref: trioRef(source, item), title: item.title, category: item.category, readiness: 'reference-only',
    compatibility: { nativeFormat: 'svelte', targets: [], state: 'unsupported', reason: TARGET_REASON },
    rightsStatus: 'unknown',
    fitReasons: [`Candidate ${source.candidate}: ${source.summary}`, 'Root licence MIT; per-file upstream provenance is not assessed.'],
    // No local preview of native Svelte material; the pinned source file is cited in fitReasons.
    previewCapability: { available: false, kind: 'none', reason: `Reference-only native Svelte source; open ${repositoryUrl}/blob/${source.commit}/${item.path}` },
    adoptionCapability: { available: false, reason: 'unsupported-capability' },
    sourceAttribution: { title: source.repository, url: repositoryUrl },
    implementationOrigin: 'reference',
    operationGrants: [], admissionStage: 'reference-only', needDecision: 'reference-only', needReason: NEED_REASON,
    ...(successor ? { relatedRefs: [{ ref: trioRef(TRIO_SOURCES.find(entry => entry.sourceId === 'animations')!, successor), relation: 'successor-candidate' }] } : {}),
    sourceIdentity: identity,
  };
}

/* ----------------------------------- Aceternity ----------------------------------- */

interface AceternityItem { itemId: string; title: string; registrySha256: string; componentSha256: string; dependencies: string[]; category: ResourceCandidate['category']; repair: string | null }
export const ACETERNITY_ITEMS: readonly AceternityItem[] = Object.freeze([
  { itemId: 'bento-grid', title: 'Bento Grid', registrySha256: '9d988ea63b4209b65e386aa26dba37005d67667e122184c8905b6d31eda32482', componentSha256: 'a3cdb12c2f3183385859da768cd5a66a4024dd017230fb278b8f2d2acf85c730', dependencies: ['@tabler/icons-react'], category: 'layout', repair: null },
  { itemId: 'card-hover-effect', title: 'Card Hover Effect', registrySha256: '6f9451d50fdce14344c0fbab29f8f47ac29bd11d11dc11fb95f3fc94bce271af', componentSha256: 'af736705935d3cda78f5ec03d23c808ed52e881902f0d03180b194a9cf67c309', dependencies: ['motion'], category: 'component', repair: 'Keyboard focus has no matching hover decoration; constant layout ID needs instance scoping and a reduced-motion fallback.' },
  { itemId: 'tabs', title: 'Animated Tabs', registrySha256: 'a0f2d1eb503190ec2e53ee5887a9b33d7c94e3f6d6548f07afd0a79ef0effcaa', componentSha256: '0d34660aeb2d49d912b1216343bf7a86edf6dc2e0eb097ad53c30068e6950a71', dependencies: ['@radix-ui/react-tabs'], category: 'component', repair: 'No tablist/tab/tabpanel roles, arrow keys do not move selection, empty data crashes or leaves stale panels, and transforms continue under reduced motion.' },
]);
/** Operation rights as recorded by the item's RightsAssessment; nothing here widens them. */
const aceternityRights = (item: AceternityItem) => aceternityAssessmentFor(item.itemId).operationRights.map(({ operation, decision, reason }) => ({ operation, decision, reason }));
const aceternityAssessmentSummary = (item: AceternityItem) => {
  const record = aceternityAssessmentFor(item.itemId);
  return {
    id: record.id, revision: record.revision, evaluatorRole: record.evaluator.role, basis: record.evaluator.basis,
    termsUrl: record.terms?.canonicalUrl ?? null, termsSha256: record.terms?.sha256 ?? null, clauseRefs: [...(record.terms?.clauseRefs ?? [])], evaluatedAt: record.evaluatedAt,
    ...(record.ownerDecision ? { ownerDecision: { ...record.ownerDecision } } : {}),
  };
};
const LEGACY_GRANT = { allowed: 'permitted', blocked: 'blocked', unknown: 'unknown' } as const;
const legacyGrant = (item: AceternityItem, operation: (typeof SOURCE_OPERATIONS)[number], legacy: ResourceCandidate['operationGrants'][number]['operation']) => {
  const right = aceternityRights(item).find(entry => entry.operation === operation)!;
  return { operation: legacy, state: LEGACY_GRANT[right.decision], reason: right.reason };
};
/** Apply needs these; the refusal names the ones that are still not allowed. */
/** True when the item's assessment allows every operation apply needs. */
const applyAllowed = (item: AceternityItem) => aceternityApplyAllowed(aceternityRights(item));
const aceternityRef = (item: AceternityItem): ResourceRef => ({ sourceType: 'reference', sourceId: 'aceternity', itemId: item.itemId, revisionOrDigest: `sha256:${item.registrySha256}` });

function aceternityCandidate(item: AceternityItem): ResourceCandidate {
  const locator = `https://ui.aceternity.com/registry/${item.itemId}.json`;
  return {
    ref: aceternityRef(item), title: item.title, category: item.category, readiness: item.repair ? 'needs-repair' : 'unverified',
    compatibility: { nativeFormat: 'react-tsx', targets: ['react'], state: 'unverified', reason: 'react-source/v1 P3 adoption, helper/alias closure (cn, clsx, tailwind-merge) and TypeScript typecheck are pending (G38).' },
    rightsStatus: applyAllowed(item) ? 'permitted' : 'restricted',
    fitReasons: [`Declared dependencies: ${item.dependencies.join(', ')}`, ...(item.repair ? [`Repair before admission: ${item.repair}`] : [])],
    previewCapability: { available: false, kind: 'none', reason: 'No local preview harness for registry React source yet; open the source page instead' },
    adoptionCapability: { available: false, reason: applyAllowed(item) ? 'acceptance-receipt-pending' : 'operation-rights-unknown' },
    sourceAttribution: { title: 'Aceternity UI', url: `https://ui.aceternity.com/components/${item.itemId}` },
    implementationOrigin: 'upstream-source',
    operationGrants: [
      legacyGrant(item, 'host-preview', 'host-preview'),
      legacyGrant(item, 'incorporate-project', 'incorporation'),
      legacyGrant(item, 'redistribute-unit', 'redistribution'),
    ],
    admissionStage: item.repair ? 'needs-repair' : 'discovered',
    needDecision: 'justified', needReason: 'Owner-requested priority source (Oct3, G38); per-item project fit and benefit are still recorded at admission.',
    sourceIdentity: {
      repositoryUrl: 'https://ui.aceternity.com', commit: null, registryLocator: locator, contentSha256: item.componentSha256,
      acquisitionMode: 'project-fetch', documentedConnector: null, operationRights: aceternityRights(item),
      nextGate: 'G38: repairs (tabs, card-hover-effect), react-source/v1 typecheck and react-unit/v1 second-project reuse receipts',
      evidenceRefs: [ACETERNITY_EVALUATION, ACETERNITY_MANIFEST, ACETERNITY_RIGHTS_EVIDENCE],
      rightsAssessment: aceternityAssessmentSummary(item),
    },
  };
}

/* ------------------------------------- adapters ------------------------------------- */

const listingDigest = (items: readonly ResourceCandidate[]) => createHash('sha256').update(JSON.stringify(items.map(item => resourceRefKey(item.ref)).sort())).digest('hex');
function staticAdapter(sourceId: ResourceRef['sourceId'], items: readonly ResourceCandidate[], reason: string): ResourceSourceAdapter {
  return { sourceId, list: async () => ({ items, status: { sourceId, state: 'searched', reason, itemCount: items.length, listingDigest: listingDigest(items) } }) };
}

/** Frozen reference/project-fetch sources. No network, no bytes beyond committed metadata. */
export function createReferenceResourceSources(): ResourceSourceAdapter[] {
  return [
    ...TRIO_SOURCES.map(source => staticAdapter(source.sourceId, source.items.map(item => trioCandidate(source, item)), source.statusReason)),
    staticAdapter('aceternity', ACETERNITY_ITEMS.map(aceternityCandidate), 'Project-fetch through the shadcn registry route: 3 evaluated free items indexed; private use admitted by owner decision 2026-10-09 (G38); nothing purchased or mirrored.'),
  ];
}

/* ------------------------------- adoption refusal gate ------------------------------- */

export type ReferenceAdoptionRefusal =
  | { status: 409; reason: 'resource-ref-stale'; message: string; details: { currentRefKey: string } }
  | { status: 404; reason: 'resource-ref-unknown'; message: string; details: Record<string, never> }
  | { status: 422; reason: 'unsupported-capability'; message: string; details: NativeFormatRefusalDetails }
  | { status: 422; reason: 'operation-rights-unknown'; message: string; details: OperationRightsRefusalDetails };

/**
 * The plan/apply gate for these sources, run after input parsing and project authority:
 * unknown → 404, stale revision → 409, then target format (native Svelte → 422
 * unsupported-capability with the need decision) before rights (Aceternity → 422
 * operation-rights-unknown only while its assessment leaves an apply operation not
 * allowed). Null means the ref is not one of these sources, or that it may proceed to
 * the catalogue preparer, which fetches and verifies the bytes.
 */
export function referenceAdoptionRefusal(ref: ResourceRef): ReferenceAdoptionRefusal | null {
  const trio = TRIO_SOURCES.find(source => source.sourceId === ref.sourceId);
  const aceternity = ref.sourceId === 'aceternity';
  if (!trio && !aceternity) return null;
  const aceternityItem = aceternity ? ACETERNITY_ITEMS.find(item => item.itemId === ref.itemId) : undefined;
  const current = trio
    ? trio.items.filter(item => item.itemId === ref.itemId).map(item => trioRef(trio, item))[0]
    : aceternityItem && aceternityRef(aceternityItem);
  if (!current || current.sourceType !== ref.sourceType) return { status: 404, reason: 'resource-ref-unknown', message: 'Resource is unavailable or unknown; search again', details: {} };
  if (current.revisionOrDigest !== ref.revisionOrDigest) return { status: 409, reason: 'resource-ref-stale', message: 'The source changed since it was inspected; inspect the current revision', details: { currentRefKey: resourceRefKey(current) } };
  if (trio) {
    return {
      status: 422, reason: 'unsupported-capability', message: 'Native Svelte material has no first-release HTML or React target; it stays an attributed reference',
      details: { kind: 'adoption', reason: 'unsupported-capability', nativeFormat: 'svelte', supportedTargets: [...SUPPORTED_ADOPTION_TARGETS], needDecision: 'reference-only', needReason: NEED_REASON, nextGate: NEXT_GATE },
    };
  }
  // `current` exists only when the item was found above.
  const missing = aceternityRights(aceternityItem!)
    .filter(right => ACETERNITY_APPLY_OPERATIONS.includes(right.operation))
    .flatMap(right => right.decision === 'allowed' ? [] : [{ operation: right.operation, decision: right.decision, reason: right.reason! }]);
  if (missing.length === 0) return null;
  return {
    status: 422, reason: 'operation-rights-unknown', message: 'The operations this apply needs are not allowed for this source yet; nothing was prepared',
    details: { kind: 'adoption', reason: 'operation-rights-unknown', nextGate: 'G38', operations: missing },
  };
}
