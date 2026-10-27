import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeCliLlm } from '../src/node.ts';
import type { FetchFn } from '../src/types.ts';

test('the Claude CLI client downloads images, tells the model where they are and parses its JSON', async () => {
  const seen: { args: string[]; cwd: string }[] = [];
  const fetch: FetchFn = async (input) => String(input).endsWith('.png')
    ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png; charset=binary' } })
    : new Response('', { status: 404 });
  const llm = createClaudeCliLlm({
    model: 'haiku',
    fetch,
    run: async (args, cwd) => {
      seen.push({ args, cwd });
      return '```json\n{"ok":true}\n```';
    },
  });
  const out = await llm.json({ system: 'sys', user: 'usr', images: ['https://x.example.com/a.png', 'https://x.example.com/missing.jpg'] });
  assert.deepEqual(out, { ok: true });
  const call = seen[0];
  assert.ok(call);
  assert.deepEqual(call.args.slice(0, 7), ['-p', '--model', 'haiku', '--allowedTools', 'Read', '--add-dir', call.cwd]);
  assert.match(call.args[8] as string, /Answer with one JSON object and nothing else\.$/);
  assert.match(call.args[9] as string, /^usr\n\nLook at these image files with the Read tool before answering:\n.*image-1\.png$/);
  assert.ok(!(call.args[9] as string).includes('image-2'));
});

test('the Claude CLI client rejects an answer that is not JSON', async () => {
  const llm = createClaudeCliLlm({ run: async () => 'no json here' });
  await assert.rejects(llm.json({ system: 's', user: 'u' }), /valid JSON/);
});
