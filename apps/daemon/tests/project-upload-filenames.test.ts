import { symlink, readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openUniqueUploadFile } from '../src/project-upload-file.js';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

describe('project upload filenames', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function createProject(): Promise<string> {
    const id = `upload-names-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { project: { id: string } };
    return body.project.id;
  }

  async function upload(projectId: string, files: Array<{ name: string; body: string }>) {
    const form = new FormData();
    for (const file of files) {
      form.append('files', new Blob([file.body], { type: 'text/plain' }), file.name);
    }
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/upload`, {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      files: Array<{ name: string; path: string; originalName: string }>;
    };
  }

  it('preserves uploaded source filenames and suffixes only duplicates', async () => {
    const projectId = await createProject();

    const first = await upload(projectId, [
      { name: 'deck.html', body: 'first' },
      { name: 'deck.html', body: 'second' },
    ]);
    expect(first.files.map((file) => file.name)).toEqual(['deck.html', 'deck-1.html']);
    expect(first.files.map((file) => file.originalName)).toEqual(['deck.html', 'deck.html']);

    const second = await upload(projectId, [
      { name: 'deck.html', body: 'third' },
    ]);
    expect(second.files.map((file) => file.name)).toEqual(['deck-2.html']);

    await expect(fetch(`${baseUrl}/api/projects/${projectId}/raw/deck.html`).then((res) => res.text()))
      .resolves.toBe('first');
    await expect(fetch(`${baseUrl}/api/projects/${projectId}/raw/deck-1.html`).then((res) => res.text()))
      .resolves.toBe('second');
    await expect(fetch(`${baseUrl}/api/projects/${projectId}/raw/deck-2.html`).then((res) => res.text()))
      .resolves.toBe('third');
  });
  it('D15 skips dangling symlinks instead of writing through them', async () => {
    const projectId = await createProject();
    const projectDir = path.join(process.env.OD_DATA_DIR!, 'projects', projectId);
    const target = path.join(projectDir, 'symlink-target.txt');
    await mkdir(projectDir, { recursive: true });
    await symlink(target, path.join(projectDir, 'deck.html'));
    try {
      const saved = await upload(projectId, [{ name: 'deck.html', body: 'safe' }]);
      expect(saved.files[0]?.name).toBe('deck-1.html');
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('D15 preserves every concurrent upload with the same name', async () => {
    const projectId = await createProject();
    const bodies = Array.from({ length: 8 }, (_, i) => `upload ${i}`);
    const saved = await Promise.all(bodies.map((body) => upload(projectId, [{ name: 'same.txt', body }])));
    expect(new Set(saved.map((result) => result.files[0]?.name)).size).toBe(bodies.length);
    for (const [index, result] of saved.entries()) {
      expect(await fetch(`${baseUrl}/api/projects/${projectId}/raw/${result.files[0]!.name}`).then((res) => res.text())).toBe(bodies[index]);
    }
  });

  it('D15 reserves concurrent destinations before the writers consume bytes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-upload-reservation-'));
    const created: Awaited<ReturnType<typeof openUniqueUploadFile>>[] = [];
    try {
      created.push(...await Promise.all(Array.from({ length: 16 }, () =>
        openUniqueUploadFile(dir, 'same.txt', new Set(), () => {}),
      )));
      expect(new Set(created.map((file) => file.filename)).size).toBe(16);
      await Promise.all(created.map((file, i) => file.handle.writeFile(`writer ${i}`)));
      for (const [index, file] of created.entries()) {
        expect(await readFile(file.destination, 'utf8')).toBe(`writer ${index}`);
      }
    } finally {
      await Promise.all(created.map((file) => file.handle.close()));
      await rm(dir, { recursive: true, force: true });
    }
  });

});
