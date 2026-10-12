// @vitest-environment node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { ToolsDevPlacementOwner } from '@/tools-dev/types';
import { requestJson } from '@/vitest/http';
import { createSmokeSuite, type ToolsDevDaemonContext } from '@/vitest/suite';

const odBin = fileURLToPath(new URL('../../../apps/daemon/bin/od.mjs', import.meta.url));

/** Explicit native owner selection (see tools-dev/placement-bootstrap.test.ts); coordinated cases need it. */
const owner: ToolsDevPlacementOwner | null = process.env.OD_E2E_PLACEMENT_OWNER_BINDING
  && process.env.OD_E2E_PLACEMENT_OWNER_SHA256 && process.env.OD_E2E_PLACEMENT_OWNER_PROVENANCE
  ? { binding: process.env.OD_E2E_PLACEMENT_OWNER_BINDING, sha256: process.env.OD_E2E_PLACEMENT_OWNER_SHA256, provenance: process.env.OD_E2E_PLACEMENT_OWNER_PROVENANCE }
  : null;

type Version = { id: string; source?: string };
type PlacementStatus = { mode: string; reason: string; activation: { adoption: string } };
type CreatedProject = { project: { id: string } };

/** The daemon reports its internal placement mode only in its own isolated log. */
async function placementStatus(context: ToolsDevDaemonContext): Promise<PlacementStatus | undefined> {
  const marker = '[od] placement-runtime ';
  const logs = Object.values(await context.logs());
  const lines = (await Promise.all(logs.map(log => readFile(log.logPath, 'utf8').catch(() => log.lines.join('\n'))))).join('\n').split('\n');
  return lines.filter(line => line.includes(marker)).map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as PlacementStatus).at(-1);
}
async function od(daemonUrl: string, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = execFile(process.execPath, [odBin, ...args], {
      env: { ...process.env, OD_DAEMON_URL: daemonUrl }, maxBuffer: 4 * 1024 * 1024, timeout: 60_000,
    }, (error, stdout, stderr) => {
      const failure = error as { code?: number } | null;
      resolve({ code: typeof failure?.code === 'number' ? failure.code : error ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
    child.stdin?.end(stdin);
  });
}
async function odJson<T>(daemonUrl: string, args: string[], stdin?: string): Promise<T> {
  const result = await od(daemonUrl, [...args, '--json'], stdin);
  expect(result.code, `od ${args.join(' ')}: ${result.stderr || result.stdout}`).toBe(0);
  return JSON.parse(result.stdout) as T;
}

/**
 * The existing manual project-file writer cohort through its real surfaces:
 * compiled `od files` for write/upload/version-create/version-restore/delete
 * and history reads; HTTP for the composer multi-file upload and rename
 * (API-only, no CLI rename exists). Effects are read back from the project's
 * physical root. The HTML write already captures a manual version, so the
 * first versions GET is the idempotent existing-history read; the separately
 * seeded no-history file exercises the GET auto-baseline mutation.
 */
async function journey(base: string, scratch: string, projectId: string, root: string) {
  const steps: Record<string, unknown> = {};
  await odJson(base, ['files', 'write', projectId, 'page.html'], '<html><body>v1</body></html>');
  expect(await readFile(join(root, 'page.html'), 'utf8')).toBe('<html><body>v1</body></html>');
  // The write captured the first (manual) version; this read creates nothing.
  const baseline = await odJson<{ versions: Version[] }>(base, ['files', 'versions', projectId, 'page.html']);
  expect(baseline.versions).toHaveLength(1);
  const v1 = baseline.versions[0]!.id;
  await odJson(base, ['files', 'write', projectId, 'page.html'], '<html><body>v2</body></html>');
  const created = await odJson<{ version: Version }>(base, ['files', 'version-create', projectId, 'page.html', '--source', 'manual']);
  const restored = await odJson<{ version: Version }>(base, ['files', 'version-restore', projectId, 'page.html', v1]);
  expect(restored.version.source).toBe('restore');
  expect(await readFile(join(root, 'page.html'), 'utf8')).toBe('<html><body>v1</body></html>');
  const history = await odJson<{ versions: Version[] }>(base, ['files', 'versions', projectId, 'page.html']);
  expect(history.versions.map(v => v.id)).toEqual(expect.arrayContaining([v1, created.version.id, restored.version.id]));
  steps.history = history.versions.map(v => v.source);

  const local = join(scratch, `logo-${projectId}.txt`); await writeFile(local, 'single upload');
  await odJson(base, ['files', 'upload', projectId, local, '--as', 'assets/logo.txt']);
  expect(await readFile(join(root, 'assets', 'logo.txt'), 'utf8')).toBe('single upload');

  const form = new FormData(); form.append('dir', 'drops'); form.append('files', new Blob(['composer drop'], { type: 'text/plain' }), 'drop.txt');
  const uploaded = await fetch(new URL(`/api/projects/${projectId}/upload`, base), { body: form, method: 'POST' });
  expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  expect(await readFile(join(root, 'drops', 'drop.txt'), 'utf8')).toBe('composer drop');

  const renamed = await requestJson<{ file: { name: string } }>(base, `/api/projects/${projectId}/files/rename`, { body: { from: 'page.html', to: 'renamed.html' } });
  expect(renamed.file.name).toBe('renamed.html');
  expect(existsSync(join(root, 'page.html'))).toBe(false);
  const renamedHistory = await odJson<{ versions: Version[] }>(base, ['files', 'versions', projectId, 'renamed.html']);
  expect(renamedHistory.versions).toHaveLength(history.versions.length);

  const deleted = await od(base, ['files', 'delete', projectId, 'renamed.html']);
  expect(deleted.code, deleted.stderr).toBe(0);
  expect(existsSync(join(root, 'renamed.html'))).toBe(false);

  // EXTERNAL fixture setup (not daemon permit proof): an HTML file with no history.
  await writeFile(join(root, 'seeded.html'), '<html><body>seeded</body></html>');
  // The versions GET itself creates the missing baseline (a mutating read), then reads it idempotently.
  const seeded = await odJson<{ versions: Version[] }>(base, ['files', 'versions', projectId, 'seeded.html']);
  expect(seeded.versions).toHaveLength(1); expect(seeded.versions[0]!.source).toBe('manual');
  const reread = await odJson<{ versions: Version[] }>(base, ['files', 'versions', projectId, 'seeded.html']);
  expect(reread.versions.map(v => v.id)).toEqual([seeded.versions[0]!.id]);
  steps.seededBaseline = seeded.versions.map(v => v.source);
  steps.files = (await requestJson<{ files: Array<{ name: string }> }>(base, `/api/projects/${projectId}/files`)).files.map(f => f.name).sort();
  return steps;
}

async function exercise(base: string, scratch: string, dataDir: string) {
  const managed = (await requestJson<CreatedProject>(base, '/api/projects', {
    body: { designSystemId: null, id: randomUUID(), metadata: { kind: 'prototype' }, name: 'Writer journey managed', pendingPrompt: null, skillId: null },
  })).project.id;
  const importedDir = join(scratch, 'imported-folder'); await mkdir(importedDir, { recursive: true });
  const imported = (await requestJson<CreatedProject>(base, '/api/import/folder', { body: { baseDir: importedDir, name: 'Writer journey imported' } })).project.id;
  return {
    managed: await journey(base, scratch, managed, join(dataDir, 'projects', managed)),
    imported: await journey(base, scratch, imported, importedDir),
  };
}

describe('project-file writer journey (isolated runtime; HTTP + compiled od)', () => {
  test('[P1] ordinary not-activated managed and imported save/upload/history/rename/delete', async () => {
    const suite = await createSmokeSuite('project-files-ordinary');
    await suite.with.toolsDevDaemon(async (context) => {
      await context.start();
      const status = await placementStatus(context);
      expect(status).toMatchObject({ mode: 'ordinary-uncoordinated', reason: 'not-activated', activation: { adoption: 'closed' } });
      const steps = await exercise(context.daemonUrl(), suite.scratchDir, suite.dataDir);
      await suite.report.json('project-files/ordinary.json', { status, steps });
    });
  }, 240_000);

  test.skipIf(!owner)('[P1] coordinated-open managed and imported save/upload/history/rename/delete', async () => {
    const suite = await createSmokeSuite('project-files-coordinated');
    await suite.with.toolsDevDaemon(async (context) => {
      await context.start({ placementOwner: owner! });
      const status = await placementStatus(context);
      expect(status).toMatchObject({ mode: 'coordinated-open', activation: { adoption: 'closed' } });
      const steps = await exercise(context.daemonUrl(), suite.scratchDir, suite.dataDir);
      await suite.report.json('project-files/coordinated.json', { status, steps });
    });
  }, 240_000);
});
