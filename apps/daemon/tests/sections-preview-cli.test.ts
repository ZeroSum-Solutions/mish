// `od sections preview <id>` — the CLI half of the Enlarge compiled-section preview (AC-R07,
// root AGENTS.md dual-track rule). It reads the same GET /api/sections/:id/preview the Enlarge
// shell frames: readiness and the document's policy by default, the document itself with --html.
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerSectionsRoutes } from '../src/routes/sections.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_SRC = path.resolve(HERE, '../src/cli.ts');
const TSX_CLI = path.resolve(HERE, '../../../node_modules/tsx/dist/cli.mjs');
const repoRoot = path.resolve(HERE, '../../..');

let server: http.Server;
let baseUrl: string;
beforeAll(async () => {
  const app = express();
  registerSectionsRoutes(app, {
    http: { sendApiError: (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } }) },
    paths: { RUNTIME_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'sections-preview-cli-')) },
  } as never, { previewRoots: { hyperuiRoot: path.join(repoRoot, 'plugins/_official/shared/ui-kits/hyperui'), cultKitDir: null } });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const od = (...args: string[]) => execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args, '--daemon-url', baseUrl], { maxBuffer: 16 * 1024 * 1024 });

describe('od sections preview', () => {
  it('reports a ready compiled-section document and its no-network policy as JSON', async () => {
    const { stdout } = await od('sections', 'preview', 'hyperui:application/charts/1', '--json');
    const body = JSON.parse(stdout);
    expect(body).toMatchObject({ id: 'hyperui:application/charts/1', state: 'ready', status: 200, url: '/api/sections/hyperui%3Aapplication%2Fcharts%2F1/preview' });
    expect(body.contentSecurityPolicy).toMatch(/connect-src 'none'.*sandbox allow-scripts/);
    expect(body.bytes).toBeGreaterThan(1000);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it('prints the document with --html and says why a section has no preview', async () => {
    const { stdout } = await od('sections', 'preview', 'hyperui:application/charts/1', '--html');
    expect(stdout).toMatch(/^<!doctype html>/);
    const failure = await od('sections', 'preview', 'family-section:app-shell:app-shell-detail', '--json').then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(failure?.code).not.toBe(0);
    expect(`${failure?.stdout}${failure?.stderr}`).toMatch(/404|no compiled preview/);
  }, 60_000);
});
