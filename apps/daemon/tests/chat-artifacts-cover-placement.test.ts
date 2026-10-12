import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { freezeAndRenderChatArtifactCovers } from '../src/chat-artifacts/cover.js';
import type { MessageArtifactRow } from '../src/chat-artifacts/store.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-cover-placement-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>Cover</title>');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE workspace_artifacts (id TEXT PRIMARY KEY, project_id TEXT)');
  db.prepare('INSERT INTO workspace_artifacts (id, project_id) VALUES (?, ?)').run('artifact-1', 'project-1');
  const row = {
    id: 'ref-1', kind: 'html', labelAtCapture: 'index.html',
    workspaceArtifactId: 'artifact-1', snapshotId: null,
  } as MessageArtifactRow;
  return { root, db, row };
}

describe('selected cover publication', () => {
  it('hands the render to the publication owner instead of starting it unjoined', async () => {
    const { root, db, row } = await fixture();
    try {
      const calls: string[] = [];
      let scheduled: ((finalIO: { assertCurrent(): void }) => Promise<void>) | null = null;
      const report = await freezeAndRenderChatArtifactCovers(
        { db, blobs: {} as never, finalIO: { assertCurrent: () => { calls.push('capture-guard'); } } },
        {
          projectRoot: root, rows: [row],
          renderer: async () => { calls.push('render'); return { ok: false }; },
          scheduleRenders: (render) => { scheduled = render; },
        },
      );
      expect(report.frozen).toBe(1);
      // Nothing renders until the owner runs it under its own accepted write.
      expect(calls).not.toContain('render');
      expect(scheduled).not.toBeNull();
      await scheduled!({ assertCurrent: () => { calls.push('owner-guard'); } });
      expect(calls).toContain('render');
      // The failure record is written under the owner's fresh guard, not the capture guard.
      const afterRender = calls.slice(calls.indexOf('render'));
      expect(afterRender).toContain('owner-guard');
      expect(afterRender).not.toContain('capture-guard');
    } finally { db.close(); }
  });

  it('a joined render is not budgeted: it settles only when the renderer does', async () => {
    const { root, db, row } = await fixture();
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let scheduled: ((finalIO: { assertCurrent(): void }) => Promise<void>) | null = null;
      await freezeAndRenderChatArtifactCovers(
        { db, blobs: {} as never },
        {
          projectRoot: root, rows: [row],
          renderer: async () => { await gate; return { ok: false }; },
          scheduleRenders: (render) => { scheduled = render; },
        },
      );
      let settled = false;
      const running = scheduled!({ assertCurrent: () => {} }).then(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      release();
      await running;
      expect(settled).toBe(true);
    } finally { db.close(); }
  });

  it('a lost owner refuses the joined render failure record', async () => {
    const { root, db, row } = await fixture();
    try {
      let scheduled: ((finalIO: { assertCurrent(): void }) => Promise<void>) | null = null;
      await freezeAndRenderChatArtifactCovers(
        { db, blobs: {} as never },
        {
          projectRoot: root, rows: [row],
          renderer: async () => ({ ok: false }),
          scheduleRenders: (render) => { scheduled = render; },
        },
      );
      // The guard runs before the failure-record SQL; its refusal propagates to the owner.
      await expect(scheduled!({ assertCurrent: () => { throw new Error('owner lost'); } })).rejects.toThrow('owner lost');
    } finally { db.close(); }
  });
});
