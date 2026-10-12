// AC-R10.2: fixtures only; placement uses existing verified-copy machinery.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaGalleryPlaceResponse, MediaGalleryEntryDetail, MediaGalleryReuseRequest, MediaGalleryReuseResponse } from '@open-design/contracts';
import { openDatabase, updateProject } from '../../src/db.js';
import { generate, lastJson, postJson, runCli, startFakeImageProvider, startR10Daemon, waitTerminal, type FakeProvider, type R10Daemon } from './r10-harness.js';

describe('AC-R10.2 distinct placement', () => {
  let provider: FakeProvider | undefined;
  let daemon: R10Daemon | undefined;
  afterEach(async () => { provider?.releaseHeld(); await daemon?.stop(); await provider?.close(); });
  async function setup() {
    provider = await startFakeImageProvider();
    daemon = await startR10Daemon(provider);
    const project = await daemon.createProject();
    const source = await generate(daemon.url, project.projectId, { prompt: 'fixture hero', output: 'hero.png' });
    await waitTerminal(daemon.url, source);
    return { daemon, source, ...project };
  }
  it('places a verified copy without overwrite; replay and lineage survive restart; unlink retains both files', async () => {
    const { daemon, source, projectId, projectDir } = await setup();
    const bytes = await readFile(path.join(projectDir, 'hero.png'));
    await writeFile(path.join(projectDir, 'placed.png'), 'owner file');
    const url = () => `${daemon.url}/api/projects/${projectId}/media/gallery/${source}/place`;
    const request = { output: 'placed.png' };
    const headers = { 'idempotency-key': 'place-intent' };
    const response = await postJson(url(), request, headers);
    expect(response.status).toBe(201);
    const placed = await response.json() as MediaGalleryPlaceResponse;
    expect(placed).toMatchObject({ action: 'place', sourceId: source, entry: { projectId, file: { name: 'placed-2.png' }, lineage: { parentId: source, relation: 'reuse', parentInProject: true } } });
    expect(await readFile(path.join(projectDir, 'placed.png'), 'utf8')).toBe('owner file');
    expect(await readFile(path.join(projectDir, 'placed-2.png'))).toEqual(bytes);
    await daemon.restart();
    const replay = await postJson(url(), request, headers);
    expect(replay.status).toBe(200);
    expect((await replay.json() as MediaGalleryPlaceResponse).entry.id).toBe(placed.entry.id);
    const detail = await (await fetch(`${daemon.url}/api/projects/${projectId}/media/gallery/${placed.entry.id}`)).json() as MediaGalleryEntryDetail;
    expect(detail.chain[0]?.lineage.parentId).toBe(source);
    await postJson(`${daemon.url}/api/projects/${projectId}/media/gallery/${source}/unlink`, {});
    expect(await readFile(path.join(projectDir, 'hero.png'))).toEqual(bytes);
    expect(await readFile(path.join(projectDir, 'placed-2.png'))).toEqual(bytes);
  });
  it('places Q output into explicitly selected canvas P and leaves Q untouched', async () => {
    const { daemon, source, projectId: q, projectDir: qDir } = await setup();
    const canvas = await daemon.createProject();
    const bytes = await readFile(path.join(qDir, 'hero.png'));
    const response = await postJson(`${daemon.url}/api/projects/${q}/media/gallery/${source}/place`, { targetProjectId: canvas.projectId, output: 'canvas.png' });
    expect(response.status).toBe(201);
    const placed = await response.json() as MediaGalleryPlaceResponse;
    expect(placed).toMatchObject({ action: 'place', sourceProjectId: q, entry: { projectId: canvas.projectId, file: { name: 'canvas.png' }, lineage: { parentId: source, relation: 'reuse', parentInProject: false } } });
    expect(await readFile(path.join(canvas.projectDir, 'canvas.png'))).toEqual(bytes);
    expect(await readFile(path.join(qDir, 'hero.png'))).toEqual(bytes);
    await expect(readFile(path.join(qDir, 'canvas.png'))).rejects.toMatchObject({ code: 'ENOENT' });
    const cli = await runCli(['media', 'place', source, '--project', q, '--target', canvas.projectId, '--output', 'cli-canvas.png', '--json', '--daemon-url', daemon.url]);
    expect(cli.code, cli.stderr).toBe(0);
    expect(lastJson(cli.stdout)).toMatchObject({ action: 'place', entry: { projectId: canvas.projectId } });
    expect(await readFile(path.join(canvas.projectDir, 'cli-canvas.png'))).toEqual(bytes);
  });
  it('preserves the same-project reuse HTTP contract: unique copy, unchanged source, replay after restart', async () => {
    const { daemon, source, projectId, projectDir } = await setup();
    const bytes = await readFile(path.join(projectDir, 'hero.png'));
    const request: MediaGalleryReuseRequest = { targetProjectId: projectId };
    const headers = { 'idempotency-key': 'same-project-reuse' };
    const url = () => `${daemon.url}/api/projects/${projectId}/media/gallery/${source}/reuse`;
    const response = await postJson(url(), request, headers);
    expect(response.status).toBe(201);
    const copied = await response.json() as MediaGalleryReuseResponse;
    expect(copied).toMatchObject({ sourceId: source, sourceProjectId: projectId, bytesCopied: bytes.length, entry: { projectId, file: { name: 'hero-2.png' }, lineage: { parentId: source, relation: 'reuse', parentInProject: true } } });
    expect(await readFile(path.join(projectDir, 'hero.png'))).toEqual(bytes);
    expect(await readFile(path.join(projectDir, 'hero-2.png'))).toEqual(bytes);
    await daemon.restart();
    const replay = await postJson(url(), request, headers);
    expect(replay.status).toBe(200);
    expect((await replay.json() as MediaGalleryReuseResponse).entry.id).toBe(copied.entry.id);
    await expect(readFile(path.join(projectDir, 'hero-3.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('CLI place uses the placement route; traversal and conflicting replay intents fail closed', async () => {
    const { daemon, source, projectId } = await setup();
    const args = ['media', 'place', source, '--project', projectId, '--output', 'asset.png', '--idempotency-key', 'cli-place', '--json', '--daemon-url', daemon.url];
    const result = await runCli(args);
    expect(result.code, result.stderr).toBe(0);
    expect(lastJson(result.stdout)).toMatchObject({ action: 'place', entry: { file: { name: 'asset.png' } } });
    const url = `${daemon.url}/api/projects/${projectId}/media/gallery/${source}/place`;
    expect((await postJson(url, { output: '../escape.png' })).status).toBe(400);
    expect((await postJson(url, { output: 'different.png' }, { 'idempotency-key': 'cli-place' })).status).toBe(409);
    expect((await postJson(url, {}, { origin: 'https://evil.example' })).status).toBe(403);
  });
  it('place and reuse reject labelled placeholder bytes at the daemon boundary', async () => {
    const { daemon, projectId } = await setup();
    process.env.OD_MEDIA_ALLOW_STUBS = '1';
    const stub = await generate(daemon.url, projectId, { model: 'midjourney-v7', prompt: 'placeholder' });
    await waitTerminal(daemon.url, stub);
    const target = await daemon.createProject();
    for (const action of ['place', 'reuse']) {
      const response = await postJson(`${daemon.url}/api/projects/${projectId}/media/gallery/${stub}/${action}`, { targetProjectId: target.projectId });
      expect(response.status, action).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'MEDIA_GALLERY_OUTPUT_UNAVAILABLE' } });
    }
  });
  it('previews and copies imported-folder assets in their registered roots', async () => {
    const { daemon, source, projectId, projectDir } = await setup();
    const sourceDir = path.join(daemon.dataDir, 'imported-source-fixture');
    const targetDir = path.join(daemon.dataDir, 'imported-target-fixture');
    await mkdir(sourceDir); await mkdir(targetDir);
    await rename(path.join(projectDir, 'hero.png'), path.join(sourceDir, 'hero.png'));
    const target = await daemon.createProject();
    const db = openDatabase(process.cwd(), { dataDir: daemon.dataDir });
    updateProject(db, projectId, { metadata: { kind: 'prototype', baseDir: sourceDir } });
    updateProject(db, target.projectId, { metadata: { kind: 'prototype', baseDir: targetDir } });
    const detail = await (await fetch(`${daemon.url}/api/projects/${projectId}/media/gallery/${source}`)).json() as MediaGalleryEntryDetail;
    expect(detail.entry.output.state).toBe('current');
    for (const action of ['place', 'reuse']) {
      const response = await postJson(`${daemon.url}/api/projects/${projectId}/media/gallery/${source}/${action}`, { output: `${action}.png`, targetProjectId: target.projectId });
      expect(response.status, action).toBe(201);
      const copied = await response.json() as MediaGalleryPlaceResponse;
      expect(await readFile(path.join(targetDir, copied.entry.file!.name))).toEqual(await readFile(path.join(sourceDir, 'hero.png')));
    }
    await daemon.restart();
    const saved = await (await fetch(`${daemon.url}/api/projects/${target.projectId}/media/gallery`)).json() as { entries: MediaGalleryEntryDetail['entry'][] };
    expect(saved.entries[0]?.output.state).toBe('current');
  });
  it('preserves the legacy generation-root witness for wait on an imported project', async () => {
    const { daemon, projectId } = await setup();
    const baseDir = path.join(daemon.dataDir, 'imported-wait-fixture');
    await mkdir(baseDir);
    const db = openDatabase(process.cwd(), { dataDir: daemon.dataDir });
    updateProject(db, projectId, { metadata: { kind: 'prototype', baseDir } });
    const generated = await generate(daemon.url, projectId, { output: 'new-generation.png' });
    const terminal = await waitTerminal(daemon.url, generated);
    expect(terminal).toMatchObject({ status: 'done', file: { name: 'new-generation.png' } });
    expect(terminal.error).toBeUndefined();
  });
});
