import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPage, deriveTheme } from '../src/index.ts';
import { linksJson, llmsTxt } from '../src/machine.ts';
import { handleMcp } from '../src/mcp.ts';
import type { JsonRpcResponse, McpContext } from '../src/mcp.ts';
import type { RawBlock } from '../src/types.ts';
import { defined } from './helpers.ts';

const ORIGIN = 'https://links.example.com';
const raw = (blocks: RawBlock[]) => ({
  slug: 'studio',
  profile: { name: 'Studio Name', bio: 'Hand made pots.', avatar_url: 'https://cdn.example.com/a.jpg', site_url: 'https://studio.example.com' },
  theme: deriveTheme([{}]),
  blocks,
});
const BLOCKS: RawBlock[] = [
  { type: 'link', label: 'Shop', url: 'https://studio.example.com/shop', description: 'New mugs every Friday' },
  { type: 'social', items: [{ kind: 'instagram', url: 'https://instagram.com/studio', handle: '@studio' }] },
  { type: 'posts', heading: 'Notes', items: [{ title: 'First', url: 'https://studio.substack.com/p/first' }, { title: 'Second', url: 'https://studio.substack.com/p/second' }] },
  { type: 'email', endpoint: 'https://links.example.com/api/signup' },
  { type: 'text', body: 'Hello there' },
];
const spec = checkPage(raw(BLOCKS));
const bare = checkPage(raw([BLOCKS[0] as RawBlock]));
const rpc = (method: string, params?: Record<string, unknown>, id = 1) => ({ jsonrpc: '2.0', id, method, params });
// One reply to one request: never null, never a batch.
const reply = async (ctx: McpContext, request: unknown): Promise<JsonRpcResponse> => defined(await handleMcp(ctx, request), 'reply');
interface Tool { name: string; description?: string; inputSchema: { type: string } }
interface Init { protocolVersion: string; capabilities: unknown; serverInfo: unknown; instructions: unknown }
const resultOf = async <T>(ctx: McpContext, request: unknown): Promise<T> => (await reply(ctx, request)).result as T;
const call = (ctx: McpContext, name: string, args: Record<string, unknown>) => reply(ctx, rpc('tools/call', { name, arguments: args }));
const body = (res: JsonRpcResponse) => JSON.parse((res.result as { content: { text: string }[] }).content[0]?.text as string);
const toolText = (res: JsonRpcResponse): string => (res.result as { content: { text: string }[] }).content[0]?.text as string;
const errorCode = (res: JsonRpcResponse): number | undefined => res.error?.code;
const isError = (res: JsonRpcResponse): boolean | undefined => (res.result as { isError?: boolean }).isError;

test('llms.txt has the title, the bio, every link and the agent endpoints, with no HTML', () => {
  const t = llmsTxt(spec, { origin: ORIGIN });
  assert.match(t, /^# Studio Name\n\n> Hand made pots\.\n\n## Links\n/);
  assert.ok(t.includes('- [Shop](https://studio.example.com/shop): New mugs every Friday'));
  for (const u of ['https://instagram.com/studio', 'https://studio.substack.com/p/first', 'https://studio.substack.com/p/second']) assert.ok(t.includes(u), u);
  assert.ok(t.includes('## For agents'));
  assert.ok(t.includes(`${ORIGIN}/studio/links.json`));
  assert.ok(t.includes(`${ORIGIN}/studio/mcp`));
  assert.ok(t.includes('https://links.example.com/api/signup'));
  assert.doesNotMatch(t, /<[a-z]/);
  assert.doesNotMatch(llmsTxt(bare, { origin: ORIGIN }), /Subscribe/);
});

test('links.json lists profile, links by kind and the signup; trackBase adds tracked addresses', () => {
  const j = linksJson(spec, { origin: ORIGIN });
  assert.equal(j.name, 'Studio Name');
  assert.equal(j.page_url, `${ORIGIN}/studio`);
  assert.deepEqual(j.links.map((l) => l.kind), ['link', 'social', 'post', 'post']);
  assert.equal(j.links[0]?.url, 'https://studio.example.com/shop');
  assert.ok(!('tracked_url' in (j.links[0] as object)));
  assert.deepEqual(j.subscribe, { endpoint: 'https://links.example.com/api/signup', method: 'POST', fields: ['email'], kind: 'signup' });
  assert.equal(j.generated_from, 'mish-linkpage');
  assert.equal(j.version, 1);
  const t = linksJson(spec, { origin: ORIGIN, trackBase: 'https://links.example.com/go/' });
  assert.equal(t.links[0]?.tracked_url, `https://links.example.com/go/studio/${spec.blocks[0]?.id}/0`);
  assert.equal(t.links[3]?.tracked_url, `https://links.example.com/go/studio/${spec.blocks[2]?.id}/1`);
  assert.equal(linksJson(bare, { origin: ORIGIN }).subscribe, null);
});

test('MCP initialize echoes a known protocol version, falls back otherwise, and notifications return null', async () => {
  const ctx = { spec, origin: ORIGIN };
  const a = await resultOf<Init>(ctx, rpc('initialize', { protocolVersion: '2024-11-05' }));
  assert.equal(a.protocolVersion, '2024-11-05');
  assert.deepEqual(a.capabilities, { tools: {} });
  assert.deepEqual(a.serverInfo, { name: 'mish-linkpage', version: '1' });
  assert.equal(typeof a.instructions, 'string');
  assert.equal((await resultOf<Init>(ctx, rpc('initialize', { protocolVersion: '1999-01-01' }))).protocolVersion, '2025-06-18');
  assert.equal(await handleMcp(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual(await resultOf(ctx, rpc('ping')), {});
});

test('MCP tools/list shows subscribe only when it can work', async () => {
  const listed = async (ctx: McpContext): Promise<Tool[]> => (await resultOf<{ tools: Tool[] }>(ctx, rpc('tools/list'))).tools;
  const names = async (ctx: McpContext) => (await listed(ctx)).map((t) => t.name);
  assert.deepEqual(await names({ spec, origin: ORIGIN, subscribe: async () => {} }), ['get_profile', 'list_links', 'latest_posts', 'subscribe']);
  assert.deepEqual(await names({ spec, origin: ORIGIN }), ['get_profile', 'list_links', 'latest_posts']);
  assert.deepEqual(await names({ spec: bare, origin: ORIGIN, subscribe: async () => {} }), ['get_profile', 'list_links', 'latest_posts']);
  const t = defined((await listed({ spec, origin: ORIGIN }))[0]);
  assert.equal(t.inputSchema.type, 'object');
  assert.ok(t.description);
});

test('MCP read tools return profile, filtered links and a limited list of posts', async () => {
  const ctx = { spec, origin: ORIGIN };
  assert.equal(body(await call(ctx, 'get_profile', {})).name, 'Studio Name');
  assert.equal(body(await call(ctx, 'list_links', {})).length, 4);
  assert.deepEqual(body(await call(ctx, 'list_links', { kind: 'social' })).map((l: { kind: string }) => l.kind), ['social']);
  assert.equal(body(await call(ctx, 'latest_posts', {})).length, 2);
  assert.deepEqual(body(await call(ctx, 'latest_posts', { limit: 1 })), [{ title: 'First', url: 'https://studio.substack.com/p/first' }]);
  assert.equal(errorCode(await call(ctx, 'latest_posts', { limit: 11 })), -32602);
  assert.equal(errorCode(await call(ctx, 'list_links', { kind: 'nope' })), -32602);
  assert.equal(errorCode(await call(ctx, 'nope', {})), -32602);
});

test('MCP subscribe validates the email, calls the injected function, and hides failures', async () => {
  const seen: { email: string }[] = [];
  const ctx: McpContext = { spec, origin: ORIGIN, subscribe: async (x) => { seen.push(x); } };
  const good = await call(ctx, 'subscribe', { email: 'a@b.co' });
  assert.deepEqual(seen, [{ email: 'a@b.co' }]);
  assert.equal(isError(good), undefined);
  assert.match(toolText(good), /a@b\.co/);
  const bad = await call(ctx, 'subscribe', { email: 'nope' });
  assert.equal(isError(bad), true);
  assert.equal(seen.length, 1);
  assert.equal(errorCode(await call(ctx, 'subscribe', {})), -32602);
  const boom = await call({ ...ctx, subscribe: async () => { throw new Error('db password=hunter2'); } }, 'subscribe', { email: 'a@b.co' });
  assert.equal(isError(boom), true);
  assert.doesNotMatch(JSON.stringify(boom), /hunter2/);
  assert.equal(isError(await call({ spec, origin: ORIGIN }, 'subscribe', { email: 'a@b.co' })), true);
});

test('MCP unknown methods give -32601 and batches answer each request, skipping notifications', async () => {
  const ctx = { spec, origin: ORIGIN };
  const e = await reply(ctx, rpc('resources/list', {}, 7));
  assert.equal(errorCode(e), -32601);
  assert.equal(e.id, 7);
  const out = defined(await handleMcp(ctx, [rpc('ping', undefined, 1), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list', undefined, 2)]));
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
  assert.equal(await handleMcp(ctx, [{ jsonrpc: '2.0', method: 'notifications/initialized' }]), null);
});
