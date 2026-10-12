// Atlas Digest pilot (G3), review round. The catalog name and category of a
// user design system resolve at READ time: metadata.json (only what a user
// explicitly set), then the kit's manifest.json, then the DESIGN.md heading and
// `> Category:` line. No write path may freeze a fallback into metadata.json,
// because a frozen fallback outranks a later manifest rename for good.
//
// Pinned here, per path: Publish, accepted revisions (including a revision
// that renames manifest.json), the generated README, the archive's SKILLS.md,
// the legacy package migration, kits whose folder name differs from
// manifest.id, a blank metadata title, and the read-time repair of kits an
// older daemon already froze (metadata.title equal to the DESIGN.md heading).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildUserDesignSystemArchive,
  createUserDesignSystemRevision,
  listDesignSystems,
  listUserDesignSystemFiles,
  updateUserDesignSystem,
  updateUserDesignSystemRevisionStatus,
} from '../../src/design-systems/index.js';

const MANIFEST_NAME = 'Atlas · Manifest Name';
const MANIFEST_CATEGORY = 'Atlas reference';
const HEADING = 'Heading Title From DESIGN.md';
const HEADING_CATEGORY = 'Heading Category';
const DESIGN_MD = `# ${HEADING}\n> Category: ${HEADING_CATEGORY}\n> Surface: web\n\nA kit body.\n`;

let userDir = '';

beforeEach(async () => {
  userDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'od-ds-identity-')), 'design-systems');
  await mkdir(userDir, { recursive: true });
});

afterEach(async () => {
  if (userDir) await rm(path.dirname(userDir), { recursive: true, force: true });
});

function manifestJson(id: string, name = MANIFEST_NAME, category = MANIFEST_CATEGORY): string {
  return `${JSON.stringify({
    schemaVersion: 'od-design-system-project/v1',
    id,
    name,
    category,
    files: { design: 'DESIGN.md', tokens: 'tokens.css' },
  }, null, 2)}\n`;
}

async function writeKit(
  dirId: string,
  options: { manifestId?: string; metadata?: Record<string, unknown>; extra?: Record<string, string> } = {},
): Promise<string> {
  const dir = path.join(userDir, dirId);
  const files: Record<string, string> = {
    'DESIGN.md': DESIGN_MD,
    'tokens.css': ':root { --ink: #111; }\n',
    'manifest.json': manifestJson(options.manifestId ?? dirId),
    ...(options.metadata ? { 'metadata.json': `${JSON.stringify(options.metadata, null, 2)}\n` } : {}),
    ...(options.extra ?? {}),
  };
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return dir;
}

async function catalogRow(dirId: string) {
  const rows = await listDesignSystems(userDir, {
    idPrefix: 'user:',
    source: 'user',
    isEditable: true,
    defaultStatus: 'draft',
  });
  const row = rows.find((entry) => entry.id === `user:${dirId}`);
  if (!row) throw new Error(`user:${dirId} missing from the catalog`);
  return row;
}

async function metadataOf(dirId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(userDir, dirId, 'metadata.json'), 'utf8'));
}

/** A kit as an older daemon left it: Publish froze the heading into metadata.json. */
const FROZEN_BY_OLD_DAEMON = { title: HEADING, category: HEADING_CATEGORY, status: 'published', surface: 'web' };

describe('a Publish persists no fallback identity', () => {
  it('writes status without title or category, and the catalog still shows the manifest', async () => {
    await writeKit('kit-a');
    await updateUserDesignSystem(userDir, 'user:kit-a', { status: 'published' });

    const metadata = await metadataOf('kit-a');
    expect(metadata.status).toBe('published');
    expect(metadata).not.toHaveProperty('title');
    expect(metadata).not.toHaveProperty('category');
    expect(await catalogRow('kit-a')).toMatchObject({ title: MANIFEST_NAME, category: MANIFEST_CATEGORY });
  });

  it('persists an explicit rename and keeps it over the manifest', async () => {
    await writeKit('kit-b');
    await updateUserDesignSystem(userDir, 'user:kit-b', { title: 'Chosen Name', category: 'Chosen Category' });

    expect(await metadataOf('kit-b')).toMatchObject({ title: 'Chosen Name', category: 'Chosen Category' });
    expect(await catalogRow('kit-b')).toMatchObject({ title: 'Chosen Name', category: 'Chosen Category' });
  });
});

describe('an accepted revision', () => {
  it('picks up a manifest.json rename, in the catalog and in the generated README', async () => {
    await writeKit('kit-rev');
    const revision = await createUserDesignSystemRevision(userDir, 'user:kit-rev', {
      feedback: 'Rename the kit.',
      baseBody: DESIGN_MD,
      proposedBody: `${DESIGN_MD}\nTighter.\n`,
      fileChanges: [{
        path: 'manifest.json',
        baseContent: manifestJson('kit-rev'),
        proposedContent: manifestJson('kit-rev', 'Renamed In Revision', 'Revised Category'),
      }],
    });
    if (!revision) throw new Error('revision was not created');
    await updateUserDesignSystemRevisionStatus(userDir, 'user:kit-rev', revision.id, 'accepted');

    expect(await catalogRow('kit-rev')).toMatchObject({
      title: 'Renamed In Revision',
      category: 'Revised Category',
    });
    const metadata = await metadataOf('kit-rev');
    expect(metadata).not.toHaveProperty('title');
    expect(metadata).not.toHaveProperty('category');
    await expect(readFile(path.join(userDir, 'kit-rev', 'README.md'), 'utf8'))
      .resolves.toContain('Renamed In Revision');
  });
});

describe('a kit an older daemon froze (metadata.title equals the DESIGN.md heading)', () => {
  it('shows the manifest name and category again, without rewriting metadata.json', async () => {
    await writeKit('kit-frozen', { metadata: FROZEN_BY_OLD_DAEMON });

    expect(await catalogRow('kit-frozen')).toMatchObject({ title: MANIFEST_NAME, category: MANIFEST_CATEGORY });
    expect(await metadataOf('kit-frozen')).toMatchObject({ title: HEADING, category: HEADING_CATEGORY });
  });

  it('generates its README under the manifest name', async () => {
    await writeKit('kit-readme', { metadata: FROZEN_BY_OLD_DAEMON });
    await listUserDesignSystemFiles(userDir, 'user:kit-readme');

    const readme = await readFile(path.join(userDir, 'kit-readme', 'README.md'), 'utf8');
    expect(readme).toContain(MANIFEST_NAME);
    expect(readme).not.toContain(HEADING);
  });

  it('names its archive and SKILLS.md after the manifest', async () => {
    await writeKit('kit-zip', { metadata: FROZEN_BY_OLD_DAEMON });
    const archive = await buildUserDesignSystemArchive(userDir, 'user:kit-zip');
    if (!archive) throw new Error('no archive');

    expect(archive.title).toBe(MANIFEST_NAME);
    const skills = await (await JSZip.loadAsync(archive.buffer)).file('SKILLS.md')?.async('string');
    expect(skills).toContain(MANIFEST_NAME);
    expect(skills).toContain(MANIFEST_CATEGORY);
  });

  it('migrates a legacy package under the manifest name', async () => {
    await writeKit('kit-legacy', {
      metadata: FROZEN_BY_OLD_DAEMON,
      extra: { 'preview/colors-ui-palette.html': '<main>legacy palette</main>\n' },
    });
    await listUserDesignSystemFiles(userDir, 'user:kit-legacy');

    const buttons = await readFile(
      path.join(userDir, 'kit-legacy', 'preview', 'components-buttons.html'),
      'utf8',
    );
    expect(buttons).toContain(MANIFEST_NAME);
    expect(buttons).not.toContain(HEADING);
  });

  // Sol review: the old status-only PATCH also froze the fallbacks for a kit
  // whose DESIGN.md has no H1 (the directory name) or no `> Category:` line
  // ('Custom'). Those stored fallbacks are repairable too.
  it('repairs a stored directory-name title and a stored Custom category', async () => {
    const dir = await writeKit('kit-no-heading', { metadata: { title: 'kit-no-heading', category: 'Custom', status: 'published' } });
    await writeFile(path.join(dir, 'DESIGN.md'), 'A kit body with no H1 and no Category line.\n', 'utf8');

    expect(await catalogRow('kit-no-heading')).toMatchObject({ title: MANIFEST_NAME, category: MANIFEST_CATEGORY });
    expect(await metadataOf('kit-no-heading')).toMatchObject({ title: 'kit-no-heading', category: 'Custom' });
  });

  it('keeps a user-set Custom category and a user-set folder-name title', async () => {
    const dir = await writeKit('kit-user-custom', {
      metadata: { title: 'kit-user-custom', category: 'Custom', userSet: ['title', 'category'], status: 'published' },
    });
    await writeFile(path.join(dir, 'DESIGN.md'), 'A kit body with no H1 and no Category line.\n', 'utf8');
    expect(await catalogRow('kit-user-custom')).toMatchObject({ title: 'kit-user-custom', category: 'Custom' });
  });

  it('keeps an explicit title that merely differs from the heading', async () => {
    await writeKit('kit-chosen', { metadata: { title: 'Chosen Name', status: 'published' } });
    expect((await catalogRow('kit-chosen')).title).toBe('Chosen Name');
  });
});

describe('manifest identity edges', () => {
  it('applies the manifest name and category when the folder name differs from manifest.id', async () => {
    await writeKit('kit-folder-renamed', { manifestId: 'atlas-manifest-kit' });
    expect(await catalogRow('kit-folder-renamed')).toMatchObject({
      title: MANIFEST_NAME,
      category: MANIFEST_CATEGORY,
    });
    await updateUserDesignSystem(userDir, 'user:kit-folder-renamed', { status: 'published' });
    expect(await catalogRow('kit-folder-renamed')).toMatchObject({ title: MANIFEST_NAME, status: 'published' });
  });

  it('treats a blank metadata title or category as not set', async () => {
    await writeKit('kit-blank', { metadata: { title: '   ', category: '', status: 'draft' } });
    expect(await catalogRow('kit-blank')).toMatchObject({ title: MANIFEST_NAME, category: MANIFEST_CATEGORY });
  });
});
