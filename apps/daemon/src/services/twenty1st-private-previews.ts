/** Private, downloaded 21st source stays outside the distributable repository.
 * Only catalogued IDs and checksum-verified assets can enter the preview sandbox. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import artwork from '@open-design/21st-catalog/generated/preview-artwork/manifest.json' with { type: 'json' };
import { parseTwenty1stSourceResponse, type Twenty1stItem, type Twenty1stSourceResponse } from '@open-design/contracts';
import { inspectTwenty1stLocalImports } from './twenty1st-local-import-closure.js';

interface PrivateEntry {
  id: string;
  slug: string;
  title: string;
  description: string;
  sourceSha256: string;
  sourceVerified: boolean;
  sourceFiles: Array<{path: string; content: string; sha256: string}>;
  primarySourcePath?: string;
  assets: {script: string; style: string};
  assetSha256: {script: string; style: string};
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const assetName = /^[a-z0-9][a-z0-9.-]*\.(?:js|css)$/;
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src https: data: blob:; font-src 'self' data:; media-src https: blob:; connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
/** The downloaded Spline runtime needs its public scene and pinned WebAssembly assets.
 * JavaScript eval and other previews retain the stricter policy. */
function previewPolicy(id: string): string {
  if (id === '21st:moumensoliman-glassmorphism-listen-app') return `${csp}; frame-src https://open.spotify.com/embed/`;
  return id === '21st:serafimcloud-spline-scene'
    ? csp.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")
      .replace("connect-src 'none'", 'connect-src https://prod.spline.design https://cdn.spline.design https://assets.spline.design https://unpkg.com/@splinetool/runtime@2.0.58/build/bevel.wasm')
      .replace("worker-src 'none'", 'worker-src blob:')
      .replace('media-src https: blob:', 'media-src https: data: blob:')
    : csp;
}

/** Exact reviewed edits; raw pinned source and assets must pass every checksum first. */
type ReviewedEdit = { from: string } & ({ to: string } | { artworkId: 'studio' | 'glass' | 'landscape' | 'portrait-one' });
const reviewedCopy: Record<string, { path: string; edits: ReviewedEdit[] }> = {
  '21st:hero-ui-card': {
    path: 'gallery/components/twentyfirst/hero-ui-card/demo.tsx',
    edits: [{ from: 'Lorem ipsum dolor sit amet consectetur. Sed arcu donec id aliquam dolor sed amet faucibus etiam.', to: 'Share a sample of your work and tell the team what you want to create.' }],
  },
  '21st:ruixen-ui-gallery-hover-carousel': {
    path: 'gallery/components/twentyfirst/gallery-hover-carousel/gallery-hover-carousel.tsx',
    edits: [
      { from: 'Explore our collection of innovative solutions and cutting-edge technologies designed to transform your business.', to: 'Browse project images. Use the arrows to move through the collection.' },
      { from: 'Build Modern UIs', to: 'Studio workspace' },
      { from: 'Create stunning user interfaces with our comprehensive design system.', to: 'A wooden worktable, paper models, and a desk lamp beside a tall studio window.' },
      { from: 'Computer Vision Technology', to: 'Glass vessels' },
      { from: 'Powerful image recognition and processing capabilities that allow AI systems to analyze, understand, and interpret visual information from the world.', to: 'Blue and amber glass vessels on a pale stone plinth against a dark backdrop.' },
      { from: 'Machine Learning Automation', to: 'Activity dashboard' },
      { from: 'Self-improving algorithms that learn from data patterns to automate complex tasks and make intelligent decisions with minimal human intervention.', to: 'A dark dashboard combines an activity chart, region map, and status panels.' },
      { from: 'Predictive Analytics', to: 'Alpine lake' },
      { from: 'Advanced forecasting capabilities that analyze historical data to predict future trends and outcomes, helping businesses make data-driven decisions.', to: 'A still mountain lake bordered by pine trees and pale limestone slopes.' },
      { from: 'Neural Network Architecture', to: 'Portrait study' },
      { from: 'Sophisticated AI models inspired by human brain structure, capable of solving complex problems through deep learning and pattern recognition.', to: 'An illustrative portrait of a fictional creative director in soft daylight.' },
      { from: 'https://cdn.21st.dev/assets/mirror/60/60f1fc317cc965fa57d1bb420b79a441aaebc281f64fceda8b7bff238686177d.png', artworkId: 'studio' },
      { from: 'https://cdn.21st.dev/assets/mirror/5b/5be809c811b5c484f4f36c477a13b0af7da32fdd20512c7f6c2c38e681e32afa.png', artworkId: 'glass' },
      { from: 'https://cdn.21st.dev/assets/mirror/ff/ff0d274d6f15232322c8938fc0c067cb4a70ef4e568b8b61256f8254749f9374.png', artworkId: 'landscape' },
      { from: 'https://cdn.21st.dev/assets/mirror/58/58274556122ef7e984b226b075e8ab2c153e238896e21ad4b56d0ce447455c31.png', artworkId: 'portrait-one' },
    ],
  },
};
function replaceReviewedLiteral(content: string, from: string, to: string): string {
  if (content.split(from).length !== 2) throw new Error('Reviewed private literal must occur exactly once');
  return content.replace(from, to);
}
/** Fixed project-owned image IDs, verified before embedding in both source and JavaScript. */
function reviewedArtwork(id: 'studio' | 'glass' | 'landscape' | 'portrait-one'): string {
  const item = artwork.items.find(item => item.id === id);
  if (!item || artwork.schema !== 'catalog-preview-artwork/1' || item.file !== `${id}.webp`) throw new Error('Invalid reviewed artwork manifest');
  const directory = realpathSync(path.dirname(fileURLToPath(import.meta.resolve('@open-design/21st-catalog/generated/preview-artwork/manifest.json'))));
  const target = realpathSync(path.join(directory, item.file));
  if (path.dirname(target) !== directory) throw new Error('Reviewed artwork escapes its root');
  const bytes = readFileSync(target);
  if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw new Error('Reviewed artwork checksum mismatch');
  return `data:image/webp;base64,${bytes.toString('base64')}`;
}
function refineCopy(entry: PrivateEntry, source: Twenty1stSourceResponse, assets: Map<string, Buffer>) {
  const rule = reviewedCopy[entry.id];
  if (!rule) return { entry, source, assets };
  if (source.provenance !== 'upstream-private') throw new Error('Reviewed copy needs validated private source');
  const original = source.files.find(file => file.path === rule.path);
  if (!original) throw new Error('Reviewed private copy source file is missing');
  let content = original.content;
  let scriptContent = assets.get(entry.assets.script)!.toString('utf8');
  for (const edit of rule.edits) {
    const replacement = 'artworkId' in edit ? reviewedArtwork(edit.artworkId) : edit.to;
    content = replaceReviewedLiteral(content, edit.from, replacement);
    scriptContent = replaceReviewedLiteral(scriptContent, edit.from, replacement);
  }
  const files = source.files.map(file => file === original ? { ...file, content, sha256: digest(content) } : file);
  const sourceSha256 = digest(files.map(file => `${file.path}\0${file.sha256}\n`).join(''));
  const script = Buffer.from(scriptContent);
  const refinedAssets = new Map(assets).set(entry.assets.script, script);
  const refinement = {
    originalSourceSha256: source.sourceSha256,
    note: rule.edits.some(edit => 'artworkId' in edit)
      ? 'Reviewed imagery and copy refinement: this local preview and exported code use project descriptions and original Higgsfield imagery in four promotional image slots, including a fictional portrait. The dashboard image and original pinned source remain unchanged.'
      : 'Reviewed copy refinement: this local preview and exported code replace placeholder wording. The original pinned source remains unchanged.',
  };
  return {
    entry: { ...entry, sourceSha256, sourceFiles: files, assetSha256: { ...entry.assetSha256, script: digest(script) } },
    source: { ...source, files, sourceSha256, refinement },
    assets: refinedAssets,
  };
}

export class Twenty1stPrivatePreviews {
  private readonly entries = new Map<string, { entry: PrivateEntry; source: Twenty1stSourceResponse; assets: Map<string, Buffer> }>();
  /** Configuration is trusted host input, never request input. Invalid kits fail closed. */
  constructor(directory: string | undefined, rows: Twenty1stItem[]) {
    if (!directory) return;
    const root = realpathSync(directory);
    const manifest = JSON.parse(readFileSync(path.join(root, 'preview-manifest.json'), 'utf8')) as {schema?: unknown;items?: unknown};
    if (manifest.schema !== '21st-private-previews/1' || !Array.isArray(manifest.items) || manifest.items.length > 128) throw new Error('Invalid private preview manifest');
    const known = new Map(rows.map(row => [row.id, row]));
    for (const value of manifest.items) {
      const entry = value as PrivateEntry;
      const row = known.get(entry.id);
      if (!row || this.entries.has(entry.id) || typeof entry.description !== 'string' || typeof entry.slug !== 'string' || !/^[a-z0-9-]+$/.test(entry.slug)) throw new Error('Invalid private preview identity');
      const source = parseTwenty1stSourceResponse({id:row.id,title:entry.title,provenance:'upstream-private',referenceUrl:row.itemUrl,referenceAuthor:row.author,sourceSha256:entry.sourceSha256,sourceVerified:entry.sourceVerified,files:entry.sourceFiles,primarySourcePath:entry.primarySourcePath});
      for (const file of source.files) if (digest(file.content) !== file.sha256) throw new Error(`Private source checksum mismatch: ${row.id}`);
      if (digest(source.files.map(file => `${file.path}\0${file.sha256}\n`).join('')) !== source.sourceSha256) throw new Error(`Private source bundle checksum mismatch: ${row.id}`);
      const assets = new Map<string, Buffer>();
      for (const kind of ['script', 'style'] as const) {
        const name = entry.assets?.[kind];
        if (typeof name !== 'string' || !assetName.test(name)) throw new Error('Invalid private preview asset');
        const target = realpathSync(path.join(root, name));
        if (path.dirname(target) !== root) throw new Error('Private preview asset escapes its root');
        const bytes = readFileSync(target);
        if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error('Invalid private preview asset size');
        if (digest(bytes) !== entry.assetSha256?.[kind]) throw new Error('Private preview asset checksum mismatch');
        assets.set(name, bytes);
      }
      const refined = refineCopy(entry, source, assets);
      const localImportClosure = inspectTwenty1stLocalImports(refined.source.files);
      this.entries.set(entry.id, { ...refined, source: refined.source.provenance === 'upstream-private'
        ? { ...refined.source, localImportClosure } : refined.source });
    }
  }
  private find(id: string) { return this.entries.get(id.startsWith('21st:') ? id : `21st:${id}`); }
  project(row: Twenty1stItem): Twenty1stItem {
    const found = this.find(row.id);
    if (!found) return row;
    const {ownedAlternative: _alternative, ...item} = row;
    const url = `/api/21st/${encodeURIComponent(row.id)}`;
    return {...item,privateImplementation:{title:found.entry.title,description:found.entry.description,provenance:'upstream-private',sourceVerified:found.entry.sourceVerified,sourceSha256:found.source.sourceSha256,...(found.source.provenance === 'upstream-private' && found.source.localImportClosure ? {localImportClosure:found.source.localImportClosure} : {}),...(found.source.provenance === 'upstream-private' && found.source.refinement ? {refinement:found.source.refinement} : {}),sourceUrl:`${url}/source`,previewUrl:`${url}/preview`}};
  }
  source(id: string) { return this.find(id)?.source; }
  asset(id: string, name: string) { return this.find(id)?.assets.get(name); }
  preview(id: string): {html:string;csp:string} | undefined {
    const found = this.find(id);
    if (!found) return undefined;
    const escape = (value:string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
    const url = `/api/21st/${encodeURIComponent(found.entry.id)}/assets`;
    return {csp:previewPolicy(found.entry.id),html:`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(found.entry.title)}</title><link rel="stylesheet" href="${url}/${found.entry.assets.style}"></head><body><div id="root"></div><script src="${url}/${found.entry.assets.script}" defer></script></body></html>`};
  }
}
