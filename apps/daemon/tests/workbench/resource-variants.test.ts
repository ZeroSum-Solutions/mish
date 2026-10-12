import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResourceDetailResponse, parseResourceSearchResponse } from '@mish/contracts';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { createGsapRecipeMaterials, createGsapResourceSource } from '../../src/workbench/recipes/gsap/index.js';
import { createLocalResourceSources } from '../../src/workbench/resources.js';

/**
 * AC-R07 preamble: "Variant changes preserve selection context and disclose actual target
 * dependencies." Inspect resolves the inspected resource's variant group from the same listing,
 * so every variant carries a current opaque key, its label, whether it previews, and the
 * dependencies it brings into the target project. The UI and `od workbench inspect` read the
 * same response.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done())))); });

async function harness() {
  const gsap = createGsapResourceSource(createGsapRecipeMaterials());
  const sections = createLocalResourceSources({ listPlugins: async () => [], sectionPreviews: { hyperuiRoot: path.join(repoRoot, 'plugins/_official/shared/ui-kits/hyperui'), cultKitDir: null } }).find(source => source.sourceId === 'sections')!;
  const app = express(); app.use(express.json());
  registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async () => true, sourcesForRequest: () => [gsap, sections] } as never);
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', () => done()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const od = async (args: string[]) => { let body: any; const code = await runWorkbenchCli(args, { baseUrl: url, write: value => { body = value; } }); return { code, body }; };
  const search = async (query: string, category: string) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'variants-query-')), 'query.txt');
    writeFileSync(file, query);
    const result = await od(['search', '--prompt-file', file, '--category', category, '--limit', '100', '--json']);
    return parseResourceSearchResponse(result.body).results;
  };
  return { url, od, search };
}

describe('variant groups in inspect (UI and od share the endpoint)', () => {
  it('discloses each GSAP target variant with its own target dependencies', async () => {
    const h = await harness();
    const listing = await h.od(['search', '--category', 'motion', '--limit', '50', '--json']);
    const html = parseResourceSearchResponse(listing.body).results.find(r => r.ref.itemId === 'section-entrance-html')!;
    expect(html.variantLabel).toBe('HTML');
    expect(html.targetDependencies).toEqual([{ name: 'gsap', range: '3.15.0', scope: 'bundled' }]);
    const inspected = await h.od(['inspect', '--ref', html.refKey, '--json']);
    expect(inspected.code).toBe(0);
    const detail = parseResourceDetailResponse(inspected.body);
    expect(detail.variants?.map(v => [v.label, v.current, v.previewAvailable])).toEqual([['HTML', true, true], ['React', false, false]]);
    const react = detail.variants!.find(v => v.label === 'React')!;
    expect(react.targetDependencies).toEqual([
      { name: 'react', range: '>=17', scope: 'project' }, { name: 'react-dom', range: '>=17', scope: 'project' },
      { name: 'gsap', range: '^3.15.0', scope: 'project' }, { name: '@gsap/react', range: '^2.1.2', scope: 'project' },
    ]);
    // The variant's key is current: inspecting it moves `current` and keeps the same group.
    const other = parseResourceDetailResponse((await h.od(['inspect', '--ref', react.refKey, '--json'])).body);
    expect(other.resource.ref.itemId).toBe('section-entrance-react');
    expect(other.variants?.map(v => [v.label, v.current])).toEqual([['HTML', false], ['React', true]]);
    const viaHttp = await fetch(`${h.url}/api/workbench/resources/${react.refKey}`);
    expect(parseResourceDetailResponse(await viaHttp.json())).toEqual(other);
  });

  it('groups HyperUI blocks of one kind as variants, each previewable with compiled utilities', async () => {
    const h = await harness();
    const block = (await h.search('Application Charts 1', 'section')).find(r => r.ref.itemId === 'hyperui:application/charts/1')!;
    expect(block).toMatchObject({ variantGroup: 'hyperui:application/charts', variantLabel: '1', targetDependencies: [{ name: 'tailwindcss', range: '4.3.3', scope: 'compiled' }] });
    const detail = parseResourceDetailResponse((await h.od(['inspect', '--ref', block.refKey, '--json'])).body);
    expect(detail.variants!.length).toBeGreaterThan(5);
    expect(detail.variants!.map(v => v.label)).toEqual([...detail.variants!.map(v => v.label)].sort((a, b) => Number(a) - Number(b)));
    expect(detail.variants!.filter(v => v.current).map(v => v.refKey)).toEqual([block.refKey]);
    expect(detail.variants!.every(v => v.previewAvailable)).toBe(true);
  });

  it('omits variants for a resource outside any group', async () => {
    const h = await harness();
    const family = (await h.search('App Shell', 'section')).find(r => r.ref.itemId.startsWith('family-section:'))!;
    expect(parseResourceDetailResponse((await h.od(['inspect', '--ref', family.refKey, '--json'])).body).variants).toBeUndefined();
  });
});
