import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readAppConfig } from '../../src/app-config.js';
import { execAgentFile } from '../../src/runtimes/invocation.js';
import { probeAgentAuthStatus } from '../../src/runtimes/auth.js';
import { buildIntegrationRoster } from '../../src/workbench/integration-roster.js';
import { createIntegrationProbes } from '../../src/workbench/integration-probes.js';

vi.mock('../../src/runtimes/registry.js', async original => {
  const registry = await original<typeof import('../../src/runtimes/registry.js')>();
  const defs = [...registry.PRODUCT_AGENT_DEFS,
    { ...registry.getAgentDef('claude')!, id: 'claude_work', name: 'Work Claude', env: { CLAUDE_CONFIG_DIR: '/fixture/claude-work' } },
    { ...registry.getAgentDef('codex')!, id: 'codex_work', name: 'Work Codex', env: { CODEX_HOME: '/fixture/codex-work' } },
    { ...registry.getAgentDef('claude')!, id: 'refero', name: 'Local name collision' },
  ];
  const getDef = (id: string) => defs.find(def => def.id === id) ?? null;
  return { ...registry, PRODUCT_AGENT_DEFS: defs, getAgentDef: getDef, getProductAgentDef: getDef };
});
vi.mock('../../src/app-config.js', async original => ({ ...await original<typeof import('../../src/app-config.js')>(), readAppConfig: vi.fn() }));
vi.mock('../../src/runtimes/resolution.js', () => ({ resolveAgentBin: vi.fn(() => '/fixture/bin/agent') }));
vi.mock('../../src/runtimes/launch.js', async original => {
  const launch = await original<typeof import('../../src/runtimes/launch.js')>();
  return { ...launch, resolveAgentLaunch: vi.fn((...args: Parameters<typeof launch.resolveAgentLaunch>) => ({
    ...launch.resolveAgentLaunch(...args), selectedPath: '/fixture/bin/agent', launchPath: '/fixture/bin/agent', childPathPrepend: ['/fixture/agent-tools'],
  })) };
});
vi.mock('../../src/runtimes/invocation.js', () => ({ execAgentFile: vi.fn() }));
vi.mock('../../src/runtimes/auth.js', () => ({ probeAgentAuthStatus: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readAppConfig).mockResolvedValue({});
  vi.mocked(execAgentFile).mockResolvedValue({ stdout: '1.2.3', stderr: '' });
  vi.mocked(probeAgentAuthStatus).mockResolvedValue({ status: 'ok' });
});

describe('local CLI profile probes', () => {
  it('keeps a curated integration on its own lane when a local profile collides', async () => {
    const row = buildIntegrationRoster({ mcpServers: [], licences: [] }).entries.find(entry => entry.id === 'refero')!;
    const probes = createIntegrationProbes({ dataDir: '/fixture/data', skillRoots: [], proxy: { search: vi.fn() } });
    expect((await probes.inspect(row)).reason).toMatch(/No daemon MCP binding/);
    expect(execAgentFile).not.toHaveBeenCalled();
  });
  it.each([
    ['claude_work', 'CLAUDE_CONFIG_DIR', '/fixture/claude-work'],
    ['codex_work', 'CODEX_HOME', '/fixture/codex-work'],
  ])('checks the %s profile account with its definition environment', async (id, key, value) => {
    const row = buildIntegrationRoster({ mcpServers: [], licences: [] }).entries.find(entry => entry.id === id)!;
    const probes = createIntegrationProbes({ dataDir: '/fixture/data', skillRoots: [], proxy: { search: vi.fn() } });
    const state = await probes.inspect(row);
    expect((await probes.probe(row, state)).runtime.connection).toBe('connected');
    // Assert selected fields so a failed check cannot print the inherited environment.
    const [versionBin, , versionOptions] = vi.mocked(execAgentFile).mock.calls[0]!;
    const [authDef, authBin, authEnv] = vi.mocked(probeAgentAuthStatus).mock.calls[0]!;
    expect(versionBin).toBe('/fixture/bin/agent');
    expect(versionOptions?.env?.[key]).toBe(value);
    expect(authDef.id).toBe(id);
    expect(authBin).toBe('/fixture/bin/agent');
    expect(authEnv[key]).toBe(value);
    expect(authEnv.PATH).toContain('/fixture/agent-tools');
    expect(JSON.stringify(state)).not.toContain(value);
  });
  it('keeps configured environment overrides above profile defaults', async () => {
    vi.mocked(readAppConfig).mockResolvedValue({ agentCliEnv: { codex_work: { CODEX_HOME: '/fixture/configured-codex' } } });
    const row = buildIntegrationRoster({ mcpServers: [], licences: [] }).entries.find(entry => entry.id === 'codex_work')!;
    const probes = createIntegrationProbes({ dataDir: '/fixture/data', skillRoots: [], proxy: { search: vi.fn() } });
    await probes.probe(row, await probes.inspect(row));
    expect(vi.mocked(probeAgentAuthStatus).mock.calls[0]![2].CODEX_HOME).toBe('/fixture/configured-codex');
  });
});
