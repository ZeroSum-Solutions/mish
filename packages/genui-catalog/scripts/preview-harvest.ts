/** Build an offline review sheet from the package's actual sandboxed demos.
 * Run after build: pnpm --filter @mish/genui-catalog preview:harvest
 * The result is ignored, reproducible, and has no server or external assets.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { demoDocument } from '../dist/data.js';

const root = path.resolve(import.meta.dirname, '..');
const seed = JSON.parse(readFileSync(path.join(root, 'data/harvest-seed.json'), 'utf8')) as { components: Array<{ id: string; source: { Component: string } }> };
const attr = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const cards = seed.components.map(({ id, source }) => {
 const normal = demoDocument(id); const reduced = demoDocument(id, { reducedMotion: true });
 if (!normal || !reduced) throw new Error(`Build is missing ${id}`);
 const demos = path.join(root, '.tmp/harvest-demos'); mkdirSync(demos, { recursive: true });
 writeFileSync(path.join(demos, `${id}.html`), normal);
 writeFileSync(path.join(demos, `${id}-reduced.html`), reduced);
 return `<article><header><h2>${attr(source.Component)}</h2><code>${id}</code></header><iframe title="${attr(source.Component)} preview" sandbox="allow-scripts" data-normal="${attr(normal)}" data-reduced="${attr(reduced)}" srcdoc="${attr(normal)}"></iframe></article>`;
}).join('\n');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owned component harvest</title><style>
*{box-sizing:border-box}body{margin:0;background:#080c14;color:#f0e7ff;font:15px/1.6 system-ui,sans-serif}main{max-width:1240px;padding:48px 24px 80px;margin:auto}h1{font-size:clamp(32px,5vw,56px);font-weight:500;letter-spacing:-.045em;line-height:1.1;margin:16px 0}p{color:#b8c2d8;max-width:64ch}.label{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#a5b4cc}.controls{display:flex;gap:24px;align-items:center;flex-wrap:wrap;margin:32px 0}button{color:#f0e7ff;background:#202436;border:1px solid #69738b;border-radius:999px;padding:10px 20px;min-height:44px;font:inherit;cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid #a5d8ff;outline-offset:4px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}article{border:1px solid #394257;border-radius:16px;overflow:hidden;background:#0c101b}article header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 24px;border-bottom:1px solid #394257}h2{font:500 15px system-ui;margin:0}code{font:11px monospace;color:#a5b4cc}iframe{display:block;border:0;width:100%;height:430px;background:#0c101b}@media(max-width:700px){main{padding:28px 12px 48px}.grid{grid-template-columns:1fr}article header{padding:16px}code{font-size:10px}}
</style></head><body><main><span class="label">GenUI / October 2026</span><h1>Owned component harvest.</h1><p>Fourteen effects built with plain ESM and scoped CSS. Each preview uses the package's actual built code and runs without a network connection.</p><div class="controls"><label><input id="reduced" type="checkbox"> Reduce motion</label><button type="button" id="replay">Replay previews</button></div><section class="grid" aria-label="Component previews">${cards}</section></main><script>
const frames=[...document.querySelectorAll('iframe')];function replay(){for(const frame of frames)frame.srcdoc=document.getElementById('reduced').checked?frame.dataset.reduced:frame.dataset.normal}document.getElementById('reduced').addEventListener('change',replay);document.getElementById('replay').addEventListener('click',replay);
</script></body></html>`;
const out = path.join(root, '.tmp/harvest-preview.html'); mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, html);
console.log(out);
