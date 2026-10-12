import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { associateRunProducedFiles } from '../../src/runtimes/run-produced-files.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-produced-placement-'));
  roots.push(root);
  const file = path.join(root, 'hero.png');
  await fs.writeFile(file, 'image');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, produced_files_json TEXT)');
  db.prepare('INSERT INTO messages (id, produced_files_json) VALUES (?, NULL)').run('message-1');
  return { root, file, db };
}

describe('selected terminal produced-file publication', () => {
  it('refuses post-stat SQL when owner is lost during the awaited read', async () => {
    const { root, file, db } = await fixture();
    try {
      let current = true;
      const pending = associateRunProducedFiles(db, {
        messageId: 'message-1', projectRoot: root, touchedPaths: [file],
        finalIO: { assertCurrent: () => { if (!current) throw new Error('owner lost'); } },
      });
      current = false;
      await expect(pending).rejects.toThrow('owner lost');
      expect(db.prepare('SELECT produced_files_json AS files FROM messages WHERE id = ?')
        .get('message-1')).toEqual({ files: null });
    } finally { db.close(); }
  });

  it('keeps ordinary and current selected association behavior', async () => {
    const { root, file, db } = await fixture();
    try {
      const selected = await associateRunProducedFiles(db, {
        messageId: 'message-1', projectRoot: root, touchedPaths: [file],
        finalIO: { assertCurrent: () => {} },
      });
      expect(selected.written).toBe(true);
      db.prepare('UPDATE messages SET produced_files_json = NULL WHERE id = ?').run('message-1');
      const ordinary = await associateRunProducedFiles(db, {
        messageId: 'message-1', projectRoot: root, touchedPaths: [file],
      });
      expect(ordinary.written).toBe(true);
    } finally { db.close(); }
  });
});
