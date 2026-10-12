/** Extra provider APIs required by the site binding layer, shared by the older
 * protection-focused fixtures. The dedicated site tests assert these calls. */
const projects = new Map<string, { name: string; accountId: string }>();
const aliases = new Map<string, { projectId: string; deploymentId: string }>();
export function resetVercelSiteProviderFixtures() { aliases.clear(); projects.clear(); }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
type Options = { projectId: string; deploymentId: string; host: string };
export function withVercelSiteProvider(mock: typeof fetch, options?: Options): typeof fetch {
  let projectName = '';
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const parsed = new URL(url);
    const method = init?.method || 'GET';
    const accountId = parsed.searchParams.get('teamId') || 'fixture_account';
    if (options) {
      aliases.set(options.host, { projectId: options.projectId, deploymentId: options.deploymentId });
      if (parsed.hostname === 'api.vercel.com') {
        if (parsed.pathname.startsWith('/v9/projects/od-')) {
          projectName = decodeURIComponent(parsed.pathname.split('/').pop()!);
          return json({}, 404);
        }
        if (parsed.pathname === '/v11/projects') {
          projectName = JSON.parse(String(init?.body)).name;
          projects.set(options.projectId, { name: projectName, accountId });
          return json({ id: options.projectId, name: projectName, accountId });
        }
        if (parsed.pathname.endsWith('/domains')) return json({ domains: [{ name: options.host }] });
        if (parsed.pathname.startsWith('/v2/deployments/') && parsed.pathname.endsWith('/aliases') && method === 'GET') {
          return json({ aliases: options.host ? [{ alias: options.host }] : [] });
        }
      }
    }
    if (parsed.hostname === 'api.vercel.com' && parsed.pathname.startsWith('/v4/aliases/')) {
      const alias = decodeURIComponent(parsed.pathname.split('/').pop()!);
      const binding = aliases.get(alias);
      if (binding) return json({ alias, ...binding });
    }
    const response = await mock(input, init);
    if (parsed.hostname !== 'api.vercel.com' || !response.ok) return response;
    if (!(response instanceof Response)) return response;
    const payload = await response.clone().json().catch(() => null) as Record<string, any> | null;
    if (payload?.readyState && options) {
      return json({ ...payload, projectId: payload.projectId || options.projectId, url: `hash-${options.host}` });
    }
    if (payload?.id && (Object.hasOwn(payload, 'ssoProtection') || Object.hasOwn(payload, 'passwordProtection'))) {
      return json({ accountId, ...projects.get(payload.id), ...payload });
    }
    return response;
  };
}
