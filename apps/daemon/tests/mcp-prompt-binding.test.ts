import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeMcpConfig } from '../src/mcp-config.js';
import { setToken } from '../src/mcp-tokens.js';
import { mcpEndpointFingerprint } from '../src/mcp-endpoint.js';

vi.mock('../src/runtimes/chat-prompt-inputs.js', () => ({
  resolveOdNextRequestUserPrompt: () => 'Hello',
  resolveResearchCommandContract: () => '',
  composeChatAgentTextPayload: (input: { connectedExternalMcpReference: string }) => ({ composedPrompt: input.connectedExternalMcpReference }),
}));
vi.mock('../src/strategies/od-next/task-input-snapshot.js', () => ({ loadOdNextTaskInputSnapshot: () => ({}) }));
vi.mock('../src/strategies/od-next/frozen-skill-package.js', () => ({ renderFrozenSkillRosterContext: () => '', resolveFrozenSkillBundleBodies: () => '' }));

const { createOdNextInitialPromptBundleService } = await import('../src/strategies/od-next/initial-prompt-bundle-service.js');
let dataDir: string;
const url = 'https://mcp.example.test/mcp';
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-prompt-'));
  await writeMcpConfig(dataDir, { servers: [{ id: 'remote', label: 'Synthetic connected service', transport: 'http', enabled: true, authMode: 'oauth', url }] });
});
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });
async function prompt() {
  const service = createOdNextInitialPromptBundleService({
    db: {} as never, runtimeDataDir: dataDir, projectsDir: path.join(dataDir, 'projects'), daemonUrl: 'http://localhost:1', sandboxEnabled: false,
    getAgentDef: () => ({ id: 'codex', streamFormat: 'plain' } as never), createAgentRuntimeToolPrompt: () => '',
    composeDaemonSystemPrompt: async () => ({ prompt: '', odNextBundleHead: {} as never, odNextRecipeIdentity: {} as never }),
  });
  return (await service({ meta: { agentId: 'codex', message: 'Hello' }, frozenSkillPackage: {} as never, taskInputSnapshot: {} as never })).text;
}
it.each([undefined, mcpEndpointFingerprint(url + '?changed=1')])('never advertises an unbound or changed connection to the agent', async endpointFingerprint => {
  await setToken(dataDir, 'remote', { accessToken: 'synthetic-token', tokenType: 'Bearer', savedAt: 1, ...(endpointFingerprint ? { endpointFingerprint } : {}) });
  expect(await prompt()).not.toContain('Synthetic connected service');
});
it('advertises an exactly bound, current authorization', async () => {
  await setToken(dataDir, 'remote', { accessToken: 'synthetic-token', tokenType: 'Bearer', savedAt: 1, endpointFingerprint: mcpEndpointFingerprint(url) });
  expect(await prompt()).toContain('Synthetic connected service');
});

it.skipIf(process.platform === 'win32')('fails visibly when saved credentials cannot be read safely', async () => {
  await rm(path.join(dataDir, 'mcp-config.json'));
  const unrelated = path.join(dataDir, 'unrelated.json');
  await writeFile(unrelated, JSON.stringify({ servers: [] }), { mode: 0o644 });
  await symlink(unrelated, path.join(dataDir, 'mcp-config.json'));
  await expect(prompt()).rejects.toMatchObject({ code: 'MCP_CREDENTIAL_FILE_UNSAFE', message: expect.stringMatching(/mcp-config\.json.*Settings/) });
});
