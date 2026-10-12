/**
 * The atlas importer: regex-over-static-HTML parsing of spine cards, archetype cards, the
 * compatibility matrix, the skin strip, cross-cutting formats and the `familyDetails` script
 * object, plus the pre-write validation from `src/atlas.ts`. A synthetic fixture stands in for
 * the real atlas page (same markup shapes, two spines instead of nine) so the test does not
 * depend on the checked-in `shape-atlas.json`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAtlasHtml } from '../scripts/import-shape-atlas.ts';

// Mirrors the real atlas's markup exactly (spine-card, archetype-card, matrix table, skin-strip,
// the "Cross-cutting formats" index panel, and the familyDetails script object) at a scale of two
// spines and three archetype cards. The BB entry in familyDetails carries a trailing space before
// its closing `]` — the same shape as the real page's MI entry — to prove the parser accepts it.
const FIXTURE_HTML = `<!doctype html>
<html><body>
<div class="sheet-meta"><span>Composition ledger</span><span>v1.0</span></div>
<article class="spine-card"><div class="spine-top"><span class="spine-code">AA</span><span class="spine-family">Alpha</span></div><h3>Alpha spine</h3><p>Alpha intent.</p><div class="spine-flow">Need → act</div><div class="spine-cta">CTA: Go, act now</div></article>
<article class="spine-card"><div class="spine-top"><span class="spine-code">BB</span><span class="spine-family">Beta</span></div><h3>Beta spine</h3><p>Beta intent.</p><div class="spine-flow">Try → win</div><div class="spine-cta">CTA: Try</div></article>
<table class="matrix"><thead><tr><th class="corner">Source / target</th><th>AA</th><th>BB</th></tr></thead><tbody>
<tr data-row="AA"><th><button class="row-pick" data-pick="AA"><code>AA</code> Alpha spine</button></th><td class="s3" data-score="3">3</td><td class="s2" data-score="2">2</td></tr>
<tr data-row="BB"><th><button class="row-pick" data-pick="BB"><code>BB</code> Beta spine</button></th><td class="s2" data-score="2">2</td><td class="s3" data-score="3">3</td></tr>
</tbody></table>
<article class="archetype-card paper" data-family="AA" data-search="alpha one thing"><div class="archetype-card-head"><h4>Alpha One</h4><span class="family-tag">AA.01</span></div><p class="intent">Alpha one intent.</p><div><span class="mini-label">Spine</span><p class="spine-line">Need → act</p></div><div><span class="mini-label">Sections</span><p class="section-line">Hero, proof.</p></div><div class="card-bottom"><div><span class="mini-label">Primary CTA</span><span class="primary-cta">Go now</span></div><div><span class="mini-label">Closest transfers</span><p class="reuse-copy">Beta · Gamma</p></div></div></article>
<article class="archetype-card paper" data-family="AA" data-search="alpha two thing"><div class="archetype-card-head"><h4>Alpha Two</h4><span class="family-tag">AA.02</span></div><p class="intent">Alpha two intent.</p><div><span class="mini-label">Spine</span><p class="spine-line">Need → decide</p></div><div><span class="mini-label">Sections</span><p class="section-line">Hero, decide.</p></div><div class="card-bottom"><div><span class="mini-label">Primary CTA</span><span class="primary-cta">Decide now</span></div><div><span class="mini-label">Closest transfers</span><p class="reuse-copy">Delta</p></div></div></article>
<article class="archetype-card paper" data-family="BB" data-search="beta one thing"><div class="archetype-card-head"><h4>Beta One</h4><span class="family-tag">BB.01</span></div><p class="intent">Beta one intent.</p><div><span class="mini-label">Spine</span><p class="spine-line">Try → win</p></div><div><span class="mini-label">Sections</span><p class="section-line">Hero, win.</p></div><div class="card-bottom"><div><span class="mini-label">Primary CTA</span><span class="primary-cta">Win now</span></div><div><span class="mini-label">Closest transfers</span><p class="reuse-copy">Alpha</p></div></div></article>
<article class="index-panel paper"><h3>Cross-cutting formats</h3><p>x</p><div class="index-list"><div class="index-item"><b>Landing page</b><span>One audience, one action</span></div></div></article>
<article class="index-panel paper"><h3>Visual skins</h3><p>x</p><div class="skin-strip"><span>Minimal</span><span>Bold</span></div></article>
<script>
var familyDetails = {
AA: ["Alpha headline.", "Alpha transfer text."],
BB: ["Beta headline.", "Beta transfer text." ]
};
</script>
</body></html>`;

test('parseAtlasHtml: spines, archetypes, matrix, skins, formats and transfer notes (including the trailing-space entry)', () => {
  const atlas = parseAtlasHtml(FIXTURE_HTML, { source: 'file:///fixture.html', fetched: '2026-09-19' });
  assert.deepEqual(atlas, {
    source: 'file:///fixture.html',
    version: '1.0',
    fetched: '2026-09-19',
    spines: [
      { code: 'AA', kind: 'Alpha', name: 'Alpha spine', intent: 'Alpha intent.', steps: ['Need', 'act'], ctas: ['Go', 'act now'] },
      { code: 'BB', kind: 'Beta', name: 'Beta spine', intent: 'Beta intent.', steps: ['Try', 'win'], ctas: ['Try'] },
    ],
    archetypes: [
      {
        id: 'AA.01', spine: 'AA', name: 'Alpha One', intent: 'Alpha one intent.',
        steps: ['Need', 'act'], sections: ['Hero', 'proof'], primaryCta: 'Go now',
        closestTransfers: ['Beta', 'Gamma'], keywords: ['alpha', 'one', 'thing'],
      },
      {
        id: 'AA.02', spine: 'AA', name: 'Alpha Two', intent: 'Alpha two intent.',
        steps: ['Need', 'decide'], sections: ['Hero', 'decide'], primaryCta: 'Decide now',
        closestTransfers: ['Delta'], keywords: ['alpha', 'two', 'thing'],
      },
      {
        id: 'BB.01', spine: 'BB', name: 'Beta One', intent: 'Beta one intent.',
        steps: ['Try', 'win'], sections: ['Hero', 'win'], primaryCta: 'Win now',
        closestTransfers: ['Alpha'], keywords: ['beta', 'one', 'thing'],
      },
    ],
    compatibility: { AA: { AA: 3, BB: 2 }, BB: { AA: 2, BB: 3 } },
    transferNotes: {
      AA: { headline: 'Alpha headline.', transfer: 'Alpha transfer text.' },
      BB: { headline: 'Beta headline.', transfer: 'Beta transfer text.' },
    },
    skins: ['Minimal', 'Bold'],
    formats: [{ name: 'Landing page', summary: 'One audience, one action' }],
  });
});

test('parseAtlasHtml: an asymmetric matrix is rejected', () => {
  const asymmetric = FIXTURE_HTML.replace(
    '<tr data-row="BB"><th><button class="row-pick" data-pick="BB"><code>BB</code> Beta spine</button></th><td class="s2" data-score="2">2</td><td class="s3" data-score="3">3</td></tr>',
    '<tr data-row="BB"><th><button class="row-pick" data-pick="BB"><code>BB</code> Beta spine</button></th><td class="s9" data-score="9">9</td><td class="s3" data-score="3">3</td></tr>',
  );
  assert.throws(() => parseAtlasHtml(asymmetric, { source: 'x', fetched: 'y' }), /symmetric/);
});
