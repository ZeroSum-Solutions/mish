import { validateVercelProjectName, vercelSiteNameSuggestion, type VercelDeploymentInfo, type VercelNameCheckResponse } from '@open-design/contracts';
import { DeployError, vercelProjectNameForProject } from '../deploy.js';

type Config = { token: string; teamId?: string | undefined; teamSlug?: string | undefined };
type Json = Record<string, any>;
export type VercelBinding = { vercelProjectId: string; vercelProjectName: string; vercelAccountId: string; vercelTeamId: string | null; vercelTeamSelection: string; vercel?: VercelDeploymentInfo };

export async function vercelSiteRequest(config: Config, endpoint: string, method = 'GET', body?: unknown) {
  const query = new URLSearchParams(config.teamId ? { teamId: config.teamId } : config.teamSlug ? { slug: config.teamSlug } : {});
  const response = await fetch(`https://api.vercel.com${endpoint}${query.size ? `${endpoint.includes('?') ? '&' : '?'}${query}` : ''}`, {
    method, headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8_000),
  });
  const json = await response.json().catch(() => null) as Json | null;
  if (!json || typeof json !== 'object') throw new DeployError('Vercel returned an invalid response.', 502, undefined, 'VERCEL_BAD_RESPONSE');
  return { ok: response.ok, status: response.status, json };
}

function taken(name: string) {
  return new DeployError(`The Vercel site name "${name}" is taken. Try "${vercelSiteNameSuggestion(name, '2')}".`, 409,
    { name, suggestion: vercelSiteNameSuggestion(name, '2') }, 'VERCEL_NAME_TAKEN');
}
function requireOk(result: Awaited<ReturnType<typeof vercelSiteRequest>>, name?: string) {
  if (result.ok) return result.json;
  if (name && (result.status === 409 || result.json.error?.code === 'project_name_taken' || result.json.error?.code === 'project_already_exists')) throw taken(name);
  throw new DeployError(result.json.error?.message || `Vercel request failed (${result.status}).`, result.status);
}
function identityMismatch(): never {
  throw new DeployError('The saved Vercel project does not match this name or provider account/team. Keep the saved name and account settings.', 409, undefined, 'VERCEL_IDENTITY_MISMATCH');
}

export async function checkVercelName(config: Config, name: string, prior?: Json): Promise<VercelNameCheckResponse> {
  const validation = validateVercelProjectName(name);
  if (!validation.valid) return { name, ...validation, advisory: true, suggestion: vercelSiteNameSuggestion(name) };
  if (!config.token) throw new DeployError('Vercel token is required.', 400, undefined, 'VERCEL_TOKEN_REQUIRED');
  const found = await vercelSiteRequest(config, `/v9/projects/${encodeURIComponent(name)}`);
  if (found.status === 404) return { name, valid: true, available: true, advisory: true };
  const project = requireOk(found);
  const owned = prior && prior.vercelProjectId === project.id && (!prior.vercelAccountId || prior.vercelAccountId === project.accountId)
    && (!prior.vercelProjectName || prior.vercelProjectName === project.name);
  return { name, valid: true, available: Boolean(owned), advisory: true, ...(owned ? {} : { reason: 'taken', suggestion: vercelSiteNameSuggestion(name, '2') }) };
}

/** Only a successful create or a persisted provider ID permits linking a project. */
export async function bindVercelSite(config: Config, projectId: string, requested?: string, prior?: Json): Promise<VercelBinding> {
  const selection = config.teamId ? `id:${config.teamId}` : config.teamSlug ? `slug:${config.teamSlug}` : '';
  if (prior?.vercelTeamSelection && !selection) identityMismatch();
  const name = requested ?? prior?.vercelProjectName ?? vercelProjectNameForProject(projectId);
  // Legacy names can exceed the DNS-label limit. Keep them only for saved projects.
  if (!(prior?.vercelProjectId && !prior.vercelProjectName && name === vercelProjectNameForProject(projectId)) && !validateVercelProjectName(name).valid) {
    throw new DeployError('Enter a lowercase site name of 1–63 letters, digits or hyphens, without edge hyphens or three consecutive hyphens. Reserved names cannot be used.', 400,
      { suggestion: vercelSiteNameSuggestion(String(name)) }, 'VERCEL_NAME_INVALID');
  }
  let project: Json;
  if (prior?.vercelProjectId) {
    if (prior.vercelProjectName && prior.vercelProjectName !== name) identityMismatch();
    project = requireOk(await vercelSiteRequest(config, `/v9/projects/${encodeURIComponent(prior.vercelProjectId)}`));
    if (project.id !== prior.vercelProjectId || project.name !== name || (prior.vercelAccountId && project.accountId !== prior.vercelAccountId)) identityMismatch();
  } else {
    const hint = await checkVercelName(config, name);
    if (!hint.available) throw taken(name);
    // A race between GET and POST must fail. Never fetch-and-adopt after a 409.
    project = requireOk(await vercelSiteRequest(config, '/v11/projects', 'POST', { name, framework: null }), name);
  }
  if (typeof project.id !== 'string' || !project.id || project.name !== name || typeof project.accountId !== 'string' || !project.accountId) identityMismatch();
  const teamId = project.accountId.startsWith('team_') ? project.accountId : null;
  if ((config.teamId && teamId !== config.teamId) || (config.teamSlug && !teamId) || (prior?.vercelTeamId !== undefined && prior.vercelTeamId !== teamId)) identityMismatch();
  return { vercelProjectId: project.id, vercelProjectName: name, vercelAccountId: project.accountId, vercelTeamId: teamId, vercelTeamSelection: selection,
    ...(prior?.vercel ? { vercel: prior.vercel } : {}) };
}

/** Provider aliases and project domains are discovery data, never computed URLs. */
export async function bindVercelStableAlias(config: Config, binding: VercelBinding, deploymentId: string, immutableUrl: string, returnedAliases: unknown[] = []): Promise<VercelDeploymentInfo> {
  const domains: Json[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: '100', ...(cursor ? { until: cursor } : {}) });
    const result = await vercelSiteRequest(config, `/v9/projects/${encodeURIComponent(binding.vercelProjectId)}/domains?${query}`);
    // Tokens may read deployments but not project domains. A returned alias can
    // still be checked through the alias API; a domain-read denial reserves nothing.
    if (!result.ok && [403, 404].includes(result.status)) break;
    const data = requireOk(result);
    if (Array.isArray(data.domains)) domains.push(...data.domains);
    const next = data.pagination?.next;
    if (next === undefined || next === null) break;
    cursor = String(next);
    if (seen.has(cursor) || page === 99) throw new DeployError('Vercel domain pagination could not be completed.', 502, undefined, 'VERCEL_ALIAS_UNVERIFIED');
    seen.add(cursor);
  }
  const excluded = new Set(domains.filter(d => d.redirect || d.gitBranch || d.customEnvironmentId || d.verified === false).map(d => d.name));
  const eligible = (name: unknown): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9-]*\.vercel\.app$/.test(name)
    && `https://${name}` !== immutableUrl && !excluded.has(name);
  const candidates = domains.filter(d => !d.redirect && !d.gitBranch && !d.customEnvironmentId && d.verified !== false).map(d => d.name).filter(eligible);
  const requestedAddress = `${binding.vercelProjectName}.vercel.app`;
  const saved = binding.vercel?.assignedAlias;
  let alias = saved || (candidates.includes(requestedAddress) ? requestedAddress : candidates[0]);
  if (!alias) {
    const aliases = requireOk(await vercelSiteRequest(config, `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`));
    const returned = [...returnedAliases, ...(Array.isArray(aliases.aliases) ? aliases.aliases.map((a: Json) => a.alias) : [])].filter(eligible);
    alias = returned.includes(requestedAddress) ? requestedAddress : returned[0];
  }
  if (!eligible(alias)) throw new DeployError('Vercel has not assigned a stable site address yet. Retry the deployment.', 502, undefined, 'VERCEL_ALIAS_UNVERIFIED');
  if (!candidates.includes(alias)) {
    const detail = await vercelSiteRequest(config, `/v9/projects/${encodeURIComponent(binding.vercelProjectId)}/domains/${encodeURIComponent(alias)}`);
    if (!detail.ok || detail.json.name !== alias || detail.json.projectId !== binding.vercelProjectId ||
      detail.json.verified !== true || detail.json.redirect || detail.json.gitBranch || detail.json.customEnvironmentId) {
      throw new DeployError('Vercel could not verify this address as a stable project domain.', 502, undefined, 'VERCEL_ALIAS_UNVERIFIED');
    }
  }
  const endpoint = `/v4/aliases/${encodeURIComponent(alias)}`;
  const current = await vercelSiteRequest(config, endpoint);
  if (current.ok && current.json.projectId !== binding.vercelProjectId) identityMismatch();
  if (!current.ok && current.status !== 404) requireOk(current);
  // A saved alias can be reused only while Vercel still reports it on our project.
  if (!current.ok && !candidates.includes(alias)) throw new DeployError('The saved Vercel alias is no longer assigned to this project.', 502, undefined, 'VERCEL_ALIAS_UNVERIFIED');
  let assignmentError: unknown;
  if (!current.ok || (current.json.deploymentId || current.json.deployment?.id) !== deploymentId) {
    try { requireOk(await vercelSiteRequest(config, `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`, 'POST', { alias })); }
    catch (error) { assignmentError = error; }
  }
  // Always read back: a lost POST response can still have applied the assignment.
  const verified = requireOk(await vercelSiteRequest(config, endpoint));
  if (verified.alias !== alias || verified.projectId !== binding.vercelProjectId || (verified.deploymentId || verified.deployment?.id) !== deploymentId) {
    if (assignmentError) throw assignmentError;
    throw new DeployError('The stable Vercel address is not bound to this deployment. Retry the deployment.', 502, undefined, 'VERCEL_ALIAS_UNVERIFIED');
  }
  return { projectName: binding.vercelProjectName, requestedAddress, assignedAlias: alias,
    stableUrl: `https://${alias}`, deploymentUrl: immutableUrl, bindingVerified: true };
}

/** Link checks never move an alias; an old record must not roll back a newer publish. */
export async function verifyVercelStoredAlias(config: Config, metadata: Json, deploymentId: string, url: string): Promise<void> {
  const alias = metadata.vercel?.assignedAlias;
  if (!alias || url !== `https://${alias}`) throw new DeployError('The stored Vercel alias is not verified.', 502, undefined, 'VERCEL_ALIAS_UNVERIFIED');
  const current = requireOk(await vercelSiteRequest(config, `/v4/aliases/${encodeURIComponent(alias)}`));
  if (current.alias !== alias || current.projectId !== metadata.vercelProjectId || (current.deploymentId || current.deployment?.id) !== deploymentId) {
    throw new DeployError('The stable Vercel address now points to another deployment.', 409, undefined, 'VERCEL_ALIAS_UNVERIFIED');
  }
}
