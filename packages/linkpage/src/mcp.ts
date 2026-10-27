// A small MCP server (Streamable HTTP, JSON replies only) for one link page. Pass the parsed JSON-RPC body
// to handleMcp and send back what it returns (nothing, with 202, when it returns null).
import { linksJson, pageItems, signupOf } from './machine.ts';
import type { PageSpec } from './types.ts';

const VERSIONS = ['2025-03-26', '2025-06-18', '2024-11-05'];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface McpContext {
  spec: PageSpec;
  origin?: string;
  /** Adds an address to the creator's email list. Without it the subscribe tool is not offered. */
  subscribe?: (input: { email: string }) => Promise<unknown>;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: true;
}

type Args = Record<string, unknown>;

const TOOLS = [
  { name: 'get_profile', description: 'Get the name, bio, site address and page address of this creator.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_links', description: 'List the creator\'s links, social profiles and posts, optionally only one kind.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['link', 'social', 'post'], description: 'Only return this kind.' } }, additionalProperties: false } },
  { name: 'latest_posts', description: 'Get the newest posts (title and address), newest first.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many, 1 to 10. Default 5.' } }, additionalProperties: false } },
  { name: 'subscribe', description: 'Subscribe an email address to the creator\'s email list. Only call this when the person asked you to.', inputSchema: { type: 'object', properties: { email: { type: 'string', format: 'email', description: 'The address to subscribe.' } }, required: ['email'], additionalProperties: false } },
];

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: JsonRpcId | undefined, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const text = (value: unknown, isError = false): ToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

async function callTool(ctx: McpContext, name: string, args: Args): Promise<ToolResult> {
  const { spec, origin } = ctx;
  const info = linksJson(spec, { origin });
  if (name === 'get_profile') return text({ name: info.name, bio: info.bio, avatar_url: info.avatar_url, site_url: info.site_url, page_url: info.page_url });
  if (name === 'list_links') return text(info.links.filter((l) => !args.kind || l.kind === args.kind));
  if (name === 'latest_posts') return text(pageItems(spec).filter((i) => i.kind === 'post').slice(0, (args.limit as number | undefined) ?? 5).map((i) => ({ title: i.label, url: i.url })));
  // subscribe
  if (!ctx.subscribe || !signupOf(spec)) return text('This page has no email list to subscribe to.', true);
  if (!EMAIL.test(args.email as string)) return text('That does not look like an email address.', true);
  try {
    await ctx.subscribe({ email: args.email as string });
    return text(`Subscribed ${args.email}.`);
  } catch {
    return text('The subscription did not go through. Try again later.', true);
  }
}

async function one(ctx: McpContext, input: unknown): Promise<JsonRpcResponse | null> {
  const req = input as JsonRpcRequest | null | undefined;
  if (!req || typeof req !== 'object' || Array.isArray(req) || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return fail(req?.id, -32600, 'Invalid request');
  const { id, method } = req;
  const params = (req.params ?? {}) as Record<string, unknown>;
  const note = id === undefined || id === null;
  if (method.startsWith('notifications/')) return null;
  if (note) return null;
  const tools = TOOLS.filter((t) => t.name !== 'subscribe' || (ctx.subscribe && signupOf(ctx.spec)));
  if (method === 'initialize') {
    const v = VERSIONS.includes(params.protocolVersion as string) ? params.protocolVersion : '2025-06-18';
    return ok(id as JsonRpcId, { protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'mishmash-linkpage', version: '1' }, instructions: `Tools for ${ctx.spec.profile.name}'s link page: read the profile and links, see the latest posts${tools.length === 4 ? ', or subscribe an email address' : ''}.` });
  }
  if (method === 'ping') return ok(id as JsonRpcId, {});
  if (method === 'tools/list') return ok(id as JsonRpcId, { tools });
  if (method === 'tools/call') {
    const tool = tools.find((t) => t.name === params.name);
    const args = (params.arguments ?? {}) as Args;
    if (typeof params.name !== 'string' || typeof args !== 'object' || Array.isArray(args)) return fail(id, -32602, 'Invalid params');
    if (!tool) return params.name === 'subscribe' ? ok(id as JsonRpcId, text('This page has no email list to subscribe to.', true)) : fail(id, -32602, `Unknown tool "${params.name}"`);
    if (tool.name === 'list_links' && args.kind !== undefined && !['link', 'social', 'post'].includes(args.kind as string)) return fail(id, -32602, 'kind must be link, social or post');
    if (tool.name === 'latest_posts' && args.limit !== undefined && !(Number.isInteger(args.limit) && (args.limit as number) >= 1 && (args.limit as number) <= 10)) return fail(id, -32602, 'limit must be a whole number from 1 to 10');
    if (tool.name === 'subscribe' && typeof args.email !== 'string') return fail(id, -32602, 'email is required');
    return ok(id as JsonRpcId, await callTool(ctx, tool.name, args));
  }
  return fail(id, -32601, `Method not found: ${method}`);
}

export async function handleMcp(ctx: McpContext, request: readonly unknown[]): Promise<JsonRpcResponse[] | null>;
export async function handleMcp(ctx: McpContext, request: unknown): Promise<JsonRpcResponse | null>;
export async function handleMcp(ctx: McpContext, request: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(request)) {
    if (!request.length) return fail(null, -32600, 'Invalid request');
    const out = (await Promise.all(request.map((r) => one(ctx, r)))).filter((r): r is JsonRpcResponse => r !== null);
    return out.length ? out : null;
  }
  return one(ctx, request);
}
