import express from 'express';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseResourceDetailResponse, parseResourceSearchResponse, type ResourceResult } from '@mish/contracts';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { createLocalResourceSources } from '../../src/workbench/resources.js';
import { listOwnedDesignSystemKits, type OwnedKitListerDeps } from '../../src/workbench/resources-user-design-systems.js';

/** USER design-systems directory fixture: alpha belongs to member A, beta to member B,
 * gamma was never claimed, and escape is a symlink to a kit outside the directory. */
function userRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'od-b52-user-ds-'));
  const kit = (dir: string, title: string, css: string) => {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, 'DESIGN.md'), `# ${title}\n\nPrimary #0b5f66 on #ffffff.\n`);
    writeFileSync(path.join(root, dir, 'tokens.css'), css);
  };
  kit('alpha', 'Alpha Clinic', ':root { --color-bg: #ffffff; --color-text: #111111; --space-2: 8px; }');
  kit('beta', 'Beta Private', ':root { --color-bg: #000000; --color-text: #fafafa; --text-base: 1rem; }');
  kit('gamma', 'Gamma Local', ':root { --color-surface: #ffffff; }');
  const outside = mkdtempSync(path.join(tmpdir(), 'od-b52-outside-'));
  mkdirSync(path.join(outside, 'escape'));
  writeFileSync(path.join(outside, 'escape', 'DESIGN.md'), '# Escape\n');
  symlinkSync(path.join(outside, 'escape'), path.join(root, 'escape'));
  return root;
}
const owners: Record<string, string | null> = { 'user:alpha': 'member-a', 'user:beta': 'member-b', 'user:gamma': null, 'user:escape': 'member-a' };
/** A directory that confirms exactly the pair the request claims (the local/dev verifier's shape). */
const confirmClaim: OwnedKitListerDeps['verifyWorkspaceRequestAuthority'] = async (req: any) => ({ ok: true, context: { workspaceId: req.get('x-od-workspace-id'), workspaceMemberId: req.get('x-od-workspace-member-id') } as never });
function listerDeps(root: string, verify: OwnedKitListerDeps['verifyWorkspaceRequestAuthority'] = confirmClaim): OwnedKitListerDeps {
  return {
    verifyWorkspaceRequestAuthority: verify,
    // The real catalog hides claimed kits from a headerless caller (spec 04 §10).
    async listAllDesignSystems({ workspaceId }) {
      return Object.entries(owners).filter(([, owner]) => workspaceId !== null || owner === null).map(([id]) => ({ id, title: id.slice(5), source: 'user' }));
    },
    visibleInWorkspaceCatalog: (system, workspaceId, memberId) => workspaceId === 'ws' && owners[system.id] === memberId,
    userRoot: root,
    teamRoot: () => path.join(root, '.team'),
  };
}
const emptyBundled = () => mkdtempSync(path.join(tmpdir(), 'od-b52-bundled-'));

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });
async function app(root: string, verify?: OwnedKitListerDeps['verifyWorkspaceRequestAuthority']): Promise<string> {
  const bundled = emptyBundled();
  const instance = express(); instance.use(express.json());
  registerWorkbenchRoutes(instance, {
    http: { sendApiError }, authorizeProjectRequest: async () => true,
    // Mirrors server.ts: sources are built per request from that request's own scope.
    sourcesForRequest: req => createLocalResourceSources({ listPlugins: async () => [], designSystemsRoot: bundled, userKits: () => listOwnedDesignSystemKits(req, listerDeps(root, verify)), workspace: req.get('x-od-workspace-id') ? { workspaceId: req.get('x-od-workspace-id')!, workspaceMemberId: req.get('x-od-workspace-member-id')! } : null }),
  });
  server = instance.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const member = (id: string) => ({ 'x-od-workspace-id': 'ws', 'x-od-workspace-member-id': id });
async function search(base: string, headers: Record<string, string>) {
  const response = await fetch(`${base}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ facets: { sourceIds: ['design-systems', 'design-md'] }, limit: 100 }) });
  expect(response.status).toBe(200);
  return parseResourceSearchResponse(await response.json());
}
const ids = (results: readonly ResourceResult[]) => results.map(item => item.ref.itemId);

describe('AC-R04.1/R04.2 user design-system kits', () => {
  it('AC-R04.1 authorization: a member sees their own Personal kit and never another member\'s, on the same daemon', async () => {
    const base = await app(userRoot());
    const a = await search(base, member('member-a'));
    expect(ids(a.results)).toEqual(expect.arrayContaining(['user:alpha', 'user:alpha/color-palette', 'user:alpha/spacing-scale']));
    expect(ids(a.results).some(id => id.startsWith('user:beta') || id.startsWith('user:gamma'))).toBe(false);
    const b = await search(base, member('member-b'));
    expect(ids(b.results)).toEqual(expect.arrayContaining(['user:beta', 'user:beta/type-scale']));
    expect(ids(b.results).some(id => id.startsWith('user:alpha'))).toBe(false);
    // A's reference never resolves for B: not even as stale.
    const alpha = a.results.find(item => item.ref.itemId === 'user:alpha/color-palette')!;
    const leak = await fetch(`${base}/api/workbench/resources/${alpha.refKey}`, { headers: member('member-b') });
    expect(leak.status).toBe(404);
    const preview = await fetch(`${base}/api/workbench/resources/${alpha.refKey}/preview?workspaceId=ws&workspaceMemberId=member-b`);
    expect(preview.status).toBe(404);
    // The DESIGN.md source follows the same per-request visibility.
    expect(ids(b.results.filter(item => item.ref.sourceId === 'design-md'))).toEqual(['user:beta']);
  });

  it('AC-R04.1 authorization: a headerless caller sees only never-claimed kits; an unverifiable member sees none and the listing says why', async () => {
    const root = userRoot();
    const local = await search(await app(root), {});
    expect(ids(local.results).filter(id => id.startsWith('user:'))).toEqual(expect.arrayContaining(['user:gamma', 'user:gamma/color-palette']));
    expect(ids(local.results).some(id => id.startsWith('user:alpha') || id.startsWith('user:beta'))).toBe(false);
    await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
    const verify = vi.fn(async () => ({ ok: false as const, status: 403 as const, code: 'WORKSPACE_ACCESS_DENIED' as const, message: 'denied' }));
    const denied = await search(await app(root, verify as never), member('member-a'));
    expect(verify).toHaveBeenCalled();
    expect(ids(denied.results).some(id => id.startsWith('user:'))).toBe(false);
    expect(denied.sourceStatuses.find(status => status.sourceId === 'design-systems')).toMatchObject({ state: 'degraded', reason: 'workspace-membership-unverified:1' });
  });

  it('AC-R04.1 security: a kit symlinked outside the USER directory is refused with a named reason', async () => {
    const a = await search(await app(userRoot()), member('member-a'));
    expect(ids(a.results).some(id => id.startsWith('user:escape'))).toBe(false);
    expect(a.sourceStatuses.find(status => status.sourceId === 'design-systems')!.reason).toContain('user-kit-outside-root:1');
  });

  it('AC-R04.1 semantics and AC-R07.3: kit items stay unverified; cohorts preview through the static specimen route under the same authority', async () => {
    const root = userRoot();
    const base = await app(root);
    const a = await search(base, member('member-a'));
    const kit = a.results.find(item => item.ref.itemId === 'user:alpha')!;
    expect(kit).toMatchObject({ category: 'design-system', readiness: 'unverified', rightsStatus: 'unknown', adoptionCapability: { available: false }, implementationOrigin: 'user-design-system' });
    expect(kit.previewCapability.url).toBe('/api/design-systems/user%3Aalpha/preview?workspaceId=ws&workspaceMemberId=member-a');
    const palette = a.results.find(item => item.ref.itemId === 'user:alpha/color-palette')!;
    expect(palette.previewCapability.url).toBe(`/api/workbench/resources/${palette.refKey}/preview?workspaceId=ws&workspaceMemberId=member-a`);
    const preview = await fetch(`${base}${palette.previewCapability.url}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toContain('text/html');
    expect(preview.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await preview.text();
    expect(html).toContain('--color-text');
    expect(html).not.toMatch(/<script|https?:\/\//);
    const designMd = a.results.find(item => item.ref.sourceId === 'design-md' && item.ref.itemId === 'user:alpha')!;
    expect(designMd).toMatchObject({ readiness: 'reference-only', admissionStage: 'reference-only', category: 'reference' });
    expect(designMd.fitReasons[0]).toContain('#0b5f66');
    // Frozen evidence: an edited token file makes the old reference and its preview stale.
    writeFileSync(path.join(root, 'alpha', 'tokens.css'), ':root { --color-bg: #ffffff; --color-text: #222222; }');
    const stale = await fetch(`${base}/api/workbench/resources/${palette.refKey}`, { headers: member('member-a') });
    expect(stale.status).toBe(409);
    expect((await fetch(`${base}${palette.previewCapability.url}`)).status).toBe(409);
    // A navigation pair that disagrees with the headers is refused outright.
    expect((await fetch(`${base}${palette.previewCapability.url}`, { headers: member('member-b') })).status).toBe(400);
    const current = parseResourceDetailResponse(await (await fetch(`${base}/api/workbench/resources/${(await search(base, member('member-a'))).results.find(item => item.ref.itemId === 'user:alpha/color-palette')!.refKey}`, { headers: member('member-a') })).json());
    expect(current.resource.readiness).toBe('unverified');
  });
});
