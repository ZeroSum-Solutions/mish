import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRecipe } from '../../../design-templates/agency-site/scripts/schema.ts';
import { renderAgencySite } from '../../../design-templates/agency-site/scripts/render.ts';
import { compose } from '../../../design-templates/agency-site/scripts/compose.ts';

const template = fileURLToPath(new URL('../../../design-templates/agency-site/', import.meta.url));
const fixture = async (name = 'jewelry') => JSON.parse(await readFile(path.join(template, 'scripts/fixtures', `${name}.json`), 'utf8'));

describe('agency compiler', () => {
  it.each(['jewelry', 'service'])('[P1] renders %s deterministically with scoped assets and stable targets', async (name) => {
    const recipe = await fixture(name);
    const first = renderAgencySite(recipe, 'site-r1.html');
    expect(renderAgencySite(recipe, 'site-r1.html')).toEqual(first);
    expect(first.manifest.metadata.agencySite.recipeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.manifest.supportingFiles).toEqual([`assets/agency-site/r1/${recipe.sections[0].image.file}`]);
    const ids = [...first.html.matchAll(/data-od-id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    recipe.sections[0].title = 'A revised headline';
    expect([...renderAgencySite(recipe, 'site-r2.html').html.matchAll(/data-od-id="([^"]+)"/g)].map((m) => m[1])).toEqual(ids);
    expect(first.html).not.toMatch(/<script|<iframe|onerror=/);
    expect(first.html).toContain('prefers-reduced-motion');
    expect(first.html).toContain('mailto:');
  });

  it.each([
    ['unknown field', (r: any) => { r.script = 'alert(1)'; }],
    ['bad version', (r: any) => { r.version = 2; }],
    ['invalid color', (r: any) => { r.brand.ink = 'red;display:none'; }],
    ['low contrast', (r: any) => { r.brand.ink = r.brand.background; }],
    ['font injection', (r: any) => { r.brand.display = '</style>'; }],
    ['executable URL', (r: any) => { r.sections[0].action.href = 'javascript:alert(1)'; }],
    ['protocol-relative URL', (r: any) => { r.sections[0].action.href = '//example.com'; }],
    ['ambiguous HTTPS URL', (r: any) => { r.sections[3].action.href = 'https:example.com/contact'; }],
    ['URL credentials', (r: any) => { r.sections[0].action.href = 'https://name:pass@example.com'; }],
    ['bad asset', (r: any) => { r.sections[0].image.file = '../brief.md'; }],
    ['SVG asset', (r: any) => { r.sections[0].image.file = 'hero.svg'; }],
    ['empty alt', (r: any) => { r.sections[0].image.alt = ''; }],
    ['wrong section prop', (r: any) => { r.sections[1].action = r.sections[0].action; }],
    ['duplicate IDs', (r: any) => { r.sections[1].id = r.sections[0].id; }],
    ['reserved ID', (r: any) => { r.sections[1].id = 'site-name'; }],
    ['missing proof', (r: any) => { r.sections[2] = { ...r.sections[1], id: 'more-items' }; }],
    ['inert contact', (r: any) => { r.sections[3].action.href = '#contact'; }],
    ['null section', (r: any) => { r.sections[1] = null; }],
  ])('[P1] rejects %s before rendering', async (_name, mutate) => {
    const recipe = await fixture(); mutate(recipe);
    expect(() => parseRecipe(recipe)).toThrow();
  });

  it('[P1] renders markup-like copy as text', async () => {
    const recipe = await fixture(); recipe.sections[0].title = '<script>alert("test")</script>';
    const { html } = renderAgencySite(recipe, 'site-r1.html');
    expect(html).toContain('&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('[P1] refuses existing output and keeps edited r1 intact while producing r2', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agency-compiler-'));
    try {
      const input = path.join(template, 'scripts/fixtures/service.json');
      const assets = path.join(template, 'assets');
      const first = await compose(input, assets, path.join(dir, 'r1'), 'site-r1.html');
      await writeFile(first.entry, '<h1>My canvas edit</h1>');
      const manifestBefore = await readFile(first.manifest, 'utf8');
      await expect(compose(input, assets, path.join(dir, 'r1'), 'site-r1.html')).rejects.toThrow();
      const recipe = await fixture('service'); recipe.revision = 'r2';
      await writeFile(path.join(dir, 'r2.json'), JSON.stringify(recipe));
      const second = await compose(path.join(dir, 'r2.json'), assets, path.join(dir, 'r2'), 'site-r2.html');
      expect(await readFile(first.entry, 'utf8')).toBe('<h1>My canvas edit</h1>');
      expect(await readFile(first.manifest, 'utf8')).toBe(manifestBefore);
      expect(await readFile(second.entry, 'utf8')).toContain('assets/agency-site/r2/service-garden-hero.png');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
