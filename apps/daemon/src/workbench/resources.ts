import { rankKitComponents, isPickerComponent, type ComponentTargetFacts, type ComponentProjectFacts, type ComponentKitFacts, type ComponentKitApprovalResolver } from './component-ranking.js';
import { createHash } from 'node:crypto';
import { constants, lstatSync, opendirSync, fstatSync, openSync, readSync, closeSync, type Dirent } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FontKitInventory, InstalledPluginRecord, ResourceCandidate, ResourceResult, ResourceDetailResponse, ResourceRef, ResourceRequestContext, ResourceSearchRequest, ResourceSearchResponse, ResourceSourceSnapshot, ResourceSourceStatus, ProjectDesignContextSnapshot, WorkbenchPreferencesSnapshot } from '@mish/contracts';
import { RESOURCE_SOURCE_IDS, parseResourceDetailResponse, parseResourceSearchRequest, parseResourceSearchResponse, parseProjectDesignContextSnapshot, parseWorkbenchPreferencesSnapshot } from '@mish/contracts';
import type { SectionCatalogEntry } from '@mish/contracts/api/section-catalog';
import { demoDocument, genuiCatalog } from '@mish/genui-catalog/data';
import type { CatalogEntry } from '@mish/genui-catalog';
import sectionCatalogJson from '@mish/section-catalog/catalog.json' with { type: 'json' };
import { publicCultEntry } from '../routes/sections.js';
import { sectionPreviewCapability, sectionVariantFields, type SectionPreviewRoots } from './section-previews.js';
import { createDesignSystemsResourceSource } from './resources-design-systems.js';
import { createDesignMdResourceSource } from './resources-design-md.js';
import { createBriefTokensSource, createProjectTokensSource, type WorkspaceNavigation } from './resources-tokens.js';
import type { OwnedKitListing } from './resources-user-design-systems.js';
import { renderTokenSpecimen, type TokenSpecimen } from './token-evidence.js';
import { fontConstraintReport, fontRequirementsFromContext } from '../fonts/requirements.js';
import { createReferenceResourceSources } from './reference-sources.js';
import { CONTEXT_RANKING_VERSION, rankContextualResources, selectLexicalResources, hasRankableProjectContext, CONTINUOUS_MOTION_STYLE_TAG, resourceRefKey as refKey, resourceOrderingEnvironment, literalResourceMatch } from './context-ranking.js';

export interface ResourceSourceAdapter {
  sourceId: ResourceSourceStatus['sourceId'];
  list(context: ResourceRequestContext): Promise<ResourceSourceSnapshot>;
  /** Fonts source only (AC-R11 preamble): the kit/example font inventory joined with the listed items. */
  fontKitInventory?(items: readonly ResourceCandidate[]): Promise<FontKitInventory | null>;
  /** One current listing plus the token specimen for `ref` at exactly its revision (or
   * null). previewResource runs inspect's authority and stale checks over THAT listing,
   * so the checks and the bytes served come from a single read. */
  preview?(ref: ResourceRef, context: ResourceRequestContext): Promise<{ snapshot: ResourceSourceSnapshot; specimen: TokenSpecimen | null }>;
}
export class ResourceError extends Error {
  constructor(readonly status: number, readonly code: 'resource-ref-unknown' | 'resource-ref-stale' | 'resource-cursor-stale' | 'project-forbidden', message: string, readonly nextSteps: string[] = []) { super(message); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b,'en')).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(key: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(key) || key.length > 20000) throw new Error('Invalid key');
  const bytes = Buffer.from(key, 'base64url');
  if (bytes.toString('base64url') !== key) throw new Error('Noncanonical key');
  return JSON.parse(bytes.toString('utf8'));
}
function decodeRef(key: string): ResourceRef {
  try {
    const v: unknown = decode(key);
    if (!Array.isArray(v) || v.length !== 5 || v[0] !== 1 || !v.slice(1).every(x => typeof x === 'string' && x.length)) throw new Error('Invalid ref');
    const ref = { sourceType: v[1], sourceId: v[2], itemId: v[3], revisionOrDigest: v[4] } as ResourceRef;
    if (!RESOURCE_SOURCE_IDS.includes(ref.sourceId) || !['library','plugin','section','genui','font','skill','reference'].includes(ref.sourceType) || refKey(ref) !== key) throw new Error('Invalid ref');
    return ref;
  } catch { throw new ResourceError(404, 'resource-ref-unknown', 'Resource reference is unknown or malformed', ['Search again for a current reference']); }
}
function assertContext(context: ResourceRequestContext, projectId?: string): void {
  if (!context.principalId || (projectId !== undefined && projectId !== context.projectId)) throw new ResourceError(403, 'project-forbidden', 'Project scope is not authorized');
}
function sameIdentity(a: ResourceRef, b: ResourceRef): boolean { return a.sourceType === b.sourceType && a.sourceId === b.sourceId && a.itemId === b.itemId; }
/** A frozen candidate never changes, so one successful validation and one canonical form
 * hold for its lifetime (the fonts source reuses thousands of frozen listing candidates). */
const validatedFrozen = new WeakSet<object>();
const canonicalFrozen = new WeakMap<object, string>();
function canonicalItem(item: ResourceCandidate): string {
  if (!Object.isFrozen(item)) return canonical(item);
  let value = canonicalFrozen.get(item);
  if (value === undefined) { value = canonical(item); canonicalFrozen.set(item, value); }
  return value;
}
function snapshot(sourceId: ResourceSourceStatus['sourceId'], items: readonly ResourceCandidate[]): ResourceSourceSnapshot {
  // Same digest as digest(sortedItems): an array's canonical form is its items' canonical forms joined.
  const sorted = items.map(item => [refKey(item.ref), item] as const).sort((a, b) => a[0].localeCompare(b[0], 'en'));
  const listingDigest = createHash('sha256').update(`[${sorted.map(([, item]) => canonicalItem(item)).join(',')}]`).digest('hex');
  return { items, status: { sourceId, state: 'searched', reason: null, itemCount: items.length, listingDigest } };
}
/**
 * AC-R07 preamble (Sol r07 BLOCK): the styled-components readiness check runs for every kit
 * preview that needs it, whichever source lists it. A previewable HTML resource whose declared
 * target dependencies include styled-components is a `styled-components` preview, so the Enlarge
 * host reports it ready only after the runtime has injected styles. Applied once, where every
 * source's items enter the workbench (search and inspect alike).
 */
function withPreviewAdapterClassification(item: ResourceCandidate): ResourceCandidate {
  const preview = item.previewCapability;
  if (!preview.available || preview.kind !== 'html' || preview.adapter === 'styled-components') return item;
  if (!item.targetDependencies?.some(dependency => dependency.name === 'styled-components')) return item;
  return { ...item, previewCapability: { ...preview, adapter: 'styled-components' } };
}
async function loadSources(context: ResourceRequestContext, sources: readonly ResourceSourceAdapter[]): Promise<ResourceSourceSnapshot[]> {
  // Every adapter rechecks its current authority on every call. Do not cache across principals.
  return Promise.all(sources.map(async source => {
    try {
      const result = await source.list(context);
      if (result.status.sourceId !== source.sourceId) throw new Error('Adapter identity mismatch');
      if (result.status.state === 'unavailable' || result.status.state === 'not-federated') return { ...result, items: [] };
      // One malformed item must not hide valid authorized neighbors. Keep the same
      // strict evidence and adoption checks; invalid claims are excluded, never repaired.
      const items: ResourceCandidate[] = [];
      let excluded = 0;
      for (const item of result.items) {
        try {
          if (item.ref.sourceId !== source.sourceId) throw new Error('Item source mismatch');
          // r07: classify first; an unchanged frozen candidate keeps its one-time validation (fonts perf).
          const classified = withPreviewAdapterClassification(item);
          if (!validatedFrozen.has(classified)) {
            parseResourceDetailResponse({ resource: { ...classified, refKey: refKey(classified.ref) }, sourceStatus: result.status });
            if (Object.isFrozen(classified)) validatedFrozen.add(classified);
          }
          items.push(classified);
        } catch { excluded++; }
      }
      return { items, status: { ...result.status, ...(excluded ? { state: 'degraded', reason: [result.status.reason, `invalid-resource-metadata:${excluded} excluded`].filter(Boolean).join('; ') } : {}), itemCount: items.length, listingDigest: snapshot(source.sourceId, items).status.listingDigest } };
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'status' in err && err.status === 403) throw new ResourceError(403, 'project-forbidden', 'Project scope is not authorized');
      if (err instanceof ResourceError) throw err;
      // Avoid revealing provider errors, filesystem paths or protected metadata in degraded discovery.
      return { items: [], status: { sourceId: source.sourceId, state: 'degraded', reason: 'source-list-failed', itemCount: null, listingDigest: null } };
    }
  }));
}
export interface ResourceSearchOptions {
  /** Current snapshots loaded under the existing project authority, never from request JSON. */
  projectState?: { context: ProjectDesignContextSnapshot; preferences: WorkbenchPreferencesSnapshot } | undefined;
  ranking?: { now?: () => number; budgetMs?: number };
  /** Service-owned environment override for deterministic local fixtures. */
  orderingEnvironmentDigest?: string;
  componentProjectFacts?: ComponentProjectFacts | null;
  componentTarget?: ComponentTargetFacts | null;
  activeKitId?: string | null;
  activeKitSourceId?: ResourceRef['sourceId'];
  /** Fresh V05 approval, scoped to this request. Omission means unverified. */
  kitApproval?: ComponentKitApprovalResolver;
  componentsOnly?: boolean;
}
/** Legacy saved/project selections belong to design-systems; explicit sources stay distinct. */
export function componentKitSelection(options: ResourceSearchOptions, picker?: ResourceSearchRequest['componentPicker']) {
  const saved = options.projectState?.context.context?.designSystemRef;
  const id = picker?.kitId ?? saved?.id ?? options.activeKitId ?? undefined;
  return { id, sourceId: picker?.kitId ? picker.kitSourceId ?? 'design-systems' as const : saved?.sourceId ?? options.activeKitSourceId ?? 'design-systems' as const,
    revision: picker?.kitId ? undefined : saved?.revisionOrDigest };
}
async function selectedComponentKit(items: readonly ResourceCandidate[], options: ResourceSearchOptions, picker?: ResourceSearchRequest['componentPicker']): Promise<ComponentKitFacts | null> {
  const selection = componentKitSelection(options, picker);
  const item = items.find(item => item.category === 'design-system' && item.ref.sourceId === selection.sourceId && item.ref.itemId === selection.id && (!selection.revision || item.ref.revisionOrDigest === selection.revision));
  if (!item) return null;
  return { id: item.ref.itemId, sourceId: item.ref.sourceId, revisionOrDigest: item.ref.revisionOrDigest, axes: item.kitTokenAxes ?? { color: false, radius: false, type: false }, tokens: item.kitTokenNames,
    approval: await options.kitApproval?.(item.ref) ?? 'unverified' };
}
/** Uses the same source+ID+revision selection in inspection and the real Apply hook. */
export async function readActiveComponentKit(context: ResourceRequestContext, sources: readonly ResourceSourceAdapter[], options: ResourceSearchOptions): Promise<ComponentKitFacts | null> {
  const selection = componentKitSelection(options);
  const source = sources.find(source => source.sourceId === selection.sourceId);
  const snapshot = selection.id && source ? (await loadSources(context, [source]))[0] : undefined;
  return selectedComponentKit(snapshot?.items ?? [], options);
}
export async function searchResources(request: ResourceSearchRequest, context: ResourceRequestContext, sources: readonly ResourceSourceAdapter[], options: ResourceSearchOptions = {}): Promise<ResourceSearchResponse> {
  request = parseResourceSearchRequest(request);
  assertContext(context, request.projectId);
  const state = options.projectState ? { context: parseProjectDesignContextSnapshot(options.projectState.context), preferences: parseWorkbenchPreferencesSnapshot(options.projectState.preferences) } : null;
  if (state && (!context.projectId || state.context.projectId !== context.projectId || state.preferences.projectId !== context.projectId)) throw new ResourceError(403, 'project-forbidden', 'Project scope is not authorized');
  const requested = request.useProjectContext ?? state?.preferences.effective.useProjectContext ?? true;
  const selection = request.useProjectContext === undefined ? 'saved' as const : 'request-override' as const;
  const preferenceRevision = state?.preferences.revision ?? 0;
  const observedContextRevision = state?.context.revision ?? 0;
  const savedContext = state?.context.context ?? null;
  const snapshots = await loadSources(context, sources);
  const statuses = RESOURCE_SOURCE_IDS.map(sourceId => snapshots.find(s => s.status.sourceId === sourceId)?.status ?? { sourceId, state: 'not-federated' as const, reason: 'No local adapter for this source', itemCount: null, listingDigest: null });
  const indexDigest = digest(statuses);
  const unique = new Map<string, ResourceCandidate>();
  for (const { items } of snapshots) for (const item of items) unique.set(refKey(item.ref), item);
  const cohort = [...unique.values()].filter(item => (!request.facets.category || item.category === request.facets.category) && (!request.facets.sourceIds?.length || request.facets.sourceIds.includes(item.ref.sourceId)));
  const staleCursor = () => new ResourceError(409, 'resource-cursor-stale', 'Search cursor no longer matches this query, scope or index', ['Search again without a cursor']);
  let incoming: { binding: string; offset: number; mode: 'ranked' | 'lexical' | 'timeout-lexical' } | null = null;
  if (request.cursor) {
    try {
      const cursor: unknown = decode(request.cursor);
      if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== 2 || typeof cursor[1] !== 'string' || !/^[a-f0-9]{64}$/.test(cursor[1]) || !Number.isSafeInteger(cursor[2]) || cursor[2] <= 0 || !['ranked','lexical','timeout-lexical'].includes(cursor[3])) throw new Error('Stale');
      incoming = { binding: cursor[1], offset: cursor[2] as number, mode: cursor[3] as 'ranked' | 'lexical' | 'timeout-lexical' };
    } catch { throw staleCursor(); }
  }
  let selected: ReturnType<typeof selectLexicalResources>;
  let reason: 'context-disabled' | 'no-project' | 'context-absent' | 'context-not-rankable' | 'ranking-timeout' | null;
  let resultMode: 'ranked' | 'lexical' | 'timeout-lexical' = 'lexical';
  if (!requested || !context.projectId || !savedContext) {
    reason = !requested ? 'context-disabled' : !context.projectId ? 'no-project' : 'context-absent';
    selected = selectLexicalResources(cohort, request.query);
  } else if (incoming?.mode === 'timeout-lexical' && hasRankableProjectContext(savedContext)) {
    // A later fast clock must not move page2 from lexical to ranked order.
    selected = selectLexicalResources(cohort, request.query, savedContext); reason = 'ranking-timeout'; resultMode = 'timeout-lexical';
  } else {
    const ranked = rankContextualResources(cohort, request.query, savedContext, { ...options.ranking, pageLimit: request.limit });
    selected = ranked;
    reason = !ranked.rankable ? 'context-not-rankable' : ranked.timedOut ? 'ranking-timeout' : null;
    resultMode = !ranked.rankable ? 'lexical' : ranked.timedOut ? 'timeout-lexical' : 'ranked';
  }
  let componentRanking;
  if (request.componentPicker) {
    const selection = componentKitSelection(options, request.componentPicker);
    const kitId = selection.id;
    const kit = await selectedComponentKit([...unique.values()], options, request.componentPicker);
    // Show all starts from literal matches rather than the contextual pre-filter, so explicitly
    // conflicting resources remain inspectable. Their immutable Apply gate still refuses them.
    const candidates = selected.items.filter(isPickerComponent);
    if (request.componentPicker.showAll) {
      const seen = new Set(candidates.map(item => refKey(item.ref)));
      for (const item of cohort) if (isPickerComponent(item) && !seen.has(refKey(item.ref)) && literalResourceMatch(item, request.query)) {
        candidates.push(item); seen.add(refKey(item.ref));
      }
    }
    const ranked = rankKitComponents(candidates, { kit, projectFacts: options.componentProjectFacts ?? null, target: options.componentTarget ?? null, context: savedContext, requestedKitId: kitId, requestedKitSourceId: selection.sourceId,
      showAll: request.componentPicker.showAll, useProjectContext: requested && reason !== 'ranking-timeout', mode: request.componentPicker.mode });
    // Preserve contextual colour/type placements while replacing only component
    // slots. Moving every component ahead would crowd eligible token suggestions
    // out of the first page (AC-R05.2).
    const componentQueue = [...ranked.items];
    const mixed = selected.items.flatMap(item => isPickerComponent(item) ? componentQueue.length ? [componentQueue.shift()!] : [] : [item]);
    selected = { ...selected, items: options.componentsOnly ? ranked.items : [...mixed, ...componentQueue] };
    componentRanking = { version: 'kit-components/1' as const, kitId: kitId ?? null, kitSourceId: selection.sourceId, kitRevisionOrDigest: kit?.revisionOrDigest ?? null,
      showAll: request.componentPicker.showAll, hidden: ranked.hidden, reason: ranked.reason };
  }
  const applied = resultMode === 'ranked';
  const binding = digest({ query: request.query, componentPicker: request.componentPicker, componentRanking, componentFits: request.componentPicker ? selected.items.map(item => [refKey(item.ref), item.componentFit]) : undefined, componentTarget: options.componentTarget, componentProjectFacts: options.componentProjectFacts, componentsOnly: options.componentsOnly, facets: { category: request.facets.category, sourceIds: request.facets.sourceIds ? [...new Set(request.facets.sourceIds)].sort() : [] }, limit: request.limit, requested, selection, preferenceRevision, observedContextRevision, contextRevision: applied ? observedContextRevision : null, rankingVersion: CONTEXT_RANKING_VERSION, resultMode, orderingEnvironmentDigest: options.orderingEnvironmentDigest ?? digest(resourceOrderingEnvironment()), context, indexDigest });
  if (incoming && (incoming.binding !== binding || incoming.mode !== resultMode || incoming.offset >= selected.items.length)) throw staleCursor();
  const offset = incoming?.offset ?? 0;
  const results = selected.items.slice(offset, offset + request.limit).map(item => ({ ...item, refKey: refKey(item.ref) }));
  // AC-R05.4: empty index, an offline licensed connector, an unavailable remote
  // source and a ranking timeout are distinct, truthful conditions, so they get
  // distinct text here rather than one generic "some sources failed" string.
  // Reuses the existing sourceStatuses[].reason and degradedReason fields; no
  // new response field.
  const unavailableSources = statuses.filter(status => status.state === 'unavailable');
  const degradedSources = statuses.filter(status => status.state === 'degraded');
  const describe = (list: typeof statuses) => list.map(status => `${status.sourceId} (${status.reason ?? 'no reason given'})`).join(', ');
  const emptyIndex = unique.size === 0 && unavailableSources.length === 0 && degradedSources.length === 0;
  const degradedReason = [
    unavailableSources.length ? `Unavailable: ${describe(unavailableSources)}` : null,
    degradedSources.length ? `Degraded: ${describe(degradedSources)}` : null,
    emptyIndex ? 'The resource index currently has no items for this scope' : null,
    reason === 'ranking-timeout' ? 'Context ranking exceeded its budget; showing literal lexical results with declared motion exclusions' : null,
  ].filter(Boolean).join('; ') || null;
  // AC-R11.3: say which saved constraints rerank the fonts in this cohort, how many fonts
  // meet each (zero included), and which constraints are not font requirements.
  const fontConstraints = applied && savedContext ? fontConstraintReport(cohort.filter(item => item.fontProfile), fontRequirementsFromContext(savedContext)) : undefined;
  // AC-R11 preamble: the first page of a font-category search also says which font families
  // the bundled kits and examples declare, and what each maps to (kept off other searches).
  const fontsAdapter = sources.find(source => source.sourceId === 'fonts');
  const fontsSnapshot = snapshots.find(entry => entry.status.sourceId === 'fonts');
  const fontKits = !request.cursor && request.facets.category === 'font' && (!request.facets.sourceIds?.length || request.facets.sourceIds.includes('fonts')) && fontsAdapter?.fontKitInventory && fontsSnapshot
    ? await fontsAdapter.fontKitInventory(fontsSnapshot.items) : null;
  return parseResourceSearchResponse({ ...(componentRanking ? { componentRanking } : {}), ...(fontConstraints ? { fontConstraints } : {}), ...(fontKits ? { fontKits } : {}), results, sourceStatuses: statuses, context: { requested, applied, reason, projectId: context.projectId ?? null, preferenceRevision, observedContextRevision, selection, rankingVersion: CONTEXT_RANKING_VERSION, resultMode }, contextRevision: applied ? observedContextRevision : null, excluded: selected.excluded, nextCursor: offset + request.limit < selected.items.length ? encode([2,binding,offset + request.limit,resultMode]) : null, indexDigest, degradedReason });
}
export async function inspectResource(key: string, context: ResourceRequestContext, sources: readonly ResourceSourceAdapter[], options?: ResourceSearchOptions): Promise<ResourceDetailResponse> {
  assertContext(context);
  const ref = decodeRef(key);
  const source = sources.find(s => s.sourceId === ref.sourceId);
  const found = source ? (await loadSources(context, [source]))[0] : undefined;
  const item = found?.items.find(i => sameIdentity(i.ref, ref));
  if (!item || !found) throw new ResourceError(404,'resource-ref-unknown','Resource is unavailable or unknown',['Search again for a current authorized reference']);
  if (item.ref.revisionOrDigest !== ref.revisionOrDigest) throw new ResourceError(409,'resource-ref-stale','Resource revision has changed',[`Inspect current reference: ${refKey(item.ref)}`]);
  const variants = variantOptions(item, found.items);
  const selection = componentKitSelection(options ?? {});
  const kit = options ? await readActiveComponentKit(context, sources, options) : null;
  return parseResourceDetailResponse({ resource: { ...item, ...(options && isPickerComponent(item) ? { componentFit: rankKitComponents([item], {
    kit, projectFacts: options.componentProjectFacts ?? null, target: options.componentTarget ?? null, context: options.projectState?.context.context ?? null, showAll: true,
    requestedKitId: selection.id, requestedKitSourceId: selection.sourceId,
    useProjectContext: options.projectState?.preferences.effective.useProjectContext ?? true,
  }).items[0]!.componentFit } : {}), refKey: refKey(item.ref) }, sourceStatus: found.status, ...(variants ? { variants } : {}) });
}
/** AC-R07 preamble: the inspected resource's variant group, from the same authorized listing, so
 * every key is current. A variant's label orders the group (numerically when every label is a
 * number) and its target dependencies say what choosing it brings into the project. */
function variantOptions(item: ResourceCandidate, listing: readonly ResourceCandidate[]): NonNullable<ResourceDetailResponse['variants']> | undefined {
  if (!item.variantGroup) return undefined;
  const members = listing.filter(candidate => candidate.variantGroup === item.variantGroup && candidate.ref.sourceId === item.ref.sourceId);
  if (members.length < 2) return undefined;
  const label = (candidate: ResourceCandidate) => candidate.variantLabel ?? candidate.title;
  const numeric = members.every(candidate => /^\d+$/u.test(label(candidate)));
  return [...members]
    .sort((a, b) => numeric ? Number(label(a)) - Number(label(b)) : 0)
    .map(candidate => ({
      refKey: refKey(candidate.ref), title: candidate.title, label: label(candidate),
      current: sameIdentity(candidate.ref, item.ref), previewAvailable: candidate.previewCapability.available,
      targetDependencies: candidate.targetDependencies ?? [],
    }));
}
/** AC-R07.3: the static preview document for a token cohort. The same authority and
 * stale checks as inspect run first, so a preview never serves bytes the caller cannot
 * inspect, and its revision binds exactly the tokens rendered. */
export async function previewResource(key: string, context: ResourceRequestContext, sources: readonly ResourceSourceAdapter[]): Promise<{ resource: ResourceResult; specimen: TokenSpecimen; html: string }> {
  assertContext(context);
  const ref = decodeRef(key);
  const missing = () => new ResourceError(404, 'resource-ref-unknown', 'This resource has no workbench preview document', ['Open the resource detail for its preview state']);
  const source = sources.find(s => s.sourceId === ref.sourceId);
  if (!source?.preview) throw missing();
  let listing: Awaited<ReturnType<NonNullable<ResourceSourceAdapter['preview']>>>;
  try { listing = await source.preview(ref, context); } catch { throw missing(); }
  // inspect's own validation, authority and stale checks, over this one listing.
  const detail = await inspectResource(key, context, [{ sourceId: source.sourceId, list: async () => listing.snapshot }]);
  const specimen = listing.specimen;
  if (!detail.resource.previewCapability.available || !specimen || specimen.itemId !== detail.resource.ref.itemId || specimen.revision !== detail.resource.ref.revisionOrDigest) throw missing();
  return { resource: detail.resource, specimen, html: renderTokenSpecimen(specimen) };
}
/** A document that asks a canvas for a WebGL context (string literals survive minification). */
const WEBGL_CONTEXT_REQUEST = /getContext\(\s*["'`](?:webgl2?|experimental-webgl)["'`]/u;
function baseCandidate(ref: ResourceRef, title: string, category: ResourceCandidate['category'], nativeFormat: string): ResourceCandidate {
  return { ref, title, category, readiness: 'unverified', compatibility: { nativeFormat, targets: nativeFormat === 'html' ? ['html'] : [], state: 'unverified', reason: 'Current target and per-item acceptance evidence is pending' }, rightsStatus: 'unknown', fitReasons: [], previewCapability: { available: false, kind: 'none', reason: 'adapter-missing' }, adoptionCapability: { available: false, reason: 'adapter-missing' }, sourceAttribution: { title }, operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Project need is not assessed by W1 metadata discovery' };
}
/** Current authorized source bytes fence mutable local previews. No bytes or paths leave
 * this helper; dependency checkouts and Git internals are not plugin source revisions. */
async function currentPluginSourceDigest(root: string): Promise<string | null> {
  const files: Array<[string, string]> = [];
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const walk = async (directory: string, relative: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a,b) => a.name.localeCompare(b.name,'en'));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', '.git'].includes(entry.name)) await walk(filename, nextRelative);
        } else if (entry.isFile()) {
          const hash = createHash('sha256');
          const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
          } finally { await handle.close(); }
          files.push([nextRelative, hash.digest('hex')]);
        }
      }
    };
    await walk(root, '');
    return digest(files);
  } catch { return null; }
}
/** Aggregate limits for one final reference-validation/save operation. They bound
 * work between synchronous calls, not a syscall's blocking wall-clock duration. */
export const PLUGIN_SOURCE_VALIDATION_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, files: 2048, entries: 8192, milliseconds: 250 });
type PluginSourceBudget = { bytes: number; files: number; entries: number; startedAt: number | null };
const sourceBudget = (): PluginSourceBudget => ({ bytes: 0, files: 0, entries: 0, startedAt: null });
function checkSourceBudget(budget: PluginSourceBudget): void {
  budget.startedAt ??= performance.now();
  if (budget.bytes > PLUGIN_SOURCE_VALIDATION_LIMITS.bytes || budget.files > PLUGIN_SOURCE_VALIDATION_LIMITS.files
    || budget.entries > PLUGIN_SOURCE_VALIDATION_LIMITS.entries || performance.now() - budget.startedAt > PLUGIN_SOURCE_VALIDATION_LIMITS.milliseconds) throw new Error('Plugin source validation budget exceeded');
}
/** Same tree and revision contract as discovery for under-budget readable trees.
 * Missing/unreadable/over-budget source never becomes a commit-time revision. */
function readPluginResourceRevision(plugin: InstalledPluginRecord, budget: PluginSourceBudget): string | null {
  const files: Array<[string, string]> = [];
  try {
    checkSourceBudget(budget);
    const rootStat = lstatSync(plugin.fsPath);
    checkSourceBudget(budget);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const walk = (directory: string, relative: string): void => {
      checkSourceBudget(budget);
      const handle = opendirSync(directory, { bufferSize: 1 });
      const entries: Dirent[] = [];
      try {
        let entry: Dirent | null;
        while ((entry = handle.readSync()) !== null) {
          budget.entries += 1; checkSourceBudget(budget);
          entries.push(entry);
        }
      } finally { handle.closeSync(); }
      checkSourceBudget(budget);
      entries.sort((a,b) => a.name.localeCompare(b.name,'en'));
      for (const entry of entries) {
        checkSourceBudget(budget);
        if (entry.isSymbolicLink()) continue;
        const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', '.git'].includes(entry.name)) walk(filename, nextRelative);
        } else if (entry.isFile()) {
          budget.files += 1; checkSourceBudget(budget);
          const hash = createHash('sha256');
          const file = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
          try {
            const stat = fstatSync(file);
            checkSourceBudget(budget);
            if (!stat.isFile() || stat.size > PLUGIN_SOURCE_VALIDATION_LIMITS.bytes - budget.bytes) throw new Error('Plugin source is not a bounded regular file');
            let size: number;
            // One sentinel byte detects growth beyond the aggregate limit.
            while ((size = readSync(file, buffer, 0, Math.min(buffer.length, PLUGIN_SOURCE_VALIDATION_LIMITS.bytes - budget.bytes + 1), null)) > 0) {
              budget.bytes += size; checkSourceBudget(budget);
              hash.update(buffer.subarray(0, size));
            }
            checkSourceBudget(budget);
          } finally { closeSync(file); }
          files.push([nextRelative, hash.digest('hex')]);
        }
      }
    };
    walk(plugin.fsPath, '');
    const revision = pluginResourceRevision(plugin, digest(files));
    checkSourceBudget(budget);
    return revision;
  } catch { return null; }
}
export function currentPluginResourceRevision(plugin: InstalledPluginRecord): string | null {
  return readPluginResourceRevision(plugin, sourceBudget());
}
/** Create once per resolver/save, never globally or before async discovery.
 * Only source digests are memoized; each reference still checks fresh authority. */
export function createPluginResourceRevisionValidator(): (plugin: InstalledPluginRecord) => string | null {
  const budget = sourceBudget();
  const revisions = new Map<InstalledPluginRecord, string | null>();
  return plugin => {
    try { checkSourceBudget(budget); } catch { return null; }
    if (!revisions.has(plugin)) revisions.set(plugin, readPluginResourceRevision(plugin, budget));
    return revisions.get(plugin) ?? null;
  };
}
function pluginResourceRevision(plugin: InstalledPluginRecord, currentBytes: string | null): string {
  return `sha256:${digest({ manifest: plugin.manifest, sourceDigest: plugin.sourceDigest, manifestDigest: plugin.manifestDigest, version: plugin.version, currentBytes })}`;
}
/** `CatalogEntry` (packages/genui-catalog/src/types.ts, mirroring schema/catalog.schema.json)
 * does not declare these two fields yet — adding them there needs a schema change this
 * adapter does not own. Declared locally so reading them is narrow and typed rather than an
 * `any` reach-through, and so an eventual upstream schema addition of the same shape is a
 * no-op here, not a breaking rename.
 *   - `motion: 'continuous'`: the catalog entry's *default* (non-reduced-motion) render keeps
 *     a requestAnimationFrame/CSS-infinite loop running continuously (e.g. a WebGL shader
 *     surface), as opposed to a one-shot entrance transition. Set only where verified from the
 *     component's own source — see `components/atc-shader/index.ts`'s start/stop-on-visibility
 *     rAF loop — never inferred from `category` or `kind` alone.
 *   - `styleClass: 'retro'`: the entry's visual style is itself retro/skeuomorphic. No current
 *     catalog entry sets this; the mapping below exists so one can without another code change
 *     once genui-catalog data says so. */
interface GenuiStyleSignal { motion?: 'continuous'; styleClass?: 'retro' }
function genuiStyleSignal(entry: CatalogEntry): GenuiStyleSignal {
  return entry as unknown as GenuiStyleSignal;
}
/** Only existing authorized local metadata and demo serving authority. No connector retrieval.
 *
 * AC-R05 preamble / AC-R17.4 follow-up: context-ranking.ts's continuous-GPU-motion and
 * retro-styleClass default-suppression gate keys on styleTags containing the literal
 * 'continuous-motion' (CONTINUOUS_MOTION_STYLE_TAG) and on styleClass === 'retro'. The genui
 * adapter below now derives both from real catalog metadata (GenuiStyleSignal above) instead
 * of never populating them — verified today only for genui's atc-shader (a real continuous
 * requestAnimationFrame component, previously tagged 'background' only — see
 * tests/workbench/resources-genui-style.test.ts). No section-catalog entry carries equivalent
 * motion/retro metadata yet (`SectionCatalogEntry` has no such field at all), so the sections
 * adapter is unchanged pending that classification work. */
/** `designSystemsRoot` is the daemon's design-systems *resource* directory (the bundled
 * catalog), never a path under the daemon data root; omitted, that row stays not-federated.
 * The owned-resource rows are request-scoped and each stays not-federated when omitted:
 * `userKits` lists this request's visible kits from the USER design-systems directory
 * (under the daemon data root), `projectRoot` resolves the already-authorized project's
 * files, `readProjectContext` reads its saved brief, and `workspace` is the navigation
 * scope their preview URLs carry.
 * `fonts` (AC-R11) is the curated Fontsource source built once by the caller over the bundled-plugins
 * resource root; omitted, that row stays not-federated. */
export function createLocalResourceSources(deps: {
  listPlugins(context: ResourceRequestContext): Promise<readonly InstalledPluginRecord[]>; pluginNavigationQuery?: string; designSystemsRoot?: string;
  userKits?: () => Promise<OwnedKitListing>; projectRoot?: (projectId: string) => string | null;
  readProjectContext?: (projectId: string) => ProjectDesignContextSnapshot['context']; workspace?: WorkspaceNavigation;
  fonts?: ResourceSourceAdapter;
  /** AC-R07: compiled HTML section previews; omitted, every section keeps `adapter-missing`. */
  sectionPreviews?: SectionPreviewRoots;
}): ResourceSourceAdapter[] {
  return [
    { sourceId: 'plugins', async list(context) {
      const items: ResourceCandidate[] = [];
      for (const plugin of await deps.listPlugins(context)) {
        const currentBytes = await currentPluginSourceDigest(plugin.fsPath);
        const item = baseCandidate({ sourceType: 'plugin', sourceId: 'plugins', itemId: plugin.id, revisionOrDigest: pluginResourceRevision(plugin, currentBytes) }, plugin.title || plugin.id, plugin.manifest.od?.kind === 'skill' ? 'skill' : 'template', 'plugin');
        item.sourceAttribution = { title: plugin.title || plugin.id };
        item.styleTags = [...new Set((plugin.manifest.tags ?? []).map(tag => tag.trim()).filter(Boolean))];
        if (plugin.manifest.od?.preview?.entry) item.previewCapability = { available: true, kind: 'html', url: `/api/plugins/${encodeURIComponent(plugin.id)}/preview${deps.pluginNavigationQuery ?? ''}`, reason: null };
        if (currentBytes === null) { item.readiness = 'unavailable'; item.previewCapability = {available:false,kind:'none',reason:'source-unavailable'}; }
        items.push(item);
      }
      // Recheck visibility after filesystem I/O so revoked items have no stale-key recovery.
      const visibleIds = new Set((await deps.listPlugins(context)).map(plugin => plugin.id));
      return snapshot('plugins', items.filter(item => visibleIds.has(item.ref.itemId)));
    } },
    { sourceId: 'genui', async list() {
      return snapshot('genui', genuiCatalog.manifest.components.map(entry => {
        const demo = demoDocument(entry.id);
        const item = baseCandidate({ sourceType: 'genui', sourceId: 'genui', itemId: entry.id, revisionOrDigest: `sha256:${digest({ entry, demo })}` }, entry.name, 'component', 'html');
        item.sourceAttribution = { title: entry.source.name, url: entry.sourceUrl };
        item.implementationOrigin = entry.source.name === 'original' ? 'owned-original' : 'provenance-unverified';
        const style = genuiStyleSignal(entry);
        item.styleTags = [entry.category, ...(style.motion === 'continuous' ? [CONTINUOUS_MOTION_STYLE_TAG] : [])];
        if (style.styleClass) item.styleClass = style.styleClass;
        // AC-R07: a demo that requests a WebGL context previews under the WebGL adapter family.
        if (demo) item.previewCapability = { available: true, kind: 'html', url: `/api/genui/catalog/${encodeURIComponent(entry.id)}/preview`, reason: null, adapter: WEBGL_CONTEXT_REQUEST.test(demo) ? 'webgl' : 'html-document' };
        if (entry.verdict === 'cut' || entry.licenceDecision === 'cut') { item.readiness = 'unavailable'; item.availabilityReason = 'rights-blocked'; item.previewCapability = { available: false, kind: 'none', reason: 'rights-blocked' }; }
        return item;
      }));
    } },
    { sourceId: 'sections', async list() {
      const catalog = (sectionCatalogJson as { entries: SectionCatalogEntry[] }).entries;
      const items = catalog.flatMap(raw => {
        const entry = publicCultEntry(raw); if (!entry) return [];
        const item = baseCandidate({ sourceType: 'section', sourceId: 'sections', itemId: entry.id, revisionOrDigest: `sha256:${digest(entry)}` }, entry.title, entry.sectionKind === 'page-composition' ? 'layout' : 'section', entry.content.kind === 'vendored-block' ? 'html' : entry.content.kind);
        item.sourceAttribution = { title: entry.sourceKind === 'cult-pro' ? entry.title : entry.sourceKind };
        item.styleTags = [entry.sectionKind];
        item.sectionKind = entry.sectionKind;
        item.spineAffinities = entry.spineAffinities;
        if (entry.availability === 'reference-only') { item.readiness = 'reference-only'; item.admissionStage = 'reference-only'; }
        if (entry.preview.kind === 'external-link') item.previewCapability = { available: true, kind: 'reference', url: entry.preview.url, reason: 'Reference link; no local executable preview adapter' };
        const compiled = deps.sectionPreviews ? sectionPreviewCapability(entry, catalog, deps.sectionPreviews) : null;
        if (compiled) item.previewCapability = compiled;
        Object.assign(item, sectionVariantFields(entry));
        // Artifact IDs alone are not URLs or a preview readiness proof; W1 does not invent routes.
        return [item];
      });
      return snapshot('sections', items);
    } },
    ...(deps.designSystemsRoot ? [createDesignSystemsResourceSource({ root: deps.designSystemsRoot, ...(deps.userKits ? { userKits: deps.userKits } : {}) })] : []),
    ...(deps.designSystemsRoot || deps.userKits ? [createDesignMdResourceSource({ ...(deps.designSystemsRoot ? { root: deps.designSystemsRoot } : {}), ...(deps.userKits ? { userKits: deps.userKits } : {}) })] : []),
    ...(deps.projectRoot ? [createProjectTokensSource({ projectRoot: deps.projectRoot, workspace: deps.workspace ?? null })] : []),
    ...(deps.readProjectContext ? [createBriefTokensSource({ readContext: deps.readProjectContext, workspace: deps.workspace ?? null })] : []),
    ...(deps.fonts ? [deps.fonts] : []),
    // AC-R18.6–R18.8: frozen reference-link and project-fetch entries from committed receipts.
    ...createReferenceResourceSources(),
  ];
}
