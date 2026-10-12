import { readDesignSystemApproval, setDesignSystemApproval } from './approval.js';
import { listDesignSystems, updateUserDesignSystem } from './index.js';

export interface ApprovedDesignSystemSeed {
  id: string;
  revision: string;
}
type SeedKit = { id: string; approval?: import('@mish/contracts').DesignSystemApproval };
export async function approveAtlasSeed(seeds: readonly ApprovedDesignSystemSeed[], io: {
  list(): Promise<SeedKit[]>;
  approve(seed: ApprovedDesignSystemSeed): Promise<SeedKit>;
}): Promise<SeedKit[]> {
  if (seeds.length !== 7 || new Set(seeds.map(seed => seed.id)).size !== 7) throw new Error('Atlas approval seed must name seven distinct kits');
  const catalog = await io.list();
  for (const seed of seeds) {
    if (!seed.id.startsWith('user:atlas-') || !/^[a-f0-9]{64}$/.test(seed.revision)) throw new Error('Invalid Atlas approval seed');
    if (catalog.find(kit => kit.id === seed.id)?.approval?.revision !== seed.revision) throw new Error(`Atlas seed revision mismatch: ${seed.id}`);
  }
  const results = [];
  for (const seed of seeds) {
    const kit = await io.approve(seed);
    if (kit.approval?.status !== 'approved' || kit.approval.revision !== seed.revision || kit.approval.approvedRevision !== seed.revision) throw new Error(`Atlas kit changed during seeding: ${seed.id}`);
    results.push(kit);
  }
  return results;
}
/**
 * Seed an owner-vetted Atlas cohort after supported installation. Validate all
 * seven exact revisions before changing any receipt. Never trust names alone.
 */
export async function seedApprovedAtlasKits(root: string, seeds: readonly ApprovedDesignSystemSeed[]): Promise<void> {
  await approveAtlasSeed(seeds, {
    list: () => listDesignSystems(root, { idPrefix: 'user:', source: 'user', isEditable: true, defaultStatus: 'draft' }),
    async approve(seed) {
      await updateUserDesignSystem(root, seed.id, { status: 'published' });
      await setDesignSystemApproval(root, seed.id, true, seed.revision);
      return { id: seed.id, approval: await readDesignSystemApproval(root, seed.id) };
    },
  });
}
