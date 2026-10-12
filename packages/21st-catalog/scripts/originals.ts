/** Builds independently authored alternatives. Never reads upstream registry/source files. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = JSON.parse(readFileSync(join(root, 'originals/manifest.json'), 'utf8')) as { id: string; slug: string; title: string; description: string; referenceUrl: string; referenceAuthor: string }[];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const runtime = readFileSync(join(root, 'originals/runtime.ts'), 'utf8');
const baseCss = readFileSync(join(root, 'originals/base.css'), 'utf8');
const runtimeJs = stripTypeScriptTypes(runtime).replace(/export /g, '');
const items = rows.map(row => {
  const source = readFileSync(join(root, 'originals', row.slug, 'index.ts'), 'utf8').replace("'../runtime.ts'", "'./runtime.ts'");
  const css = baseCss + readFileSync(join(root, 'originals', row.slug, 'style.css'), 'utf8');
  const javascript = runtimeJs + '\n' + stripTypeScriptTypes(source.replace(/^import .*;\n/m, ''));
  const script = javascript.replace(/export /g, '') + '\nmount(document.getElementById("demo"), {theme: new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark", reducedMotion: new URLSearchParams(location.search).get("motion") === "reduced"});\ndocument.addEventListener("keydown", function(event) { if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]") && parent !== window) { event.preventDefault(); parent.postMessage({type: "mishh-original-preview-escape"}, "*"); } });';
  const scriptHash = createHash('sha256').update(script).digest('base64');
  const style = 'html,body{margin:0;min-height:100%;background:transparent}#demo{min-height:100vh}' + css;
  const styleHash = createHash('sha256').update(style).digest('base64');
  const attributes = [...source.matchAll(/style=\\"(.*?)\\"/g)].map(m => m[1]!.replace(/\\/g, ''));
  const attributeHashes = [...new Set(attributes)].map(v => `'sha256-${createHash('sha256').update(v).digest('base64')}'`).join(' ');
  const csp = `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'sha256-${styleHash}'; style-src-attr 'unsafe-hashes' ${attributeHashes || "'none'"}; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none';`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${row.title} — original ZeroSum alternative</title><style>${style}</style><main id="demo"></main><script type="module">${script}</script></html>`;
  const notice = `INDEPENDENTLY AUTHORED ALTERNATIVE\nCopyright (c) 2026 ZeroSum Solutions\n\nThis source was independently authored for Mishh Mashh. It is not the upstream component, a source port, or an author-endorsed release. No upstream componentCode or demoCode was used.\n\nVisual/behavioral reference: ${row.referenceUrl}\nReference author: ${row.referenceAuthor}\nThe upstream item's rights apply only to its upstream source and do not grant or restrict this independently authored code. Upstream attribution does not imply endorsement.\n\nPermission is granted to use, copy, modify, and distribute this independently authored source for any purpose, including commercial use, with this notice retained. THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY.\n`;
  const readme = `# ${row.title}\n\n${row.description}\n\nThis is an independently authored ZeroSum alternative to the saved reference, not the original 21st.dev author's code. See NOTICE.txt.\n\n## Run\n\nOpen index.html in a browser. It is self-contained and runs offline without a server, build step, packages, fonts, images, or network requests. Add ?theme=light or ?motion=reduced for alternate framing.\n\n## Reuse / remix\n\nImport { mount } from './component.js' in a browser module, include style.css, and call mount(element, { theme: 'dark', reducedMotion: false }). Keep the returned handle and call handle.destroy() before replacing the host. destroy restores the host's attributes and original child nodes and removes event listeners.\n\nindex.ts and runtime.ts are the editable TypeScript source. They use the same mount(element, options) => { destroy() } contract as the owned GenUI catalog; compile with a DOM-enabled TypeScript toolchain when editing. component.js is the ready-to-use, dependency-free browser module.\n\nDemo data and local confirmation states are examples; they do not call services, play audio, publish, book sessions, or represent real telemetry.\n\nReference: ${row.referenceUrl}\nReference author: ${row.referenceAuthor}\n`;
  const files = [{path:'index.ts',content:source},{path:'runtime.ts',content:runtime},{path:'component.js',content:javascript},{path:'style.css',content:css},{path:'index.html',content:html},{path:'NOTICE.txt',content:notice},{path:'README.md',content:readme}].map(f => ({...f,sha256:hash(f.content)}));
  return {...row,provenance:'independently-authored' as const,sourceSha256:hash(files.map(f=>`${f.path}\0${f.sha256}\n`).join('')),files};
});
const text = JSON.stringify({schema:'21st-originals/1',items},null,2)+'\n';
const out = join(root, 'generated/21st-originals.json');
if(process.argv.includes('--check')){
 if(readFileSync(out,'utf8')!==text)throw new Error('21st originals drift: run the originals script');
 console.log(`21st originals: ${items.length} bundles match source`);
}else{writeFileSync(out,text);console.log(`21st originals: wrote ${items.length} owned bundles`);}
