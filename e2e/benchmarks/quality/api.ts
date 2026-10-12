import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileReceipt } from './types.ts';
export class HttpError extends Error { constructor(public status: number, route: string) { super(`${route}: HTTP ${status}`); } }
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function safePath(name: string): string[] {
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes(':') || part.startsWith('.') || /[\x00-\x1f]/u.test(part))) throw new Error('Unsafe or private artifact path');
  return parts;
}
export function client(baseUrl: string, headers: Record<string, string>, timeoutMs: number) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Pass a loopback HTTP daemon origin without credentials');
  async function request(route: string, projectId?: string, body?: unknown, budgetMs = timeoutMs, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(new URL(route, base), {
      method, redirect: 'error',
      headers: { ...headers, ...(projectId ? { 'x-od-project-id': projectId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(Math.max(1, Math.ceil(budgetMs))),
    });
    if (!response.ok) throw new HttpError(response.status, route.split('?')[0]!);
    return response;
  }
  async function json(route: string, projectId?: string, body?: unknown, budgetMs?: number): Promise<unknown> {
    return (await request(route, projectId, body, budgetMs)).json();
  }
  async function saveFiles(projectId: string, output: string, onSaved?: (file: FileReceipt) => void): Promise<FileReceipt[]> {
    const listing = await json(`/api/projects/${encodeURIComponent(projectId)}/files`, projectId) as { files?: Array<{ name: string; path?: string; type?: string; traceObjectReason?: string }> };
    if (!Array.isArray(listing.files)) throw new Error('Invalid file inventory');
    const saved: FileReceipt[] = [];
    for (const file of listing.files) {
      if (file.type === 'dir' || file.traceObjectReason) continue;
      const name = file.path ?? file.name;
      const parts = safePath(name);
      if (saved.some(item => item.name === name)) throw new Error('Duplicate artifact path');
      const bytes = Buffer.from(await (await request(`/api/projects/${encodeURIComponent(projectId)}/raw/${parts.map(encodeURIComponent).join('/')}`, projectId)).arrayBuffer());
      const target = join(output, ...parts);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
      const receipt = { name, bytes: bytes.length, sha256: digest(bytes) };
      saved.push(receipt); onSaved?.(receipt);
    }
    if (!saved.some(file => /\.html?$/iu.test(file.name) && !file.name.startsWith('_brand-build/'))) throw new Error('No HTML pages generated');
    return saved;
  }
  async function bytes(route: string) { return Buffer.from(await (await request(route)).arrayBuffer()); }
  /** Single-field settings writes (`PUT /api/app-config`); compare mode only. */
  async function put(route: string, body: unknown): Promise<unknown> { return (await request(route, undefined, body, timeoutMs, 'PUT')).json(); }
  return { json, saveFiles, bytes, put };
}
