import type { Request } from 'express';
import type { ResourceRef } from '@open-design/contracts';
import { resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import { CatalogueAdoptionError } from './adoption/catalogue-adoption.js';
import { resourceRefKey } from './context-ranking.js';
import { componentApplyGate, isPickerComponent } from './component-ranking.js';
import type { ComponentGateTarget } from './component-target.js';
import { componentKitSelection, inspectResource, readActiveComponentKit, ResourceError, type ResourceSearchOptions, type ResourceSourceAdapter } from './resources.js';

export interface ComponentGateDeps {
  sourcesForRequest(req: Request): readonly ResourceSourceAdapter[];
  /** Mutation checks bypass the picker cache and observe the target afresh. */
  factsForRequest(req: Request, projectId: string, target?: ComponentGateTarget): Promise<ResourceSearchOptions>;
}
/** The production hook, also exercised by HTTP wiring tests. No request body supplies gate facts. */
export function createComponentGateForRequest(deps: ComponentGateDeps) {
  return async (req: Request, projectId: string, ref: ResourceRef, insertion?: ComponentGateTarget): Promise<void> => {
    const authority = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!authority.ok) throw new CatalogueAdoptionError(422, 'component-apply-blocked', 'Workspace scope is unverified');
    const member = authority.context;
    const context = { principalId: member ? `workspace:${member.workspaceId}:${member.workspaceMemberId}` : 'local-daemon', projectId };
    const sources = deps.sourcesForRequest(req);
    const { resource } = await inspectResource(resourceRefKey(ref), context, sources).catch((error: unknown) => {
      if (error instanceof ResourceError && (error.status === 404 || error.status === 409)) throw new CatalogueAdoptionError(error.status, error.code, error.message, { nextSteps: error.nextSteps });
      throw error;
    });
    if (!isPickerComponent(resource)) return;
    const facts = await deps.factsForRequest(req, projectId, insertion);
    const blockers = componentApplyGate(resource, facts.componentTarget ?? null, facts.projectState?.context.context ?? null, facts.componentProjectFacts);
    if (componentKitSelection(facts).id) {
      const kit = await readActiveComponentKit(context, sources, facts);
      if (!kit || kit.approval !== 'approved') blockers.push('kit-unapproved');
    }
    if (blockers.length) throw new CatalogueAdoptionError(422, 'component-apply-blocked', 'Component admission, target compatibility or kit approval is unverified; inspect the current gates before applying', { blockers });
  };
}
