import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseResourceSearchResponse, type ComponentFit } from '@mish/contracts';
import { approvedDesignSystemFixtures } from './approved-design-systems';

/** Real V05 approval and V06 target/admission assessment; never forge Apply permission. */
export async function approvedComponentFits(sourceId: 'gsap' | 'react95') {
  const fixtures = await approvedDesignSystemFixtures(['Component apply fixture']);
  let folder: string | undefined;
  const stop = async () => {
    try { await fixtures.stop(); }
    finally { if (folder) await rm(folder, { recursive: true, force: true }); }
  };
  try {
    const kit = fixtures.kits.get('Component apply fixture')!;
    folder = await mkdtemp(path.join(tmpdir(), 'od-web-component-target-'));
    const dependencies = { react: '18.3.1', 'react-dom': '18.3.1', gsap: '3.15.0', '@gsap/react': '2.1.2', 'styled-components': '5.3.11', '@types/styled-components': '5.1.36' };
    const files: Record<string, string> = {
      'index.html': '<!doctype html><h1>Fixture</h1>',
      'src/App.tsx': 'export default function App() { return <main>Fixture</main>; }',
      'tsconfig.json': '{}',
      'package.json': JSON.stringify({ dependencies }),
      ...Object.fromEntries(Object.entries(dependencies).map(([name, version]) => [`node_modules/${name}/package.json`, JSON.stringify({ name, version })])),
    };
    // Imported-folder fixtures preserve scoped package names; the file-upload API sanitizes @.
    // These manifests exercise installed-package observation, not package execution.
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(folder, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const imported = await fixtures.request('/api/import/folder', 'POST', { baseDir: folder, name: 'Component apply fixture', skillId: null, designSystemId: kit.id }) as { project: { id: string } };
    const projectId = imported.project.id;
    const ranked = parseResourceSearchResponse(await fixtures.request('/api/workbench/components/rank', 'POST', {
      projectId, facets: { sourceIds: [sourceId] }, componentPicker: { kitId: kit.id, kitSourceId: 'design-systems', showAll: true }, limit: 100,
    }));
    const fits = new Map<string, ComponentFit>();
    for (const resource of ranked.results) {
      if (resource.componentFit) fits.set(resource.ref.itemId, resource.componentFit);
    }
    return { fits, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
