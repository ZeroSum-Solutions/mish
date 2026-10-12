import express from 'express';
import { createContext, runInContext } from 'node:vm';
import { expect, it } from 'vitest';
import { registerDesignSystemRoutes, type RegisterDesignSystemRoutesDeps } from '../../src/routes/design-systems.js';

it('installs storage before authored scripts on all sandboxed design-system preview paths', async () => {
  const html = '<!doctype html><html><head><script>window.localStorage.setItem("theme", "dark");window.__theme = window.localStorage.getItem("theme");</script></head><body>Preview</body></html>';
  let packaged = true;
  const app = express();
  registerDesignSystemRoutes(app, {
    db: {} as never,
    paths: { USER_DESIGN_SYSTEMS_DIR: '/unused', CRAFT_DIR: '/unused' } as never,
    workspaceResources: { getWorkspaceResource: () => null, getWorkspaceResourceByResourceId: () => null },
    designSystems: {
      listAllDesignSystems: async () => [],
      readAvailableDesignSystem: async () => '# Kit',
      readAvailableDesignSystemStaticFile: async (_id: string, file: string) => file.endsWith('.html') && packaged
        ? { path: file, bytes: Buffer.from(html), contentType: 'text/html', updatedAt: new Date(0).toISOString() } : null,
      renderDesignSystemPreview: () => html,
      renderDesignSystemShowcase: () => html,
    } as unknown as RegisterDesignSystemRoutesDeps['designSystems'],
    generationJobs: {} as never,
  } as unknown as RegisterDesignSystemRoutesDeps);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing port');
    for (const route of ['preview', 'showcase', 'static?path=system/index.html', 'static/system/index.html', 'showcase']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/design-systems/example/${route}`);
      expect(response.status).toBe(200);
      const served = await response.text();
      const context = createContext({ DOMException });
      runInContext(`window = globalThis; for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { configurable: true, get() { throw new DOMException('Blocked storage', 'SecurityError'); } });`, context);
      for (const script of served.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        expect(() => runInContext(script[1]!, context), route).not.toThrow();
      }
      expect(runInContext('window.__theme', context), route).toBe('dark');
      expect(served.indexOf('data-od-preview-storage')).toBeLessThan(served.indexOf('window.localStorage.setItem'));
      packaged = route !== 'static/system/index.html';
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
