import { ConnectorError } from './connectors/connector-error.js';
import { McpCredentialFileError } from '../mcp-private-file.js';
import { mcpTokenMatchesEndpoint } from '../mcp-endpoint.js';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { integrationTestability, parseIntegrationRuntime, type IntegrationRosterEntry, type IntegrationRuntime } from '@open-design/contracts';
import { readMcpConfig, effectiveMcpAuthMode, type McpServerConfig } from '../mcp-config.js';
import { getToken, isTokenExpired, type StoredMcpToken } from '../mcp-tokens.js';
import { listMotionSitesTools } from '../motionsites/mcp-client.js';
import { getProductAgentDef } from '../runtimes/registry.js';
import { resolveOnPath } from '../runtimes/executables.js';
import { applyAgentLaunchEnv, resolveAgentLaunch } from '../runtimes/launch.js';
import { execAgentFile } from '../runtimes/invocation.js';
import { probeAgentAuthStatus } from '../runtimes/auth.js';
import { spawnEnvForAgent } from '../runtimes/env.js';
import { agentCliEnvForAgent, readAppConfig } from '../app-config.js';
import { resolveHiggsfieldCliPath, runHiggsfieldCli } from '../media/higgsfield-runtime.js';
import { ALL_INTEGRATION_ROWS, RUNTIME_INTEGRATION_ROWS } from './integration-roster-data.js';
import { matchingRosterServers } from './integration-roster.js';
import type { ConnectorProxy } from './connectors/connector-proxy.js';
import { IntegrationProbeFailure, type IntegrationInstallSource, type IntegrationProbeResult } from './integration-status.js';

const requirePackage = createRequire(import.meta.url);
const versionOnly = (value: string): string | null => value.match(/\b\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-.][a-zA-Z0-9]{1,12})?\b/u)?.[0] ?? null;
const fixedRuntime = (entry: IntegrationRosterEntry): IntegrationRuntime => ({ ...entry.runtime!, connection: 'missing', accountLabel: null, workflow: { lastSuccess: null, lastTest: null } });
const needsMcpToken = (server: McpServerConfig): boolean => effectiveMcpAuthMode(server) === 'oauth'
  && !Object.entries(server.headers ?? {}).some(([name, value]) => name.toLowerCase() === 'authorization' && value.trim() !== '');
const rosterAgentDef = (id: string) => RUNTIME_INTEGRATION_ROWS.some(row => row.id === id) ? getProductAgentDef(id) : null;
/** Validate the exact binding/token snapshot used for dispatch; never trust earlier inspection. */
function mcpConnection(runtime: IntegrationRuntime, server: McpServerConfig, token: StoredMcpToken | null): IntegrationRuntime {
  const missing = { ...runtime, connection: 'missing' as const };
  if (!server.enabled) return { ...missing, reason: 'The matching MCP binding is disabled. Enable it in Settings.' };
  if (needsMcpToken(server)) {
    if (!token) return { ...missing, reason: 'MCP account is missing. Sign in to this binding in Settings.' };
    if (isTokenExpired(token)) return { ...missing, connection: 'expired', reason: 'MCP authorization expired. Sign in again in Settings.' };
    if (!mcpTokenMatchesEndpoint(token, server.url)) return { ...missing, reason: 'Saved authorization belongs to another endpoint or has no resource binding. Sign in to this binding again.' };
  }
  return { ...runtime, connection: 'connected', reason: 'Enabled MCP binding with configured authorization. Run Test to check a real connection.' };
}

/** All probes use existing daemon-owned lanes. GET inspects local state only; Test may do read-only I/O. */
export function createIntegrationProbes(options: { dataDir: string; skillRoots: readonly string[]; proxy: Pick<ConnectorProxy, 'search'> }) {
  const keyed = (runtime: IntegrationRuntime, value: unknown) => ({ ...runtime, verificationKey: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
  const fileIdentity = async (file: string | null) => { if (!file) return null; try { const info = await stat(file); return [file, info.mtimeMs, info.size]; } catch { return [file, null]; } };
  const binding = async (entry: IntegrationRosterEntry): Promise<McpServerConfig | undefined> => {
    const row = ALL_INTEGRATION_ROWS.find(item => item.id === entry.id)!;
    const matches = matchingRosterServers(row, (await readMcpConfig(options.dataDir)).servers) as McpServerConfig[];
    return matches.find(item => item.enabled) ?? matches[0];
  };
  async function inspect(entry: IntegrationRosterEntry): Promise<IntegrationRuntime & { verificationKey?: string; installSource?: IntegrationInstallSource }> {
    const runtime = fixedRuntime(entry);
    const capability = integrationTestability(entry);
    if (!capability.testable) return { ...runtime, installed: entry.installState.state === 'bundled' ? 'installed' : 'not-required', reason: capability.message, fix: { label: 'Reference only', url: null, command: null } };
    const def = rosterAgentDef(entry.id);
    if (def) {
      const config = agentCliEnvForAgent((await readAppConfig(options.dataDir)).agentCliEnv, entry.id);
      const launch = resolveAgentLaunch(def, config); const bin = launch.launchPath;
      runtime.installed = bin ? 'installed' : 'missing';
      runtime.fix = { label: 'Review Local CLI sign-in', url: entry.urls[0] ?? null, command: entry.id === 'claude' ? 'claude auth login' : entry.id === 'codex' ? 'codex login' : null };
      runtime.reason = bin ? 'CLI installed; run Test to check its configured authentication.' : 'CLI executable is missing. Install it and rescan Local CLI settings.';
      // Reading status never spawns an authentication probe or prints environment values.
      return { ...keyed(runtime, [entry.id, await fileIdentity(launch.selectedPath), await fileIdentity(bin), launch.childPathPrepend, def.env, config]), installSource: 'agent-cli' };
    }
    if ((entry.id === 'github' || entry.id === 'vercel') && !await binding(entry)) {
      const bin = resolveOnPath(entry.id === 'github' ? 'gh' : 'vercel');
      if (bin) {
        runtime.installed = 'installed'; runtime.reason = 'CLI installed. Run Test to verify its signed-in account.';
        runtime.fix = { label: 'Sign in through the existing CLI', url: entry.urls[0] ?? null, command: entry.id === 'github' ? 'gh auth login' : 'vercel login' };
        return { ...keyed(runtime, [entry.id, await fileIdentity(bin)]), installSource: 'provider-cli' };
      }
    }
    if (entry.id === 'higgsfield') {
      try { await access(resolveHiggsfieldCliPath()); runtime.installed = 'installed'; } catch { runtime.installed = 'missing'; }
      runtime.reason = 'Run Test to check the Higgsfield subscription account.';
      runtime.fix = { label: 'Sign in to Higgsfield', url: 'https://higgsfield.ai', command: 'hf auth login' }; return { ...keyed(runtime, [entry.id, runtime.installed]), installSource: 'subscription-cli' };
    }
    if (entry.id === 'gsap') {
      try { const pkg = requirePackage('gsap/package.json') as { version: string }; runtime.version = versionOnly(pkg.version); runtime.installed = 'installed'; runtime.connection = 'connected'; runtime.reason = 'Local GSAP package is available; no account is required.'; } catch { runtime.installed = 'missing'; runtime.reason = 'Local GSAP package is missing. Reinstall workspace dependencies.'; }
      runtime.fix = { label: 'Restore workspace dependencies', url: null, command: 'pnpm install --frozen-lockfile' }; return keyed(runtime, [entry.id, runtime.version, runtime.installed]);
    }
    if (entry.id === 'hallmark') {
      runtime.installed = 'missing';
      for (const root of options.skillRoots) { try { await access(join(root, 'hallmark', 'SKILL.md')); runtime.installed = 'installed'; break; } catch { /* Next admitted skill root. */ } }
      runtime.reason = runtime.installed === 'installed' ? 'Skill installed. Applying the rubric still needs a workflow receipt.' : 'Hallmark is missing from the daemon skill catalogue. Import the admitted skill in Settings.';
      runtime.connection = runtime.installed === 'installed' ? 'connected' : 'missing'; return keyed(runtime, [entry.id, await Promise.all(options.skillRoots.map(root => fileIdentity(join(root, 'hallmark', 'SKILL.md'))))]);
    }
    const server = await binding(entry);
    if (!server) { runtime.installed = entry.installState.state === 'bundled' ? 'installed' : 'missing'; runtime.reason = 'No daemon MCP binding. Add the admitted integration in Settings → Integrations.'; return { ...runtime, installSource: 'mcp-binding' }; }
    runtime.installed = 'installed';
    const token = needsMcpToken(server) ? await getToken(options.dataDir, server.id) : null;
    const facts = [entry.id, server, token ? { endpointFingerprint: token.endpointFingerprint ?? null, resourceUrl: token.resourceUrl ?? null, clientId: token.clientId ?? null, issuer: token.authServerIssuer ?? null, scope: token.scope ?? null } : null];
    runtime.fix = { label: 'Review MCP setup and sign-in', url: entry.urls[0] ?? null, command: 'od mcp --help' };
    // A server label is not an account principal and may contain credentials; it is never copied.
    return { ...keyed(mcpConnection(runtime, server, token), facts), installSource: 'mcp-binding' };
  }
  async function probe(entry: IntegrationRosterEntry, current: IntegrationRuntime): Promise<IntegrationProbeResult> {
    const { verificationKey: _key, installSource: _source, ...facts } = current as IntegrationRuntime & { verificationKey?: string; installSource?: IntegrationInstallSource };
    let runtime = parseIntegrationRuntime(facts);
    const def = rosterAgentDef(entry.id);
    if (def) {
      const config = agentCliEnvForAgent((await readAppConfig(options.dataDir)).agentCliEnv, entry.id);
      const launch = resolveAgentLaunch(def, config); const bin = launch.launchPath;
      if (!bin || !launch.selectedPath) throw new IntegrationProbeFailure('cli-not-installed', runtime);
      const env = applyAgentLaunchEnv(spawnEnvForAgent(entry.id, { ...process.env, ...def.env }, config, undefined, { resolvedBin: launch.selectedPath, adapterEnv: def.env ?? {} }), launch);
      let version;
      try { version = await execAgentFile(bin, def.versionArgs, { env, timeout: 5000, maxBuffer: 64 * 1024 }); }
      catch { throw new IntegrationProbeFailure('cli-version-check-failed', { ...runtime, reason: 'The CLI version command failed or timed out. Review the executable in Local CLI settings or reinstall it.' }); }
      runtime.version = versionOnly(String(version.stdout));
      const auth = await probeAgentAuthStatus(def, bin, env);
      if (auth?.status !== 'ok') throw new IntegrationProbeFailure('cli-auth-unverified', { ...runtime, connection: 'missing', reason: def.authProbe ? 'CLI authentication was not verified. Run the sign-in command or review Local CLI settings.' : 'This runtime has no read-only authentication probe. Check its account in Local CLI settings; generation was not dispatched.' });
      runtime.connection = 'connected'; runtime.reason = 'CLI authentication probe passed; generation has not been tested.';
      return { kind: 'connection', operation: 'cli-auth-status', runtime };
    }
    if ((entry.id === 'github' || entry.id === 'vercel') && !await binding(entry)) {
      const bin = resolveOnPath(entry.id === 'github' ? 'gh' : 'vercel');
      if (bin) {
        const args = entry.id === 'github' ? ['api', 'user'] : ['whoami'];
        try {
          const result = await execAgentFile(bin, args, { env: process.env, timeout: 10_000, maxBuffer: 64 * 1024 });
          const label: unknown = entry.id === 'github' ? (JSON.parse(String(result.stdout)) as { login?: unknown }).login : String(result.stdout).trim();
          // Only provider usernames are admitted, never arbitrary CLI output or credentials.
          if (typeof label !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,38}$/u.test(label) || /^(?:(?:sk|pk|rk)[_-]|gh[pousr]_|github_pat_|xox[abp]-|Bearer)/iu.test(label) || /[A-Za-z0-9_]{32,}/u.test(label)) throw new Error('Invalid account label');
          runtime.accountLabel = label; runtime.connection = 'connected'; runtime.reason = 'Signed-in account check passed; deployment and repository workflows remain unverified.';
          const version = await execAgentFile(bin, ['--version'], { env: process.env, timeout: 5000, maxBuffer: 64 * 1024 }).catch(() => null);
          runtime.version = version ? versionOnly(String(version.stdout)) : null;
          return { kind: 'connection', operation: 'cli-account-status', runtime };
        } catch { throw new IntegrationProbeFailure('cli-account-unverified', { ...runtime, connection: 'missing', reason: 'The CLI account check failed. Run the sign-in command and retry.' }); }
      }
    }
    if (entry.id === 'higgsfield') {
      try {
        const account: unknown = JSON.parse(await runHiggsfieldCli(['account', 'status'], '', 10000));
        if (!account || typeof account !== 'object' || !('subscription_plan_type' in account) || typeof account.subscription_plan_type !== 'string') throw new Error('Account unverified');
      } catch { throw new IntegrationProbeFailure('subscription-unverified', { ...runtime, connection: 'missing', reason: 'Higgsfield account check failed. Sign in through the existing subscription lane and retry.' }); }
      runtime.connection = 'connected'; runtime.reason = 'Subscription account check passed; media generation has not been tested.';
      return { kind: 'connection', operation: 'account-status', runtime };
    }
    if (runtime.connection !== 'connected') throw new IntegrationProbeFailure(runtime.connection === 'expired' ? 'connection-expired' : 'connection-missing', runtime);
    if (entry.id === 'gsap') {
      const { gsap } = requirePackage('gsap') as typeof import('gsap');
      const target = { value: 0 }; const tween = gsap.to(target, { value: 1, duration: 1, paused: true });
      try { tween.progress(1); if (target.value !== 1) throw new Error('GSAP check failed'); } finally { tween.kill(); }
      return { kind: 'workflow', operation: 'local-tween', runtime };
    }
    if (entry.id === 'hallmark') return { kind: 'connection', operation: 'skill-availability', runtime };
    if (['mobbin', 'motionsites'].includes(entry.id)) {
      try { await options.proxy.search(entry.id, entry.id === 'mobbin' ? { query: 'navigation', kind: 'screens', platform: 'web', limit: 1 } : { query: 'navigation', limit: 1 }); }
      catch (error) {
        if (error instanceof ConnectorError && error.code === 'connector-binding-missing') {
          throw new IntegrationProbeFailure(error.code, { ...runtime, connection: 'missing', reason: error.message });
        }
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        const expired = code === 'connector-needs-sign-in' || code === 'connector-access-revoked';
        throw new IntegrationProbeFailure(expired ? 'connection-expired' : code === 'connector-rate-limited' ? 'rate-limited' : 'workflow-check-failed', { ...runtime, connection: expired ? 'expired' : runtime.connection, reason: expired ? 'Authorization was rejected. Sign in again in Settings.' : code === 'connector-rate-limited' ? 'Provider rate limit reached. Retry the read-only check later.' : 'Read-only search failed. Review the binding and retry.' });
      }
      return { kind: 'workflow', operation: 'authorized-search', runtime };
    }
    const server = await binding(entry);
    if (server?.transport === 'stdio') throw new IntegrationProbeFailure('probe-not-supported', { ...runtime, connection: 'missing', reason: 'This binding is owned by an agent stdio lane. Check it through that agent after sign-in; the daemon does not start commands or install packages from Test.' });
    if (!server || server.transport !== 'http' || !server.url) throw new IntegrationProbeFailure('probe-not-supported', { ...runtime, reason: 'This binding has no daemon HTTP probe. Review its MCP setup; no tool was dispatched.' });
    const token = needsMcpToken(server) ? await getToken(options.dataDir, server.id) : null;
    runtime = mcpConnection(runtime, server, token);
    if (runtime.connection !== 'connected') throw new IntegrationProbeFailure(runtime.connection === 'expired' ? 'connection-expired' : 'connection-missing', runtime);
    const signal = AbortSignal.timeout(10_000);
    try { await listMotionSitesTools({ url: server.url, accessToken: token?.accessToken ?? '', ...(server.headers ? { headers: server.headers } : {}), fetchImpl: (url, init) => fetch(url, { ...init, signal, redirect: 'error' }) }); }
    catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
      const expired = status === 401 || status === 403;
      throw new IntegrationProbeFailure(expired ? 'connection-expired' : status === 429 ? 'rate-limited' : signal.aborted ? 'check-timeout' : 'connection-check-failed', { ...runtime, connection: expired ? 'expired' : runtime.connection, reason: expired ? 'MCP authorization was rejected. Sign in again in Settings.' : status === 429 ? 'MCP rate limit reached. Retry later.' : signal.aborted ? 'The MCP check timed out after 10 seconds. Check the endpoint and retry.' : 'MCP connection check failed. Review the endpoint and retry.' });
    }
    return { kind: 'connection', operation: 'mcp-tools-list', runtime };
  }
  const credentialRuntime = (entry: IntegrationRosterEntry, error: McpCredentialFileError): IntegrationRuntime => ({
    ...fixedRuntime(entry), reason: error.message,
    fix: { label: 'Repair saved credentials in Settings → External MCP servers', url: null, command: null },
  });
  return {
    async inspect(entry: IntegrationRosterEntry) {
      try { return await inspect(entry); }
      catch (error) {
        if (!(error instanceof McpCredentialFileError)) throw error;
        // A distinct binding key cannot restore an earlier connected receipt over this refusal.
        return keyed(credentialRuntime(entry, error), [error.code, error.store]);
      }
    },
    async probe(entry: IntegrationRosterEntry, current: IntegrationRuntime) {
      try { return await probe(entry, current); }
      catch (error) {
        if (!(error instanceof McpCredentialFileError)) throw error;
        throw new IntegrationProbeFailure(error.code, credentialRuntime(entry, error));
      }
    },
  };
}
