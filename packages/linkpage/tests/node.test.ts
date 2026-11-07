import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createClaudeCliLlm } from '../src/node.ts';
import type { FetchFn } from '../src/types.ts';

test('the Claude CLI client downloads images, tells the model where they are and parses its JSON', async () => {
  const seen: { args: string[]; cwd: string; input: string | undefined }[] = [];
  const fetch: FetchFn = async (input) => String(input).endsWith('.png')
    ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png; charset=binary' } })
    : new Response('', { status: 404 });
  const llm = createClaudeCliLlm({
    model: 'haiku',
    fetch,
    run: async (args, cwd, input) => {
      seen.push({ args, cwd, input });
      return '```json\n{"ok":true}\n```';
    },
  });
  const out = await llm.json({ system: 'sys', user: 'usr', images: ['https://x.example.com/a.png', 'https://x.example.com/missing.jpg'] });
  assert.deepEqual(out, { ok: true });
  const call = seen[0];
  assert.ok(call);
  // Locked down: only the Read tool exists, no MCP servers, no user/project settings or hooks, nothing asks to run.
  const flag = (name: string): string | undefined => call.args[call.args.indexOf(name) + 1];
  assert.equal(flag('--model'), 'haiku');
  assert.equal(flag('--tools'), 'Read');
  assert.equal(flag('--allowedTools'), 'Read');
  assert.equal(flag('--setting-sources'), '');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--add-dir'), call.cwd);
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.ok(call.args.includes('--disable-slash-commands'));
  assert.ok(!call.args.includes('--dangerously-skip-permissions'));
  assert.match(flag('--append-system-prompt') as string, /Answer with one JSON object and nothing else\.$/);
  // The prompt, which carries scraped text, goes over stdin and not onto the command line.
  assert.ok(!call.args.some((a) => a.includes('usr')));
  assert.match(call.input as string, /^usr\n\nLook at these image files with the Read tool before answering:\n.*image-1\.png$/);
  assert.ok(!(call.input as string).includes('image-2'));
  assert.ok(!existsSync(call.cwd), 'the temporary folder is removed afterwards');
});

test('the Claude CLI client rejects an answer that is not JSON', async () => {
  const llm = createClaudeCliLlm({ run: async () => 'no json here' });
  await assert.rejects(llm.json({ system: 's', user: 'u' }), /valid JSON/);
});

test('the temporary folder is removed even when claude fails', async () => {
  let dir = '';
  const llm = createClaudeCliLlm({ run: async (_args, cwd) => { dir = cwd; throw new Error('boom'); } });
  await assert.rejects(llm.json({ system: 's', user: 'u' }), /boom/);
  assert.ok(dir && !existsSync(dir));
});

test('a resolved executable path is the program that runs', async () => {
  const seen: string[] = [];
  const llm = createClaudeCliLlm({ executable: '/opt/bin/claude', run: async (_args, _cwd, _input, file) => { seen.push(file); return '{"a":1}'; } });
  assert.deepEqual(await llm.json({ system: 's', user: 'u' }), { a: 1 });
  assert.deepEqual(seen, ['/opt/bin/claude']);
});
