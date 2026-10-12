import type Database from 'better-sqlite3';
import {
  aggregateCloudflarePagesStatus,
  checkDeploymentUrl,
  cloudflarePagesProjectNameForProject,
  deployLinkSentence,
  CLOUDFLARE_PAGES_PROVIDER_ID,
  readCloudflarePagesDomain,
  vercelProjectNameForProject,
  parsePageMarker,
  readDeployConfig,
  resolveCloudflarePagesAccess,
} from '../deploy.js';
import { listDeployments } from '../db.js';

type JsonObject = Record<string, unknown>;

export interface DeploymentLike {
  providerId?: string | null;
  url?: string | null;
  providerMetadata?: JsonObject | null;
  cloudflarePages?: JsonObject | null;
  [key: string]: unknown;
}

const CLOUDFLARE_PAGES_PROJECT_METADATA_KEY = 'cloudflarePagesProjectName';

export function cloudflarePagesDeploymentMetadata(projectName: string | null | undefined): JsonObject | undefined {
  const normalized = typeof projectName === 'string' ? projectName.trim() : '';
  return normalized
    ? { [CLOUDFLARE_PAGES_PROJECT_METADATA_KEY]: normalized }
    : undefined;
}

export function cloudflarePagesProjectNameFromDeployment(deployment: DeploymentLike | null | undefined): string {
  const value = deployment?.providerMetadata?.[CLOUDFLARE_PAGES_PROJECT_METADATA_KEY];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return cloudflarePagesProjectNameFromUrl(deployment?.url);
}

function cloudflarePagesProjectNameFromUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (!host.endsWith('.pages.dev')) return '';
    const labels = host.slice(0, -'.pages.dev'.length).split('.').filter(Boolean);
    return labels.at(-1) || '';
  } catch {
    return '';
  }
}

export function cloudflarePagesProjectNameForDeploy(
  db: Database.Database,
  projectId: string,
  projectName: string,
  prior: DeploymentLike | null | undefined,
): string {
  const priorName = cloudflarePagesProjectNameFromDeployment(prior);
  if (priorName) return priorName;

  for (const deployment of listDeployments(db, projectId) as DeploymentLike[]) {
    if (deployment.providerId !== CLOUDFLARE_PAGES_PROVIDER_ID) continue;
    const stableName = cloudflarePagesProjectNameFromDeployment(deployment);
    if (stableName) return stableName;
  }

  return cloudflarePagesProjectNameForProject(projectId, projectName);
}

export function publicDeployment<T extends DeploymentLike>(deployment: T): Omit<T, 'providerMetadata'>;
export function publicDeployment<T>(deployment: T): T;
export function publicDeployment(deployment: unknown): unknown {
  if (!deployment || typeof deployment !== 'object') return deployment;
  const { providerMetadata: _providerMetadata, ...publicShape } = deployment as DeploymentLike;
  if (publicShape.providerId === 'vercel-self' && !publicShape.vercel && typeof publicShape.projectId === 'string') {
    const projectName = typeof _providerMetadata?.vercelProjectName === 'string' ? _providerMetadata.vercelProjectName : vercelProjectNameForProject(publicShape.projectId);
    return { ...publicShape, vercel: { bindingVerified: Boolean(_providerMetadata?.vercelProjectId), projectName, requestedAddress: `${projectName}.vercel.app` } };
  }
  return publicShape;
}

export function publicDeployments<T extends DeploymentLike>(deployments: readonly T[] | null | undefined): Array<Omit<T, 'providerMetadata'>> {
  // Provider bindings are durable retry state, not deployed links. Also hide
  // empty-URL records written before the binding status was introduced.
  return (deployments || [])
    .filter((deployment) => deployment.status !== 'binding' && Boolean(deployment.url?.trim()))
    .map((deployment) => publicDeployment(deployment));
}

export async function checkCloudflarePagesDeploymentLinks(existing: DeploymentLike): Promise<DeploymentLike> {
  const current = isRecord(existing.cloudflarePages) ? existing.cloudflarePages : {};
  const projectName = stringValue(current.projectName) || cloudflarePagesProjectNameFromDeployment(existing);
  const config = await readDeployConfig(CLOUDFLARE_PAGES_PROVIDER_ID);
  const pagesDevUrl = stringValue(asRecord(current.pagesDev)?.url) || existing.url;
  // The page this deployment uploaded; without it no GET can prove `public`.
  const pageMarker = parsePageMarker(existing.providerMetadata?.pageMarker);
  const pagesDevResult = await checkDeploymentUrl(pagesDevUrl);
  const pagesDevStatus = pagesDevResult.reachable ? 'ready' : pagesDevResult.status || 'link-delayed';
  const pagesDevAccess = await resolveCloudflarePagesAccess({
    url: pagesDevUrl,
    linkStatus: pagesDevStatus,
    marker: pageMarker,
  });
  const pagesDev = {
    ...(asRecord(current.pagesDev) ?? {}),
    url: pagesDevUrl,
    status: pagesDevStatus,
    statusMessage: deployLinkSentence({
      access: pagesDevAccess,
      status: pagesDevStatus,
      fallback: pagesDevResult.statusMessage || stringValue(asRecord(current.pagesDev)?.statusMessage) || 'Cloudflare Pages is still preparing the pages.dev link.',
    }),
    access: pagesDevAccess,
    reachableAt: pagesDevResult.reachable ? Date.now() : asRecord(current.pagesDev)?.reachableAt,
  };
  let customDomain = asRecord(current.customDomain);
  if (customDomain?.url && customDomain.status !== 'conflict') {
    let pagesDomain: JsonObject | null = null;
    if (config?.token && config?.accountId && projectName) {
      try {
        pagesDomain = await readCloudflarePagesDomain({ ...config, projectName }, stringValue(customDomain.hostname));
      } catch {
        pagesDomain = null;
      }
    }
    const customResult = await checkDeploymentUrl(customDomain.url);
    const pagesDomainStatus = pagesDomain?.status || customDomain.pagesDomainStatus;
    const failedByApi = ['error', 'blocked', 'deactivated'].includes(String(pagesDomainStatus || '').toLowerCase());
    const activeByApi = String(pagesDomainStatus || '').toLowerCase() === 'active';
    const readyByReachability = customResult.reachable && activeByApi;
    // Its own anonymous GET, never the pages.dev answer: an Access policy
    // can cover the custom hostname while pages.dev stays open.
    const customAccess = readyByReachability
      ? await resolveCloudflarePagesAccess({ url: customDomain.url, linkStatus: 'ready', marker: pageMarker })
      : 'unknown';
    customDomain = {
      ...customDomain,
      access: customAccess,
      domainStatus: pagesDomain
        ? pagesDomain.status === 'active'
          ? 'active'
          : failedByApi
            ? 'failed'
            : 'pending'
        : customDomain.domainStatus,
      pagesDomainStatus,
      validationData: pagesDomain?.validation_data ?? customDomain.validationData,
      verificationData: pagesDomain?.verification_data ?? customDomain.verificationData,
      status: readyByReachability
        ? 'ready'
        : customDomain.status === 'failed' || failedByApi
          ? 'failed'
          : 'pending',
      statusMessage: readyByReachability
        ? 'Custom domain is ready.'
        : failedByApi
          ? 'Cloudflare Pages reported a custom-domain error.'
          : customResult.statusMessage || stringValue(customDomain.statusMessage) || 'Custom domain is still being prepared.',
    };
  }
  const cloudflarePages = {
    ...current,
    projectName,
    pagesDev,
    ...(customDomain ? { customDomain } : {}),
  };
  const aggregate = aggregateCloudflarePagesStatus(pagesDev, customDomain ?? undefined);
  return {
    url: stringValue(pagesDev.url),
    status: aggregate.status,
    statusMessage: aggregate.statusMessage,
    access: pagesDevAccess,
    cloudflarePages,
    providerMetadata: {
      ...(existing.providerMetadata || {}),
      cloudflarePages,
    },
  };
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): JsonObject | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
