import { withVercelSiteProvider } from './helpers/vercel-site-provider.js';
import { describe, expect, it, vi } from 'vitest';

import { deployToVercel, vercelFileDigest } from '../src/deploy.js';

describe('deployToVercel file uploads', () => {
  it('stops the upload pool at the first failed upload and never creates the deployment', async () => {
    const files = Array.from({ length: 24 }, (_, index) => ({ file: `assets/${index}.bin`, data: Buffer.from(`file-${index}`) }));
    const failingDigest = vercelFileDigest(files[3]?.data ?? Buffer.alloc(0));
    const uploads: string[] = [];
    let deployments = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', withVercelSiteProvider(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://api.vercel.com/v2/files')) {
        const digest = new Headers(init?.headers).get('x-vercel-digest') ?? '';
        uploads.push(digest);
        // Mirror fetch: an aborted request rejects instead of answering.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
        if (digest === failingDigest) return new Response(JSON.stringify({ error: { code: 'too_many_requests', message: 'Too many requests.' } }), { status: 429, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ urls: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://api.vercel.com/v13/deployments')) {
        deployments += 1;
        return new Response(JSON.stringify({ id: 'dpl-never', url: 'never.vercel.app', readyState: 'READY' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }), { projectId: 'prj_abort', deploymentId: 'dpl-never', host: 'never.vercel.app' }));
    try {
      await expect(deployToVercel({ config: { token: 'test-token' }, files, projectId: 'abort-test' })).rejects.toMatchObject({ status: 429, message: 'Too many requests.' });
      // Let any straggling worker settle before counting.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(uploads.length).toBeLessThan(files.length);
      expect(deployments).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      globalThis.fetch = realFetch;
    }
  });
});
