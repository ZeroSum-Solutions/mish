import type Database from 'better-sqlite3';
import { integrationTestability, parseIntegrationRuntime, type IntegrationRoster, type IntegrationRosterEntry, type IntegrationRuntime } from '@mish/contracts';
import { PRODUCT_AGENT_DEFS } from '../runtimes/registry.js';
import { RUNTIME_INTEGRATION_ROWS } from './integration-roster-data.js';

/**
 * What a runtime row's live probe found, which decides how its install state is
 * worded. `agent-cli`: a local agent CLI executable. `mcp-binding`: a matching
 * server in the daemon's MCP config. `provider-cli`: the provider's own CLI on
 * the daemon PATH (GitHub `gh`, Vercel `vercel`) when no MCP server matches.
 * `subscription-cli`: the CLI bundled for a subscription lane (Higgsfield).
 */
export type IntegrationInstallSource = 'agent-cli' | 'mcp-binding' | 'provider-cli' | 'subscription-cli';

const RUNTIME_ROW_IDS: ReadonlySet<string> = new Set(RUNTIME_INTEGRATION_ROWS.map(row => row.id));
const AGENT_CLI_ROW_IDS: ReadonlySet<string> = new Set(
  RUNTIME_INTEGRATION_ROWS.filter(row => PRODUCT_AGENT_DEFS.some(def => def.id === row.id)).map(row => row.id),
);
const PROVIDER_CLI: Readonly<Record<string, string>> = { github: 'gh', vercel: 'vercel' };

/** The probe's own answer when it gave one; otherwise what the row can only be. */
function installSourceFor(entry: IntegrationRosterEntry, reported: IntegrationInstallSource | undefined): IntegrationInstallSource | null {
  // Curated rows keep their recorded install state whatever the probe reports.
  if (!RUNTIME_ROW_IDS.has(entry.id)) return null;
  if (AGENT_CLI_ROW_IDS.has(entry.id)) return 'agent-cli';
  if (reported) return reported;
  if (entry.id === 'higgsfield') return 'subscription-cli';
  return entry.daemonBinding !== 'not-applicable' ? 'mcp-binding' : null;
}

function liveInstallState(entry: IntegrationRosterEntry, source: IntegrationInstallSource, runtime: IntegrationRuntime): IntegrationRosterEntry['installState'] | null {
  const installed = runtime.installed === 'installed';
  if (!installed && runtime.installed !== 'missing') return null;
  const configured = (reason: string) => ({ state: 'configured' as const, basis: 'agent-runtime-receipt' as const, reason });
  const absent = (reason: string) => ({ state: 'not-installed' as const, basis: 'none' as const, reason });
  const cli = PROVIDER_CLI[entry.id];
  switch (source) {
    case 'agent-cli':
      return installed ? configured(`Detected on this machine${runtime.version ? ` (version ${runtime.version})` : ''}.`)
        : absent('Not found on this machine. Install it, or set its path in Settings.');
    case 'provider-cli':
      return installed ? configured(`The ${cli ?? 'provider'} CLI is on the daemon PATH; no MCP server is configured for it.`)
        : absent('No matching MCP server is configured. Add it in Settings → External MCP.');
    case 'subscription-cli':
      return installed ? configured('The bundled Higgsfield CLI is available to the daemon. Run Test to check the subscription account.')
        : absent('The bundled Higgsfield CLI is missing. Reinstall Mishh Mashh, or set OD_HIGGSFIELD_BIN to the hf executable.');
    case 'mcp-binding':
      return installed ? configured('The daemon has a matching MCP server configured.')
        : absent(`No matching MCP server is configured. Add it in Settings → External MCP${cli ? `, or install and sign in to the ${cli} CLI` : ''}.`);
  }
}

/**
 * A runtime row carries no recorded install state, only the static placeholder
 * "Live installation has not been checked". Once the live probe has answered
 * installed or missing, the row's install state says the same thing as its
 * runtime, worded for what the probe actually checked: a local CLI is "on this
 * machine", an MCP binding or a bundled CLI is not. Curated rows keep their
 * recorded install state, and so does any row whose probe could not answer.
 */
function withLiveInstallState(entry: IntegrationRosterEntry, runtime: IntegrationRuntime, reported?: IntegrationInstallSource): IntegrationRosterEntry {
  const source = installSourceFor(entry, reported);
  const installState = source ? liveInstallState(entry, source, runtime) : null;
  return installState ? { ...entry, runtime, installState } : { ...entry, runtime };
}

export const CONNECTION_RECEIPT_MAX_AGE_MS = 5 * 60 * 1000;

export interface IntegrationProbeResult {
  kind: 'connection' | 'workflow';
  operation: string;
  runtime: IntegrationRuntime;
}
export interface IntegrationStatusDeps {
  db: Database.Database;
  inspect: (entry: IntegrationRosterEntry) => Promise<IntegrationRuntime & { verificationKey?: string; installSource?: IntegrationInstallSource }>;
  probe: (entry: IntegrationRosterEntry, runtime: IntegrationRuntime) => Promise<IntegrationProbeResult>;
  now?: () => Date;
}
export class IntegrationStatusError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
/** Known, fixed diagnostics only; never wrap raw provider errors. */
export class IntegrationProbeFailure extends Error {
  constructor(readonly code: string, readonly runtime: IntegrationRuntime) { super(runtime.reason); }
}
export function migrateIntegrationStatus(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_integration_status (
    integration_id TEXT PRIMARY KEY, runtime_json TEXT NOT NULL CHECK(json_valid(runtime_json))
  )`);
}

/** UI and CLI share live connection inspection and persisted, secret-free receipts. */
export class IntegrationStatusService {
  readonly #inflight = new Map<string, Promise<IntegrationRosterEntry>>();
  constructor(readonly deps: IntegrationStatusDeps) {}
  #stored(id: string): { key: string; runtime: IntegrationRuntime } | null {
    const row = this.deps.db.prepare('SELECT runtime_json FROM workbench_integration_status WHERE integration_id=?').get(id) as { runtime_json: string } | undefined;
    try {
      const value = row ? JSON.parse(row.runtime_json) as { key: unknown; runtime: unknown } : null;
      return value && typeof value.key === 'string' ? { key: value.key, runtime: parseIntegrationRuntime(value.runtime) } : null;
    } catch { return null; }
  }
  async status(roster: IntegrationRoster): Promise<IntegrationRoster> {
    const entries = await Promise.all(roster.entries.map(async entry => {
      const capability = integrationTestability(entry);
      if (!capability.testable) return { ...entry, runtime: {
        ...entry.runtime!, installed: entry.installState.state === 'bundled' ? 'installed' as const : 'not-required' as const,
        connection: 'missing' as const, accountLabel: null, reason: capability.message,
        fix: { label: 'Reference only', url: null, command: null }, workflow: { lastSuccess: null, lastTest: null },
      } };
      let runtime = entry.runtime!;
      let key = entry.id;
      let source: IntegrationInstallSource | undefined;
      try {
        const { verificationKey, installSource, ...live } = await this.deps.inspect(entry);
        runtime = parseIntegrationRuntime(live); key = verificationKey ?? entry.id; source = installSource;
      } catch { runtime = { ...runtime, connection: 'missing', reason: 'Connection configuration could not be read; review setup.' }; key = ''; }
      const stored = this.#stored(entry.id);
      const matching = stored?.key === key ? stored.runtime : null;
      const liveConnection = runtime.connection;
      if (matching) {
        const elapsed = (this.deps.now?.() ?? new Date()).getTime() - Date.parse(matching.workflow.lastTest?.at ?? '');
        runtime = { ...matching, installed: runtime.installed, version: runtime.version ?? matching.version, ...(runtime.connection === 'expired' || runtime.installed === 'missing' ? { connection: runtime.connection === 'expired' ? 'expired' : 'missing', accountLabel: null, reason: runtime.reason } : {}) };
        if (!['gsap', 'hallmark'].includes(entry.id) && runtime.connection === 'connected' && !(elapsed >= 0 && elapsed <= CONNECTION_RECEIPT_MAX_AGE_MS)) {
          runtime = { ...runtime, connection: 'missing', accountLabel: null, reason: 'The last connection check is stale. Run Test to verify the current account; earlier workflow use remains dated evidence.' };
        }
      } else {
        runtime = { ...runtime, connection: ['gsap', 'hallmark'].includes(entry.id) ? runtime.connection : runtime.connection === 'expired' ? 'expired' : 'missing', workflow: { lastSuccess: null, lastTest: null } };
        if (!['gsap', 'hallmark'].includes(entry.id) && liveConnection === 'connected') runtime.reason = 'Connection has not been verified for the current binding. Run Test or review its account setup.';
      }
      return withLiveInstallState(entry, parseIntegrationRuntime(runtime), source);
    }));
    return { ...roster, entries };
  }
  test(roster: IntegrationRoster, id: string): Promise<IntegrationRosterEntry> {
    const entry = roster.entries.find(item => item.id === id);
    if (!entry) throw new IntegrationStatusError(404, 'NOT_FOUND', 'Unknown integration');
    const capability = integrationTestability(entry);
    if (!capability.testable) throw new IntegrationStatusError(422, capability.reason, capability.message);
    const pending = this.#inflight.get(id);
    if (pending) return pending;
    const task = this.#test(entry).finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, task);
    return task;
  }
  async #test(entry: IntegrationRosterEntry): Promise<IntegrationRosterEntry> {
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    let runtime = entry.runtime!;
    let kind: IntegrationProbeResult['kind'] = 'connection';
    let operation = 'connection-check';
    let passed = false;
    let key = entry.id;
    let failureCode: string | null = null;
    let source: IntegrationInstallSource | undefined;
    try {
      const { verificationKey, installSource, ...live } = await this.deps.inspect(entry);
      key = verificationKey ?? entry.id; runtime = parseIntegrationRuntime(live); source = installSource;
      const result = await this.deps.probe(entry, runtime);
      runtime = parseIntegrationRuntime(result.runtime); kind = result.kind; operation = result.operation;
      passed = true;
      const { verificationKey: afterKey, installSource: afterSource, ...after } = await this.deps.inspect(entry);
      source = afterSource;
      if ((afterKey ?? entry.id) !== key) {
        key = afterKey ?? entry.id; passed = false; failureCode = 'configuration-changed';
        runtime = { ...parseIntegrationRuntime(after), connection: 'missing', reason: 'Integration configuration changed during the check. Run Test again for the current binding.' };
      }
    } catch (error) {
      if (error instanceof IntegrationProbeFailure) { runtime = error.runtime; failureCode = error.code; }
      // Never persist provider messages, stdout, stderr, request URLs or exceptions.
    }
    const stored = this.#stored(entry.id);
    if (!passed && runtime.connection !== 'expired') runtime = { ...runtime, connection: 'missing' };
    if (!passed && !failureCode) runtime = { ...runtime, reason: 'Read-only check failed. Review the installation, account and endpoint setup, then retry.' };
    const workflow = stored?.key === key ? stored.runtime.workflow : { lastSuccess: null, lastTest: null };
    const next = parseIntegrationRuntime({ ...runtime, workflow: {
      lastSuccess: passed && kind === 'workflow' ? { at, operation } : workflow.lastSuccess,
      lastTest: { at, outcome: passed ? 'passed' : 'failed', kind,
        code: passed ? 'check-passed' : failureCode ?? (runtime.connection === 'expired' ? 'connection-expired' : runtime.connection === 'missing' ? 'connection-missing' : 'check-unavailable'),
        message: passed ? kind === 'workflow' ? 'Read-only workflow call succeeded.' : 'Connection check passed; a workflow call is still unverified.' : failureCode ? runtime.reason : 'Read-only check failed. Review the installation, account and endpoint setup, then retry.' },
    } });
    this.deps.db.prepare('INSERT INTO workbench_integration_status(integration_id, runtime_json) VALUES (?, ?) ON CONFLICT(integration_id) DO UPDATE SET runtime_json=excluded.runtime_json').run(entry.id, JSON.stringify({ key, runtime: next }));
    return withLiveInstallState(entry, next, source);
  }
}
