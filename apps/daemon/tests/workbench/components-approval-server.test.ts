import type { Server } from 'node:http';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { register } from 'prom-client';
import { parseResourceSearchResponse } from '@mish/contracts';
import { designSystemRevision, setDesignSystemApproval, syncPublishedDesignSystemApproval } from '../../src/design-systems/approval.js';
import { createTeamResourceShareService, type TeamResourceRequestScope } from '../../src/collab/team-resource-share.js';
import { materializeWorkspaceScopedTeamResource, teamResourceWorkspaceRoot } from '../../src/collab/team-resource-materialization.js';
import { workspaceTeamDesignSystemBindingResourceId } from '../../src/design-systems/workspace-team-binding.js';

type Started = { url: string; server: Server; shutdown?: () => Promise<void> | void };
let started: Started | undefined;
let root = '';
afterEach(async () => {
  await started?.shutdown?.();
  if (started?.server.listening) await new Promise<void>(done => started!.server.close(() => done()));
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  register.clear();
  vi.resetModules();
});

it('V06 production picker uses V05 approval: refuses draft, missing, unapproved and revoked kits; allows approved kits without acceptance evidence', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'od-v06-approval-'));
  const kits = path.join(root, 'design-systems');
  for (const [id, status] of [['draft', 'draft'], ['unapproved', 'published'], ['approved', 'published']] as const) {
    await mkdir(path.join(kits, id), { recursive: true });
    await writeFile(path.join(kits, id, 'DESIGN.md'), '# Kit');
    await writeFile(path.join(kits, id, 'metadata.json'), JSON.stringify({ title: id, status }));
    if (id !== 'unapproved') await setDesignSystemApproval(kits, id, true, await designSystemRevision(path.join(kits, id)));
  }
  vi.stubEnv('OD_DATA_DIR', root);
  vi.stubEnv('OD_COLLAB_TRANSPORT', 'off');
  vi.stubEnv('OD_RESOURCE_TRANSPORT', 'off');
  vi.stubEnv('OD_TEAM_PROJECTS_TRANSPORT', 'off');
  vi.resetModules();
  const { startServer } = await import('../../src/server.js');
  started = await startServer({ port: 0, returnServer: true }) as Started;
  const created = await fetch(`${started.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'approval-project', name: 'Approval fixture', skillId: null }) });
  expect(created.status).toBe(200);
  const file = await fetch(`${started.url}/api/projects/approval-project/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'index.html', content: '<!doctype html><h1>Approval fixture</h1>' }) });
  expect(file.status).toBe(200);
  const rank = async (kitId: string, kitSourceId = 'design-systems') => {
    const response = await fetch(`${started!.url}/api/workbench/components/rank`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'approval-project', facets: { sourceIds: ['gsap'] }, componentPicker: { kitId, kitSourceId, showAll: true }, limit: 100 }) });
    expect(response.status).toBe(200);
    const body = parseResourceSearchResponse(await response.json());
    const component = body.results.find(item => item.ref.itemId === 'section-entrance-html');
    expect(component).toBeDefined();
    return component!;
  };
  for (const id of ['user:draft', 'user:missing', 'user:unapproved']) {
    expect((await rank(id)).componentFit?.apply).toEqual({ allowed: false, blockers: ['kit-unapproved'] });
  }
  const approved = await rank('user:approved');
  expect(approved.acceptanceEvidence).toBeUndefined();
  expect.soft(approved.componentFit?.apply).toEqual({ allowed: true, blockers: [] });
  expect.soft((await rank('neutral-product')).componentFit?.apply).toEqual({ allowed: true, blockers: [] });
  expect((await rank('neutral-product', 'project-tokens')).componentFit?.apply).toEqual({ allowed: false, blockers: ['kit-unapproved'] });
  await setDesignSystemApproval(kits, 'approved', false, await designSystemRevision(path.join(kits, 'approved')));
  expect((await rank('user:approved')).componentFit?.apply).toEqual({ allowed: false, blockers: ['kit-unapproved'] });
}, 60_000);

it('V06 production picker allows and ranks an approved Team publication while a local revoke wins over later Team approval', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'od-v06-team-approval-'));
  const id = 'user:team-kit';
  const workspaceId = 'approval-team';
  const memberId = 'approval-member';
  const scope: TeamResourceRequestScope = {
    principal: { teamId: workspaceId, memberId, role: 'owner', lifecycleState: 'active', workspaceType: 'team' },
    canShare: true,
  };
  const publisherRoot = path.join(root, 'publisher');
  const publisherDir = path.join(publisherRoot, 'team-kit');
  const kits = path.join(root, 'design-systems');
  const teamRoot = teamResourceWorkspaceRoot(kits, workspaceId);
  await mkdir(publisherDir, { recursive: true });
  await writeFile(path.join(publisherDir, 'DESIGN.md'), '# Approved Team kit');
  await writeFile(path.join(publisherDir, 'metadata.json'), JSON.stringify({ title: 'Team kit', status: 'published' }));
  await writeFile(path.join(publisherDir, 'tokens.css'), ':root { --od-recipe-accent: #123456; --od-recipe-on-accent: #ffffff; --radius: 8px; --font-size-body: 16px; }');
  const revision = await designSystemRevision(publisherDir);
  await setDesignSystemApproval(publisherRoot, id, true, revision);

  // Only the outer Vela transport is faked; publication and Team record parsing are real.
  let publishedMetadata: Record<string, unknown> = {};
  const share = createTeamResourceShareService({
    kind: 'design_system', idPrefix: 'ds', resolveDir: () => publisherDir,
    describeResource: () => ({ localId: id, approvedDesignSystemRevision: revision }),
    env: { OD_WORKSPACE_CONTEXT_SOURCE: 'vela' },
    run: async (args, requestedWorkspaceId) => {
      expect(requestedWorkspaceId).toBe(workspaceId);
      if (args[0] === 'push') {
        expect(args.slice(1, 4)).toEqual(['design_system', 'ds-approval-team-user-team-kit', publisherDir]);
        publishedMetadata = JSON.parse(args[args.indexOf('--metadata-json') + 1]!);
        return JSON.stringify({ version: 1, id: 'team-version-1' });
      }
      if (args[0] === 'shared') return JSON.stringify({ resources: [{
        id: 'ds-approval-team-user-team-kit', kind: 'design_system', ownerMemberId: memberId,
        metadata: publishedMetadata, publishedVersion: { id: 'team-version-1', version: 1 },
      }] });
      throw new Error(`Unexpected Vela operation: ${args[0]}`);
    },
  });
  await expect(share.share(id, scope)).resolves.toMatchObject({ version: 1 });
  const [published] = await share.sharedResources(scope, { authoritative: true });
  expect(published).toMatchObject({ id, approvedDesignSystemRevision: revision });
  await materializeWorkspaceScopedTeamResource({
    kindRoot: kits, storageName: 'team-kit',
    identity: { kind: 'design_system', workspaceId, resourceId: id, hubResourceId: published!.hubResourceId! },
    pullInto: async dir => {
      await cp(publisherDir, dir, { recursive: true });
      await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ title: 'Team kit', status: 'published', teamSynced: true, workspaceId }));
    },
    verifyWorkspaceScope: async () => true, verifyStillShared: async () => true,
  });
  await syncPublishedDesignSystemApproval(teamRoot, id, published!.approvedDesignSystemRevision);

  vi.stubEnv('OD_DATA_DIR', root);
  vi.stubEnv('OD_WORKSPACE_CONTEXT_SOURCE', 'local');
  vi.stubEnv('OD_COLLAB_TRANSPORT', 'off');
  vi.stubEnv('OD_RESOURCE_TRANSPORT', 'off');
  vi.stubEnv('OD_TEAM_PROJECTS_TRANSPORT', 'off');
  vi.resetModules();
  const { startServer } = await import('../../src/server.js');
  started = await startServer({ port: 0, returnServer: true }) as Started;
  const { openDatabase, ensureWorkspaceResource } = await import('../../src/db.js');
  ensureWorkspaceResource(openDatabase(root, { dataDir: root }), 'design_system', workspaceId,
    workspaceTeamDesignSystemBindingResourceId(workspaceId, id), { visibility: 'team', resourceState: 'active' });
  // Local fixture mode supplies static membership; all catalogue and approval wiring is production code.
  const headers = { 'content-type': 'application/json', 'x-od-workspace-id': workspaceId, 'x-od-workspace-member-id': memberId, 'x-od-workspace-type': 'team', 'x-od-workspace-role': 'owner' };
  const created = await fetch(`${started.url}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ id: 'team-approval-project', name: 'Team approval fixture', skillId: null }) });
  expect(created.status).toBe(200);
  const file = await fetch(`${started.url}/api/projects/team-approval-project/files`, { method: 'POST', headers, body: JSON.stringify({ name: 'index.html', content: '<!doctype html><h1>Team approval fixture</h1>' }) });
  expect(file.status).toBe(200);
  const rank = async () => {
    const response = await fetch(`${started!.url}/api/workbench/components/rank`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'team-approval-project', facets: { sourceIds: ['gsap'] }, componentPicker: { kitId: id, kitSourceId: 'design-systems', showAll: true }, limit: 100 }) });
    expect(response.status).toBe(200);
    return parseResourceSearchResponse(await response.json());
  };
  const ranked = await rank();
  expect(ranked.componentRanking).toMatchObject({ kitId: id, kitSourceId: 'design-systems', reason: null });
  expect(ranked.componentRanking?.kitRevisionOrDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  const htmlIndex = ranked.results.findIndex(item => item.ref.itemId === 'section-entrance-html');
  const reactIndex = ranked.results.findIndex(item => item.ref.itemId === 'section-entrance-react');
  expect(htmlIndex).toBeGreaterThanOrEqual(0);
  expect(reactIndex).toBeGreaterThan(htmlIndex);
  expect(ranked.results[htmlIndex]!.componentFit).toMatchObject({ kitId: id, score: 0, apply: { allowed: true, blockers: [] } });
  expect(ranked.results[reactIndex]!.componentFit?.apply.allowed).toBe(false);
  const blockedEarlierTitleIndex = ranked.results.findIndex(item => item.ref.itemId === 'flip-filter-react');
  expect(blockedEarlierTitleIndex).toBeGreaterThan(htmlIndex);
  expect(ranked.results[blockedEarlierTitleIndex]!.componentFit?.apply.allowed).toBe(false);

  await setDesignSystemApproval(teamRoot, id, false, revision, path.join(teamRoot, '.local'));
  await syncPublishedDesignSystemApproval(teamRoot, id, published!.approvedDesignSystemRevision);
  const revoked = await rank();
  expect(revoked.results.find(item => item.ref.itemId === 'section-entrance-html')?.componentFit?.apply)
    .toEqual({ allowed: false, blockers: ['kit-unapproved'] });
  const revokedReactIndex = revoked.results.findIndex(item => item.ref.itemId === 'flip-filter-react');
  const revokedHtmlIndex = revoked.results.findIndex(item => item.ref.itemId === 'section-entrance-html');
  expect(revokedReactIndex).toBeGreaterThanOrEqual(0);
  expect(revokedHtmlIndex).toBeGreaterThan(revokedReactIndex);
}, 60_000);
