import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createGsapRecipeMaterials, createGsapResourceSource } from '../../src/workbench/recipes/gsap/index.js';
import { createLocalResourceSources } from '../../src/workbench/resources.js';

/**
 * Sol r07 WARN, deferred by the captain to the video-federation unit: the Enlarge native video
 * player (AC-R07.1) is reached only through `previewCapability.kind: 'video'`, and no workbench
 * source emits that kind yet. This spec records the gap so it cannot be mistaken for coverage.
 * When the video-federation unit maps authorized local video assets
 * (`/api/library/assets/:id/raw`) to `kind: 'video'`, replace it with a search → inspect proof
 * that such an item reaches the player.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('native video previews: no live source yet (video-federation follow-up)', () => {
  it('no current workbench source emits a video preview', async () => {
    const sources = [
      ...createLocalResourceSources({
        listPlugins: async () => [],
        designSystemsRoot: path.join(repoRoot, 'design-systems'),
        sectionPreviews: { hyperuiRoot: path.join(repoRoot, 'plugins/_official/shared/ui-kits/hyperui'), cultKitDir: path.join(repoRoot, 'data/component-kits/cult-ui-pro') },
      }),
      createGsapResourceSource(createGsapRecipeMaterials()),
    ];
    const items = (await Promise.all(sources.map(source => source.list({ principalId: 'local-daemon' })))).flatMap(snapshot => snapshot.items);
    expect(items.length).toBeGreaterThan(300);
    expect(items.filter(item => item.previewCapability.kind === 'video').map(item => item.ref.itemId)).toEqual([]);
  });
});
