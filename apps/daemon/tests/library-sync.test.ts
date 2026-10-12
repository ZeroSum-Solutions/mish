// Daemon-side core of "see everything in the Library": reconcileLibrary mirrors
// user design systems and agent-produced project deliverables into the Library
// as *referenced* rows, classified into the Agent / Generated / Upload / Design
// system buckets the grid filters on. This pins:
//   - design systems become one `design-system` card (linking to /design-systems/:id),
//   - agent-authored pages → agent-task, generated media → generated, files the
//     user dropped in → manual-upload, and scaffolding (css/js) is excluded,
//   - the timeline buckets by the artifact's own mtime (not sync time), and
//   - the pass is idempotent (re-running indexes nothing new).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import { listLibraryAssets, updateLibraryAsset, addLibraryAssetSource } from '../src/library-store.js';
import { registerLibraryAsset, resolveAssetBytesPath, libraryObjectPath } from '../src/library.js';
import { reconcileLibrary } from '../src/library-sync.js';
import type Database from 'better-sqlite3';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, writeFile: vi.fn(original.writeFile) };
});

let db: Database.Database;
let dataDir: string;
let projectsDir: string;
let designSystemsDir: string;
let libraryDir: string;

const PROJECT_ID = 'proj-1';
const DS_DIR = 'acme';
// A fixed past day so we can assert the timeline buckets by file mtime.
const ARTIFACT_DATE = '2021-04-08';
const ARTIFACT_TS = new Date(`${ARTIFACT_DATE}T12:00:00`).getTime();

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'od-library-sync-'));
  projectsDir = path.join(dataDir, 'projects');
  designSystemsDir = path.join(dataDir, 'design-systems');
  libraryDir = path.join(dataDir, 'library');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(designSystemsDir, { recursive: true });
  db = openDatabase(dataDir, { dataDir });
});

afterEach(async () => {
  closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

async function seedProject(): Promise<void> {
  const now = Date.now();
  insertProject(db, { id: PROJECT_ID, name: 'Proj', createdAt: now, updatedAt: now });
  insertConversation(db, {
    id: 'conv-1',
    projectId: PROJECT_ID,
    title: 'C',
    createdAt: now,
    updatedAt: now,
  });

  const dir = path.join(projectsDir, PROJECT_ID);
  await mkdir(dir, { recursive: true });
  // index.html + render.png are agent-produced; logo.png is a user drop-in;
  // styles.css is scaffolding (must be excluded).
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Deck</h1>');
  // Distinct bytes per png so content-hash dedup keeps them separate assets.
  await writeFile(path.join(dir, 'render.png'), pngBytes('render'));
  await writeFile(path.join(dir, 'logo.png'), pngBytes('logo'));
  await writeFile(path.join(dir, 'styles.css'), 'h1{color:red}');
  // Stamp the deliverables with a known past mtime to assert timeline bucketing.
  const stamp = new Date(ARTIFACT_TS);
  for (const f of ['index.html', 'render.png', 'logo.png']) {
    await utimes(path.join(dir, f), stamp, stamp);
  }

  upsertMessage(db, 'conv-1', {
    id: 'msg-1',
    role: 'assistant',
    content: 'made a deck',
    producedFiles: [
      { path: 'index.html', name: 'index.html', kind: 'html', size: 24, mtime: ARTIFACT_TS },
      { path: 'render.png', name: 'render.png', kind: 'image', size: 70, mtime: ARTIFACT_TS },
    ],
  });
}

async function seedDesignSystem(): Promise<void> {
  const root = path.join(designSystemsDir, DS_DIR);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'DESIGN.md'),
    '---\nname: Acme\ncategory: Brand\n---\n\n# Acme\n\nAcme brand system.\n',
  );
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 'od-design-system-project/v1',
      id: DS_DIR,
      name: 'Acme',
      category: 'Brand',
      files: { design: 'DESIGN.md', tokens: 'tokens.css', components: 'components.html' },
    }),
  );
  await writeFile(path.join(root, 'components.html'), '<!doctype html><button>Acme</button>');
}

// A tiny valid 1x1 PNG so dimension sniffing / mime detection have real bytes.
// `tag` trailing bytes (ignored by decoders, magic bytes intact) make otherwise
// identical pngs hash differently so they stay distinct Library assets.
function pngBytes(tag: string): Buffer {
  const base = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  return Buffer.concat([base, Buffer.from(`\n<!-- ${tag} -->`)]);
}

function paths() {
  return {
    LIBRARY_DIR: libraryDir,
    PROJECTS_DIR: projectsDir,
    USER_DESIGN_SYSTEMS_DIR: designSystemsDir,
  };
}

describe('reconcileLibrary', () => {
  it('mirrors design systems + agent deliverables, classifies sources, excludes scaffolding', async () => {
    await seedProject();
    await seedDesignSystem();

    const result = await reconcileLibrary(db, paths());

    expect(result.designSystems).toBe(1);
    // index.html + render.png + logo.png; styles.css excluded.
    expect(result.projectAssets).toBe(3);
    expect(result.total).toBe(4);

    const assets = listLibraryAssets(db, {});
    const byRel = new Map(assets.map((a) => [a.relPath, a]));

    // No scaffolding leaked in.
    expect([...byRel.keys()]).not.toContain('styles.css');

    const sourceKindFor = (rel: string) => byRel.get(rel)?.sources?.[0]?.sourceKind;
    expect(sourceKindFor('index.html')).toBe('agent-task'); // authored page
    expect(sourceKindFor('render.png')).toBe('generated'); // agent media
    expect(sourceKindFor('logo.png')).toBe('manual-upload'); // user drop-in

    // The design system is one `design-system` card linking back to itself.
    const ds = assets.find((a) => a.kind === 'design-system');
    expect(ds).toBeTruthy();
    expect(ds?.sources?.[0]?.sourceKind).toBe('design-system');
    expect(ds?.sources?.[0]?.designSystemId).toBe(`user:${DS_DIR}`);

    // Project assets are referenced (bytes stay in the project) and back-link it.
    const html = byRel.get('index.html')!;
    expect(html.storage).toBe('referenced');
    expect(html.originProjectId).toBe(PROJECT_ID);
    expect(html.sources?.[0]?.projectId).toBe(PROJECT_ID);

    // Timeline buckets by the artifact's own mtime, not the sync time.
    expect(html.archivedDate).toBe(ARTIFACT_DATE);
  });

  it('is idempotent — a second pass indexes nothing new', async () => {
    await seedProject();
    await seedDesignSystem();

    const first = await reconcileLibrary(db, paths());
    expect(first.total).toBe(4);
    const countAfterFirst = listLibraryAssets(db, {}).length;

    const second = await reconcileLibrary(db, paths());
    expect(second.total).toBe(0);
    expect(second.deduped).toBeGreaterThanOrEqual(4);
    expect(listLibraryAssets(db, {}).length).toBe(countAfterFirst);
  });

  it('refreshes edited referenced bytes without replacing identity or provenance', async () => {
    await seedProject();
    await reconcileLibrary(db, paths());
    const original = listLibraryAssets(db, {}).find(a => a.relPath === 'index.html')!;
    updateLibraryAsset(db, original.id, { tags: ['saved'], metadata: { favorite: true } });
    const edited = '<!doctype html><h1>Changed deck</h1>';
    await writeFile(path.join(projectsDir, PROJECT_ID, 'index.html'), edited);
    await reconcileLibrary(db, paths());
    const refreshed = listLibraryAssets(db, {}).find(a => a.id === original.id)!;
    expect(refreshed.contentHash).toBe(createHash('sha256').update(edited).digest('hex'));
    expect(refreshed.size).toBe(Buffer.byteLength(edited));
    expect(refreshed.sources).toEqual(original.sources);
    expect(refreshed.tags).toEqual(['saved']);
    expect(refreshed.metadata?.favorite).toBe(true);
    expect(createHash('sha256').update(await readFile(resolveAssetBytesPath(refreshed, projectsDir)!)).digest('hex')).toBe(refreshed.contentHash);
    const again = await reconcileLibrary(db, paths());
    expect(again.total).toBe(0);
    expect(listLibraryAssets(db, {}).find(a => a.id === original.id)).toEqual(refreshed);
  });

  it('refreshes same-size edits when the file modification time changes', async () => {
    await seedProject();
    await reconcileLibrary(db, paths());
    const original = listLibraryAssets(db, {}).find(a => a.relPath === 'index.html')!;
    const edited = '<!doctype html><h1>Edit</h1>';
    expect(Buffer.byteLength(edited)).toBe(original.size);
    const file = path.join(projectsDir, PROJECT_ID, 'index.html');
    await writeFile(file, edited);
    await utimes(file, new Date(ARTIFACT_TS + 1000), new Date(ARTIFACT_TS + 1000));
    await reconcileLibrary(db, paths());
    expect(listLibraryAssets(db, {}).find(a => a.id === original.id)?.contentHash).toBe(createHash('sha256').update(edited).digest('hex'));
  });

  it('verifies same-size edits even when original modification time is restored', async () => {
    await seedProject();
    await reconcileLibrary(db, paths());
    const original = listLibraryAssets(db, {}).find(a => a.relPath === 'index.html')!;
    const edited = '<!doctype html><h1>Edit</h1>';
    const file = path.join(projectsDir, PROJECT_ID, 'index.html');
    await writeFile(file, edited);
    await utimes(file, new Date(ARTIFACT_TS), new Date(ARTIFACT_TS));
    await reconcileLibrary(db, paths());
    expect(listLibraryAssets(db, {}).find(a => a.id === original.id)?.contentHash).toBe(createHash('sha256').update(edited).digest('hex'));
  });

  it('keeps an owned deduplicated upload immutable when its project copy changes', async () => {
    await seedProject();
    const file = path.join(projectsDir, PROJECT_ID, 'index.html');
    const { asset: owned } = await registerLibraryAsset({ db, libraryDir, storage: 'owned', absPath: file,
      kind: 'html', filename: 'index.html', originProjectId: PROJECT_ID, relPath: 'index.html',
      source: { sourceKind: 'manual-upload', projectId: PROJECT_ID, relPath: 'index.html' } });
    await reconcileLibrary(db, paths());
    const edited = '<h1>New project copy</h1>';
    await writeFile(file, edited);
    await reconcileLibrary(db, paths());
    const assets = listLibraryAssets(db, {});
    const unchanged = assets.find(a => a.id === owned.id)!;
    expect(unchanged.contentHash).toBe(owned.contentHash);
    expect(await readFile(resolveAssetBytesPath(unchanged, projectsDir)!, 'utf8')).toBe('<!doctype html><h1>Deck</h1>');
    const reference = assets.find(a => a.storage === 'referenced' && a.contentHash === createHash('sha256').update(edited).digest('hex'))!;
    expect(reference).toBeDefined();
    const editedAgain = '<h1>Another project edit</h1>';
    await writeFile(file, editedAgain);
    await reconcileLibrary(db, paths());
    expect(listLibraryAssets(db, {}).find(a => a.id === reference.id)?.contentHash).toBe(createHash('sha256').update(editedAgain).digest('hex'));
    expect(await readFile(resolveAssetBytesPath(owned, projectsDir)!, 'utf8')).toBe('<!doctype html><h1>Deck</h1>');
  });

  it('preserves the other project reference when deduplicated bytes diverge', async () => {
    await seedProject();
    await reconcileLibrary(db, paths());
    const original = listLibraryAssets(db, {}).find(a => a.relPath === 'index.html')!;
    const other = 'other-project';
    insertProject(db, { id: other, name: 'Other', createdAt: Date.now(), updatedAt: Date.now() });
    await mkdir(path.join(projectsDir, other));
    await writeFile(path.join(projectsDir, other, 'index.html'), '<!doctype html><h1>Deck</h1>');
    addLibraryAssetSource(db, { assetId: original.id, sourceKind: 'manual-upload', projectId: other, relPath: 'index.html' });
    const edited = '<h1>Edited primary</h1>';
    await writeFile(path.join(projectsDir, PROJECT_ID, 'index.html'), edited);
    vi.mocked(writeFile).mockClear();
    await reconcileLibrary(db, paths());
    const assets = listLibraryAssets(db, {});
    const old = assets.find(a => a.id === original.id)!;
    expect(old.contentHash).toBe(original.contentHash);
    expect(createHash('sha256').update(await readFile(resolveAssetBytesPath(old, projectsDir)!)).digest('hex')).toBe(old.contentHash);
    expect(old.sources).toHaveLength(2);
    expect(old.storage).toBe('owned');
    // Canonical objects are published atomically, never overwritten in place.
    expect(vi.mocked(writeFile).mock.calls.some(([file]) => String(file) === old.filePath)).toBe(false);
    expect(vi.mocked(writeFile).mock.calls.some(([file]) => String(file).endsWith('.tmp'))).toBe(true);
    const secondEdit = '<h1>Other project edited too</h1>';
    await writeFile(path.join(projectsDir, other, 'index.html'), secondEdit);
    await reconcileLibrary(db, paths());
    expect(listLibraryAssets(db, {}).some(a => a.contentHash === createHash('sha256').update(secondEdit).digest('hex'))).toBe(true);
    expect(createHash('sha256').update(await readFile(resolveAssetBytesPath(old, projectsDir)!)).digest('hex')).toBe(original.contentHash);
    expect(assets.some(a => a.contentHash === createHash('sha256').update(edited).digest('hex'))).toBe(true);
  });

  it('recovers original shared bytes through owned ingestion without replacing saved identity', async () => {
    await seedProject();
    await reconcileLibrary(db, paths());
    const original = listLibraryAssets(db, {}).find(a => a.relPath === 'index.html')!;
    updateLibraryAsset(db, original.id, { tags: ['saved'], metadata: { favorite: true } });
    const originalBytes = Buffer.from('<!doctype html><h1>Deck</h1>');
    addLibraryAssetSource(db, { assetId: original.id, sourceKind: 'manual-upload', projectId: PROJECT_ID, relPath: 'backup.html' });
    const sharedSources = listLibraryAssets(db, {}).find(a => a.id === original.id)!.sources;
    await writeFile(path.join(projectsDir, PROJECT_ID, 'backup.html'), '<h1>Backup changed too</h1>');
    const changed = '<h1>Current content</h1>';
    await writeFile(path.join(projectsDir, PROJECT_ID, 'index.html'), changed);
    const { asset: recovered, deduped } = await registerLibraryAsset({ db, libraryDir, storage: 'owned',
      kind: 'html', mime: 'text/html', bytes: originalBytes, filename: 'index.html',
      source: { sourceKind: 'manual-upload' } });
    expect(deduped).toBe(true);
    expect(recovered.id).toBe(original.id);
    expect(recovered.storage).toBe('owned');
    expect(recovered.tags).toEqual(['saved']);
    expect(recovered.metadata?.favorite).toBe(true);
    expect(recovered.sources).toEqual(expect.arrayContaining(sharedSources));
    expect(await readFile(resolveAssetBytesPath(recovered, projectsDir)!)).toEqual(originalBytes);
    await reconcileLibrary(db, paths());
    const current = listLibraryAssets(db, {}).find(a => a.storage === 'referenced' && a.relPath === 'index.html')!;
    expect(current.id).not.toBe(original.id);
    expect(current.contentHash).toBe(createHash('sha256').update(changed).digest('hex'));
    expect(listLibraryAssets(db, {}).some(a => a.storage === 'referenced' && a.relPath === 'backup.html')).toBe(true);
    await writeFile(path.join(projectsDir, PROJECT_ID, 'index.html'), '<h1>Later content</h1>');
    expect(await readFile(resolveAssetBytesPath(recovered, projectsDir)!)).toEqual(originalBytes);
    const repeat = await registerLibraryAsset({ db, libraryDir, storage: 'owned', bytes: originalBytes,
      kind: 'html', mime: 'text/html', source: { sourceKind: 'manual-upload' } });
    expect(repeat.asset.id).toBe(original.id);
    expect(repeat.asset.sources).toEqual(recovered.sources);
  });

  it('rejects an in-flight reference refresh after owned recovery won the race', async () => {
    await seedProject();
    await reconcileLibrary(db, paths());
    const original = listLibraryAssets(db, {}).find(a => a.relPath === 'index.html')!;
    const bytes = await readFile(path.join(projectsDir, PROJECT_ID, 'index.html'));
    const { asset: owned } = await registerLibraryAsset({ db, libraryDir, storage: 'owned', bytes,
      kind: 'html', mime: 'text/html', source: { sourceKind: 'manual-upload' } });
    const changedHash = createHash('sha256').update('Edited while ingestion ran').digest('hex');
    expect(updateLibraryAsset(db, original.id, { contentHash: changedHash, size: 1 }, original.contentHash)).toBe(false);
    const retained = listLibraryAssets(db, {}).find(a => a.id === original.id)!;
    expect(retained.contentHash).toBe(original.contentHash);
    expect(retained.storage).toBe('owned');
    expect(await readFile(resolveAssetBytesPath(owned, projectsDir)!)).toEqual(bytes);
  });

  it('does not publish an orphan object when owned promotion rejects a stale hash', async () => {
    await seedProject();
    await reconcileLibrary(db, paths());
    const original = listLibraryAssets(db, {}).find(a => a.relPath === 'index.html')!;
    const bytes = await readFile(path.join(projectsDir, PROJECT_ID, 'index.html'));
    const objectPath = libraryObjectPath(libraryDir, original.contentHash, '.html');
    const prepare = db.prepare.bind(db);
    let changed = false;
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (!changed && sql.includes("SET storage = 'owned'")) {
        changed = true;
        prepare('UPDATE library_assets SET content_hash = ? WHERE id = ?')
          .run(createHash('sha256').update('Concurrent edit').digest('hex'), original.id);
      }
      return prepare(sql);
    });
    try {
      await expect(registerLibraryAsset({ db, libraryDir, storage: 'owned', bytes,
        kind: 'html', mime: 'text/html', source: { sourceKind: 'manual-upload' } }))
        .rejects.toThrow('changed during owned ingestion');
      expect(changed).toBe(true);
      await expect(readFile(objectPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(path.dirname(objectPath))).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('rolls back owned promotion when atomic object publication fails', async () => {
    await seedProject();
    await reconcileLibrary(db, paths());
    const original = listLibraryAssets(db, {}).find(a => a.relPath === 'index.html')!;
    const bytes = await readFile(path.join(projectsDir, PROJECT_ID, 'index.html'));
    const objectPath = libraryObjectPath(libraryDir, original.contentHash, '.html');
    await mkdir(objectPath, { recursive: true });
    await expect(registerLibraryAsset({ db, libraryDir, storage: 'owned', bytes,
      kind: 'html', mime: 'text/html', source: { sourceKind: 'manual-upload' } })).rejects.toThrow();
    const retained = listLibraryAssets(db, {}).find(a => a.id === original.id)!;
    expect(retained.storage).toBe('referenced');
    expect(retained.contentHash).toBe(original.contentHash);
    expect(await readFile(resolveAssetBytesPath(retained, projectsDir)!)).toEqual(bytes);
    expect((await readdir(path.dirname(objectPath))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refreshes MIME when referenced image bytes change format at the same path', async () => {
    await seedProject();
    await reconcileLibrary(db, paths());
    const original = listLibraryAssets(db, {}).find(a => a.relPath === 'logo.png')!;
    await writeFile(path.join(projectsDir, PROJECT_ID, 'logo.png'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await reconcileLibrary(db, paths());
    expect(listLibraryAssets(db, {}).find(a => a.id === original.id)?.mime).toBe('image/jpeg');
  });

  it('reports a hash collision without deleting either saved asset or its sources', async () => {
    await seedProject();
    await reconcileLibrary(db, paths());
    const original = listLibraryAssets(db, {}).find(a => a.relPath === 'index.html')!;
    updateLibraryAsset(db, original.id, { tags: ['saved'], metadata: { favorite: true } });
    const edited = '<h1>Already owned</h1>';
    const { asset: owned } = await registerLibraryAsset({ db, libraryDir, storage: 'owned', text: edited,
      kind: 'html', filename: 'upload.html', source: { sourceKind: 'manual-upload' } });
    await writeFile(path.join(projectsDir, PROJECT_ID, 'index.html'), edited);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await reconcileLibrary(db, paths());
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('content already belongs to'));
      const assets = listLibraryAssets(db, {});
      const retained = assets.find(a => a.id === original.id)!;
      expect(retained.contentHash).toBe(original.contentHash);
      expect(retained.sources).toEqual(original.sources);
      expect(retained.tags).toEqual(['saved']);
      expect(retained.metadata?.favorite).toBe(true);
      expect(assets.find(a => a.id === owned.id)?.contentHash).toBe(owned.contentHash);
      expect(await readFile(resolveAssetBytesPath(owned, projectsDir)!, 'utf8')).toBe(edited);
    } finally { warning.mockRestore(); }
  });

  it('skips manifest preview paths that escape the design-system root', async () => {
    const root = path.join(designSystemsDir, DS_DIR);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(designSystemsDir, 'outside.html'), '<!doctype html><h1>Secret</h1>');
    await writeFile(
      path.join(root, 'DESIGN.md'),
      '---\nname: Acme\ncategory: Brand\n---\n\n# Acme\n',
    );
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 'od-design-system-project/v1',
        id: DS_DIR,
        name: 'Acme',
        preview: { pages: [{ path: '../outside.html', role: 'overview' }] },
      }),
    );
    await writeFile(path.join(root, 'components.html'), '<!doctype html><button>Safe</button>');

    const result = await reconcileLibrary(db, paths());

    expect(result.designSystems).toBe(1);
    const ds = listLibraryAssets(db, {}).find((asset) => asset.kind === 'design-system');
    expect(ds?.relPath).toBe('components.html');
    expect(await realpath(path.resolve(ds?.filePath ?? ''))).toBe(
      await realpath(path.join(root, 'components.html')),
    );
  });

  it('does not register a design-system preview that is a symlink', async () => {
    const root = path.join(designSystemsDir, DS_DIR);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(designSystemsDir, 'outside.html'), '<!doctype html><h1>Secret</h1>');
    await writeFile(
      path.join(root, 'DESIGN.md'),
      '---\nname: Acme\ncategory: Brand\n---\n\n# Acme\n',
    );
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 'od-design-system-project/v1',
        id: DS_DIR,
        name: 'Acme',
        preview: { pages: [{ path: 'components.html', role: 'overview' }] },
      }),
    );
    await symlink(path.join(designSystemsDir, 'outside.html'), path.join(root, 'components.html'));

    const result = await reconcileLibrary(db, paths());

    expect(result.designSystems).toBe(0);
    expect(listLibraryAssets(db, {}).filter((asset) => asset.kind === 'design-system')).toEqual([]);
  });
});
