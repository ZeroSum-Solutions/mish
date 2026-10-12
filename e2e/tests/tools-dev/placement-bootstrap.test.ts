// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import type { ToolsDevPlacementOwner } from '@/tools-dev/types';
import { requestJson } from '@/vitest/http';
import { createSmokeSuite, type ToolsDevDaemonContext } from '@/vitest/suite';

/**
 * Explicit native owner selection built outside startup (binary, SHA-256 and
 * provenance record). Coordinated cases need it and the measured darwin-arm64
 * host; ordinary not-activated cases always run.
 */
const owner: ToolsDevPlacementOwner | null = process.env.OD_E2E_PLACEMENT_OWNER_BINDING
  && process.env.OD_E2E_PLACEMENT_OWNER_SHA256 && process.env.OD_E2E_PLACEMENT_OWNER_PROVENANCE
  ? { binding: process.env.OD_E2E_PLACEMENT_OWNER_BINDING, sha256: process.env.OD_E2E_PLACEMENT_OWNER_SHA256, provenance: process.env.OD_E2E_PLACEMENT_OWNER_PROVENANCE }
  : null;

type PlacementStatus = {
  mode: string; reason: string; incarnationId: string | null;
  dataRoot: { canonical: string; createdThisBoot: boolean; predecessor: { proof: string; generation: number | null; reason: string | null } } | null;
  transition: { kind: string; global: string | null } | null;
  activation: { adoption: string; gates: string[] };
};
type CreatedProject = { project: { id: string } };

/** The daemon reports its internal placement state only in its own log (no public status API). */
async function placementLog(context: ToolsDevDaemonContext): Promise<{
  statuses: PlacementStatus[]; refusals: Array<{ reason: string; status: number }>; seals: Array<{ sealed: boolean; generation?: number; reason?: string }>;
}> {
  // Full isolated log file: the status line is emitted early and can leave the 200-line tail.
  const logs = Object.values(await context.logs());
  const lines = (await Promise.all(logs.map(log => readFile(log.logPath, 'utf8').catch(() => log.lines.join('\n'))))).join('\n').split('\n');
  const pick = <T>(marker: string) => lines.filter(line => line.includes(marker)).map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as T);
  return {
    statuses: pick<PlacementStatus>('[od] placement-runtime '), refusals: pick<{ reason: string; status: number }>('[od] placement-bootstrap refused '),
    seals: pick<{ sealed: boolean; generation?: number; reason?: string }>('[od] placement-seal '),
  };
}
async function createProject(baseUrl: string, name: string): Promise<string> {
  const created = await requestJson<CreatedProject>(baseUrl, '/api/projects', {
    body: { designSystemId: null, id: randomUUID(), metadata: { kind: 'prototype' }, name, pendingPrompt: null, skillId: null },
  });
  return created.project.id;
}
async function upload(baseUrl: string, projectId: string, name: string, content: string): Promise<void> {
  const form = new FormData(); form.append('files', new Blob([content], { type: 'text/plain' }), name);
  const response = await fetch(new URL(`/api/projects/${projectId}/upload`, baseUrl), { body: form, method: 'POST' });
  expect(response.ok, await response.clone().text()).toBe(true);
}
/**
 * The tools-dev pid is the detached `tsx` CLI wrapper, which runs the daemon in
 * a child process of its own group. SIGKILL to the wrapper alone leaves that
 * child (and its native owner) alive, and a later `stop` then stops it cleanly.
 * A crash is the whole process group killed; wait until the group is empty.
 */
async function killGroupAndWait(leader: number): Promise<void> {
  process.kill(-leader, 'SIGKILL');
  for (let i = 0; i < 500; i++) { try { process.kill(-leader, 0); } catch { return; } await new Promise(r => setTimeout(r, 20)); }
  throw new Error(`daemon process group ${leader} did not exit after SIGKILL`);
}

describe('tools-dev placement bootstrap (isolated runtime, data root and ports)', () => {
  test('[P1] no binding is not-activated ordinary mode; uploads and imported saves keep working', async () => {
    const suite = await createSmokeSuite('placement-not-activated');
    await suite.with.toolsDevDaemon(async (context) => {
      await context.start();
      const { statuses } = await placementLog(context);
      expect(statuses.at(-1)).toMatchObject({ mode: 'ordinary-uncoordinated', reason: 'not-activated', transition: { kind: 'no-database', global: null }, activation: { adoption: 'closed' } });
      expect(existsSync(join(suite.dataDir, '.daemon-placement-owner.lock'))).toBe(false);
      const base = context.daemonUrl();
      const managed = await createProject(base, 'Placement ordinary managed');
      await upload(base, managed, 'notes.txt', 'managed upload');
      const files = await requestJson<{ files: Array<{ name: string }> }>(base, `/api/projects/${managed}/files`);
      expect(files.files.map(file => file.name)).toContain('notes.txt');
      const importedDir = join(suite.scratchDir, 'imported-folder'); await mkdir(importedDir, { recursive: true });
      const imported = await requestJson<CreatedProject>(base, '/api/import/folder', { body: { baseDir: importedDir, name: 'Placement ordinary imported' } });
      await requestJson(base, `/api/projects/${imported.project.id}/files`, { body: { name: 'saved.txt', content: 'imported save' } });
      expect(await readFile(join(importedDir, 'saved.txt'), 'utf8')).toBe('imported save');
      await suite.report.json('placement/not-activated.json', { statuses, files: files.files.map(file => file.name) });
    });
  }, 180_000);

  test('[P1] an unreadable existing journal globally refuses not-activated startup before eager initialization', async () => {
    const suite = await createSmokeSuite('placement-transition-closed');
    // Pre-existing corrupt durable bytes: the read-only pre-check cannot read them.
    await mkdir(suite.dataDir, { recursive: true });
    const corrupt = Buffer.from('not a sqlite database; retained user bytes\n');
    await writeFile(join(suite.dataDir, 'app.sqlite'), corrupt);
    await suite.with.toolsDevDaemon(async (context) => {
      await expect(context.start()).rejects.toThrow();
      const { refusals, statuses } = await placementLog(context);
      expect(refusals).toContainEqual({ reason: 'transition-closed:journal-unreadable:SQLITE_NOTADB', status: 503 });
      expect(statuses).toEqual([]);
      expect(await readdir(suite.dataDir)).toEqual(['app.sqlite']);
      const after = await readFile(join(suite.dataDir, 'app.sqlite'));
      expect(createHash('sha256').update(after).digest('hex')).toBe(createHash('sha256').update(corrupt).digest('hex'));
      await suite.report.json('placement/transition-closed.json', { refusals, statuses, entries: await readdir(suite.dataDir) });
    });
  }, 180_000);

  test.skipIf(!owner)('[P1] a supplied missing binding refuses mutating startup before any data-root effect', async () => {
    const suite = await createSmokeSuite('placement-missing-binding');
    await suite.with.toolsDevDaemon(async (context) => {
      await expect(context.start({ placementOwner: { ...owner!, binding: join(suite.scratchDir, 'absent-owner.node') } })).rejects.toThrow();
      const { refusals, statuses } = await placementLog(context);
      expect(refusals).toContainEqual({ reason: 'provenance-binding-selection', status: 503 });
      expect(statuses).toEqual([]);
      expect(existsSync(suite.dataDir)).toBe(false);
      await suite.report.json('placement/missing-binding.json', { refusals, statuses, dataRootExists: existsSync(suite.dataDir) });
    });
  }, 180_000);

  test.skipIf(!owner)('[P1] actual owner: fresh root opens, a second owner refuses before its database, SIGKILL then pinned and unpinned restarts', async () => {
    const first = await createSmokeSuite('placement-owner-a');
    const second = await createSmokeSuite('placement-owner-b', { dataDir: first.dataDir });
    await first.with.toolsDevDaemon(async (a) => {
      const started = await a.start({ placementOwner: owner! });
      const opened = (await placementLog(a)).statuses.at(-1)!;
      expect(opened).toMatchObject({ mode: 'coordinated-open', reason: 'owner-qualified', dataRoot: { createdThisBoot: true }, activation: { adoption: 'closed' } });
      expect(opened.activation.gates).not.toContain('legacy-predecessor-unproven');
      const before = (await readdir(first.dataDir)).sort();
      await second.with.toolsDevDaemon(async (b) => {
        await expect(b.start({ placementOwner: owner! })).rejects.toThrow();
        expect((await placementLog(b)).refusals).toContainEqual({ reason: 'owner-busy', status: 409 });
      });
      expect((await readdir(first.dataDir)).sort()).toEqual(before);

      const pid = started.daemon?.pid ?? (await a.status()).apps?.daemon?.pid;
      expect(typeof pid).toBe('number');
      await killGroupAndWait(pid!);
      await a.stop().catch(() => undefined);
      await a.start({ placementOwner: owner! });
      const restarted = (await placementLog(a)).statuses.at(-1)!;
      expect(restarted).toMatchObject({ mode: 'coordinated-open', dataRoot: { createdThisBoot: false } });
      expect(restarted.incarnationId).not.toBe(opened.incarnationId);
      expect(restarted.activation.gates).toContain('legacy-predecessor-unproven');
      // B4-1b: SIGKILL wrote no seal, so the typed reason is the absent seal.
      expect(restarted.dataRoot?.predecessor).toMatchObject({ proof: 'unproven', reason: 'predecessor-seal-absent' });
      expect(restarted.activation.gates).toContain('predecessor-seal-absent');
      await a.stop();
      await a.start();
      const ordinary = (await placementLog(a)).statuses.at(-1)!;
      expect(ordinary).toMatchObject({ mode: 'ordinary-uncoordinated', reason: 'not-activated', transition: { kind: 'inspected', global: null } });
      await createProject(a.daemonUrl(), 'Placement after coordinated restart');
      await first.report.json('placement/owner-lifecycle.json', { opened, restarted, ordinary, killedPid: pid, dataRootEntriesBeforeSecondOwner: before });
    });
  }, 600_000);

  test.skipIf(!owner)('[P1] B4-1b actual owner: a clean stop seals the root, the restart is proven, and an ordinary daemon in between breaks the chain', async () => {
    const suite = await createSmokeSuite('placement-root-seal');
    await suite.with.toolsDevDaemon(async (context) => {
      await context.start({ placementOwner: owner! });
      const created = (await placementLog(context)).statuses.at(-1)!;
      expect(created).toMatchObject({ mode: 'coordinated-open', dataRoot: { createdThisBoot: true, predecessor: { proof: 'created' } } });
      await createProject(context.daemonUrl(), 'Placement sealed root'); // A real database write before the seal.

      // Clean stop through tools-dev: the daemon seals after its HTTP server closed, then releases the owner.
      await context.stop();
      expect((await placementLog(context)).seals.at(-1)).toEqual({ sealed: true, generation: 1 });
      expect(existsSync(join(suite.dataDir, 'placement', 'root-seal.json'))).toBe(true);
      await context.start({ placementOwner: owner! });
      const sealed = (await placementLog(context)).statuses.at(-1)!;
      expect(sealed).toMatchObject({ mode: 'coordinated-open', dataRoot: { createdThisBoot: false, predecessor: { proof: 'sealed', generation: 1, reason: null } } });
      expect(sealed.incarnationId).not.toBe(created.incarnationId);
      expect(sealed.activation.gates).not.toContain('legacy-predecessor-unproven');
      expect(existsSync(join(suite.dataDir, 'placement', 'root-seal.json'))).toBe(false); // Consumed by the boot that accepted it.

      // The chain continues across a second clean restart.
      await context.stop();
      expect((await placementLog(context)).seals.at(-1)).toEqual({ sealed: true, generation: 2 });
      await context.start({ placementOwner: owner! });
      const chained = (await placementLog(context)).statuses.at(-1)!;
      expect(chained.dataRoot?.predecessor).toMatchObject({ proof: 'sealed', generation: 2 });
      await context.stop();
      expect((await placementLog(context)).seals.at(-1)).toEqual({ sealed: true, generation: 3 });

      // An ordinary daemon between the runs opens the database: the next coordinated boot is unproven.
      await context.start();
      expect((await placementLog(context)).statuses.at(-1)).toMatchObject({ mode: 'ordinary-uncoordinated', reason: 'not-activated' });
      await context.stop();
      await context.start({ placementOwner: owner! });
      const broken = (await placementLog(context)).statuses.at(-1)!;
      expect(broken).toMatchObject({ mode: 'coordinated-open', dataRoot: { predecessor: { proof: 'unproven', reason: 'predecessor-seal-root-changed' } } });
      expect(broken.activation.gates).toEqual(expect.arrayContaining(['legacy-predecessor-unproven', 'predecessor-seal-root-changed']));
      await context.stop();
      // An unproven boot never seals.
      expect((await placementLog(context)).seals.at(-1)).toEqual({ sealed: false, reason: 'root-unproven' });
      await suite.report.json('placement/root-seal.json', { created, sealed, chained, broken, seals: (await placementLog(context)).seals });
    });
  }, 600_000);
});
