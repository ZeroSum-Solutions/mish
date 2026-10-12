import { createHash } from 'node:crypto';
import {
  parsePutProjectDesignContext, parsePutProjectRubric,
  type ProjectDesignContextDraft, type ResourceRef, type ResourceRequestContext,
} from '@mish/contracts';
import type { LibraryAssetRecord } from '../library-store.js';
import type { ProjectContextReferences } from './project-context.js';
import { inspectResource, type ResourceSourceAdapter } from './resources.js';
import { resourceRefKey } from './context-ranking.js';

const systemKey = (ref: DesignSystemRef) => JSON.stringify([ref.sourceId ?? 'design-systems', ref.id, ref.revisionOrDigest]);
type DesignSystemRef = NonNullable<ProjectDesignContextDraft['designSystemRef']>;
export interface ProjectContextReferenceRequest {
  assets: string[];
  resources: ResourceRef[];
  designSystems: DesignSystemRef[];
}
export function contextReferenceRequest(family: 'context' | 'rubric', input: unknown): ProjectContextReferenceRequest {
  const request: ProjectContextReferenceRequest = { assets: [], resources: [], designSystems: [] };
  const sources = family === 'context'
    ? parsePutProjectDesignContext(input).draft.factSources.map(fact => fact.source)
    : parsePutProjectRubric(input).draft.checks.map(check => check.provenance.source);
  for (const source of sources) if (source) {
    if ('assetId' in source) request.assets.push(source.assetId);
    else request.resources.push(source.resourceRef);
  }
  if (family === 'context') {
    const ref = parsePutProjectDesignContext(input).draft.designSystemRef;
    if (ref) request.designSystems.push(ref);
  }
  return request;
}
/** Digest the exact UTF-8 DESIGN.md selected by the authorized detail path. */
export function designSystemReferenceDigest(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}
export interface DesignSystemReferenceEvidence {
  body: string;
  bindingKey: string;
  projectId?: string;
  sourceCurrent(): boolean;
}
export interface ContextReferenceResolutionDeps {
  getAsset(id: string): LibraryAssetRecord | null;
  requestContext: ResourceRequestContext;
  requestScopedSources: readonly ResourceSourceAdapter[];
  /** Fresh SQLite authority/selection identity, never a preloaded grant boolean. */
  resourceBindingKey(ref: ResourceRef): string | null;
  resourceSourceCurrent(ref: ResourceRef): boolean;
  readDesignSystem(id: string): Promise<DesignSystemReferenceEvidence | null>;
  designSystemBindingKey(id: string, projectId?: string): string | null;
}
/** Async resolution completes outside SQLite. Final synchronous checks re-read
 * bindings and source bytes before saving. An external filesystem writer can
 * still change already-read bytes during or after validation, before SQLite
 * commits; this is not an atomic filesystem snapshot. Evidence grants no use. */
export async function resolveProjectContextReferences(projectId: string, request: ProjectContextReferenceRequest, deps: ContextReferenceResolutionDeps): Promise<ProjectContextReferences> {
  const resources = new Map<string, string>();
  const systems = new Map<string, DesignSystemReferenceEvidence>();
  for (const ref of request.resources) {
    const key = resourceRefKey(ref);
    if (resources.has(key)) continue;
    try {
      await inspectResource(key, deps.requestContext, deps.requestScopedSources);
      const binding = deps.resourceBindingKey(ref);
      if (binding !== null) resources.set(key, binding);
    } catch { /* unknown, stale and unauthorized all fail closed at save */ }
  }
  for (const ref of request.designSystems) {
    // This legacy resolver serves only the design-systems source. Other sources
    // need their own authorized resolver; never substitute a same-ID kit.
    if (ref.sourceId && ref.sourceId !== 'design-systems') continue;
    try {
      const evidence = await deps.readDesignSystem(ref.id);
      if (evidence && designSystemReferenceDigest(evidence.body) === ref.revisionOrDigest && deps.designSystemBindingKey(ref.id, evidence.projectId) === evidence.bindingKey) systems.set(systemKey(ref), evidence);
    } catch { /* no protected metadata leaves the resolver */ }
  }
  return {
    asset(id, assetId) {
      if (id !== projectId || !request.assets.includes(assetId)) return false;
      const asset = deps.getAsset(assetId);
      return !!asset && (asset.originProjectId === projectId || asset.sources.some(source => source.projectId === projectId));
    },
    resource(id, ref) {
      const evidence = resources.get(resourceRefKey(ref));
      return id === projectId && evidence !== undefined && deps.resourceBindingKey(ref) === evidence && deps.resourceSourceCurrent(ref);
    },
    designSystem(id, ref) {
      const evidence = systems.get(systemKey(ref));
      return id === projectId && (!ref.sourceId || ref.sourceId === 'design-systems') && !!evidence && deps.designSystemBindingKey(ref.id, evidence.projectId) === evidence.bindingKey && evidence.sourceCurrent();
    },
  };
}
