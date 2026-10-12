import { CONNECTOR_IDS, connectorResourceRef, type ConnectorId, type ResourceRef } from '@mish/contracts';
import { ReferenceSelectionError, type DesignReferenceSource } from '../brief/references.js';
import { ConnectorError, connectorDeriveDecision, type ConnectorProxy } from './connector-proxy.js';

/** Project scope never grants access to an owner-seat connector account. */
export function mayUseOwnerSeatConnector(connectorId: string, principalId: string): boolean {
  return connectorId !== 'mobbin' || ['local-owner', 'local-daemon'].includes(principalId);
}

/**
 * AC-R15.2 brief references from website connectors. A selected ref resolves to a
 * result this daemon captured through the connector proxy, at the exact capture
 * revision (`captured:<capturedAt>`). The excerpt is composed by the daemon from
 * validated fields only (kind, title, canonical link), never from provider prose,
 * so it counts as reviewed. Whether it may become model input is the connector's
 * `derive-from-reference` decision: Mobbin is allowed under the owner decision of
 * 2026-10-09; MotionSites and Refero stay refused.
 */
export function connectorReferenceSource(proxy: Pick<ConnectorProxy, 'capturedReference' | 'select'>, fallback?: DesignReferenceSource): DesignReferenceSource {
  return {
    async resolve(ref: ResourceRef, context) {
      if (ref.sourceType !== 'reference' || !(CONNECTOR_IDS as readonly string[]).includes(ref.sourceId)) {
        return fallback ? fallback.resolve(ref, context) : { kind: 'unknown' };
      }
      const connectorId = ref.sourceId as ConnectorId;
      // Workspace project authority does not grant access to the local owner's Mobbin account.
      if (!mayUseOwnerSeatConnector(connectorId, context.principalId)) return { kind: 'forbidden' };
      let resource = proxy.capturedReference(connectorId, ref.itemId);
      if (resource && connectorResourceRef(resource).revisionOrDigest !== ref.revisionOrDigest) return { kind: 'stale' };
      if (connectorId === 'mobbin') {
        if (connectorDeriveDecision(connectorId) !== 'permitted') return { kind: 'forbidden' };
        if (!ref.revisionOrDigest.startsWith('captured:')) return { kind: 'stale' };
        const capturedAt = ref.revisionOrDigest.replace(/^captured:/u, '');
        try { resource = (await proxy.select(connectorId, { itemId: ref.itemId, capturedAt })).resource; }
        catch (error) {
          if (!(error instanceof ConnectorError)) throw error;
          if (error.code === 'connector-item-unknown') return { kind: 'unknown' };
          const status = error.status === 403 || error.status === 409 || error.status === 422 ? error.status : 503;
          throw new ReferenceSelectionError(status, error.code, error.message);
        }
      }
      if (!resource) return { kind: 'unknown' };
      if (connectorResourceRef(resource).revisionOrDigest !== ref.revisionOrDigest) return { kind: 'stale' };
      const kind = resource.category ? `${resource.category} reference` : 'Reference';
      return {
        kind: 'found',
        document: {
          ref, title: resource.title,
          attribution: `${resource.attribution.provider} · ${resource.title} · ${resource.canonicalUrl}`,
          review: 'reviewed', deriveFromReference: connectorDeriveDecision(connectorId), projectId: null,
          excerpt: `${kind} from ${resource.attribution.provider}: ${resource.title}. Source: ${resource.canonicalUrl}`,
          tokens: { colors: [], fonts: [] },
        },
      };
    },
  };
}
