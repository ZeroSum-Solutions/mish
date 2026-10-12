import express from 'express';
import Database from 'better-sqlite3';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConnectorInventory, parseIntegrationRoster, parseLicenceRecordSnapshot } from '@open-design/contracts';
import { registerWorkbenchIntegrationRoutes } from '../../src/routes/workbench-integrations.js';
import { migrateWorkbenchLicenceRecords } from '../../src/workbench/licence-record.js';
import { IntegrationStatusService, migrateIntegrationStatus } from '../../src/workbench/integration-status.js';
import { runIntegrationsCli } from '../../src/workbench/integrations-cli.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';

let server: Server | undefined; let db: Database.Database | undefined; const dirs: string[] = [];
afterEach(async () => {
  if (server) await new Promise<void>(done => server!.close(() => done()));
  server = undefined; db?.close(); db = undefined;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function boot(options: { sameOrigin?: boolean } = {}) {
  db = new Database(':memory:'); migrateWorkbenchLicenceRecords(db); migrateIntegrationStatus(db);
  const app = express(); app.use(express.json());
  const readMcpServers = vi.fn(async () => [{ id: 'shadcn-ui', templateId: 'shadcn-ui', enabled: true }]);
  registerWorkbenchIntegrationRoutes(app, {
    db, readMcpServers,
    status: new IntegrationStatusService({ db, inspect: async entry => entry.runtime!, probe: async (entry, runtime) => {
      if (entry.id === 'refero') throw new Error('Bearer secret-value');
      return { kind: 'workflow', operation: 'stubbed-authorized-search', runtime: { ...runtime, connection: 'connected' } };
    } }),
    http: {
      sendApiError: (res: express.Response, status: number, code: string, message: string, init?: object) => res.status(status).json({ error: { code, message, ...init } }),
      isLocalSameOrigin: () => options.sameOrigin ?? true, resolvedPortRef: { current: 0 },
    },
  });
  server = app.listen(0); await new Promise<void>(done => server!.once('listening', done));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, readMcpServers };
}
const terms = { kind: 'terms-version', sha256: 'c'.repeat(64), citationUrl: 'https://example.com/licence', clauseRefs: ['2.1'] };
const draft = { holder: 'Example Owner', termsVersion: '2026-01', termsEvidence: terms, operationScope: [{ operation: 'host-preview', decision: 'allowed', clauseRefs: ['2.1'] }] };
const put = (base: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/workbench/licences/react-bits`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function cli(base: string, args: string[], env: NodeJS.ProcessEnv = {}, stdin?: unknown) {
  const values: unknown[] = [];
  const code = await runWorkbenchCli(args, { baseUrl: base, env, readStdin: async () => JSON.stringify(stdin), write: value => values.push(value) });
  return { code, value: values[0] };
}

describe('AC-R08.1 / AC-R12.1 HTTP surface', () => {
  it('serves the roster and connector inventory through contract DTOs with the live daemon binding', async () => {
    const { base, readMcpServers } = await boot();
    const roster = parseIntegrationRoster(await (await fetch(`${base}/api/workbench/integrations`)).json());
    expect(roster.entries.find(entry => entry.id === 'shadcn')?.daemonBinding).toBe('enabled');
    expect(roster.licences.map(item => item.sourceId)).toEqual(['react-bits']);
    expect(readMcpServers).toHaveBeenCalled();
    const inventory = parseConnectorInventory(await (await fetch(`${base}/api/workbench/connectors/inventory`)).json());
    expect(inventory.sites.find(site => site.entryId === 'figma')?.decision).toBe('unsupported');
    for (const site of inventory.sites) expect(site.operations.length, site.entryId).toBeGreaterThan(0);
    expect(inventory.sites.find(site => site.entryId === 'gsap')?.operations.map(item => item.operation)).toContain('visual-animation-editor');
    expect(inventory.exclusions.map(item => item.name)).toEqual(expect.arrayContaining(['Material UI', 'cnblocks']));
    expect(inventory.rosterDigest).toBe(roster.rosterDigest);
  });
  it('still answers the roster when the MCP config cannot be read, marking bindings not-configured', async () => {
    const { base, readMcpServers } = await boot();
    readMcpServers.mockRejectedValueOnce(new Error('private path /Users/x'));
    const response = await fetch(`${base}/api/workbench/integrations`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('/Users/x');
    expect(parseIntegrationRoster(JSON.parse(body)).entries.find(entry => entry.id === 'shadcn')?.daemonBinding).toBe('not-configured');
  });
  it('degrades an unreadable stored licence record: reads stay 200 and the row says unreadable', async () => {
    const { base } = await boot();
    expect((await put(base, { expectedRevision: 0, draft })).status).toBe(200);
    db!.prepare('UPDATE workbench_licence_record_current SET record_json=?').run(JSON.stringify({ schema: 'licence-record/1', holder: 'x', future: true }));
    const response = await fetch(`${base}/api/workbench/integrations`);
    expect(response.status).toBe(200);
    const roster = parseIntegrationRoster(await response.json());
    expect(roster.licences[0]).toMatchObject({ recordState: 'unreadable', revision: 1 });
    expect(roster.entries.find(entry => entry.id === 'react-bits')?.pendingReceipts.join(' ')).toMatch(/unreadable/i);
    expect((await fetch(`${base}/api/workbench/licences/react-bits`)).status).toBe(200);
  });
  it('refuses cross-origin reads', async () => {
    const { base } = await boot({ sameOrigin: false });
    for (const path of ['integrations', 'connectors/inventory', 'licences/react-bits']) expect((await fetch(`${base}/api/workbench/${path}`)).status).toBe(403);
  });
});

describe('R16 licence record HTTP surface', () => {
  it('saves the owner record and reflects the holder as the React Bits principal', async () => {
    const { base } = await boot();
    const response = await put(base, { expectedRevision: 0, draft });
    expect(response.status).toBe(200);
    const saved = parseLicenceRecordSnapshot(await response.json());
    expect(saved.operations.find(item => item.operation === 'host-preview')).toMatchObject({ decision: 'allowed' });
    const roster = parseIntegrationRoster(await (await fetch(`${base}/api/workbench/integrations`)).json());
    expect(roster.entries.find(entry => entry.id === 'react-bits')?.account.principal).toBe('Example Owner');
    expect(parseLicenceRecordSnapshot(await (await fetch(`${base}/api/workbench/licences/react-bits`)).json())).toEqual(saved);
  });
  it.each([
    ['an agent-run tool token', { authorization: 'Bearer run-token' }],
    ['a workspace member identity', { 'x-od-workspace-id': 'w', 'x-od-workspace-member-id': 'm' }],
    ['Basic credentials', { authorization: 'Basic dXNlcjpwYXNz' }],
  ])('refuses %s: only the local owner records the licence', async (_label, headers) => {
    const { base } = await boot();
    const response = await put(base, { expectedRevision: 0, draft }, headers);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(((await (await fetch(`${base}/api/workbench/licences/react-bits`)).json()) as { revision: number }).revision).toBe(0);
  });
  it('returns typed widening, override, conflict, validation and unknown-source refusals', async () => {
    const { base } = await boot();
    const widening = await put(base, { expectedRevision: 0, draft: { ...draft, termsEvidence: null, termsVersion: null } });
    expect(widening.status).toBe(422);
    expect(await widening.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED', details: { reason: 'licence-scope-widening', operations: ['host-preview'] } } });
    expect((await put(base, { expectedRevision: 0, draft: { ...draft, holder: '' } })).status).toBe(400);
    expect((await put(base, { expectedRevision: 0, draft })).status).toBe(200);
    const conflict = await put(base, { expectedRevision: 0, draft: { ...draft, holder: 'Other' } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'CONFLICT', details: { current: { revision: 1 } } } });
    expect((await fetch(`${base}/api/workbench/licences/unknown`)).status).toBe(404);
  });
});

describe('R16 licence write surface label', () => {
  it('labels Settings (same-origin browser fetch metadata), od (declared client) and raw HTTP writes', async () => {
    const { base } = await boot();
    const settings = parseLicenceRecordSnapshot(await (await put(base, { expectedRevision: 0, draft }, { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })).json());
    expect(settings.record?.recordedBy.surface).toBe('settings');
    const raw = parseLicenceRecordSnapshot(await (await put(base, { expectedRevision: 1, draft: { ...draft, holder: 'Raw' } })).json());
    expect(raw.record?.recordedBy.surface).toBe('http');
    const dir = await mkdtemp(join(tmpdir(), 'od-licence-surface-')); dirs.push(dir);
    const file = join(dir, 'licence.json'); await writeFile(file, JSON.stringify({ ...draft, holder: 'Cli' }));
    expect(await cli(base, ['licence', 'set', '--source', 'react-bits', '--expected-revision', '2', '--input-file', file, '--json'])).toMatchObject({ code: 0, value: { record: { recordedBy: { surface: 'cli' } } } });
  });
});

describe('od workbench integrations / connector inventory / licence parity', () => {
  it('prints the same DTOs the HTTP routes serve', async () => {
    const { base } = await boot();
    // generatedAt is the read time, so compare everything else.
    const http = await (await fetch(`${base}/api/workbench/integrations`)).json() as Record<string, unknown>;
    expect(await cli(base, ['integrations', '--json'])).toEqual({ code: 0, value: { ...http, generatedAt: expect.any(String) } });
    const inventory = await (await fetch(`${base}/api/workbench/connectors/inventory`)).json();
    const fromCli = await cli(base, ['connector', 'inventory', 'get', '--json']);
    expect(fromCli).toEqual({ code: 0, value: inventory });
    expect((fromCli.value as { sites: { operations: unknown[] }[] }).sites.every(site => site.operations.length > 0)).toBe(true);
    expect(await cli(base, ['licence', 'get', '--source', 'react-bits', '--json'])).toMatchObject({ code: 0, value: { revision: 0, record: null } });
  });
  it('sets the licence from an input file with the same validation and exit codes', async () => {
    const { base } = await boot();
    const dir = await mkdtemp(join(tmpdir(), 'od-licence-cli-')); dirs.push(dir);
    const file = join(dir, 'licence.json'); await writeFile(file, JSON.stringify(draft));
    const set = await cli(base, ['licence', 'set', '--source', 'react-bits', '--expected-revision', '0', '--input-file', file, '--json']);
    expect(set).toMatchObject({ code: 0, value: { revision: 1, record: { holder: 'Example Owner' } } });
    expect(set.value).toEqual(await (await fetch(`${base}/api/workbench/licences/react-bits`)).json());
    expect(await cli(base, ['licence', 'set', '--source', 'react-bits', '--expected-revision', '1', '--input-file', '-', '--json'], {}, { ...draft, termsEvidence: null, termsVersion: null }))
      .toMatchObject({ code: 3, value: { status: 422, error: { details: { reason: 'licence-scope-widening' } } } });
    expect(await cli(base, ['licence', 'set', '--source', 'react-bits', '--expected-revision', 'x', '--input-file', '-', '--json'], {}, draft)).toMatchObject({ code: 2 });
    expect(await cli(base, ['licence', 'set', '--source', 'react-bits', '--expected-revision', '1', '--input-file', '-', '--json'], {}, { holder: 'sk-live-0123456789abcdef' })).toMatchObject({ code: 2 });
  });
  it('an agent run with a tool token cannot record the licence through od', async () => {
    const { base } = await boot();
    expect(await cli(base, ['licence', 'set', '--source', 'react-bits', '--expected-revision', '0', '--input-file', '-', '--json'], { OD_TOOL_TOKEN: 'run-token', OD_TOOL_TOKEN_ISSUER_ORIGIN: base }, draft))
      .toMatchObject({ code: 3, value: { status: 403 } });
  });
  it('documents the subcommands in workbench help', async () => {
    const values: unknown[] = [];
    await runWorkbenchCli(['--help'], { write: value => values.push(value) });
    expect(JSON.stringify(values[0])).toMatch(/od workbench integrations[\s\S]*od workbench connector inventory get[\s\S]*od workbench licence get\|set/);
  });
});

describe('D5 top-level integrations CLI and HTTP Test parity', () => {
  it.each(['awesome-design-md', 'design-system-checklist', 'fontshare', 'adobe-fonts', 'ai-sdk-agents'])('returns the same typed reference-only refusal for %s without recording a failed check', async id => {
    const { base } = await boot();
    const response = await fetch(`${base}/api/workbench/integrations/${id}/test`, { method: 'POST' });
    expect(response.status).toBe(422);
    const refusal = await response.json();
    expect(refusal).toEqual({ error: { code: 'reference-only', message: 'Reference only: no live connection to test' } });
    const values: unknown[] = [];
    expect(await runIntegrationsCli(['integrations', 'test', id, '--json'], { baseUrl: base, env: {}, write: value => values.push(value) })).toBe(3);
    expect(values).toEqual([{ status: 422, error: { code: 'reference-only', message: 'Reference only: no live connection to test' } }]);
    const status = parseIntegrationRoster(await (await fetch(`${base}/api/workbench/integrations`)).json());
    expect(status.entries.find(row => row.id === id)?.runtime?.workflow.lastTest).toBeNull();
  });
  it('tests a known row, returns the same persisted receipt in status, and fails closed for unknown IDs', async () => {
    const { base } = await boot(); const values: unknown[] = [];
    const options = { baseUrl: base, env: {}, write: (value: unknown) => values.push(value) };
    expect(await runIntegrationsCli(['integrations', 'test', 'mobbin', '--json'], options)).toBe(0);
    expect(values.pop()).toMatchObject({ id: 'mobbin', runtime: { workflow: { lastSuccess: { operation: 'stubbed-authorized-search' } } } });
    expect(await runIntegrationsCli(['integrations', 'status', '--json'], options)).toBe(0);
    expect((values.pop() as { entries: { id: string; runtime: unknown }[] }).entries.find(entry => entry.id === 'mobbin')?.runtime).toMatchObject({ workflow: { lastSuccess: { operation: 'stubbed-authorized-search' } } });
    expect(await runIntegrationsCli(['integrations', 'test', 'refero', '--json'], options)).toBe(1);
    expect(JSON.stringify(values.pop())).not.toContain('secret-value');
    expect(await runIntegrationsCli(['integrations', 'test', 'unknown', '--json'], options)).toBe(3);
    // Valid local identities reach the daemon, even when this fixture has no such profile.
    expect(await runIntegrationsCli(['integrations', 'test', 'work_profile', '--json'], options)).toBe(3);
    expect(await runIntegrationsCli(['integrations', 'test', 'Work.Profile-1', '--json'], options)).toBe(3);
    expect(await runIntegrationsCli(['integrations', 'test', '../secrets', '--json'], options)).toBe(2);
  });
  it('rejects cross-origin Test requests before calling a probe', async () => {
    const { base } = await boot({ sameOrigin: false });
    expect((await fetch(`${base}/api/workbench/integrations/mobbin/test`, { method: 'POST' })).status).toBe(403);
  });
});
