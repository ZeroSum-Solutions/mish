/**
 * Effect placement tests for the shared compiler's `scripts/effects.ts` and `renderFamily`.
 * Run: node --experimental-strip-types --test plugins/_official/shared/agency-compiler/tests/effects.test.ts
 *
 * The shared folder is not runnable on its own (`family.ts` needs a copy's generated registry), so
 * each test drives a synced family package copy: its own `effects.ts`, `catalog/` assets and
 * reference fixture. The direct family render tests stay untouched and keep pinning the no-effect
 * page (`script-src 'none'`, no `data-genui-script`).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '../../../../..');
const copyDir = (family: string) => path.join(repoRoot, `plugins/_official/examples/agency-${family}/compiler/scripts`);
const importFrom = (file: string) => import(pathToFileURL(file).href);
const { findRealTagOffset, HTML_TAG_PATTERNS } = await importFrom(path.join(repoRoot, 'packages/contracts/src/runtime/html-injection-points.ts'));

// `practice` and `guide` are deliberately NOT in this list, the same as `emmpo`'s own maxEffects
// exception below implies: both declare a single hero-title placement with `maxEffects: 1` (one
// reviewed effect, not the two-placement/maxEffects-2 shape this generic test hardcodes), so each
// has its own family-specific effects assertions elsewhere (see `render.test.ts`) rather than
// being forced into this shared test's fixed expectation.
const SITE_FAMILIES = ['watson', 'fervor', 'wrenfield', 'maben', 'halcyon', 'maren', 'emmpo', 'marketing-site', 'listings', 'publication', 'nonprofit', 'restaurant', 'community', 'docs-hub', 'storefront'];
const INLINE_FAMILIES = new Set(['watson', 'fervor', 'wrenfield', 'maben', 'halcyon', 'maren', 'emmpo']);
/** Components that need their own child markup: never allowed on an automatic placement. */
const STRUCTURAL = ['accordion-gallery', 'scroll-locked-video-hero', 'scroll-choreography', 'handwriting-svg', 'ai-chat-input', 'chroma-grid', 'card-swap', 'stack', 'decay-card', 'ripple-distortion'];

type Plan = { effects: Array<{ placement: string; componentId: string; source: 'hint' | 'jev' }> };
type Report = { applied: Array<{ placement: string; componentId: string; kind: string; source: string }>; skipped: Array<{ placement: string; componentId?: string; reason: string }>; bytesAdded: number };
type Declaration = { scriptPolicy: 'none' | 'hash' | 'inline'; maxEffects: number; placements: Record<string, { host: { id: string } | { odId: string }; allow: string[] }> };
type Effects = {
  applyEffectPlan: (html: string, plan: Plan, declaration: Declaration | null) => { html: string; report: Report };
  readFamilyEffectDeclaration: (family: string) => Declaration | null;
  componentKind: (id: string) => 'css-only' | 'js';
  scriptHashSource: (text: string) => string;
  PAGE_BYTE_LIMIT: number;
  parseFamilyEffectDeclaration: (value: unknown, catalogComponents: readonly string[], label: string) => Declaration;
};

const effectsOf = async (family: string): Promise<Effects> => importFrom(path.join(copyDir(family), 'effects.ts'));

/** The family's reference fixture, rendered by its own module with stand-in asset paths. */
async function referencePage(family: string): Promise<string> {
  const { FAMILIES } = await importFrom(path.join(copyDir(family), 'families/registry.ts'));
  const module = FAMILIES[family];
  const recipe = module.validate(JSON.parse(readFileSync(path.join(copyDir(family), `families/${family}/reference.fixture.json`), 'utf8')));
  const paths = Object.fromEntries(module.requirements(recipe).map((item: { id: string; kind: string }) => [item.id, `assets/test/${item.id}.${item.kind === 'font' ? 'woff2' : item.kind === 'video' ? 'mp4' : 'png'}`]));
  return module.render(recipe, paths, { outputScope: module.outputScope });
}

const plan = (...items: Array<[string, string]>): Plan => ({ effects: items.map(([placement, componentId]) => ({ placement, componentId, source: 'hint' as const })) });
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** Visible text: every tag, style and script body removed. */
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, '');
const cspOf = (html: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
const scriptText = (html: string, id: string) => new RegExp(`<script type="module" data-genui-script="${id}">([\\s\\S]*?)</script>`).exec(html)?.[1];
const openTagWith = (html: string, attribute: string) => html.match(new RegExp(`<[a-z0-9]+ [^>]*${attribute}[^>]*>`, 'g')) ?? [];

test('every site family declares reviewed placements whose hosts render once and accept each allowed id', async () => {
  for (const family of SITE_FAMILIES) {
    const effects = await effectsOf(family);
    const declaration = effects.readFamilyEffectDeclaration(family);
    assert.ok(declaration, `${family} declares effects`);
    assert.equal(declaration.scriptPolicy, INLINE_FAMILIES.has(family) ? 'inline' : 'hash', family);
    assert.equal(declaration.maxEffects, family === 'emmpo' ? 1 : 2, family);
    const html = await referencePage(family);
    for (const [placement, entry] of Object.entries(declaration.placements)) {
      for (const id of entry.allow) {
        assert.ok(!STRUCTURAL.includes(id), `${family} ${placement} allows structural ${id}`);
        const { report } = effects.applyEffectPlan(html, plan([placement, id]), declaration);
        assert.deepEqual(report.skipped, [], `${family} ${placement} ${id}`);
        assert.equal(report.applied.length, 1, `${family} ${placement} ${id}`);
      }
    }
  }
  for (const family of ['app-shell', 'crm-dashboard']) assert.equal((await effectsOf(family)).readFamilyEffectDeclaration(family), null, family);
});

test('marketing-site: renderFamily decorates the host, inlines each asset once and allows the script by hash', async () => {
  const { renderAgencySite } = await importFrom(path.join(copyDir('marketing-site'), 'render.ts'));
  const fixture = JSON.parse(readFileSync(path.join(copyDir('marketing-site'), 'families/marketing-site/reference.fixture.json'), 'utf8'));
  const base = renderAgencySite(fixture, 'site.html', { version: 1, assets: [] });
  assert.equal(base.effects, undefined, 'no plan, no report');
  const result = renderAgencySite(fixture, 'site.html', { version: 1, assets: [] }, { effects: plan(['hero-title', 'split-text'], ['cta', 'glare-hover']) });
  const html: string = result.html;
  assert.deepEqual(result.effects.skipped, []);
  assert.deepEqual(result.effects.applied.map((item: { componentId: string; kind: string }) => [item.componentId, item.kind]), [['split-text', 'js'], ['glare-hover', 'css-only']]);
  assert.equal(result.effects.bytesAdded, Buffer.byteLength(html) - Buffer.byteLength(base.html));
  const hosts = openTagWith(html, 'data-od-id="marketing-site-hero--heading"');
  assert.equal(hosts.length, 1);
  assert.match(hosts[0]!, /class="mt-2 text-2xl font-semibold text-gray-900 sm:text-3xl genui-split-text"/, 'class merged, not replaced');
  assert.match(hosts[0]!, /data-genui="split-text"/);
  assert.match(openTagWith(html, 'id="marketing-site-cta"')[0]!, /class="overflow-hidden bg-gray-50 sm:grid genui-glare-hover"/);
  for (const id of ['split-text', 'glare-hover']) assert.equal(count(html, `<style data-genui-style="${id}">`), 1, id);
  assert.equal(count(html, 'data-genui-script='), 1, 'only the js component ships a script');
  const script = scriptText(html, 'split-text');
  assert.ok(script, 'split-text auto.js inlined');
  const hash = `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;
  assert.ok(cspOf(html).includes(`script-src ${hash}`), 'script-src carries the hash of the exact inlined bytes');
  assert.ok(!cspOf(html).includes("script-src 'none'"));
  assert.equal(cspOf(html).replace(`script-src ${hash}`, "script-src 'none'"), cspOf(base.html), 'no other directive changes');
  // Inserted at the real </head> and </body>, as the shared contracts locator finds them.
  assert.ok(html.slice(0, findRealTagOffset(html, HTML_TAG_PATTERNS.headClose)).endsWith('</style>'));
  assert.ok(html.slice(0, findRealTagOffset(html, HTML_TAG_PATTERNS.bodyClose)).endsWith(`${script}</script>`));
  assert.equal(text(html), text(base.html), 'text content unchanged');
  assert.ok(Buffer.byteLength(html) < 200 * 1024);
});

test('marketing-site: css-only effects leave script-src none untouched', async () => {
  const effects = await effectsOf('marketing-site');
  const html = await referencePage('marketing-site');
  const { html: out, report } = effects.applyEffectPlan(html, plan(['cta', 'glare-hover']), effects.readFamilyEffectDeclaration('marketing-site'));
  assert.equal(report.applied.length, 1);
  assert.ok(cspOf(out).includes("script-src 'none'"));
  assert.equal(count(out, 'data-genui-script='), 0);
});

test('every inlined stylesheet carries a reduced-motion block', async () => {
  for (const family of SITE_FAMILIES) {
    const effects = await effectsOf(family);
    const declaration = effects.readFamilyEffectDeclaration(family)!;
    const html = await referencePage(family);
    for (const [placement, entry] of Object.entries(declaration.placements)) {
      for (const id of entry.allow) {
        const { html: out } = effects.applyEffectPlan(html, plan([placement, id]), declaration);
        const css = new RegExp(`<style data-genui-style="${id}">([\\s\\S]*?)</style>`).exec(out)?.[1] ?? '';
        assert.match(css, /prefers-reduced-motion:\s*reduce/, `${family} ${id}`);
      }
    }
  }
});

test('watson: a component the family already inlines is reused, not inlined twice, under its own CSP', async () => {
  const effects = await effectsOf('watson');
  const html = await referencePage('watson');
  assert.equal(count(html, '<style data-genui-style="scroll-reveal">'), 1, 'the family already ships scroll-reveal');
  const { html: out, report } = effects.applyEffectPlan(html, plan(['section-reveal', 'scroll-reveal']), effects.readFamilyEffectDeclaration('watson'));
  assert.deepEqual(report.applied, [{ placement: 'section-reveal', componentId: 'scroll-reveal', kind: 'js', source: 'hint' }]);
  const hosts = openTagWith(out, 'data-od-id="watson-footer:network"');
  assert.equal(hosts.length, 1);
  assert.match(hosts[0]!, /^<span class="genui-scroll-reveal" data-genui="scroll-reveal" data-od-id="watson-footer:network">$/);
  assert.equal(count(out, '<style data-genui-style="scroll-reveal">'), 1, 'CSS inlined once');
  assert.equal(count(out, 'data-genui-script="scroll-reveal"'), 1, 'JS inlined once');
  assert.equal(cspOf(out), cspOf(html), 'inline policy: CSP untouched');
  assert.equal(text(out), text(html), 'text content unchanged');
});

test('skips: occupied, missing, ambiguous, not allowed, script policy and max effects', async () => {
  const effects = await effectsOf('marketing-site');
  const html = await referencePage('marketing-site');
  const declaration: Declaration = {
    scriptPolicy: 'none',
    maxEffects: 1,
    placements: {
      eyebrow: { host: { odId: 'marketing-site-hero--eyebrow' }, allow: ['shiny-text'] },
      nav: { host: { id: 'no-such-host' }, allow: ['glare-hover'] },
      'section-title': { host: { odId: 'marketing-site-features--heading' }, allow: ['split-text', 'glare-hover'] },
      cta: { host: { id: 'marketing-site-cta' }, allow: ['glare-hover'] },
      'card-surface': { host: { id: 'marketing-site-footer' }, allow: ['glare-hover'] },
    },
  };
  const { html: out, report } = effects.applyEffectPlan(html, plan(
    ['eyebrow', 'shiny-text'], ['nav', 'glare-hover'], ['hero-title', 'split-text'], ['cta', 'masked-heading'],
    ['section-title', 'split-text'], ['cta', 'glare-hover'], ['card-surface', 'glare-hover'],
  ), declaration);
  assert.deepEqual(report.skipped.map((item) => `${item.placement}:${item.reason}`), [
    'eyebrow:host-occupied', 'nav:host-missing', 'hero-title:not-allowed', 'cta:not-allowed', 'section-title:script-policy', 'card-surface:max-effects',
  ]);
  assert.deepEqual(report.applied.map((item) => item.placement), ['cta']);
  assert.equal(count(out, 'data-genui="shiny-text"'), 1, 'the occupied host keeps its one component');
  assert.deepEqual(effects.applyEffectPlan(html, plan(['cta', 'glare-hover']), null).report.skipped, [{ placement: 'cta', componentId: 'glare-hover', reason: 'not-allowed' }]);
  const doubled = html.replace('<footer id="marketing-site-footer"', '<footer id="marketing-site-cta"');
  assert.deepEqual(effects.applyEffectPlan(doubled, plan(['cta', 'glare-hover']), declaration).report.skipped.map((item) => item.reason), ['incompatible'], 'an ambiguous host is refused');
});

test('hosts, </head> and </body> are found structurally, never inside a script, style or comment', async () => {
  const effects = await effectsOf('marketing-site');
  const page = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'"><style>/* <p id="t"> </head> */</style></head>`
    + `<body><!-- <h1 id="t"> </body> --><script type="text/plain">"<h1 id='t'></body>"</script><h1 class='a' id=t>Title</h1></body></html>`;
  const declaration: Declaration = { scriptPolicy: 'hash', maxEffects: 2, placements: { 'hero-title': { host: { id: 't' }, allow: ['split-text'] } } };
  const { html, report } = effects.applyEffectPlan(page, plan(['hero-title', 'split-text']), declaration);
  assert.equal(report.applied.length, 1);
  assert.match(html, /<h1 data-genui="split-text" class='a genui-split-text' id=t>Title<\/h1>/);
  assert.ok(html.includes('</head> */</style><style data-genui-style="split-text">'), 'style lands before the real </head>');
  assert.ok(html.endsWith('</script></body></html>') && html.includes('Title</h1><script type="module" data-genui-script="split-text">'));
  assert.ok(html.includes(`script-src ${effects.scriptHashSource(scriptText(html, 'split-text')!)}`));
});

test('byte budget: the final page stays below the limit by dropping the lowest-priority effects first', async () => {
  const effects = await effectsOf('marketing-site');
  const shell = (padding: number) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'"></head>`
    + `<body><h1 id="h">Heading</h1><p id="r">Reveal me</p><section id="c">Call</section><p>${'x'.repeat(padding)}</p></body></html>`;
  const declaration: Declaration = { scriptPolicy: 'hash', maxEffects: 3, placements: {
    'hero-title': { host: { id: 'h' }, allow: ['split-text'] },
    'section-reveal': { host: { id: 'r' }, allow: ['scroll-reveal'] },
    cta: { host: { id: 'c' }, allow: ['glare-hover'] },
  } };
  const all = plan(['section-reveal', 'scroll-reveal'], ['cta', 'glare-hover'], ['hero-title', 'split-text']);
  const cost = (items: Plan) => effects.applyEffectPlan(shell(0), items, declaration).report.bytesAdded;
  const heroOnly = cost(plan(['hero-title', 'split-text']));
  const heroAndCta = cost(plan(['hero-title', 'split-text'], ['cta', 'glare-hover']));
  // Room for the hero title alone, not for the hero title plus the cta.
  const room = Math.floor((heroOnly + heroAndCta) / 2);
  const page = shell(effects.PAGE_BYTE_LIMIT - room - Buffer.byteLength(shell(0)));
  assert.equal(Buffer.byteLength(page), effects.PAGE_BYTE_LIMIT - room);
  const { html, report } = effects.applyEffectPlan(page, all, declaration);
  assert.deepEqual(report.applied.map((item) => item.placement), ['hero-title']);
  assert.deepEqual(report.skipped.map((item) => `${item.placement}:${item.reason}`), ['section-reveal:byte-budget', 'cta:byte-budget']);
  assert.ok(Buffer.byteLength(html) < effects.PAGE_BYTE_LIMIT);
  assert.equal(report.bytesAdded, heroOnly);
  const over = shell(effects.PAGE_BYTE_LIMIT - Buffer.byteLength(shell(0)));
  assert.throws(() => effects.applyEffectPlan(over, all, declaration), (error: Error & { code?: string; bytes?: number }) => error.code === 'page-too-large' && error.bytes === 204800 && /base page is 204800 bytes/.test(error.message));
});

const tinyPage = (cspScript: string, host: string) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';${cspScript}"></head><body>${host}</body></html>`;

test('a host a family mounted by its genui-<id> class alone is occupied', async () => {
  const effects = await effectsOf('marketing-site');
  const declaration: Declaration = { scriptPolicy: 'hash', maxEffects: 2, placements: { 'hero-title': { host: { id: 't' }, allow: ['split-text'] } } };
  const page = tinyPage(" script-src 'none'", '<h1 id="t" class="big genui-shiny-text">Title</h1>');
  const { html, report } = effects.applyEffectPlan(page, plan(['hero-title', 'split-text']), declaration);
  assert.deepEqual(report.skipped, [{ placement: 'hero-title', componentId: 'split-text', reason: 'host-occupied' }]);
  assert.equal(html, page, 'nothing added');
});

test('hash policy: script-src is rebuilt from tokens, whatever the spacing of the original directive', async () => {
  const effects = await effectsOf('marketing-site');
  const declaration: Declaration = { scriptPolicy: 'hash', maxEffects: 2, placements: { 'hero-title': { host: { id: 't' }, allow: ['split-text'] } } };
  for (const directive of ["  script-src  'none'", " SCRIPT-SRC\t'none' "]) {
    const { html, report } = effects.applyEffectPlan(tinyPage(directive, '<h1 id="t">Title</h1>'), plan(['hero-title', 'split-text']), declaration);
    assert.equal(report.applied.length, 1);
    const hash = effects.scriptHashSource(scriptText(html, 'split-text')!);
    const csp = cspOf(html);
    assert.equal(csp.split(';')[1], `${directive.match(/^\s*/)![0]}script-src ${hash}`, JSON.stringify(directive));
    assert.ok(!/'none'\s*$/.test(csp), 'no stale none source');
  }
});

test('hash policy preserves verified family scripts and rejects permissive or stale sources', async () => {
  const effects = await effectsOf('community');
  const base = await referencePage('community');
  const ownScript = /<script>([\s\S]*?)<\/script>/.exec(base)![1]!;
  const ownHash = effects.scriptHashSource(ownScript);
  const { html } = effects.applyEffectPlan(base, plan(['hero-title', 'split-text']), effects.readFamilyEffectDeclaration('community'));
  assert.ok(cspOf(html).includes(ownHash));
  assert.ok(cspOf(html).includes(effects.scriptHashSource(scriptText(html, 'split-text')!)));
  assert.equal(count(html, `<script>${ownScript}</script>`), 1);
  for (const invalid of ["'unsafe-inline'", '*', "https:", "'sha256-invalid'", `${ownHash} 'unsafe-eval'`]) {
    assert.throws(() => effects.applyEffectPlan(base.replace(`script-src ${ownHash}`, `script-src ${invalid}`), plan(['hero-title', 'split-text']), effects.readFamilyEffectDeclaration('community')), /exactly match/);
  }
  const blocked = effects.applyEffectPlan(base.replace(`script-src ${ownHash}`, "script-src 'none'"), plan(['hero-title', 'split-text']), effects.readFamilyEffectDeclaration('community')).html;
  assert.ok(!cspOf(blocked).includes(ownHash), 'an originally blocked script never becomes authorized');
  assert.throws(() => effects.applyEffectPlan(base.replace(`script-src ${ownHash}`, `script-src ${ownHash}; script-src-elem 'unsafe-inline'`), plan(['hero-title', 'split-text']), effects.readFamilyEffectDeclaration('community')), /override/);
  assert.throws(() => effects.applyEffectPlan(base.replace('<script>', '<script src="https://example.com/code.js">'), plan(['hero-title', 'split-text']), effects.readFamilyEffectDeclaration('community')), /external scripts/);
  assert.throws(() => effects.applyEffectPlan(base.replace(`script-src ${ownHash}`, `script-src ${ownHash}; script-src ${ownHash}`), plan(['hero-title', 'split-text']), effects.readFamilyEffectDeclaration('community')), /duplicate/);
});

test('none and placement ids are never component ids in a declaration', async () => {
  const effects = await effectsOf('marketing-site');
  for (const id of ['none', 'hero-title']) {
    const value = { scriptPolicy: 'inline', maxEffects: 1, placements: { cta: { host: { id: 'c' }, allow: [id] } } };
    assert.throws(() => effects.parseFamilyEffectDeclaration(value, [id], 'test'), /reserved and never a component id/, id);
  }
});

test('a repair-sourced plan item is accepted and reported with its source', async () => {
  const effects = await effectsOf('marketing-site');
  const html = await referencePage('marketing-site');
  const { report } = effects.applyEffectPlan(html, { effects: [{ placement: 'cta', componentId: 'glare-hover', source: 'repair' as 'hint' }] }, effects.readFamilyEffectDeclaration('marketing-site'));
  assert.deepEqual(report.applied, [{ placement: 'cta', componentId: 'glare-hover', kind: 'css-only', source: 'repair' }]);
});

test('renderFamily composes before it applies the plan, so the budget covers the composed page', async () => {
  const { renderAgencySite } = await importFrom(path.join(copyDir('marketing-site'), 'render.ts'));
  const fixture = JSON.parse(readFileSync(path.join(copyDir('marketing-site'), 'families/marketing-site/reference.fixture.json'), 'utf8'));
  const manifest = { version: 1, assets: [] };
  const base = renderAgencySite(fixture, 'site.html', manifest);
  const marker = '<section id="composed-x">x</section>';
  const composed = renderAgencySite(fixture, 'site.html', manifest, { compose: (html: string) => html.replace('</body>', `${marker}</body>`) });
  assert.equal(composed.composed, true);
  assert.ok(composed.html.includes(marker));
  // A composed page at the limit fails before any effect is added.
  const pad = (html: string) => html.replace('</body>', `<p>${'x'.repeat(200 * 1024 - Buffer.byteLength(base.html) - 7)}</p></body>`);
  assert.throws(() => renderAgencySite(fixture, 'site.html', manifest, { compose: pad, effects: plan(['cta', 'glare-hover']) }), (error: Error & { code?: string }) => error.code === 'page-too-large');
});
