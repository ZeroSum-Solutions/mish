import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseResourceSearchRequest } from '@mish/contracts';
import { inspectResource, previewResource, searchResources } from '../../src/workbench/resources.js';
import { paletteContrastEvidence } from '../../src/workbench/token-evidence.js';
import { createProjectTokensSource } from '../../src/workbench/resources-tokens.js';
import { CONTRAST_EVIDENCE_STYLE_TAG, eligibleTokenKind } from '../../src/workbench/context-ranking.js';

const authority = { principalId: 'local-daemon', projectId: 'p' };
function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'od-b52-project-'));
  for (const [relative, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), body);
  }
  return root;
}
const tokensCss = ':root {\n  --color-bg: #ffffff;\n  --color-text: #1a1a1a;\n  --color-brand: hsl(186 45% 30%);\n  --text-base: 1rem;\n  --text-lg: 1.25rem;\n}\n';
const search = (root: string, input: Record<string, unknown> = {}, limits = {}) => searchResources(
  parseResourceSearchRequest({ projectId: 'p', useProjectContext: false, facets: { sourceIds: ['project-tokens'] }, limit: 100, ...input }),
  authority, [createProjectTokensSource({ projectRoot: id => id === 'p' ? root : null, limits })],
);

describe('AC-R04.1/R04.2 project tokens', () => {
  it('AC-R04.2: lists colour, type and spacing tokens the project stylesheets declare, with a digest and file grounding', async () => {
    const root = project({ 'tokens.css': tokensCss, 'styles/app.css': '.a { --space-2: 8px; --space-4: 16px; color: red; }' });
    const response = await search(root);
    expect(response.sourceStatuses.find(status => status.sourceId === 'project-tokens')).toMatchObject({ state: 'searched', reason: null, itemCount: 3 });
    const byCategory = Object.fromEntries(response.results.map(item => [item.category, item]));
    expect(Object.keys(byCategory).sort()).toEqual(['color-palette', 'spacing-scale', 'type-scale']);
    expect(byCategory['color-palette']!.fitReasons[0]).toMatch(/3 colour palette token\(s\) declared .*tokens\.css/);
    expect(byCategory['spacing-scale']!.fitReasons[0]).toMatch(/styles\/app\.css/);
    for (const item of response.results) expect(item).toMatchObject({ readiness: 'unverified', rightsStatus: 'permitted', adoptionCapability: { available: false }, implementationOrigin: 'project-owned' });
  });

  it('AC-R05.2: a palette whose text/surface pairs pass 4.5:1 carries contrast evidence; a failing pair does not', async () => {
    const passing = await search(project({ 'tokens.css': tokensCss }), { facets: { sourceIds: ['project-tokens'], category: 'color-palette' } });
    expect(passing.results[0]!.styleTags).toContain(CONTRAST_EVIDENCE_STYLE_TAG);
    expect(eligibleTokenKind(passing.results[0]!)).toBe('color');
    expect(passing.results[0]!.fitReasons).toContain('--color-text on --color-bg: 17.4:1 (minimum 4.5:1) passed');
    const failing = await search(project({ 'tokens.css': ':root { --color-bg: #ffffff; --color-text: #aaaaaa; }' }), { facets: { sourceIds: ['project-tokens'], category: 'color-palette' } });
    expect(failing.results[0]!.styleTags).not.toContain(CONTRAST_EVIDENCE_STYLE_TAG);
    expect(eligibleTokenKind(failing.results[0]!)).toBeNull();
    expect(failing.results[0]!.fitReasons.join('\n')).toMatch(/below 4.5:1/);
    const unpaired = await search(project({ 'tokens.css': ':root { --color-brand: #0055aa; --color-accent: rgb(10 20 30 / 50%); }' }), { facets: { sourceIds: ['project-tokens'], category: 'color-palette' } });
    expect(eligibleTokenKind(unpaired.results[0]!)).toBeNull();
    expect(unpaired.results[0]!.fitReasons.join('\n')).toMatch(/contrast is unverified/);
  });

  it('AC-R04.1 security: never follows a symlink out of the project, nor dot, dependency or build directories', async () => {
    const outside = project({ 'secret.css': ':root { --color-secret-bg: #000000; }' });
    const root = project({ 'tokens.css': tokensCss, '.hidden/x.css': ':root { --space-hidden: 4px; }', 'node_modules/pkg/x.css': ':root { --space-dep: 4px; }', 'dist/x.css': ':root { --space-dist: 4px; }' });
    symlinkSync(path.join(outside, 'secret.css'), path.join(root, 'linked.css'));
    symlinkSync(outside, path.join(root, 'linked-dir'));
    const response = await search(root);
    const names = JSON.stringify(response.results);
    for (const leaked of ['secret', 'hidden', 'space-dep', 'space-dist']) expect(names).not.toContain(leaked);
  });

  it('AC-R04.1 budgets: oversized files and file counts degrade the listing with a named reason instead of reading unbounded bytes', async () => {
    const root = project({ 'tokens.css': tokensCss, 'big.css': `:root { --space-big: 4px; }${' '.repeat(2048)}`, 'a.css': ':root{--space-a:4px}', 'b.css': ':root{--space-b:4px}' });
    const response = await search(root, {}, { fileBytes: 1024, files: 2 });
    const status = response.sourceStatuses.find(entry => entry.sourceId === 'project-tokens')!;
    expect(status.state).toBe('degraded');
    expect(status.reason).toContain('file-limit-exceeded');
    expect(JSON.stringify(response.results)).not.toContain('space-big');
    const bytes = await search(project({ 'big.css': `:root { --space-big: 4px; }${' '.repeat(2048)}` }), {}, { fileBytes: 1024 });
    expect(bytes.sourceStatuses.find(entry => entry.sourceId === 'project-tokens')).toMatchObject({ state: 'degraded', reason: 'file-byte-limit-exceeded', itemCount: 0 });
  });

  it('AC-R04.1 frozen evidence and scope: an edited stylesheet makes old refs stale; other projects never resolve them', async () => {
    const root = project({ 'tokens.css': tokensCss });
    const sources = [createProjectTokensSource({ projectRoot: id => id === 'p' ? root : id === 'q' ? root : null })];
    const first = (await searchResources(parseResourceSearchRequest({ projectId: 'p', useProjectContext: false, facets: { sourceIds: ['project-tokens'] } }), authority, sources)).results[0]!;
    expect((await inspectResource(first.refKey, authority, sources)).resource.refKey).toBe(first.refKey);
    writeFileSync(path.join(root, 'tokens.css'), tokensCss.replace('#1a1a1a', '#202020'));
    await expect(inspectResource(first.refKey, authority, sources)).rejects.toMatchObject({ status: 409, code: 'resource-ref-stale' });
    await expect(inspectResource(first.refKey, { principalId: 'local-daemon', projectId: 'q' }, sources)).rejects.toMatchObject({ status: 404 });
    const projectless = await searchResources(parseResourceSearchRequest({ facets: { sourceIds: ['project-tokens'] } }), { principalId: 'local-daemon' }, sources);
    expect(projectless.sourceStatuses.find(entry => entry.sourceId === 'project-tokens')).toMatchObject({ state: 'searched', reason: 'project-scope-required', itemCount: 0 });
  });

  it('AC-R05.2 B1: every text/surface pair is checked; a failing 17th pair (5 text x 4 surface) is not passed and not eligible', async () => {
    const text = ['--color-text', '--color-heading', '--color-body', '--color-ink', '--color-copy'];
    const surfaces = ['--color-bg', '--color-surface', '--color-canvas', '--color-paper'];
    // Pair order is text-major: index 16 is the fifth text token on the first surface.
    const css = `:root { ${text.map((name, index) => `${name}: ${index === 4 ? '#cccccc' : '#111111'};`).join(' ')} ${surfaces.map(name => `${name}: #ffffff;`).join(' ')} }`;
    const response = await search(project({ 'tokens.css': css }), { facets: { sourceIds: ['project-tokens'], category: 'color-palette' } });
    const palette = response.results[0]!;
    expect(palette.styleTags).not.toContain(CONTRAST_EVIDENCE_STYLE_TAG);
    expect(eligibleTokenKind(palette)).toBeNull();
    // The fifth text token fails on every surface: pairs 17-20, all past the old 16-pair stop.
    expect(palette.fitReasons.join('\n')).toMatch(/4 text\/surface pair\(s\) below 4.5:1/);
    expect(palette.fitReasons).toContain('--color-copy on --color-bg: 1.6:1 (minimum 4.5:1) failed');
  });

  it('AC-R05.2 B1: a palette whose pairs exceed the hard evaluation cap is unverified, never passed on a subset', () => {
    const tokens = Array.from({ length: 20 }, (_, index) => [{ name: `--color-text-${index}`, value: '#111111' }, { name: `--color-bg-${index}`, value: '#ffffff' }]).flat();
    const evidence = paletteContrastEvidence(tokens, new Map(tokens.map(token => [token.name, token.value])));
    expect(evidence.passed).toBe(false);
    expect(evidence.reason).toMatch(/contrast unverified: 400 pairs exceed the 256-pair budget/);
  });

  it('AC-R04.1: a project whose folder is missing (an unplugged imported folder) is degraded, not searched', async () => {
    const response = await search(path.join(tmpdir(), `od-b52-missing-${Date.now()}`));
    expect(response.sourceStatuses.find(entry => entry.sourceId === 'project-tokens')).toMatchObject({ state: 'degraded', reason: 'project-files-unavailable', itemCount: 0 });
  });

  it('AC-R07.3: a preview builds the source listing once and serves the specimen of exactly that listing', async () => {
    const root = project({ 'tokens.css': tokensCss });
    let listings = 0;
    const sources = [createProjectTokensSource({ projectRoot: id => { listings++; return id === 'p' ? root : null; } })];
    const item = (await searchResources(parseResourceSearchRequest({ projectId: 'p', useProjectContext: false, facets: { sourceIds: ['project-tokens'], category: 'color-palette' } }), authority, sources)).results[0]!;
    listings = 0;
    const preview = await previewResource(item.refKey, authority, sources);
    expect(listings).toBe(1);
    expect(preview.specimen.tokens.map(token => token.name)).toEqual(['--color-bg', '--color-text', '--color-brand']);
    expect(preview.html).toContain('--color-text');
  });
});
