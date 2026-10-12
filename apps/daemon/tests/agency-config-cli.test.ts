// `od agency config` with `--provider`: the fill-model keys ride the same endpoint as the Jev key,
// with `provider` in the PUT body. Driven through `runAgencyConfigCli` with an injected fetch, so
// nothing here spawns the CLI or reaches a daemon.

import { describe, expect, it } from 'vitest';

import { runAgencyConfigCli } from '../src/agency-config-cli.js';

const KEY = 'sk-deepseek-NEVER-IN-OUTPUT';

const STATUS = {
  configured: true,
  source: 'stored',
  models: {
    deepseek: { configured: true, source: 'env' },
    cerebras: { configured: false, source: 'unset' },
  },
};

function harness(stdin = '') {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return new Response(JSON.stringify(STATUS), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const run = (args: string[]) =>
    runAgencyConfigCli(args, {
      readStdin: async () => stdin,
      resolveBaseUrl: async () => 'http://daemon.test',
      fetchImpl,
    });
  return { requests, run };
}

describe('od agency config --provider', () => {
  it('status prints the Jev lines exactly as before, then one row each for DeepSeek, Cerebras and OpenRouter, and no key', async () => {
    const { run } = harness();
    const result = await run(['status']);
    expect(result).toEqual({
      kind: 'ok',
      stdout: 'Jev\tconfigured\nSource\tstored\nDeepSeek\tconfigured\tenv\nCerebras\tnot configured\tunset\nOpenRouter\tnot configured\tunset\n',
    });
    // The pre-model-key output was exactly `Jev\t<status>\nSource\t<source>\n`; it is still the prefix.
    expect(result.kind === 'ok' && result.stdout.startsWith('Jev\tconfigured\nSource\tstored\n')).toBe(true);
  });

  it('repair refuses without --confirm, and sends nothing', async () => {
    const { requests, run } = harness();
    const result = await run(['repair']);
    expect(result.kind).toBe('usage');
    expect(requests).toHaveLength(0);
  });

  it('repair --confirm posts the confirmation and prints the new file name', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ...STATUS, repaired: true, movedTo: 'agency-config.json.corrupt-2026-09-23T10-00-00-000Z' }), { status: 200 });
    }) as typeof fetch;
    const result = await runAgencyConfigCli(['repair', '--confirm'], { readStdin: async () => '', resolveBaseUrl: async () => 'http://daemon.test', fetchImpl });
    expect(requests).toEqual([{ url: 'http://daemon.test/api/agency/config/repair', method: 'POST', body: { confirm: true } }]);
    expect(result.kind === 'ok' && result.stdout.split('\n')[0]).toBe('Set the unreadable key file aside as agency-config.json.corrupt-2026-09-23T10-00-00-000Z. Save the keys again.');
  });

  it('set --provider deepseek --key-stdin sends the provider with the key and prints nothing of it', async () => {
    const { requests, run } = harness(`${KEY}\n`);
    const result = await run(['set', '--provider', 'deepseek', '--key-stdin']);
    expect(result.kind).toBe('ok');
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(requests).toEqual([{ url: 'http://daemon.test/api/agency/config', method: 'PUT', body: { provider: 'deepseek', apiKey: KEY } }]);
  });

  it('clear --provider=cerebras clears only that key', async () => {
    const { requests, run } = harness();
    await run(['clear', '--provider=cerebras']);
    expect(requests[0]?.body).toEqual({ provider: 'cerebras', clear: true });
  });

  it('without --provider the write stays on the Jev key', async () => {
    const { requests, run } = harness(`${KEY}\n`);
    await run(['set', '--key-stdin']);
    expect(requests[0]?.body).toEqual({ apiKey: KEY });
  });

  it('refuses an unknown provider before any request', async () => {
    const { requests, run } = harness();
    const result = await run(['set', '--provider', 'openai', '--key-stdin']);
    expect(result.kind).toBe('usage');
    expect(requests).toHaveLength(0);
  });

  it('still refuses --key on argv, with a provider too, and never echoes it', async () => {
    const { requests, run } = harness();
    const result = await run(['set', '--provider', 'deepseek', '--key', KEY]);
    expect(result.kind).toBe('usage');
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(requests).toHaveLength(0);
  });

  it('--json prints the daemon answer, which carries statuses only', async () => {
    const { run } = harness();
    const result = await run(['status', '--json']);
    expect(result.kind === 'ok' && JSON.parse(result.stdout)).toEqual(STATUS);
  });
});
