import { afterEach, expect, it, vi } from 'vitest';
import { applyCreatedSessionChoice, choiceFromCliFlags, runModelCli } from '../../src/workbench/model-cli.js';
afterEach(() => vi.unstubAllGlobals());
it('rejects incomplete and credential-bearing create choices before a request', () => {
  expect(choiceFromCliFlags({})).toBeUndefined();
  expect(() => choiceFromCliFlags({ agent: 'claude' })).toThrow();
  expect(() => choiceFromCliFlags({ agent: 'byok-opencode', model: 'raw', 'byok-binding-json': JSON.stringify({ protocol: 'openai', baseUrl: '', requiresApiKey: true, apiKey: 'secret' }) })).toThrow();
});
it('retains the created identity and structured partial recovery on a failed or interrupted PUT', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 409 })); vi.stubGlobal('fetch', fetchMock);
  const choice = { agentId: 'claude', modelId: 'default' };
  expect(await applyCreatedSessionChoice('http://127.0.0.1', 'p', { conversation: { id: 'real-seed' } }, choice, {})).toEqual({ partial: { code: 'session-model-create-partial', projectId: 'p', conversationId: 'real-seed', status: 409 } });
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ ...choice, expectedRevision: 0 });
  fetchMock.mockRejectedValue(new Error('network unavailable'));
  expect(await applyCreatedSessionChoice('http://127.0.0.1', 'p', { conversation: { id: 'real-seed' } }, choice, {})).toEqual({ partial: { code: 'session-model-create-partial', projectId: 'p', conversationId: 'real-seed' } });
});
it('returns one sanitized validation result and never contacts the daemon for malformed public input', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); const output: unknown[] = [];
  const code = await runModelCli(['set','--session','s','--project','p','--agent','byok-opencode','--model','raw','--expected-revision','0','--byok-binding-json','{"apiKey":"never-echo-this"}','--json'], { write: v => output.push(v) });
  expect(code).toBe(2); expect(fetchMock).not.toHaveBeenCalled(); expect(JSON.stringify(output)).not.toContain('never-echo-this');
});
it('forwards a public BYOK binding on preflight so CLI parity matches the HTTP route and composers', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, mismatches: [] }), { status: 200 })); vi.stubGlobal('fetch', fetchMock);
  const binding = { protocol: 'openai', baseUrl: 'https://api.example.com/v1', requiresApiKey: true };
  await runModelCli(['preflight','--session','s','--project','p','--agent','byok-opencode','--model','raw-model','--byok-binding-json',JSON.stringify(binding),'--daemon-url','http://127.0.0.1:1','--json'], { write: () => {} });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ agentId: 'byok-opencode', modelId: 'raw-model', byokBinding: { protocol: 'openai', requiresApiKey: true } });
});
it('rejects a credential-bearing preflight binding without contacting the daemon or echoing it', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); const output: unknown[] = [];
  const code = await runModelCli(['preflight','--session','s','--project','p','--agent','byok-opencode','--model','raw','--byok-binding-json','{"apiKey":"never-echo-this"}','--json'], { write: v => output.push(v) });
  expect(code).toBe(2); expect(fetchMock).not.toHaveBeenCalled(); expect(JSON.stringify(output)).not.toContain('never-echo-this');
});
