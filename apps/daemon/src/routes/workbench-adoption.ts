import type { Express, Request, Response } from 'express';
import { parseApplyAdoptionRequest, parseCatalogueAdoptionRequest, parseCatalogueSavedUnitDeleteResponse, parseCatalogueSaveRequest, parsePrepareAdoptionRequest, type WorkbenchAdoptionStatusResponse } from '@mish/contracts';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import { validateLocalDaemonRequest } from '../http/local-daemon-request.js';
import { CatalogueAdoptionError, CatalogueAdoptionManager, catalogueCodeForRef, decodeRefKey } from '../workbench/adoption/catalogue-adoption.js';
import type { CatalogueMaterialSource } from '../workbench/adoption/catalogue-material.js';
import { referenceAdoptionRefusal } from '../workbench/reference-sources.js';
import path from 'node:path';
import type { ComponentGateTarget } from '../workbench/component-target.js';
import type { ResourceRef } from '@mish/contracts';
import { createShadcnCatalogueMaterials } from '../workbench/adoption/shadcn-material.js';
import { CatalogueSavedUnitStore, SavedUnitError } from '../workbench/adoption/saved-units.js';
import { createGsapRecipeMaterials } from '../workbench/recipes/gsap/index.js';
import { createReact95Materials } from '../workbench/kits/react95/materials.js';
import { createAceternityCatalogueMaterials } from '../workbench/adoption/aceternity-material.js';
import { AdoptionError, type PlacementAdoptionExecutor } from '../workbench/placement/adoption-executor.js';
import { AdoptionBlobError } from '../workbench/placement/adoption-files.js';
import { adoptionHostSupported } from '../workbench/placement/adoption-provisioning.js';
import { mapPlacementFailure, placementAdoptionUnavailable, type PlacementRuntimeStatus } from '../workbench/placement/runtime-status.js';
import { PlacementCoordinationError } from '../workbench/placement/write-coordinator.js';

export interface RegisterWorkbenchAdoptionRoutesDeps {
  http: { sendApiError: (res: Response, status: number, code: any, message: string, init?: Record<string, unknown>) => unknown };
  authorizeProjectRequest: AuthorizeProjectRequest;
  /** The daemon placement runtime; its executor is null unless coordinated with a provisioned helper. */
  placement: { readonly adoption: PlacementAdoptionExecutor | null; status(): PlacementRuntimeStatus };
  /**
   * AC-R04.3/R04.4 catalogue preparer over the same executor. Omitted: the
   * route builds the default one (the selected shadcn cohort through the
   * existing importer, plus the GSAP recipes, AC-R08.5, and the React95 kit
   * templates, AC-R17.3) over
   * `placement.adoption` on first use. `null`
   * disables catalogue apply (422 `catalogue-unprovisioned`).
   */
  catalogue?: CatalogueAdoptionManager | null;
  /** Read-only copy sources. These stay available when the placement executor is closed. */
  copyMaterials?: readonly CatalogueMaterialSource[];
  /**
   * B4-1 opt-in state for `GET …/status`: the process-level
   * `OD_PLACEMENT_ADOPTION_EXECUTOR` and the Settings → Labs switch.
   * Omitted: both report off.
   */
  optIn?: () => { env: boolean; labs: boolean };
  /** Further admitted material sources for the default preparer (AC-R12.4 owned imports). */
  extraMaterials?: readonly CatalogueMaterialSource[];
  /** D6/D17: fresh target/adapter compatibility and admission; never caller-supplied facts. */
  componentGateForRequest(req: Request, projectId: string, ref: ResourceRef, target?: ComponentGateTarget): Promise<void>;
}
class RouteInputError extends Error {}
/** Contract parse failures (the daemon does not depend on zod directly). */
const isSchemaError = (error: unknown): error is Error => error instanceof Error && error.name === 'ZodError';
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * Prepare/preview/apply/undo/operation readback for the workbench adopter.
 * The same endpoints back `od workbench adoption`. Plans are prepared by the
 * daemon from a draft; apply names only the stored plan ID and digest.
 * Without a wired executor every route answers the typed 422 placement
 * refusal and preserves the caller's request unchanged.
 */
export function registerWorkbenchAdoptionRoutes(app: Express, deps: RegisterWorkbenchAdoptionRoutesDeps): void {
  if (typeof deps.componentGateForRequest !== 'function') throw new Error('Workbench adoption requires componentGateForRequest');
  const { http, authorizeProjectRequest, placement } = deps;
  let defaultCatalogue: CatalogueAdoptionManager | null = null;
  /** The configured catalogue preparer, or the default one bound to the wired executor. */
  const catalogueFor = (adoption: PlacementAdoptionExecutor): CatalogueAdoptionManager | null => {
    if (deps.catalogue !== undefined) return deps.catalogue;
    defaultCatalogue ??= new CatalogueAdoptionManager({
      executor: adoption, materials: [createShadcnCatalogueMaterials(), createAceternityCatalogueMaterials(), createGsapRecipeMaterials(), createReact95Materials(), ...(deps.extraMaterials ?? [])],
      // Saved units live under the executor's work root; an executor without one leaves them unprovisioned (typed 422).
      ...(typeof adoption.savedUnitsRoot === 'string' ? { savedUnits: new CatalogueSavedUnitStore(adoption.savedUnitsRoot) } : {}),
    });
    return defaultCatalogue;
  };
  const base = '/api/workbench/adoption';
  app.use(base, (req, res, next) => {
    const local = validateLocalDaemonRequest(req);
    if (!local.ok) return http.sendApiError(res, 403, 'FORBIDDEN', local.message, { details: local.details });
    next();
  });
  /** Server-derived principal: the paired workspace member, or the local owner. Never a body field. */
  const principalOf = (req: Request): string => {
    const resolved = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!resolved.ok) throw new RouteInputError(resolved.message);
    if (!resolved.context) return 'local-owner';
    const principal = `member:${resolved.context.workspaceMemberId}`;
    if (!PRINCIPAL.test(principal)) throw new RouteInputError('Unsupported workspace member identity');
    return principal;
  };
  const executor = (res: Response): PlacementAdoptionExecutor | null => {
    if (placement.adoption) return placement.adoption;
    const refusal = placementAdoptionUnavailable(placement.status());
    http.sendApiError(res, refusal.status, refusal.code, refusal.message, { retryable: refusal.retryable, details: refusal.details });
    return null;
  };
  const gate = (req: Request, res: Response, projectId: string, write: boolean) => {
    const header = req.get('x-od-project-id');
    if (header !== undefined && header !== projectId) throw new RouteInputError('Project header and adoption project must match');
    return authorizeProjectRequest(req, res, projectId, write ? { mode: 'write', capability: 'writeFiles' } : { mode: 'read' });
  };
  const fail = (res: Response, error: unknown) => {
    if (res.headersSent || res.destroyed) return;
    if (error instanceof RouteInputError) return http.sendApiError(res, 400, 'BAD_REQUEST', error.message);
    if (isSchemaError(error)) return http.sendApiError(res, 400, 'BAD_REQUEST', 'Invalid adoption request');
    if (error instanceof AdoptionError) {
      const code = error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'CONFLICT' : error.status === 422 ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR';
      const extra = error instanceof CatalogueAdoptionError ? error.details : {};
      return http.sendApiError(res, error.status, code, error.message, { retryable: false, details: { ...extra, kind: 'adoption', reason: error.reason, ...(error.operationId ? { operationId: error.operationId } : {}) } });
    }
    if (error instanceof SavedUnitError) {
      // Budget and limit are the caller's to fix (smaller unit, or remove a saved one); corruption is the daemon's.
      const recoverable = error.reason === 'saved-unit-budget' || error.reason === 'saved-unit-limit';
      return http.sendApiError(res, recoverable ? 422 : 500, recoverable ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR', error.message, { details: { kind: 'adoption', reason: error.reason } });
    }
    if (error instanceof AdoptionBlobError) return http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Retained adoption bytes failed verification', { details: { kind: 'adoption', reason: error.reason } });
    const mapped = mapPlacementFailure(error);
    if (mapped) return http.sendApiError(res, mapped.status, mapped.code, mapped.message, { retryable: mapped.retryable, details: mapped.details });
    if (error instanceof PlacementCoordinationError) return http.sendApiError(res, 409, 'CONFLICT', error.message, { retryable: true, details: { kind: 'placement', reason: error.code } });
    return http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Adoption operation failed');
  };

  /** Executor provisioning state and its named gates (`od workbench adoption status`, Settings → Labs). Read-only. */
  app.get(`${base}/status`, (_req, res) => {
    try {
      // Readiness only: status never constructs the executor (it is built on the first adoption request).
      const status = placement.status();
      const optIn = deps.optIn?.() ?? { env: false, labs: false };
      const response: WorkbenchAdoptionStatusResponse = { status: {
        executor: status.activation.adoption === 'executor' ? 'provisioned' : 'closed',
        placementMode: status.mode,
        optIn: { env: optIn.env === true, labs: optIn.labs === true },
        host: { platform: status.host.platform, arch: status.host.arch, supported: adoptionHostSupported({ platform: status.host.platform, arch: status.host.arch, release: status.host.osRelease }) },
        gates: [...status.activation.gates],
      } };
      res.json(response);
    } catch (error) { fail(res, error); }
  });
  /**
   * AC-R18.6–R18.8 and AC-R12.4: refs whose source cannot be applied from metadata are
   * refused after project authority and before any executor or preparer runs. Order:
   * authority → unknown/stale revision → native target format → operation rights.
   * A hand-written plan may not claim Magic Patterns provenance without a recorded import,
   * nor Aceternity provenance without the catalogue's verified registry fetch.
   * Returns true when the response was sent.
   */
  const sourceGate = async (req: Request, res: Response, projectId: string, ref: ResourceRef, viaCatalogue: boolean): Promise<boolean> => {
    const refusal = referenceAdoptionRefusal(ref);
    const forgedImport = !viaCatalogue && ref.sourceId === 'magic-patterns';
    const forgedFetch = !viaCatalogue && ref.sourceId === 'aceternity';
    if (!refusal && !forgedImport && !forgedFetch) return false;
    if (!await gate(req, res, projectId, true)) return true;
    if (forgedFetch) {
      http.sendApiError(res, 422, 'VALIDATION_FAILED', 'Aceternity source is applied from the catalogue, which fetches and verifies the registry bytes', { retryable: false, details: { kind: 'adoption', reason: 'catalogue-apply-required' } });
      return true;
    }
    if (forgedImport) {
      http.sendApiError(res, 422, 'VALIDATION_FAILED', 'Magic Patterns provenance comes only from a recorded owner import; apply it from the catalogue', { retryable: false, details: { kind: 'adoption', reason: 'owned-import-required' } });
      return true;
    }
    const code = refusal!.status === 404 ? 'NOT_FOUND' : refusal!.status === 409 ? 'CONFLICT' : 'VALIDATION_FAILED';
    const details = refusal!.status === 422 ? refusal!.details : { kind: 'adoption', reason: refusal!.reason, ...refusal!.details };
    http.sendApiError(res, refusal!.status, code, refusal!.message, { retryable: false, details });
    return true;
  };

  app.get(`${base}/catalogue/copy/:refKey`, async (req, res) => {
    try {
      const code = await catalogueCodeForRef(req.params.refKey, deps.copyMaterials ?? [createShadcnCatalogueMaterials()]);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ code });
    } catch (error) { fail(res, error); }
  });
  app.post(`${base}/prepare`, async (req, res) => {
    try {
      const draft = parsePrepareAdoptionRequest(req.body);
      if (draft.source.resourceRef && await sourceGate(req, res, draft.projectId, draft.source.resourceRef, false)) return;
      const adoption = executor(res); if (!adoption) return;
      if (!await gate(req, res, draft.projectId, true)) return;
      if (draft.source.resourceRef) await deps.componentGateForRequest(req, draft.projectId, draft.source.resourceRef, { entryPath: draft.entryPath });
      res.status(201).json({ plan: await adoption.prepare(principalOf(req), draft) });
    } catch (error) { fail(res, error); }
  });
  /** Prepare from a catalogue reference: rights, notice, dependency and replacement-review gates run in the daemon. */
  app.post(`${base}/catalogue/prepare`, async (req, res) => {
    try {
      const request = parseCatalogueAdoptionRequest(req.body);
      let ref: ResourceRef | null = null;
      try { ref = decodeRefKey(request.refKey); } catch { /* the preparer reports the unknown ref */ }
      if (ref && await sourceGate(req, res, request.projectId, ref, true)) return;
      const adoption = executor(res); if (!adoption) return;
      const catalogue = catalogueFor(adoption);
      if (!catalogue) return http.sendApiError(res, 422, 'VALIDATION_FAILED', 'Catalogue adoption is not provisioned in this daemon', { retryable: false, details: { kind: 'adoption', reason: 'catalogue-unprovisioned' } });
      if (!await gate(req, res, request.projectId, true)) return;
      // Reusing a saved unit re-checks read access to the project it was saved from.
      if (request.savedUnitId) {
        const source = catalogue.savedUnitSource(principalOf(req), request.savedUnitId);
        if (source && !await authorizeProjectRequest(req, res, source.sourceProjectId, { mode: 'read' })) return;
      }
      if (ref) await deps.componentGateForRequest(req, request.projectId, ref, { entryPath: request.entryPath, targetDir: request.targetDir });
      res.status(201).json(await catalogue.prepare(principalOf(req), request));
    } catch (error) { fail(res, error); }
  });
  /** W4: save the unit an apply wrote, as it is now in that project, for private reuse elsewhere. */
  app.post(`${base}/catalogue/save`, async (req, res) => {
    try {
      const request = parseCatalogueSaveRequest(req.body);
      const adoption = executor(res); if (!adoption) return;
      const catalogue = catalogueFor(adoption);
      if (!catalogue) return http.sendApiError(res, 422, 'VALIDATION_FAILED', 'Catalogue adoption is not provisioned in this daemon', { retryable: false, details: { kind: 'adoption', reason: 'catalogue-unprovisioned' } });
      if (!await gate(req, res, request.projectId, false)) return;
      res.status(201).json({ savedUnit: await catalogue.save(principalOf(req), request) });
    } catch (error) { fail(res, error); }
  });
  /** W4: the caller's saved units for one catalogue reference. */
  app.get(`${base}/catalogue/saved`, async (req, res) => {
    try {
      const refKey = typeof req.query.refKey === 'string' ? req.query.refKey : '';
      if (!refKey) throw new RouteInputError('refKey is required');
      const adoption = executor(res); if (!adoption) return;
      const catalogue = catalogueFor(adoption);
      if (!catalogue) return http.sendApiError(res, 422, 'VALIDATION_FAILED', 'Catalogue adoption is not provisioned in this daemon', { retryable: false, details: { kind: 'adoption', reason: 'catalogue-unprovisioned' } });
      res.json({ savedUnits: catalogue.listSaved(principalOf(req), refKey) });
    } catch (error) { fail(res, error); }
  });
  /** Sol B5/6: remove one of the caller's saved units (`od workbench adoption catalogue-saved delete <id>`). */
  app.delete(`${base}/catalogue/saved/:id`, async (req, res) => {
    try {
      const adoption = executor(res); if (!adoption) return;
      const catalogue = catalogueFor(adoption);
      if (!catalogue) return http.sendApiError(res, 422, 'VALIDATION_FAILED', 'Catalogue adoption is not provisioned in this daemon', { retryable: false, details: { kind: 'adoption', reason: 'catalogue-unprovisioned' } });
      res.json(parseCatalogueSavedUnitDeleteResponse(catalogue.deleteSaved(principalOf(req), String(req.params.id))));
    } catch (error) { fail(res, error); }
  });
  app.get(`${base}/plans/:planId`, async (req, res) => {
    try {
      const adoption = executor(res); if (!adoption) return;
      const plan = adoption.readPlan(principalOf(req), req.params.planId);
      if (!await gate(req, res, plan.projectId, false)) return;
      res.json({ plan });
    } catch (error) { fail(res, error); }
  });
  app.post(`${base}/apply`, async (req, res) => {
    try {
      const request = parseApplyAdoptionRequest(req.body);
      const adoption = executor(res); if (!adoption) return;
      const principal = principalOf(req);
      const plan = adoption.readPlan(principal, request.planId);
      if (!await gate(req, res, plan.projectId, true)) return;
      // G38 review round 2: the source gate that admitted the plan runs again at apply, for
      // every source. A revoked decision or changed item bytes refuse a prepared plan.
      const catalogue = plan.adapter.id === 'catalogue-files';
      if (await sourceGate(req, res, plan.projectId, plan.source.resourceRef, catalogue)) return;
      const manifest = plan.reads?.filter(read => read.expected.kind === 'file' && /(?:^|\/)package\.json$/u.test(read.path)).sort((a, b) => b.path.split('/').length - a.path.split('/').length)[0];
      await deps.componentGateForRequest(req, plan.projectId, plan.source.resourceRef, { entryPath: plan.target?.entryPath, ...(manifest ? { targetDir: path.posix.dirname(manifest.path).replace(/^\.$/u, '') } : {}) });
      if (catalogue) await catalogueFor(adoption)?.recheck(plan);
      res.json({ operation: await adoption.apply(principal, request) });
    } catch (error) { fail(res, error); }
  });
  app.get(`${base}/operations/:operationId`, async (req, res) => {
    try {
      const adoption = executor(res); if (!adoption) return;
      const operation = adoption.view(principalOf(req), req.params.operationId);
      if (!await gate(req, res, operation.projectId, false)) return;
      res.json({ operation });
    } catch (error) { fail(res, error); }
  });
  app.post(`${base}/operations/:operationId/undo`, async (req, res) => {
    try {
      const adoption = executor(res); if (!adoption) return;
      const principal = principalOf(req);
      const applied = adoption.view(principal, req.params.operationId);
      if (!await gate(req, res, applied.projectId, true)) return;
      res.json({ operation: await adoption.undo(principal, applied.operationId) });
    } catch (error) { fail(res, error); }
  });
}
