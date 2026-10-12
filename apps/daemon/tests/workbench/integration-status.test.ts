import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildIntegrationRoster } from '../../src/workbench/integration-roster.js';
import { IntegrationStatusService, migrateIntegrationStatus, IntegrationProbeFailure, type IntegrationStatusDeps } from '../../src/workbench/integration-status.js';
const dbs: Database.Database[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); });
const roster = () => buildIntegrationRoster({ mcpServers: [], licences: [] });
const setup = () => {
  const db = new Database(':memory:'); dbs.push(db); migrateIntegrationStatus(db);
  const inspect = vi.fn<IntegrationStatusDeps['inspect']>(async () => ({ ...roster().entries[0]!.runtime!, connection: 'connected' as const, reason: 'Configured credential', accountLabel: null }));
  const probe = vi.fn<IntegrationStatusDeps['probe']>(async (_entry, runtime) => ({ kind: 'connection' as 'connection' | 'workflow', operation: 'search', runtime }));
  const service = new IntegrationStatusService({ db, inspect, probe, now: () => new Date('2026-10-09T01:00:00Z') });
  return { db, inspect, probe, service };
};
describe('D5 separate connection and workflow receipts', () => {
  it('does not carry a legacy failed live check onto a reference-only row', async () => {
    const { db, service, inspect, probe } = setup();
    const reference = roster().entries.find(row => row.id === 'awesome-design-md')!;
    db.prepare('INSERT INTO workbench_integration_status(integration_id, runtime_json) VALUES (?, ?)').run(reference.id, JSON.stringify({ key: reference.id, runtime: { ...reference.runtime,
      reason: 'No daemon MCP binding.', workflow: { lastSuccess: null, lastTest: { at: '2026-10-09T01:00:00.000Z', outcome: 'failed', kind: 'connection', code: 'connection-missing', message: 'No daemon MCP binding.' } },
    } }));
    const listed = await service.status({ ...roster(), entries: [reference] });
    expect(listed.entries[0]?.runtime).toMatchObject({ reason: 'Reference only: no live connection to test', workflow: { lastSuccess: null, lastTest: null } });
    expect(inspect).not.toHaveBeenCalled();
    expect(() => service.test(roster(), reference.id)).toThrow('Reference only: no live connection to test');
    expect(probe).not.toHaveBeenCalled();
  });
  it('a connection check does not claim a successful workflow', async () => {
    const { service } = setup(); const entry = await service.test(roster(), 'mobbin');
    expect(entry.runtime).toMatchObject({ connection: 'connected', workflow: { lastSuccess: null, lastTest: { outcome: 'passed', kind: 'connection' } } });
  });
  it('persists a successful workflow across service instances and retains it after failure without leaking errors', async () => {
    const { service, probe, db, inspect } = setup();
    probe.mockImplementationOnce(async (_entry, runtime) => ({ kind: 'workflow', operation: 'search', runtime }));
    await service.test(roster(), 'mobbin');
    probe.mockRejectedValueOnce(new Error('Bearer secret-token-value signed-url=https://evil.test?key=secret'));
    const failed = await service.test(roster(), 'mobbin');
    expect(failed.runtime?.workflow).toMatchObject({ lastSuccess: { operation: 'search' }, lastTest: { outcome: 'failed' } });
    const reopened = new IntegrationStatusService({ db, inspect, probe });
    const value = await reopened.status(roster());
    expect(value.entries.find(item => item.id === 'mobbin')?.runtime?.workflow).toEqual(failed.runtime?.workflow);
    expect(JSON.stringify(value)).not.toMatch(/secret-token|evil.test/);
  });
  it('deduplicates simultaneous tests and rejects unknown IDs before probing', async () => {
    const { service, probe } = setup();
    await Promise.all([service.test(roster(), 'mobbin'), service.test(roster(), 'mobbin')]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(() => service.test(roster(), '../../secrets')).toThrow('Unknown integration');
  });
});

describe('D5 checked-binding persistence', () => {
  it('retains account, version and connection across a new service; invalidates them when the binding changes', async () => {
    const { db, inspect, probe } = setup();
    let key = 'binding-one';
    inspect.mockImplementation(async () => ({ ...roster().entries[0]!.runtime!, installed: 'installed' as const, connection: 'missing' as const, reason: 'Run Test', verificationKey: key, accountLabel: null }));
    probe.mockImplementation(async (_entry, runtime) => ({ kind: 'connection', operation: 'account-status', runtime: { ...runtime, connection: 'connected', accountLabel: 'sample-owner', version: '2.1.0' } }));
    const service = new IntegrationStatusService({ db, inspect, probe });
    await service.test(roster(), 'mobbin');
    const reopened = new IntegrationStatusService({ db, inspect, probe });
    expect((await reopened.status(roster())).entries.find(row => row.id === 'mobbin')?.runtime).toMatchObject({ connection: 'connected', accountLabel: 'sample-owner', version: '2.1.0' });
    key = 'binding-two';
    expect((await reopened.status(roster())).entries.find(row => row.id === 'mobbin')?.runtime).toMatchObject({ connection: 'missing', accountLabel: null, workflow: { lastSuccess: null, lastTest: null } });
  });
  it('does not report an untested configured binding as connected', async () => {
    const { service } = setup();
    expect((await service.status(roster())).entries.find(row => row.id === 'mobbin')?.runtime?.connection).toBe('missing');
  });
});

describe('D5 connection freshness', () => {
  it('expires CLI connection proof after five minutes while retaining the dated workflow and version', async () => {
    const { db, inspect, probe } = setup(); let now = new Date('2026-10-09T01:00:00Z');
    probe.mockImplementation(async (_entry, runtime) => ({ kind: 'workflow', operation: 'authorized-search', runtime: { ...runtime, connection: 'connected', version: '2.1.0', accountLabel: 'sample-owner' } }));
    const service = new IntegrationStatusService({ db, inspect, probe, now: () => now });
    await service.test(roster(), 'codex');
    expect((await service.status(roster())).entries.find(row => row.id === 'codex')?.runtime?.connection).toBe('connected');
    now = new Date('2026-10-09T01:05:00.001Z');
    expect((await service.status(roster())).entries.find(row => row.id === 'codex')?.runtime).toMatchObject({ connection: 'missing', accountLabel: null, version: '2.1.0', workflow: { lastSuccess: { operation: 'authorized-search' } } });
  });
});

it('keeps the exact setup problem before and after a refused Test', async () => {
  const { db, inspect, probe } = setup();
  const reason = 'The matching MCP binding is disabled. Enable it in Settings.';
  inspect.mockImplementation(async () => ({ ...roster().entries[0]!.runtime!, installed: 'installed', connection: 'missing', reason }));
  probe.mockImplementation(async (_entry, runtime) => { throw new IntegrationProbeFailure('connection-missing', runtime); });
  const service = new IntegrationStatusService({ db, inspect, probe });
  expect((await service.status(roster())).entries.find(row => row.id === 'mobbin')?.runtime?.reason).toBe(reason);
  expect((await service.test(roster(), 'mobbin')).runtime?.workflow.lastTest?.message).toBe(reason);
});

it('retains an actionable failed check across reload when the integration is still missing', async () => {
  const { db, inspect, probe } = setup();
  inspect.mockImplementation(async () => ({ ...roster().entries[0]!.runtime!, installed: 'missing', connection: 'missing', reason: 'No daemon MCP binding. Add it in Settings.' }));
  probe.mockImplementation(async (_entry, runtime) => { throw new IntegrationProbeFailure('connection-missing', runtime); });
  const service = new IntegrationStatusService({ db, inspect, probe });
  const result = await service.test(roster(), 'jev');
  expect((await new IntegrationStatusService({ db, inspect, probe }).status(roster())).entries.find(row => row.id === 'jev')?.runtime?.workflow.lastTest).toEqual(result.runtime?.workflow.lastTest);
});

describe('V03-1 agent runtime install state agrees with live detection', () => {
  const runtimeStatus = (installed: 'installed' | 'missing') => {
    const { db, probe } = setup();
    const inspect = vi.fn<IntegrationStatusDeps['inspect']>(async (entry) => ({
      ...entry.runtime!, installed, version: installed === 'installed' ? '2.1.295' : null,
      connection: 'missing' as const, accountLabel: null, reason: 'Run Test',
    }));
    return new IntegrationStatusService({ db, inspect, probe });
  };

  it('reports an installed agent runtime as configured, not "not checked", in status and after Test', async () => {
    const service = runtimeStatus('installed');
    const listed = (await service.status(roster())).entries.find(row => row.id === 'claude')!;
    expect(listed.runtime?.installed).toBe('installed');
    expect(listed.installState.state).toBe('configured');
    expect(listed.installState.reason).toContain('2.1.295');
    expect(listed.installState.reason).not.toMatch(/has not been checked/);
    const tested = await service.test(roster(), 'claude');
    expect(tested.installState.state).toBe('configured');
  });

  it('reports a missing agent runtime as not installed with a plain reason', async () => {
    const listed = (await runtimeStatus('missing').status(roster())).entries.find(row => row.id === 'claude')!;
    expect(listed.installState.state).toBe('not-installed');
    expect(listed.installState.reason).not.toMatch(/has not been checked/);
  });

  it('keeps the placeholder when live detection could not answer', async () => {
    const { db, probe } = setup();
    const inspect = vi.fn<IntegrationStatusDeps['inspect']>(async () => { throw new Error('unreadable'); });
    const listed = (await new IntegrationStatusService({ db, inspect, probe }).status(roster())).entries.find(row => row.id === 'claude')!;
    expect(listed.runtime?.installed).toBe('not-required');
    expect(listed.installState).toEqual(roster().entries.find(row => row.id === 'claude')!.installState);
  });

  it('leaves curated rows with their own recorded install state', async () => {
    const before = roster().entries.find(row => row.id === 'gsap')!.installState;
    const listed = (await runtimeStatus('installed').status(roster())).entries.find(row => row.id === 'gsap')!;
    expect(listed.installState).toEqual(before);
  });
});

describe('V03-1b every runtime row install state agrees with its live probe, in wording that fits the row', () => {
  const statusFor = (installed: 'installed' | 'missing', installSource?: 'agent-cli' | 'mcp-binding' | 'provider-cli' | 'subscription-cli') => {
    const { db, probe } = setup();
    const inspect = vi.fn<IntegrationStatusDeps['inspect']>(async (entry) => ({
      ...entry.runtime!, installed, version: null, connection: 'missing' as const, accountLabel: null, reason: 'Run Test',
      ...(installSource ? { installSource } : {}),
    }));
    return new IntegrationStatusService({ db, inspect, probe });
  };
  const row = async (service: IntegrationStatusService, id: string) => (await service.status(roster())).entries.find(item => item.id === id)!;

  it.each(['vercel', 'github', 'jev'])('reports a configured MCP server for %s as configured, without claiming a local install', async id => {
    const listed = await row(statusFor('installed'), id);
    expect(listed.runtime?.installed).toBe('installed');
    expect(listed.installState.state).toBe('configured');
    expect(listed.installState.reason).toBe('The daemon has a matching MCP server configured.');
    expect(listed.installState.reason).not.toMatch(/on this machine|has not been checked/);
  });

  it.each(['vercel', 'github', 'jev'])('reports a missing MCP server for %s as not installed with a Settings fix', async id => {
    const listed = await row(statusFor('missing'), id);
    expect(listed.installState.state).toBe('not-installed');
    expect(listed.installState.reason).toMatch(/^No matching MCP server is configured\./);
    expect(listed.installState.reason).toContain('Settings → External MCP');
    expect(listed.installState.reason).not.toMatch(/on this machine|has not been checked/);
  });

  it('names the provider CLI when GitHub is detected through gh rather than an MCP server', async () => {
    const service = statusFor('installed', 'provider-cli');
    const listed = await row(service, 'github');
    expect(listed.installState.state).toBe('configured');
    expect(listed.installState.reason).toContain('gh CLI');
    expect(listed.installState.reason).not.toMatch(/MCP server configured|has not been checked/);
    expect((await service.test(roster(), 'github')).installState.reason).toContain('gh CLI');
  });

  it('describes Higgsfield by what its probe checks: the bundled CLI executable', async () => {
    const installed = await row(statusFor('installed'), 'higgsfield');
    expect(installed.installState.state).toBe('configured');
    expect(installed.installState.reason).toMatch(/Higgsfield CLI/);
    expect(installed.installState.reason).not.toMatch(/on this machine|has not been checked|MCP/);
    const missing = await row(statusFor('missing'), 'higgsfield');
    expect(missing.installState.state).toBe('not-installed');
    expect(missing.installState.reason).toMatch(/Higgsfield CLI/);
    expect(missing.installState.reason).not.toMatch(/on this machine|has not been checked|MCP/);
  });

  it('keeps every runtime row consistent after Test as well as in status', async () => {
    const service = statusFor('installed');
    for (const id of ['github', 'higgsfield', 'jev', 'claude']) {
      const tested = await service.test(roster(), id);
      expect(tested.installState.state, id).toBe('configured');
      expect(tested.installState.reason, id).not.toMatch(/has not been checked/);
    }
  });

  it('keeps the recorded placeholder for MCP and subscription rows when live detection throws', async () => {
    const { db, probe } = setup();
    const inspect = vi.fn<IntegrationStatusDeps['inspect']>(async () => { throw new Error('unreadable'); });
    const service = new IntegrationStatusService({ db, inspect, probe });
    for (const id of ['github', 'higgsfield', 'vercel', 'jev']) {
      const listed = await row(service, id);
      expect(listed.runtime?.installed, id).toBe('not-required');
      expect(listed.installState, id).toEqual(roster().entries.find(item => item.id === id)!.installState);
    }
  });
});
