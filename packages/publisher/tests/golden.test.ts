/**
 * Golden output: every public family's reference recipe, three effect plans and two booking
 * embeds compile to exactly the recorded bytes. The page digests were recorded from `main` before
 * the publisher existed, by calling each compiler copy's `renderAgencySite` directly, so a match
 * here means the publisher and the resource seam changed no output.
 *
 * `UPDATE_GOLDEN=1` rewrites `tests/golden/pages.json` after an intended output change.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { compile, type CompileInput, type SiteSpec } from '../src/compile.ts';
import type { EffectPlan, FamilyCompiler } from '../src/types.ts';
import { entryHtml, FAMILIES, KEY_A, KEY_B, loadExample, PACKAGE_ROOT } from './helpers.ts';

type Golden = { bytes: number; sha256: string; manifest: string; digest: string; effects?: unknown };
const GOLDEN_FILE = path.join(PACKAGE_ROOT, 'tests/golden/pages.json');
const updating = process.env.UPDATE_GOLDEN === '1';
const goldens = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as Record<string, Golden>;
const recorded: Record<string, Golden> = {};

const EFFECT_PLANS: Record<string, EffectPlan> = {
  restaurant: { effects: [{ placement: 'hero-title', componentId: 'split-text', source: 'hint' }, { placement: 'cta', componentId: 'glare-hover', source: 'hint' }] },
  'marketing-site': { effects: [{ placement: 'section-reveal', componentId: 'scroll-reveal', source: 'jev' }, { placement: 'hero-title', componentId: 'masked-heading', source: 'hint' }] },
  practice: { effects: [{ placement: 'hero-title', componentId: 'split-text', source: 'hint' }] },
};

/** The booking embed cases: one per widget mode, at an anchor and at the end of `<main>`. */
const BOOKING_CASES: Record<string, { family: string; spec: (reference: FamilyCompiler['reference']) => SiteSpec }> = {
  'practice+booking-iframe': {
    family: 'practice',
    spec: (recipe) => ({
      recipe,
      bookingEmbeds: [{ id: 'book-online', placement: { after: 'practice-book' }, heading: 'Book a visit online', body: 'Pick a time that suits you; the practice confirms by email.', key: KEY_A, pageUrl: `https://api.example.com/book/${KEY_A}`, mode: 'iframe' }],
    }),
  },
  'restaurant+booking-script+effects': {
    family: 'restaurant',
    spec: (recipe) => ({
      recipe,
      effects: EFFECT_PLANS.restaurant,
      bookingEmbeds: [{ id: 'reserve', heading: 'Reserve a table', key: KEY_B, pageUrl: `https://api.example.com/book/${KEY_B}`, mode: 'script', scriptUrl: 'https://api.example.com/embed.js', height: 640 }],
    }),
  },
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function check(name: string, input: CompileInput): Promise<void> {
  const result = await compile(input);
  const html = entryHtml(result);
  const actual: Golden = {
    bytes: Buffer.byteLength(html), sha256: sha256(html), manifest: sha256(JSON.stringify(result.manifest)), digest: result.digest,
    ...(result.effects ? { effects: result.effects } : {}),
  };
  recorded[name] = actual;
  if (updating) return;
  if (JSON.stringify(goldens[name]) !== JSON.stringify(actual)) {
    const out = path.join(tmpdir(), 'mish-publisher-golden-actual');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, `${name}.html`), html);
    assert.deepEqual(actual, goldens[name], `${name}: output differs from the golden; the actual page is in ${out}/${name}.html`);
  }
}

for (const family of FAMILIES) {
  test(`golden: ${family} reference recipe`, async () => {
    const { compiler } = await loadExample(family);
    await check(family, { compiler, spec: { recipe: compiler.reference } });
  });
}

for (const [family, plan] of Object.entries(EFFECT_PLANS)) {
  test(`golden: ${family} with an effect plan`, async () => {
    const { compiler } = await loadExample(family);
    await check(`${family}+effects`, { compiler, spec: { recipe: compiler.reference, effects: plan } });
  });
}

for (const [name, { family, spec }] of Object.entries(BOOKING_CASES)) {
  test(`golden: ${name}`, async () => {
    const { compiler } = await loadExample(family);
    await check(name, { compiler, spec: spec(compiler.reference) });
  });
}

test('golden: brand tokens replace the recipe brand', async () => {
  const { compiler } = await loadExample('practice');
  await check('practice+brand-tokens', {
    compiler,
    spec: { recipe: compiler.reference },
    brandTokens: { name: 'Halden & Rowe Dental', descriptor: 'A family dental practice in a fictional town, used as pilot data.' },
  });
});

test('golden: every case is recorded', () => {
  if (updating) return;
  assert.deepEqual(Object.keys(recorded).sort(), Object.keys(goldens).sort());
});

after(() => {
  if (!updating) return;
  const sorted = Object.fromEntries(Object.entries(recorded).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(GOLDEN_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
});
