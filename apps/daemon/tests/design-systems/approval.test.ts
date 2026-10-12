import { mkdtemp, mkdir, writeFile, rm, symlink, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { listDesignSystems } from '../../src/design-systems/index.js';
import { designSystemSelectability } from '@mish/contracts';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it('keeps a published kit revision stable when the receiver adds its Team runtime marker', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-team-approval-marker-'));
  await mkdir(path.join(root, 'kit'));
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Approved Team kit');
  const { designSystemRevision, setDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  const revision = await designSystemRevision(path.join(root, 'kit'));
  await setDesignSystemApproval(root, 'kit', true, revision);
  await writeFile(path.join(root, 'kit/.od-team-resource.json'), JSON.stringify({ workspaceId: 'team-a', resourceId: 'user:kit' }));
  expect((await listDesignSystems(root))[0]!.approval).toMatchObject({ status: 'approved', revision });
  await mkdir(path.join(root, 'kit/assets'));
  await writeFile(path.join(root, 'kit/assets/.od-team-resource.json'), 'content asset');
  expect((await listDesignSystems(root))[0]!.approval!.status).toBe('unreviewed');
});
it('accepts only the authenticated published revision and preserves a local revoke override', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-published-approval-'));
  await mkdir(path.join(root, 'kit'));
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Reviewed Team kit');
  const { designSystemRevision, syncPublishedDesignSystemApproval, setDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  const revision = await designSystemRevision(path.join(root, 'kit'));
  const overrides = path.join(root, '.local');
  const list = () => listDesignSystems(root, { source: 'user', publishedApprovalSeed: true, approvalReceiptRoot: overrides });
  await syncPublishedDesignSystemApproval(root, 'kit', revision);
  expect((await list())[0]!.approval!.status).toBe('approved');
  await setDesignSystemApproval(root, 'kit', false, revision, overrides);
  await syncPublishedDesignSystemApproval(root, 'kit', revision);
  expect((await list())[0]!.approval!.status).toBe('unreviewed');
  await rm(overrides, { recursive: true });
  await syncPublishedDesignSystemApproval(root, 'kit');
  expect((await list())[0]!.approval!.status).toBe('unreviewed');
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Unreviewed remote change');
  await syncPublishedDesignSystemApproval(root, 'kit', revision);
  expect((await list())[0]!.approval!.status).toBe('unreviewed');
});
it('uses a newly approved publication after a stale local approval, while keeping revocation authoritative', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-team-reapproval-'));
  await mkdir(path.join(root, 'kit'));
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Reviewed R1');
  const { designSystemRevision, syncPublishedDesignSystemApproval, setDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  const overrides = path.join(root, '.local');
  const list = () => listDesignSystems(root, { publishedApprovalSeed: true, approvalReceiptRoot: overrides });
  const r1 = await designSystemRevision(path.join(root, 'kit'));
  await syncPublishedDesignSystemApproval(root, 'kit', r1);
  await setDesignSystemApproval(root, 'kit', true, r1, overrides);
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Reviewed R2');
  expect((await list())[0]!.approval!.status).toBe('unreviewed');
  const r2 = await designSystemRevision(path.join(root, 'kit'));
  await syncPublishedDesignSystemApproval(root, 'kit', r2);
  expect((await list())[0]!.approval).toMatchObject({ status: 'approved', revision: r2, approvedRevision: r2 });
  await setDesignSystemApproval(root, 'kit', false, r2, overrides);
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Reviewed R3');
  await syncPublishedDesignSystemApproval(root, 'kit', await designSystemRevision(path.join(root, 'kit')));
  expect((await list())[0]!.approval!.status).toBe('unreviewed');
});
it.each(['linked', 'invalid-metadata'])('keeps an unsafe %s publication inspectable and Unreviewed', async kind => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-team-invalid-'));
  await mkdir(path.join(root, 'kit'));
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Kit');
  if (kind === 'linked') await symlink('missing-target', path.join(root, 'kit/tokens.css'));
  else await writeFile(path.join(root, 'kit/metadata.json'), '{broken');
  const { designSystemRevision, syncPublishedDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  await syncPublishedDesignSystemApproval(root, 'kit', await designSystemRevision(path.join(root, 'kit')));
  expect((await listDesignSystems(root, { publishedApprovalSeed: true, approvalReceiptRoot: path.join(root, '.local') }))[0]!.approval!.status).toBe('unreviewed');
});

it('ships the vetted built-in revision approved and revokes it on an edit', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-built-in-approval-'));
  await cp(path.resolve('../../design-systems/neutral-product'), path.join(root, 'neutral-product'), { recursive: true });
  const [kit] = await listDesignSystems(root, { source: 'built-in' });
  expect(kit!.approval!.status).toBe('approved');
  const { setDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  const receipts = path.join(root, '.overrides');
  await setDesignSystemApproval(root, 'neutral-product', false, kit!.approval!.revision, receipts);
  expect((await listDesignSystems(root, { source: 'built-in', approvalReceiptRoot: receipts }))[0]!.approval!.status).toBe('unreviewed');
  await writeFile(path.join(root, 'neutral-product/DESIGN.md'), '# Edited built-in');
  expect((await listDesignSystems(root, { source: 'built-in' }))[0]!.approval!.status).toBe('unreviewed');
});
it('published installed kits remain unreviewed and block generation with an Approve command', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-approval-'));
  await mkdir(path.join(root, 'kit'));
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Kit\n\nVetted design.');
  const [kit] = await listDesignSystems(root, { idPrefix: 'user:', source: 'user', defaultStatus: 'published' });
  expect(kit).toMatchObject({ approval: { status: 'unreviewed' } });
  expect(designSystemSelectability(kit!)).toMatchObject({ selectable: false, reason: 'unreviewed', approveCommand: 'od design-system approve user:kit' });
});

it('revokes approval on a nested asset edit even when the catalog was cached', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-approval-'));
  await mkdir(path.join(root, 'kit/assets'), { recursive: true });
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Kit\n\nVetted design.');
  await writeFile(path.join(root, 'kit/assets/nested.css'), 'body{color:red}');
  const { setDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  const { createDesignSystemListingCache } = await import('../../src/design-systems/listing-cache.js');
  const list = createDesignSystemListingCache(listDesignSystems);
  const [kit] = await list(root);
  await setDesignSystemApproval(root, 'kit', true, kit!.approval!.revision);
  expect((await list(root))[0]!.approval!.status).toBe('approved');
  await writeFile(path.join(root, 'kit/assets/nested.css'), 'body{color:tan}');
  expect((await list(root))[0]!.approval!.status).toBe('unreviewed');
});

it('seeds seven vetted Atlas revisions and leaves unrelated installed kits unreviewed', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-atlas-seed-'));
  const seeds = [];
  const { readDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  const { seedApprovedAtlasKits } = await import('../../src/design-systems/approved-seed.js');
  for (let i = 0; i < 8; i++) {
    const name = i === 7 ? 'other-kit' : `atlas-fixture-${i}`;
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'DESIGN.md'), `# Atlas fixture ${i}\n\nDesign contract.\n`);
    await writeFile(path.join(root, name, 'metadata.json'), JSON.stringify({ status: 'draft' }));
    if (i < 7) seeds.push({ id: `user:${name}`, revision: (await readDesignSystemApproval(root, name)).revision });
  }
  await seedApprovedAtlasKits(root, seeds);
  const catalog = await listDesignSystems(root, { idPrefix: 'user:' });
  expect(catalog.filter((kit) => kit.approval!.status === 'approved')).toHaveLength(7);
  expect(catalog.find((kit) => kit.id === 'user:other-kit')!.approval!.status).toBe('unreviewed');
  for (const seed of seeds) expect(designSystemSelectability(catalog.find((kit) => kit.id === seed.id)!)).toEqual({ selectable: true });
  await writeFile(path.join(root, 'atlas-fixture-0/DESIGN.md'), '# Changed');
  expect((await listDesignSystems(root)).find((kit) => kit.id === 'atlas-fixture-0')!.approval!.status).toBe('unreviewed');
});

it('hashes nested metadata and dependency-named asset directories, and content metadata', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-approval-'));
  await mkdir(path.join(root, 'kit/assets/node_modules'), { recursive: true });
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Kit');
  const { readDesignSystemApproval, setDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  for (const file of ['assets/metadata.json', 'assets/node_modules/tokens.css', 'metadata.json']) {
    const before = await readDesignSystemApproval(root, 'kit');
    await setDesignSystemApproval(root, 'kit', true, before.revision);
    await writeFile(path.join(root, 'kit', file), file === 'metadata.json' ? '{"title":"Changed"}' : 'Changed');
    expect((await readDesignSystemApproval(root, 'kit')).status).toBe('unreviewed');
  }
});

it('keeps a kit with a linked asset inspectable without allowing approval or breaking the catalog', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-approval-'));
  await mkdir(path.join(root, 'kit/assets'), { recursive: true });
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Kit');
  await symlink('missing-target', path.join(root, 'kit/assets/linked.css'));
  const { createDesignSystemListingCache } = await import('../../src/design-systems/listing-cache.js');
  const { setDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  const [kit] = await createDesignSystemListingCache(listDesignSystems)(root);
  expect(kit).toMatchObject({ id: 'kit', approval: { status: 'unreviewed' } });
  await expect(setDesignSystemApproval(root, 'kit', true, kit!.approval!.revision)).rejects.toThrow(/linked/i);
});

it('pins exactly the seven vetted Atlas Digest ids and validates the entire cohort before approval', async () => {
  const { APPROVED_ATLAS_SEED } = await import('../../src/design-systems/approved-atlas-seed.js');
  const { approveAtlasSeed } = await import('../../src/design-systems/approved-seed.js');
  expect(APPROVED_ATLAS_SEED.map(seed => seed.id).sort()).toEqual(['user:atlas-beyond-tl03', 'user:atlas-cocollect-tl03', 'user:atlas-hellohello-tl05', 'user:atlas-odyssee-clinic-tl02', 'user:atlas-ortolan-tl05', 'user:atlas-sage-space-tl02', 'user:atlas-ulysses-de-santi-tl06']);
  const { vi } = await import('vitest');
  const approve = vi.fn();
  const catalog = APPROVED_ATLAS_SEED.map(seed => ({ id: seed.id, approval: { status: 'unreviewed' as const, revision: String(seed.revision) } }));
  catalog[6]!.approval.revision = 'changed';
  await expect(approveAtlasSeed(APPROVED_ATLAS_SEED, { list: async () => catalog, approve })).rejects.toThrow('Atlas seed revision mismatch');
  expect(approve).not.toHaveBeenCalled();
});

it.each(['{broken', 'null', '[]'])('keeps malformed metadata %s visible as Unreviewed and refuses approval', async content => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-approval-'));
  await mkdir(path.join(root, 'kit'));
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Kit');
  await writeFile(path.join(root, 'kit/metadata.json'), content);
  const [kit] = await listDesignSystems(root);
  expect(kit).toMatchObject({ id: 'kit', approval: { status: 'unreviewed' } });
  const { setDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  await expect(setDesignSystemApproval(root, 'kit', true, kit!.approval!.revision)).rejects.toThrow(/metadata/i);
});

it('honors a packaged team seed at its exact revision with a persistent revoke override', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-team-seed-'));
  await mkdir(path.join(root, 'study-example'));
  await writeFile(path.join(root, 'study-example/DESIGN.md'), '# Vetted team kit');
  const { designSystemRevision, setDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  const revision = await designSystemRevision(path.join(root, 'study-example'));
  await mkdir(path.join(root, '.approvals'));
  await writeFile(path.join(root, '.approvals/study-example.json'), JSON.stringify({ approved: true, revision }));
  const overrides = path.join(root, '.overrides');
  const list = () => listDesignSystems(root, { source: 'built-in', approvalReceiptRoot: overrides });
  expect((await list())[0]!.approval).toMatchObject({ status: 'approved', revision, approvedRevision: revision });
  await setDesignSystemApproval(root, 'study-example', false, revision, overrides);
  expect((await list())[0]!.approval!.status).toBe('unreviewed');
  await rm(overrides, { recursive: true });
  await writeFile(path.join(root, 'study-example/DESIGN.md'), '# Unreviewed edit');
  expect((await list())[0]!.approval!.status).toBe('unreviewed');
});

it('captures build assets and their revision together, without cached or cross-kit fallback bytes', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-build-snapshot-'));
  const dir = path.join(root, 'kit');
  await mkdir(path.join(dir, 'system'), { recursive: true });
  await writeFile(path.join(dir, 'DESIGN.md'), '# Reviewed design');
  await writeFile(path.join(dir, 'system/variables.css'), ':root { --accent: #1e5a78; }');
  const { designSystemRevision, readDesignSystemSnapshot } = await import('../../src/design-systems/approval.js');
  const { readDesignSystemBuildAssets } = await import('../../src/design-systems/index.js');
  const approved = await designSystemRevision(dir);
  const capture = await readDesignSystemSnapshot(dir);
  const first = await readDesignSystemBuildAssets(root, 'user:kit');
  expect(first).toMatchObject({ revision: approved, designMd: '# Reviewed design', tokensCss: ':root { --accent: #1e5a78; }' });
  await writeFile(path.join(dir, 'system/variables.css'), ':root { --accent: #000; }');
  const changed = await readDesignSystemBuildAssets(root, 'user:kit');
  expect(changed.revision).not.toBe(approved);
  expect(changed.tokensCss).toContain('#000');
  expect(capture.revision).toBe(approved);
  expect(capture.files.get('system/variables.css')!.toString()).toContain('#1e5a78');
});

it.each(['DESIGN.md', 'tokens.css'])('refuses approved %s bytes that cannot be staged as lossless UTF-8', async file => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-build-utf8-'));
  const dir = path.join(root, 'kit'); await mkdir(dir);
  await writeFile(path.join(dir, 'DESIGN.md'), '# Kit');
  await writeFile(path.join(dir, 'tokens.css'), ':root { --accent: #fff; }');
  await writeFile(path.join(dir, file), Buffer.from([0x23, 0x80]));
  const { designSystemRevision, setDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  const { readDesignSystemBuildAssets } = await import('../../src/design-systems/index.js');
  await setDesignSystemApproval(root, 'kit', true, await designSystemRevision(dir));
  expect((await listDesignSystems(root))[0]!.approval!.status).toBe('approved');
  await expect(readDesignSystemBuildAssets(root, 'kit')).rejects.toThrow(/UTF-8/);
});
it('preserves a valid UTF-8 BOM in captured build text', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'od-build-bom-'));
  const dir = path.join(root, 'kit'); await mkdir(dir);
  const bytes = Buffer.from('\ufeff:root { --accent: #fff; }', 'utf8');
  await writeFile(path.join(dir, 'DESIGN.md'), '# Kit'); await writeFile(path.join(dir, 'tokens.css'), bytes);
  const { readDesignSystemBuildAssets } = await import('../../src/design-systems/index.js');
  const assets = await readDesignSystemBuildAssets(root, 'kit');
  expect(Buffer.from(assets.tokensCss!, 'utf8')).toEqual(bytes);
});
