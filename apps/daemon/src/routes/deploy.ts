import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { checkVercelName } from '../deploy/vercel-site.js';
import { deployLinkSentence, parsePageMarker, resolveCloudflarePagesAccess } from '../deploy.js';

/** The stored marker of the page a deployment uploaded (validated where it is used). */
function storedPageMarker(existing: { providerMetadata?: unknown }): unknown {
  const metadata = existing.providerMetadata;
  return metadata && typeof metadata === 'object' ? (metadata as { pageMarker?: unknown }).pageMarker : undefined;
}

export interface RegisterDeployRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'ids' | 'deploy' | 'projectStore'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
}

export function registerDeployRoutes(app: Express, ctx: RegisterDeployRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { randomUUID } = ctx.ids;
  const { getProject } = ctx.projectStore;
  const { VERCEL_PROVIDER_ID, CLOUDFLARE_PAGES_PROVIDER_ID, isDeployProviderId, publicDeployConfigForProvider, readDeployConfig, writeDeployConfig, listCloudflarePagesZones, DeployError, listDeployments, publicDeployments, getDeployment, prepareDeployPublication, cloudflarePagesProjectNameForDeploy, deployToCloudflarePages, deployToVercel, upsertDeployment, publicDeployment, cloudflarePagesDeploymentMetadata, prepareDeployPreflight } = ctx.deploy;

  /**
   * A DeployError now carries a specific `code` (MISSING_REFERENCES,
   * CF_ASSET_TOO_LARGE, VERCEL_TOKEN_REQUIRED, …). Pass it through instead of
   * flattening every failure to BAD_REQUEST: the client mirrors the envelope
   * code into `artifact_deploy_result.error_code`, so without this every
   * distinct cause — missing token, non-HTML file, unresolved asset reference,
   * oversized asset — collapsed into one opaque HTTP_400 bucket.
   *
   * Provider transport failures deliberately arrive WITHOUT a code (see
   * cloudflareError / vercelError in apps/daemon/src/deploy.ts): they fall back
   * to the generic envelope code so the client keeps bucketing them by the real
   * provider status (HTTP_403 / HTTP_429 / HTTP_502) instead of collapsing
   * auth, quota and upstream faults into one.
   */
  const deployErrorCodeFor = (err: any, status: number): string =>
    (err instanceof DeployError && err.code) ||
    (status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST');

  const vercelPublishes = new Set<string>();

  // ---- Deploy --------------------------------------------------------------

  app.get('/api/deploy/config', async (req, res) => {
    try {
      const providerId =
        typeof req.query.providerId === 'string' ? req.query.providerId : VERCEL_PROVIDER_ID;
      if (!isDeployProviderId(providerId)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'unsupported deploy provider');
      }
      /** @type {import('@open-design/contracts').DeployConfigResponse} */
      const body = publicDeployConfigForProvider(providerId, await readDeployConfig(providerId));
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.put('/api/deploy/config', async (req, res) => {
    try {
      const input = req.body || {};
      const providerId =
        typeof input.providerId === 'string' ? input.providerId : VERCEL_PROVIDER_ID;
      if (!isDeployProviderId(providerId)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'unsupported deploy provider');
      }
      /** @type {import('@open-design/contracts').DeployConfigResponse} */
      const body = await writeDeployConfig(providerId, input);
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, deployErrorCodeFor(err, 400), String(err?.message || err));
    }
  });

  app.get('/api/deploy/vercel/name-check', (req, res, next) => ctx.http.requireLocalDaemonRequest(req, res, next), async (req, res) => {
    try {
      if (typeof req.query.name !== 'string') return sendApiError(res, 400, 'BAD_REQUEST', 'name required');
      let prior;
      if (typeof req.query.projectId === 'string') {
        if (!getProject(db, req.query.projectId)) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        if (!await ctx.authorizeProjectRequest(req, res, req.query.projectId, { mode: 'write', capability: 'writeFiles' })) return;
        prior = listDeployments(db, req.query.projectId).find((d: any) => d.providerId === VERCEL_PROVIDER_ID)?.providerMetadata;
      }
      res.json(await checkVercelName(await readDeployConfig(VERCEL_PROVIDER_ID), req.query.name, prior));
    } catch (err: any) {
      const status = err instanceof DeployError ? err.status : 502;
      sendApiError(res, status, deployErrorCodeFor(err, status), String(err?.message || err), { details: err?.details });
    }
  });

  app.get('/api/deploy/cloudflare-pages/zones', async (_req, res) => {
    try {
      /** @type {import('@open-design/contracts').CloudflarePagesZonesResponse} */
      const body = await listCloudflarePagesZones(await readDeployConfig(CLOUDFLARE_PAGES_PROVIDER_ID));
      res.json(body);
    } catch (err: any) {
      const status = err instanceof DeployError ? err.status : 400;
      const init =
        err instanceof DeployError && err.details
          ? { details: err.details }
          : {};
      sendApiError(res, status, deployErrorCodeFor(err, status), String(err?.message || err), init);
    }
  });

  app.get('/api/projects/:id/deployments', async (req, res) => {
    try {
      if (!getProject(db, req.params.id)) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      if (!await ctx.authorizeProjectRequest(req, res, req.params.id, { mode: 'read' })) return;
      /** @type {import('@open-design/contracts').ProjectDeploymentsResponse} */
      const body = { deployments: publicDeployments(listDeployments(db, req.params.id)) };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.post('/api/projects/:id/deploy', async (req, res) => {
    let ownsPublish = false;
    try {
      const { fileName, providerId = VERCEL_PROVIDER_ID, cloudflarePages, vercel, target: rawTarget, publicAccess: rawPublicAccess } = req.body || {};
      // Omitted publicAccess keeps today's behaviour exactly; any supplied
      // value must be a real boolean, because a truthy string here would
      // otherwise silently rewrite a provider's protection settings.
      if (rawPublicAccess !== undefined && typeof rawPublicAccess !== 'boolean') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid publicAccess: expected a boolean');
      }
      // Omitted target defaults to production; any supplied value must be exact.
      if (rawTarget !== undefined && rawTarget !== 'preview' && rawTarget !== 'production') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid target: expected "preview" or "production"');
      }
      const target: 'preview' | 'production' = rawTarget === 'preview' ? 'preview' : 'production';
      // Vercel production-target deploys are out of scope for this PR (P2 review
      // finding on PR #4576) — deployToVercel() never receives `target` and
      // always behaves as preview, so an explicit target=production request
      // must be rejected before any deploy call instead of silently deploying
      // as preview. Only the explicitly-supplied raw value gates this: the
      // omitted-target default (which resolves to 'production' above for
      // Cloudflare Pages parity) must keep deploying Vercel as before.
      if (providerId === VERCEL_PROVIDER_ID && rawTarget === 'production') {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'Vercel does not support target=production yet; use target=preview or omit target',
        );
      }
      if (!isDeployProviderId(providerId)) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'unsupported deploy provider',
        );
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }
      const deployProject = getProject(db, req.params.id);
      if (!deployProject) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      if (!await ctx.authorizeProjectRequest(
        req,
        res,
        req.params.id,
        { mode: 'write', capability: 'writeFiles' },
      )) return;

      if (vercel !== undefined && (providerId !== VERCEL_PROVIDER_ID || !vercel || typeof vercel !== 'object' || Array.isArray(vercel) ||
        Object.keys(vercel).some(key => key !== 'projectName') || (vercel.projectName !== undefined && typeof vercel.projectName !== 'string'))) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid vercel selection');
      }
      if (providerId === VERCEL_PROVIDER_ID) {
        if (vercelPublishes.has(req.params.id)) return sendApiError(res, 409, 'VERCEL_DEPLOY_IN_PROGRESS', 'A Vercel publish is already in progress for this project.');
        vercelPublishes.add(req.params.id);
        ownsPublish = true;
      }
      const prior = getDeployment(db, req.params.id, fileName, providerId);
      const projectBinding = providerId === VERCEL_PROVIDER_ID
        ? listDeployments(db, req.params.id).find((d: any) => d.providerId === VERCEL_PROVIDER_ID && d.providerMetadata?.vercelProjectId)
        : undefined;
      const { files, warnings } = await prepareDeployPublication(
        PROJECTS_DIR,
        req.params.id,
        fileName,
        { metadata: deployProject?.metadata, requireAgencySiteScope: deployProject.skillId === 'agency-site' },
      );
      const project = getProject(db, req.params.id);
      const cloudflarePagesProjectName =
        providerId === CLOUDFLARE_PAGES_PROVIDER_ID
          ? cloudflarePagesProjectNameForDeploy(db, req.params.id, project?.name, prior)
          : '';
      const result = providerId === CLOUDFLARE_PAGES_PROVIDER_ID
        ? await deployToCloudflarePages({
            config: {
              ...await readDeployConfig(CLOUDFLARE_PAGES_PROVIDER_ID),
              projectName: cloudflarePagesProjectName,
            },
            files,
            projectId: req.params.id,
            cloudflarePages,
            priorMetadata: prior?.providerMetadata,
            target,
          })
        : await deployToVercel({
            config: await readDeployConfig(VERCEL_PROVIDER_ID),
            files,
            projectId: req.params.id,
            publicAccess: rawPublicAccess === true,
            projectName: vercel?.projectName,
            priorMetadata: projectBinding?.providerMetadata,
            // Durable identity survives upload/alias failures and lost responses.
            // Internal 'binding' status stays out of the public DeploymentStatus
            // contract and deployment list until this file has a URL.
            onBinding: (binding: any) => upsertDeployment(db, {
              ...prior, id: prior?.id ?? randomUUID(), projectId: req.params.id, fileName, providerId,
              url: prior?.url ?? '', deploymentCount: prior?.deploymentCount ?? 0, target: 'preview',
              status: prior?.url?.trim() ? prior.status : 'binding', access: prior?.access ?? 'unknown',
              statusMessage: prior?.statusMessage ?? 'The provider project is saved, but the deployment has not been confirmed.',
              providerMetadata: { ...prior?.providerMetadata, ...binding,
                // A sibling can supply project identity, not this file's alias history.
                ...(prior ? { vercel: prior.providerMetadata?.vercel } : {}),
              },
              createdAt: prior?.createdAt ?? Date.now(), updatedAt: Date.now(),
            }),
          });
      const now = Date.now();
      /** @type {import('@open-design/contracts').DeployProjectFileResponse} */
      const body = upsertDeployment(db, {
        id: prior?.id ?? randomUUID(),
        projectId: req.params.id,
        fileName,
        providerId,
        url: result.url,
        deploymentId: result.deploymentId,
        deploymentCount: (prior?.deploymentCount ?? 0) + 1,
        target: result.target ?? target,
        status: result.status,
        statusMessage: result.statusMessage,
        // Whether anyone can open the link, apart from whether it answered.
        access: result.access,
        reachableAt: result.reachableAt,
        cloudflarePages: result.cloudflarePages,
        // The "Make preview public" intent and its outcome, so "Retry link"
        // can re-verify later without a redeploy.
        publicAccess: result.publicAccess,
        publicAccessOutcome: result.publicAccessOutcome,
        // Vercel: an unconfirmed protection read (result.providerMetadata
        // undefined) must NOT fall back to the prior deployment's metadata —
        // that would keep a stale `protection` record around after this
        // deploy's statusMessage already says the check could not be done.
        // upsertDeployment/db.ts treats `undefined` as "keep existing", so
        // pass `null` explicitly to clear it instead.
        providerMetadata:
          providerId === CLOUDFLARE_PAGES_PROVIDER_ID
            ? (result.providerMetadata ?? cloudflarePagesDeploymentMetadata(cloudflarePagesProjectName))
            : (result.providerMetadata ?? null),
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      });
      if (providerId === VERCEL_PROVIDER_ID && result.providerMetadata?.vercelProjectId) {
        for (const sibling of listDeployments(db, req.params.id)) {
          if (!sibling.url?.trim() || sibling.id === body.id || sibling.providerId !== VERCEL_PROVIDER_ID ||
            sibling.providerMetadata?.vercelProjectId !== result.providerMetadata.vercelProjectId) continue;
          upsertDeployment(db, { ...sibling, status: 'unknown', access: 'unknown',
            statusMessage: 'This site address now points to another entry file. Redeploy this file to replace it.',
            ...(sibling.publicAccess ? { publicAccessOutcome: 'verify-failed' } : {}), updatedAt: now });
        }
      }
      res.json({ ...publicDeployment(body), ...(warnings.length ? { warnings } : {}) });
    } catch (err: any) {
      const status = err instanceof DeployError ? err.status
        : err instanceof TypeError || err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 502 : 400;
      const init =
        err instanceof DeployError && err.details
          ? { details: err.details }
          : {};
      sendApiError(
        res,
        status,
        deployErrorCodeFor(err, status),
        String(err?.message || err),
        init,
      );
    } finally {
      if (ownsPublish) vercelPublishes.delete(req.params.id);
    }
  });

  app.post('/api/projects/:id/deploy/preflight', async (req, res) => {
    try {
      const { fileName, providerId = VERCEL_PROVIDER_ID } = req.body || {};
      if (!isDeployProviderId(providerId)) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'unsupported deploy provider',
        );
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }
      const preflightProject = getProject(db, req.params.id);
      if (!preflightProject) return sendApiError(res, 404, 'NOT_FOUND', 'project not found');
      if (!await ctx.authorizeProjectRequest(req, res, req.params.id, { mode: 'read' })) return;
      /** @type {import('@open-design/contracts').DeployPreflightResponse} */
      const body = await prepareDeployPreflight(
        PROJECTS_DIR,
        req.params.id,
        fileName,
        { metadata: preflightProject.metadata, providerId, requireAgencySiteScope: preflightProject.skillId === 'agency-site' },
      );
      res.json(body);
    } catch (err: any) {
      // DeployError is a known/expected outcome (validation, missing file).
      // Anything else points at a bug or an unexpected runtime state, so
      // surface it in the daemon log without leaking internals to the
      // client which still gets a generic 400.
      if (!(err instanceof DeployError)) {
        console.error('[deploy/preflight]', err);
      }
      const status = err instanceof DeployError ? err.status : 400;
      sendApiError(
        res,
        status,
        deployErrorCodeFor(err, status),
        String(err?.message || err),
      );
    }
  });

}

export interface RegisterDeploymentCheckRoutesDeps extends RouteDeps<'db' | 'http' | 'deploy' | 'projectStore'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
}

export function registerDeploymentCheckRoutes(app: Express, ctx: RegisterDeploymentCheckRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { getProject } = ctx.projectStore;
  const { getDeploymentById, CLOUDFLARE_PAGES_PROVIDER_ID, VERCEL_PROVIDER_ID, cloudflarePagesProjectNameFromDeployment, checkCloudflarePagesDeploymentLinks, checkDeploymentUrl, recheckVercelLink, recheckVercelPublicAccessLink, upsertDeployment, publicDeployment } = ctx.deploy;

  app.post(
    '/api/projects/:id/deployments/:deploymentId/check-link',
    async (req, res) => {
      try {
        if (!getProject(db, req.params.id)) {
          return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        }
        if (!await ctx.authorizeProjectRequest(
          req,
          res,
          req.params.id,
          { mode: 'write', capability: 'writeFiles' },
        )) return;
        const existing = getDeploymentById(
          db,
          req.params.id,
          req.params.deploymentId,
        );
        if (!existing) {
          return sendApiError(
            res,
            404,
            'FILE_NOT_FOUND',
            'deployment not found',
          );
        }
        const stableCloudflareProjectName =
          existing.providerId === CLOUDFLARE_PAGES_PROVIDER_ID
            ? cloudflarePagesProjectNameFromDeployment(existing)
            : '';
        if (existing.providerId === CLOUDFLARE_PAGES_PROVIDER_ID && existing.cloudflarePages?.pagesDev?.url) {
          const checked = await checkCloudflarePagesDeploymentLinks(existing);
          const now = Date.now();
          /** @type {import('@open-design/contracts').CheckDeploymentLinkResponse} */
          const body = upsertDeployment(db, {
            ...existing,
            ...checked,
            reachableAt: checked.status === 'ready' ? now : existing.reachableAt,
            updatedAt: now,
          });
          return res.json(publicDeployment(body));
        }
        // A deployment made with "Make preview public" is re-verified, not
        // merely re-probed: the usual cause of its `protected` result is
        // Vercel's edge still catching up, and the honest answer needs the
        // project's current protection settings, not just the URL. It
        // re-reads and re-probes; it never writes.
        if (existing.providerId === VERCEL_PROVIDER_ID && existing.publicAccess === true) {
          const rechecked = await recheckVercelPublicAccessLink({
            odProjectId: req.params.id,
            priorMetadata: existing.providerMetadata,
            deploymentId: existing.deploymentId,
            vercelProjectId: String(
              (existing.providerMetadata as { vercelProjectId?: unknown } | undefined)?.vercelProjectId ?? '',
            ),
            url: existing.url,
            pageMarker: storedPageMarker(existing),
          });
          const recheckedAt = Date.now();
          /** @type {import('@open-design/contracts').CheckDeploymentLinkResponse} */
          const recheckedBody = upsertDeployment(db, {
            ...existing,
            url: rechecked.url || existing.url,
            status: rechecked.status,
            statusMessage: rechecked.statusMessage,
            access: rechecked.access,
            publicAccessOutcome: rechecked.outcome,
            reachableAt: rechecked.reachableAt ?? existing.reachableAt,
            updatedAt: recheckedAt,
          });
          return res.json(publicDeployment(recheckedBody));
        }
        // A Vercel deployment made WITHOUT "Make preview public": a 200 or a
        // redirect says the URL answered, not that anyone can open it, so the
        // project's protection is re-read (GET only; this never changes a
        // setting) before the link may be called public.
        if (existing.providerId === VERCEL_PROVIDER_ID) {
          const rechecked = await recheckVercelLink({
            priorMetadata: existing.providerMetadata,
            deploymentId: existing.deploymentId,
            vercelProjectId: String(
              (existing.providerMetadata as { vercelProjectId?: unknown } | undefined)?.vercelProjectId ?? '',
            ),
            url: existing.url,
            pageMarker: storedPageMarker(existing),
          });
          const recheckedAt = Date.now();
          /** @type {import('@open-design/contracts').CheckDeploymentLinkResponse} */
          const recheckedBody = upsertDeployment(db, {
            ...existing,
            url: rechecked.url || existing.url,
            status: rechecked.status,
            statusMessage: rechecked.statusMessage,
            access: rechecked.access,
            reachableAt: rechecked.reachableAt ?? existing.reachableAt,
            updatedAt: recheckedAt,
          });
          return res.json(publicDeployment(recheckedBody));
        }
        const checkUrl = stableCloudflareProjectName
          ? `https://${stableCloudflareProjectName}.pages.dev`
          : existing.url;
        const result = await checkDeploymentUrl(checkUrl);
        const now = Date.now();
        const linkStatus = result.reachable ? 'ready' : result.status || 'link-delayed';
        // Only Cloudflare Pages reaches here (Vercel returned above). A
        // reachable link is public only when an anonymous request reached a
        // final 2xx on the same host; a bare redirect (a Cloudflare Access
        // login, say) leaves it unknown.
        const access = await resolveCloudflarePagesAccess({
          url: checkUrl,
          linkStatus,
          marker: parsePageMarker(storedPageMarker(existing)),
        });
        /** @type {import('@open-design/contracts').CheckDeploymentLinkResponse} */
        const body = upsertDeployment(db, {
          ...existing,
          url: checkUrl || existing.url,
          status: linkStatus,
          statusMessage: deployLinkSentence({
            access,
            status: linkStatus,
            fallback: result.statusMessage || 'The deployment provider is still preparing the link.',
          }),
          access,
          reachableAt: result.reachable ? now : existing.reachableAt,
          updatedAt: now,
        });
        res.json(publicDeployment(body));
      } catch (err: any) {
        sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
      }
    },
  );

}
