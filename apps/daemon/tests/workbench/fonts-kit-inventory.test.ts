import express from 'express';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FONT_KIT_REASONS, fontKitInventorySchema, parseResourceSearchRequest, type FontKitDeclaration, type FontKitInventory, type ResourceSearchResponse } from '@mish/contracts';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { searchResources } from '../../src/workbench/resources.js';
import { createFontsResourceSource } from '../../src/workbench/resources-fonts.js';
import { bundledFontCatalogue } from '../../src/fonts/catalogue.js';
import { REPO_BUNDLED_PLUGINS_ROOT, authority } from './fonts-fixture.js';

const search = (query = '', extra: Record<string, unknown> = {}) => parseResourceSearchRequest({ query, facets: { category: 'font', sourceIds: ['fonts'] }, limit: 20, ...extra });
const archivoFile = bundledFontCatalogue().families.find(family => family.id === 'archivo')!.localFiles[0]!;
const frauncesShas = bundledFontCatalogue().families.find(family => family.id === 'fraunces')!.localFiles.map(file => file.sha256);

function write(root: string, relative: string, content: string | Buffer): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
/** A bundled-plugins root holding the kit shapes AC-R11's preamble names: self-hosted, Google CSS, Fontshare CSS, tokens and system stacks. */
function kitRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'od-b6-kits-'));
  mkdirSync(path.join(root, 'examples/kit-a/fonts'), { recursive: true });
  copyFileSync(path.join(REPO_BUNDLED_PLUGINS_ROOT, archivoFile.path), path.join(root, 'examples/kit-a/fonts/brand.woff2'));
  write(root, 'examples/kit-a/style.css', "@font-face { font-family: 'Brand Sans'; src: url(\"./fonts/brand.woff2\") format('woff2'); }\nbody { font-family: 'Brand Sans', system-ui, sans-serif; }\n.x { font-family: var(--font-body); }\n");
  write(root, 'examples/kit-b/index.html', '<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;900&amp;family=Roboto+Flex:wght@400&display=swap" rel="stylesheet">\n<style>h1{font-family:"Fraunces",Georgia,serif} p{font: 400 16px/1.5 \'Roboto Flex\', Arial, sans-serif}</style>\n');
  write(root, 'examples/kit-c/tokens.json', JSON.stringify({ typography: { fontFamily: 'Mystery Grotesk' } }));
  write(root, 'examples/kit-c/app.tsx', "const css = `font-family:${family}`;\nexport const s = { fontFamily: 'Satoshi, sans-serif' };\nexport const link = 'https://api.fontshare.com/v2/css?f[]=satoshi@400,700&display=swap';\n");
  write(root, 'examples/kit-c/theme.css', ':root { --font-ui: "Ubuntu", sans-serif; --font-size-body: 16px; }\n');
  write(root, 'examples/kit-d/style.css', "@font-face{font-family:'Own Face';src:url(own.woff2) format('woff2')}\n@font-face{font-family:'Escape Face';src:url('../../../../../../etc/hosts')}\n@font-face{font-family:'Remote Face';src:url('https://cdn.example.com/remote.woff2')}\n@font-face{font-family:'Brand Fallback';src:local('Arial');size-adjust:104%}\nh1{font-family:'Own Face','Escape Face','Remote Face',serif}\n");
  write(root, 'examples/kit-d/own.woff2', Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64, 7)]));
  // A kit that names another kit's alias without loading it.
  write(root, 'examples/kit-e/tokens.css', ":root { --font-body: 'Brand Sans', sans-serif; }\n");
  return root;
}
const find = (inventory: FontKitInventory, family: string, kit?: string): FontKitDeclaration => {
  const entry = inventory.declarations.find(declaration => declaration.family === family && (!kit || declaration.kit === kit));
  if (!entry) throw new Error(`no declaration for ${family}`);
  return entry;
};

describe('AC-R11 preamble: every kit/example-declared font family is inventoried and mapped or flagged', () => {
  it('maps self-hosted admitted bytes and admitted families, and flags the rest with a named reason', async () => {
    const root = kitRoot();
    const source = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, kitRoots: [{ id: 'bundled-plugins', path: root }] });
    const inventory = fontKitInventorySchema.parse((await searchResources(search(), authority, [source])).fontKits);
    expect(inventory.scanned).toMatchObject({ roots: ['bundled-plugins'], kits: 5, truncated: false });

    // An alias whose self-hosted bytes are admitted Archivo bytes maps by digest.
    // Another kit naming that alias maps to the same admitted bytes, never to a different font.
    expect(find(inventory, 'Brand Sans', 'examples/kit-e')).toMatchObject({ loading: ['none'], state: 'mapped', catalogueItemId: 'archivo', admittedFiles: [archivoFile.sha256], kitBytesAdmitted: null, message: expect.stringContaining('examples/kit-a alias') });
    expect(find(inventory, 'Brand Sans', 'examples/kit-a')).toMatchObject({ root: 'bundled-plugins', kit: 'examples/kit-a', files: ['examples/kit-a/style.css'], loading: ['local-font-face'], state: 'mapped', reason: null, catalogueItemId: 'archivo', admittedFiles: [archivoFile.sha256], kitBytesAdmitted: true });
    // A Google-CSS family with admitted local files maps to them; the kit still loads it remotely today.
    const fraunces = find(inventory, 'Fraunces');
    expect(fraunces).toMatchObject({ kit: 'examples/kit-b', loading: ['google-fonts-css'], state: 'mapped', catalogueItemId: 'fraunces', kitBytesAdmitted: null });
    expect([...fraunces.admittedFiles].sort()).toEqual([...frauncesShas].sort());
    expect(find(inventory, 'Roboto Flex')).toMatchObject({ loading: ['google-fonts-css'], state: 'undeclared', reason: 'no-admitted-local-file', catalogueItemId: 'roboto-flex', admittedFiles: [] });
    for (const system of ['Georgia', 'Arial']) expect(find(inventory, system)).toMatchObject({ state: 'undeclared', reason: 'system-font', catalogueItemId: null });
    expect(find(inventory, 'Mystery Grotesk')).toMatchObject({ files: ['examples/kit-c/tokens.json'], state: 'undeclared', reason: 'not-in-catalogue', catalogueItemId: null });
    expect(find(inventory, 'Satoshi')).toMatchObject({ state: 'undeclared', reason: 'rights-restricted', catalogueItemId: 'fontshare-satoshi' });
    expect(find(inventory, 'Satoshi').loading).toContain('fontshare-css');
    expect(find(inventory, 'Ubuntu')).toMatchObject({ state: 'undeclared', reason: 'licence-unknown', catalogueItemId: 'ubuntu' });
    expect(find(inventory, 'Own Face')).toMatchObject({ loading: ['local-font-face'], state: 'undeclared', reason: 'kit-bytes-not-admitted', kitBytesAdmitted: false });
    expect(find(inventory, 'Remote Face')).toMatchObject({ loading: ['other-remote'], remoteHosts: ['cdn.example.com'], state: 'undeclared', reason: 'not-in-catalogue' });
    expect(find(inventory, 'Escape Face')).toMatchObject({ state: 'undeclared', kitBytesAdmitted: null });
    expect(find(inventory, 'Brand Fallback')).toMatchObject({ state: 'undeclared', reason: 'system-font', message: expect.stringMatching(/local\(\)/) });
    expect(JSON.stringify(inventory)).not.toContain('etc/hosts');

    // Generic keywords, variables and template placeholders are not font families.
    const families = inventory.declarations.map(entry => entry.family);
    for (const generic of ['serif', 'sans-serif', 'system-ui']) expect(families).not.toContain(generic);
    expect(families.some(family => /var\(|\$|\{/.test(family))).toBe(false);
    expect(inventory.counts.mapped + inventory.counts.undeclared).toBe(inventory.declarations.length);
    expect(Object.keys(inventory.counts.byReason).sort()).toEqual([...FONT_KIT_REASONS].sort());
  });

  it('never substitutes a font: an unmapped family maps to nothing, a mapped one to its own identity, its own bytes or its own alias', async () => {
    const source = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, kitRoots: [{ id: 'bundled-plugins', path: kitRoot() }] });
    const inventory = (await searchResources(search(), authority, [source])).fontKits!;
    const titles = new Map((await source.list(authority)).items.map(item => [item.ref.itemId, item.title.toLowerCase()]));
    const selfHosted = new Set(inventory.declarations.filter(entry => entry.kitBytesAdmitted === true).map(entry => `${entry.family.toLowerCase()}\0${entry.catalogueItemId}`));
    for (const entry of inventory.declarations) {
      if (entry.state === 'undeclared') expect(entry.admittedFiles, entry.family).toEqual([]);
      else expect(entry.kitBytesAdmitted === true || titles.get(entry.catalogueItemId!) === entry.family.toLowerCase() || selfHosted.has(`${entry.family.toLowerCase()}\0${entry.catalogueItemId}`), entry.family).toBe(true);
    }
  });

  it('inventories the real bundled kits and examples, mapping the Watson aliases to admitted Kumbh Sans bytes', async () => {
    const source = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, kitRoots: [{ id: 'bundled-plugins', path: REPO_BUNDLED_PLUGINS_ROOT }] });
    const inventory = fontKitInventorySchema.parse((await searchResources(search(), authority, [source])).fontKits);
    expect(inventory.scanned.kits).toBeGreaterThan(30);
    expect(find(inventory, 'WatsonBody', 'examples/agency-watson')).toMatchObject({ state: 'mapped', catalogueItemId: 'kumbh-sans', kitBytesAdmitted: true });
    // The owned acreage-farming rewrite self-hosts Archivo bytes identical (by digest) to the
    // already-admitted agency-halcyon copy, so it maps without any catalogue change.
    expect(find(inventory, 'Archivo', 'examples/acreage-farming')).toMatchObject({ loading: ['local-font-face'], state: 'mapped', catalogueItemId: 'archivo', kitBytesAdmitted: true });
    expect(find(inventory, 'Inter', 'examples/stellar-launch')).toMatchObject({ loading: ['google-fonts-css'], state: 'undeclared', reason: 'no-admitted-local-file' });
    expect(inventory.counts.mapped).toBeGreaterThan(0);
    expect(inventory.counts.undeclared).toBeGreaterThan(0);
  });

  it('attaches each family’s kit declarations to its font profile', async () => {
    const source = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, kitRoots: [{ id: 'bundled-plugins', path: kitRoot() }] });
    const results = (await searchResources(search('Archivo'), authority, [source])).results;
    const archivo = results.find(item => item.ref.itemId === 'archivo')!;
    expect(archivo.fontProfile!.kitDeclarations).toEqual([expect.objectContaining({ kit: 'examples/kit-a', family: 'Brand Sans', state: 'mapped' }), expect.objectContaining({ kit: 'examples/kit-e', family: 'Brand Sans', state: 'mapped' })]);
  });

  it('reports the inventory only on the first page of a font-category search', async () => {
    const source = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, kitRoots: [{ id: 'bundled-plugins', path: kitRoot() }] });
    const first = await searchResources(search('', { limit: 1 }), authority, [source]);
    expect(first.fontKits).toBeDefined();
    expect((await searchResources(search('', { limit: 1, cursor: first.nextCursor! }), authority, [source])).fontKits).toBeUndefined();
    expect((await searchResources(parseResourceSearchRequest({ query: '', facets: { category: 'component' } }), authority, [source])).fontKits).toBeUndefined();
    // An unscoped search (the canvas default) stays small: no inventory.
    expect((await searchResources(parseResourceSearchRequest({ query: '' }), authority, [source])).fontKits).toBeUndefined();
    // Without kit roots there is nothing to report.
    expect((await searchResources(search(), authority, [createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT })])).fontKits).toBeUndefined();
  });
});

describe('AC-R11 preamble: kit inventory HTTP and od parity', () => {
  let server: Server | undefined;
  afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });

  it('od workbench search --category font returns the same kit inventory as HTTP', async () => {
    const fonts = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, kitRoots: [{ id: 'bundled-plugins', path: kitRoot() }] });
    const app = express(); app.use(express.json());
    registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async () => true, sourcesForRequest: () => [fonts] });
    server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['search', '--category', 'font', '--json'], { baseUrl, write: value => output.push(value) })).toBe(0);
    const cli = (output[0] as ResourceSearchResponse).fontKits!;
    expect(find(cli, 'Satoshi')).toMatchObject({ reason: 'rights-restricted' });
    const http = await fetch(`${baseUrl}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ facets: { category: 'font' } }) });
    expect(((await http.json()) as ResourceSearchResponse).fontKits).toEqual(cli);
  });
});
