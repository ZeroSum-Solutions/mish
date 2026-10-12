import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseResourceSearchRequest } from '@mish/contracts';
import { createReact95Materials, createReact95ResourceSource, react95PreviewPath } from '../../src/workbench/kits/react95/materials.js';
import { REACT95_TOOLCHAIN } from '../../src/workbench/kits/react95/pins.js';
import { createGsapRecipeMaterials, createGsapResourceSource } from '../../src/workbench/recipes/gsap/index.js';
import { createLocalResourceSources, inspectResource, searchResources } from '../../src/workbench/resources.js';

/**
 * R07 round 3 live proof (replaces resources-styled-components-gap.test.ts, which recorded
 * that no live source emitted a styled-components preview before batch 7+8). The React95
 * kit templates are a live source: they declare their styled-components target dependency,
 * so where items enter the workbench they become `styled-components` previews in search and
 * inspect, pointing at the kit route. The Enlarge host then reports them ready only after the
 * runtime's style[data-styled] sheet holds rules (web: workbench-enlarge-styled; real browser:
 * e2e/ui/workbench-react95-styled-preview.test.ts).
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const context = { principalId: 'local-daemon' };
const materials = createReact95Materials();
const react95 = createReact95ResourceSource(materials);
const TEMPLATES = ['template-settings-form', 'template-window-app'];

describe('styled-components previews: React95 is the live source', () => {
  it('the live workbench sources emit exactly the React95 templates as styled-components previews', async () => {
    const sources = [
      ...createLocalResourceSources({
        listPlugins: async () => [],
        designSystemsRoot: path.join(repoRoot, 'design-systems'),
        sectionPreviews: { hyperuiRoot: path.join(repoRoot, 'plugins/_official/shared/ui-kits/hyperui'), cultKitDir: path.join(repoRoot, 'data/component-kits/cult-ui-pro') },
      }),
      createGsapResourceSource(createGsapRecipeMaterials()),
      react95,
    ];
    // The flip of the batch 5+6 gap spec: across every live source, the previewable items that
    // depend on styled-components are exactly the React95 templates.
    const listed = (await Promise.all(sources.map(source => source.list(context)))).flatMap(snapshot => snapshot.items);
    expect(listed.length).toBeGreaterThan(300);
    const dependent = listed.filter(item => item.previewCapability.available && item.targetDependencies?.some(dependency => dependency.name === 'styled-components'));
    expect(dependent.map(item => `${item.ref.sourceId}:${item.ref.itemId}`).sort()).toEqual(TEMPLATES.map(id => `react95:${id}`));
    // Where they enter the workbench (search), they become styled-components previews.
    const page = await searchResources(parseResourceSearchRequest({ limit: 100, query: 'windows 95 retro' }), context, sources);
    const styled = page.results.filter(item => item.previewCapability.available && item.previewCapability.adapter === 'styled-components');
    expect(styled.map(item => item.ref.itemId).sort()).toEqual(TEMPLATES);
    for (const item of styled) {
      expect(item.previewCapability.url).toBe(react95PreviewPath(item.ref.itemId));
      expect(item.targetDependencies).toEqual(expect.arrayContaining([{ name: 'styled-components', range: `^${REACT95_TOOLCHAIN['styled-components']}`, scope: 'project' }]));
    }
  });

  it('inspect gives the same styled-components preview and dependency for each template', async () => {
    const page = await searchResources(parseResourceSearchRequest({ limit: 100, facets: { sourceIds: ['react95'] }, query: 'windows 95 retro' }), context, [react95]);
    for (const itemId of TEMPLATES) {
      const found = page.results.find(item => item.ref.itemId === itemId)!;
      const detail = await inspectResource(found.refKey, context, [react95]);
      expect(detail.resource.previewCapability).toMatchObject({ available: true, kind: 'html', adapter: 'styled-components', url: react95PreviewPath(itemId) });
      expect(detail.resource.targetDependencies?.map(dependency => dependency.name)).toContain('styled-components');
    }
  });

  it('the kit preview document carries the styled-components runtime whose sheet the readiness check reads', async () => {
    for (const itemId of TEMPLATES) {
      const html = (await materials.preview(itemId))!;
      expect(html).toContain(`data-styled-version="${REACT95_TOOLCHAIN['styled-components']}"`);
      expect(html).toMatch(/<style data-styled="true"[^>]*>\.[A-Za-z0-9_-]+\{/u);
    }
  });
});
