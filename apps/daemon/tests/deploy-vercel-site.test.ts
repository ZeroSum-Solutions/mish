import { afterEach, describe, expect, it, vi } from 'vitest';
import { deployToVercel, vercelProjectNameForProject } from '../src/deploy.js';

const page = '<!doctype html><h1>Newest bakery page</h1>';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const prior = { vercelProjectId: 'prj_ours', vercelProjectName: 'bobs-bakery', vercelAccountId: 'team_ours', vercelTeamId: 'team_ours', vercel: { projectName: 'bobs-bakery', requestedAddress: 'bobs-bakery.vercel.app', assignedAlias: 'bobs-bakery-actual.vercel.app', stableUrl: 'https://bobs-bakery-actual.vercel.app' } };

function provider(options: { taken?: boolean; stale?: boolean; scope?: boolean; mismatch?: boolean; conflict?: boolean; legacy?: boolean; uploadFails?: boolean; assignFails?: boolean; emptyDomains?: boolean; noAlias?: boolean; redirect?: boolean; foreignAlias?: boolean; lostAlias?: boolean; branch?: boolean; paginated?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  let assigned = false;
  const name = options.legacy ? vercelProjectNameForProject('legacy') : options.mismatch ? 'someone-else' : 'bobs-bakery';
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method || 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.includes('/v9/projects/')) {
      if (url.includes('/domains/')) return json({ name: 'bobs-bakery-actual.vercel.app', projectId: 'prj_ours', verified: true, ...(options.branch ? { gitBranch: 'preview-branch' } : {}) });
      if (options.paginated && url.includes('/domains') && !new URL(url).searchParams.has('until')) return json({ domains: [], pagination: { next: 123 } });
      if (url.includes('/domains')) return json({ domains: options.emptyDomains ? [] : [{ name: 'bobs-bakery-actual.vercel.app', ...(options.redirect ? { redirect: 'other.example' } : {}) }] });
      if (url.includes('/bobs-bakery') && !options.taken) return json({}, 404);
      return json({ id: options.taken ? 'prj_other' : 'prj_ours', name, accountId: options.scope ? 'team_other' : 'team_ours', ssoProtection: null, passwordProtection: null });
    }
    if (url.includes('/v11/projects')) return options.conflict ? json({ error: { code: 'project_name_taken' } }, 409) : json({ id: 'prj_ours', name, accountId: 'team_ours' });
    if (url.includes('/v2/files')) return options.uploadFails ? json({ error: { message: 'Upload failed' } }, 503) : json({});
    if (url.includes('/v13/deployments')) return json({ id: 'dpl_new', projectId: 'prj_ours', url: 'bobs-bakery-hash-team.vercel.app', readyState: 'READY', alias: options.noAlias ? [] : ['bobs-bakery-actual.vercel.app'] });
    if (url.includes('/v2/deployments/') && method === 'POST') { if (!options.assignFails) assigned = true; if (options.lostAlias) throw new TypeError('response lost after alias write'); return options.assignFails ? json({ error: { message: 'Alias failed' } }, 503) : json({ alias: 'bobs-bakery-actual.vercel.app' }); }
    if (url.includes('/v2/deployments/')) return json({ aliases: options.noAlias ? [] : [{ alias: 'bobs-bakery-actual.vercel.app' }] });
    if (url.includes('/v4/aliases/')) return json({ alias: 'bobs-bakery-actual.vercel.app', projectId: options.foreignAlias ? 'prj_other' : 'prj_ours', deploymentId: options.stale || !assigned ? 'dpl_old' : 'dpl_new' });
    if (url.startsWith('https://bobs-bakery')) return new Response(init?.method === 'HEAD' ? '' : page, { status: 200, headers: { 'content-type': 'text/html' } });
    throw new Error(`Unexpected provider request ${method} ${url}`);
  }));
  return calls;
}
const input = () => ({ config: { token: 'fake', teamId: 'team_ours' }, files: [{ file: 'index.html', data: page }], projectId: 'bakery', projectName: 'bobs-bakery' });
afterEach(() => vi.unstubAllGlobals());

describe('Vercel site binding and stable alias', () => {
  it('rejects a branch alias discovered outside the project domain list', async () => {
    const calls = provider({ emptyDomains: true, branch: true });
    await expect(deployToVercel(input())).rejects.toMatchObject({ code: 'VERCEL_ALIAS_UNVERIFIED' });
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/aliases'))).toBe(false);
  });
  it('reads the next domain page before choosing a stable alias', async () => {
    const calls = provider({ paginated: true });
    expect((await deployToVercel(input())).url).toBe('https://bobs-bakery-actual.vercel.app');
    expect(calls.some(c => c.url.includes('until=123') && c.url.includes('teamId=team_ours'))).toBe(true);
  });
  it('never adopts a project after a lost create response without a persisted ID', async () => {
    let created = false;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/v9/projects/')) return created ? json({ id: 'prj_ours', name: 'bobs-bakery', accountId: 'team_ours' }) : json({}, 404);
      if (url.includes('/v11/projects') && init?.method === 'POST') { created = true; throw new TypeError('lost response'); }
      throw new Error('Unexpected provider write');
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(deployToVercel(input())).rejects.toThrow('lost response');
    await expect(deployToVercel(input())).rejects.toMatchObject({ code: 'VERCEL_NAME_TAKEN' });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'GET')).toHaveLength(1);
  });
  it('uses returned deployment aliases when the project domain list is empty', async () => {
    provider({ emptyDomains: true });
    expect((await deployToVercel(input())).url).toBe('https://bobs-bakery-actual.vercel.app');
  });
  it('rejects redirect domains even when they appear in the deployment alias list', async () => {
    provider({ redirect: true });
    await expect(deployToVercel(input())).rejects.toMatchObject({ code: 'VERCEL_ALIAS_UNVERIFIED' });
  });
  it('refuses an alias owned by another project before assignment', async () => {
    const calls = provider({ foreignAlias: true });
    await expect(deployToVercel(input())).rejects.toMatchObject({ code: 'VERCEL_IDENTITY_MISMATCH' });
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/aliases'))).toBe(false);
  });
  it('reconciles a lost alias response by reading the assignment back', async () => {
    provider({ lostAlias: true });
    expect((await deployToVercel(input())).url).toBe('https://bobs-bakery-actual.vercel.app');
  });
  it('refuses cleared team settings before a provider mutation', async () => {
    const calls = provider();
    await expect(deployToVercel({ ...input(), config: { token: 'fake' }, priorMetadata: { ...prior, vercelTeamSelection: 'id:team_ours' } })).rejects.toMatchObject({ code: 'VERCEL_IDENTITY_MISMATCH' });
    expect(calls).toHaveLength(0);
  });
  it('refuses an existing unowned project before upload or protection writes', async () => {
    const calls = provider({ taken: true });
    await expect(deployToVercel({ ...input(), publicAccess: true })).rejects.toMatchObject({ code: 'VERCEL_NAME_TAKEN', details: { suggestion: 'bobs-bakery-2' } });
    expect(calls.some(c => c.method === 'PATCH' || c.url.includes('/files') || c.url.includes('/v13/'))).toBe(false);
  });
  it('types a create-project race conflict', async () => {
    provider({ conflict: true });
    await expect(deployToVercel(input())).rejects.toMatchObject({ status: 409, code: 'VERCEL_NAME_TAKEN' });
  });
  it('stores the provider alias and immutable URL separately on redeploy', async () => {
    const calls = provider();
    const result = await deployToVercel({ ...input(), priorMetadata: prior });
    expect(result.url).toBe('https://bobs-bakery-actual.vercel.app');
    expect(result.providerMetadata).toMatchObject({ vercelProjectId: 'prj_ours', vercelAccountId: 'team_ours', vercelTeamId: 'team_ours', vercel: { stableUrl: result.url, deploymentUrl: 'https://bobs-bakery-hash-team.vercel.app' } });
    expect(calls.find(c => c.method === 'POST' && c.url.includes('/v13/'))?.body).toMatchObject({ project: 'prj_ours', name: 'bobs-bakery' });
  });
  it('refuses to call an alias on an older deployment ready', async () => {
    provider({ stale: true });
    await expect(deployToVercel({ ...input(), priorMetadata: prior })).rejects.toMatchObject({ code: 'VERCEL_ALIAS_UNVERIFIED' });
  });
  it.each([{ scope: true }, { mismatch: true }])('refuses changed scope or name before any write %j', async (options) => {
    const calls = provider(options);
    await expect(deployToVercel({ ...input(), priorMetadata: prior, publicAccess: true })).rejects.toMatchObject({ code: 'VERCEL_IDENTITY_MISMATCH' });
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('keeps a legacy od name with its stored provider project ID', async () => {
    const calls = provider({ legacy: true });
    await deployToVercel({ ...input(), projectId: 'legacy', projectName: undefined, priorMetadata: { vercelProjectId: 'prj_ours' } });
    expect(calls.find(c => c.method === 'POST' && c.url.includes('/v13/'))?.body?.name).toBe(vercelProjectNameForProject('legacy'));
  });
  it('checkpoints the new provider binding before a failed upload', async () => {
    provider({ uploadFails: true }); const saved = vi.fn();
    await expect(deployToVercel({ ...input(), onBinding: saved })).rejects.toMatchObject({ status: 503 });
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ vercelProjectId: 'prj_ours', vercelProjectName: 'bobs-bakery' }));
  });
  it('does not hide alias-assignment failure behind the hash URL', async () => {
    provider({ assignFails: true });
    await expect(deployToVercel({ ...input(), priorMetadata: prior })).rejects.toMatchObject({ status: 503 });
  });
});
