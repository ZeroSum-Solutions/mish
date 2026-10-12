// @vitest-environment node

// P1-2 spec 3: `od pack` and /api/packs are one surface. A synthetic pack
// folder (written at test time; no licensed bytes, no network) is installed
// through the real CLI binary against a real tools-dev daemon, listed through
// HTTP, kept across a daemon restart on the same data root, and removed.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  canonicalPackManifestJson,
  PACK_CONTENT_SCHEMAS,
  PACK_FORMAT,
  parsePackManifest,
  type PackListResponse,
} from '@open-design/contracts';

import { requestJson } from '@/vitest/http';
import { createSmokeSuite } from '@/vitest/suite';

const odBin = fileURLToPath(new URL('../../../apps/daemon/bin/od.mjs', import.meta.url));
const PACK_ID = 'e2e-synthetic-pack';

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A minimal valid pack folder; returns the folder and the sha256 of its canonical pack.json. */
async function writePackFolder(root: string): Promise<{ dir: string; digest: string }> {
  const dir = join(root, 'synthetic-pack');
  const kitManifest = `${JSON.stringify({ schemaVersion: 1, synthetic: true })}\n`;
  await mkdir(join(dir, 'kits', 'demo'), { recursive: true });
  await writeFile(join(dir, 'kits', 'demo', 'manifest.json'), kitManifest);
  const manifest = {
    format: PACK_FORMAT,
    id: PACK_ID,
    version: '1.0.0',
    title: 'E2E synthetic pack',
    licence: { scope: 'Synthetic test fixture, no licensed content', evidence: [] },
    contents: [{ kind: 'component-kit', schema: PACK_CONTENT_SCHEMAS['component-kit'], id: 'e2e-demo-kit', path: 'kits/demo' }],
    files: [{ path: 'kits/demo/manifest.json', bytes: Buffer.byteLength(kitManifest), sha256: sha256(kitManifest) }],
  };
  await writeFile(join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const parsed = parsePackManifest(manifest);
  if (!parsed.ok) throw new Error(`synthetic manifest is invalid: ${parsed.issues.join('; ')}`);
  return { dir, digest: sha256(canonicalPackManifestJson(parsed.manifest)) };
}

async function od(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    execFile(process.execPath, [odBin, ...args], { maxBuffer: 4 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      const failure = error as { code?: number } | null;
      resolve({ code: typeof failure?.code === 'number' ? failure.code : failure ? 1 : 0, stdout, stderr });
    });
  });
}

describe('licensed pack install surface (P1-2 spec 3)', () => {
  test('[P1] od pack and /api/packs install a folder pack, list the same record, keep it across a daemon restart, and remove it', async () => {
    const suite = await createSmokeSuite('pack-install-surface');
    const pack = await writePackFolder(suite.scratchDir);

    await suite.with.toolsDevDaemon(async (context) => {
      await context.start();
      const daemonUrl = context.daemonUrl();

      const installed = await od(['pack', 'install', pack.dir, '--sha256', pack.digest, '--json', '--daemon-url', daemonUrl]);
      expect(installed.code, installed.stderr || installed.stdout).toBe(0);
      const report = JSON.parse(installed.stdout) as { ok: boolean; result: { outcome: string; pack: { id: string; digest: string } } };
      expect(report.ok).toBe(true);
      expect(report.result).toMatchObject({ outcome: 'installed', pack: { id: PACK_ID, digest: pack.digest } });

      const listed = await requestJson<PackListResponse>(daemonUrl, '/api/packs');
      expect(listed.packs).toHaveLength(1);
      expect(listed.packs[0]).toMatchObject({ id: PACK_ID, version: '1.0.0', status: 'ready', digest: pack.digest });
      const cliList = await od(['pack', 'list', '--json', '--daemon-url', daemonUrl]);
      expect(JSON.parse(cliList.stdout)).toEqual(listed);
      // The pack lives under the suite's daemon data root.
      expect(existsSync(join(suite.dataDir, 'packs', PACK_ID, 'pack.json'))).toBe(true);

      await context.stop();
      await context.start();
      const restartedUrl = context.daemonUrl();
      const afterRestart = await requestJson<PackListResponse>(restartedUrl, '/api/packs');
      expect(afterRestart).toEqual(listed);

      const removed = await od(['pack', 'remove', PACK_ID, '--json', '--daemon-url', restartedUrl]);
      expect(removed.code, removed.stderr || removed.stdout).toBe(0);
      expect(JSON.parse(removed.stdout)).toEqual({ ok: true, id: PACK_ID, removedVersion: '1.0.0' });
      expect(await requestJson<PackListResponse>(restartedUrl, '/api/packs')).toEqual({ packs: [] });
      const again = await fetch(new URL(`/api/packs/${PACK_ID}`, restartedUrl), { method: 'DELETE' });
      expect(again.status).toBe(404);

      await suite.report.json('packs/install-surface.json', { installed: report.result, listed, afterRestart });
    });
  }, 300_000);
});
