import type http from 'node:http';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';

import { registerProjectUploadRoutes, type RegisterProjectUploadRoutesDeps } from '../src/routes/project/index.js';
import { PlacementCoordinationError } from '../src/workbench/placement/write-coordinator.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V0AAAAASUVORK5CYII=', 'base64');
const manifest = { version: 1, kind: 'html', renderer: 'html', entry: 'site.html', sourceSkillId: 'agency-site', exports: ['html'], supportingFiles: [], metadata: { agencySite: { version: 1, publication: 'closed-assets-v1', revision: 'r1', rendererVersion: '1.0.0', recipeDigest: 'a'.repeat(64) } } };

describe('Agency Site upload cleanup response', () => {
  it.each([
    { kind: 'valid', bytes: png, loseAuthority: true, pauseCleanup: false, status: 503 },
    { kind: 'invalid', bytes: Buffer.from('<svg/>'), loseAuthority: true, pauseCleanup: false, status: 503 },
    { kind: 'valid with held cleanup', bytes: png, loseAuthority: false, pauseCleanup: true, status: 200 },
  ])('waits for cleanup before responding to a $kind image attempt', async ({ bytes, loseAuthority, pauseCleanup, status }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agency-upload-cleanup-'));
    let server: http.Server | undefined;
    let finishCleanup = () => {};
    try {
      await writeFile(path.join(root, 'site.html'), '<h1>Agency</h1>');
      await writeFile(path.join(root, 'site.html.artifact.json'), JSON.stringify(manifest));
      const uploadedPath = path.join(root, 'upload.png');
      await writeFile(uploadedPath, bytes);

      let qualified = true;
      let writes = 0;
      let cleanupStarted!: () => void;
      const cleanupEntered = new Promise<void>((resolve) => { cleanupStarted = resolve; });
      const cleanupGate = new Promise<void>((resolve) => { finishCleanup = resolve; });
      const finalIO = { assertCurrent() {
        if (!qualified) throw new PlacementCoordinationError('OWNER_UNQUALIFIED', 'owner lost during upload cleanup');
      } };
      const lease = {
        projectId: 'agency-project',
        async write<T>(work: (guard: typeof finalIO) => Promise<T>): Promise<T> {
          writes += 1;
          if (writes === 2) {
            cleanupStarted();
            if (pauseCleanup) await cleanupGate;
            if (loseAuthority) qualified = false;
          }
          return work(finalIO);
        },
        async settle() {},
      };
      const project = { id: 'agency-project', skillId: 'agency-site', metadata: {} };
      const app = express();
      registerProjectUploadRoutes(app, {
        db: {},
        projectWrites: { admit: async () => lease },
        authorizeProjectRequest: async () => true,
        http: { sendApiError: (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } }) },
        uploads: { handleProjectUpload: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
          req.body = { imageArtifact: 'site.html' };
          req.files = [{ path: uploadedPath, originalname: 'upload.png' }] as Express.Multer.File[];
          next();
        } },
        node: { fs },
        paths: { PROJECTS_DIR: root },
        projectStore: {
          getProject: () => project,
          getWorkspaceProject: () => null,
          getWorkspaceProjectByProjectId: () => null,
        },
        projectFiles: { resolveProjectDir: () => root },
      } as unknown as RegisterProjectUploadRoutesDeps);
      server = await new Promise<http.Server>((resolve) => {
        const started = app.listen(0, '127.0.0.1', () => resolve(started));
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing local test port');
      const responsePromise = fetch(`http://127.0.0.1:${address.port}/api/projects/agency-project/upload`, { method: 'POST' });
      if (pauseCleanup) {
        await cleanupEntered;
        const beforeCleanup = await Promise.race([
          responsePromise.then(() => 'settled', () => 'settled'),
          new Promise((resolve) => setTimeout(() => resolve('pending'), 400)),
        ]);
        expect(beforeCleanup).toBe('pending');
        finishCleanup();
      }
      const response = await responsePromise;
      expect(response.status).toBe(status);
      if (loseAuthority) {
        expect((await response.json() as { error: { code: string } }).error.code).toBe('UPSTREAM_UNAVAILABLE');
      } else {
        expect(existsSync(uploadedPath)).toBe(false);
      }
    } finally {
      finishCleanup();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
