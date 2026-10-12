import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { CatalogueMaterialSource } from '../../src/workbench/adoption/catalogue-material.js';
import { catalogueCodeForRef } from '../../src/workbench/adoption/catalogue-adoption.js';
import { resourceRefKey } from '../../src/workbench/context-ranking.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';

describe('Copy code with Apply closed', () => {
  const ref = { sourceType: 'library' as const, sourceId: 'shadcn' as const, itemId: 'button', revisionOrDigest: 'sha256:current' };
  const source: CatalogueMaterialSource = { sourceId: 'shadcn', materialize: async () => ({
    ref, title: 'Button', origin: 'official',
    rights: { status: 'permitted', licence: 'MIT', notice: 'MIT notice', sourceUrl: 'https://ui.shadcn.com', packageName: 'shadcn/ui' },
    files: [{ path: 'components/ui/button.tsx', role: 'source', bytes: Buffer.from('export function Button() {}') }], packageDependencies: [],
  }) };

  it('returns code from the exact permitted resource without a placement executor', async () => {
    expect(await catalogueCodeForRef(resourceRefKey(ref), [source])).toBe('export function Button() {}');
  });

  it('refuses a stale revision instead of copying different code', async () => {
    await expect(catalogueCodeForRef(resourceRefKey({ ...ref, revisionOrDigest: 'sha256:stale' }), [source]))
      .rejects.toMatchObject({ reason: 'resource-ref-stale' });
  });

  it('refuses a material whose item identity does not match the selected reference', async () => {
    const wrong: CatalogueMaterialSource = { ...source, materialize: async itemId => {
      const material = await source.materialize(itemId);
      return material && { ...material, ref: { ...material.ref, itemId: 'other' } };
    } };
    await expect(catalogueCodeForRef(resourceRefKey(ref), [wrong])).rejects.toMatchObject({ reason: 'resource-ref-stale' });
  });

  it('serves Copy code over HTTP when the placement executor is closed', async () => {
    const app = express();
    registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {},
      http: { sendApiError: (res, status, code, message) => res.status(status).json({ error: { code, message } }) },
      authorizeProjectRequest: async () => true,
      placement: { adoption: null, status: () => { throw new Error('Copy must not query placement status'); } },
      copyMaterials: [source],
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workbench/adoption/catalogue/copy/${encodeURIComponent(resourceRefKey(ref))}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ code: 'export function Button() {}' });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('refuses a multi-source item instead of silently omitting files', async () => {
    const multi: CatalogueMaterialSource = { ...source, materialize: async itemId => {
      const material = await source.materialize(itemId);
      return material && { ...material, files: [...material.files, { path: 'components/ui/icon.tsx', role: 'source' as const, bytes: Buffer.from('export const Icon = null;') }] };
    } };
    await expect(catalogueCodeForRef(resourceRefKey(ref), [multi])).rejects.toMatchObject({ reason: 'multiple-source-files' });
  });
});
