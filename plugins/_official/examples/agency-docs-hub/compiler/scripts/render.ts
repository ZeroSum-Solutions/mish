import { createHash } from 'node:crypto';
import { parseRecipe, type Action, type Recipe, type Section } from './schema.ts';
import { styles } from './styles.ts';
import { renderFamily, type RenderFamilyOptions } from './family.ts';

export const RENDERER_VERSION = '1.0.0';
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
const e = escapeHtml;
const target = (id: string, suffix: string) => `data-od-id="${id}--${suffix}"`;
function action(value: Action, id: string): string {
  return `<a class="action" href="${e(value.href)}" ${target(id, 'action')}>${e(value.label)} <span aria-hidden="true">↗</span></a>`;
}
function renderSection(s: Section, recipe: Recipe, index: number): string {
  const eyebrow = `<p class="eyebrow" ${target(s.id, 'eyebrow')}>${e(s.eyebrow)}</p>`;
  const title = `<h2 ${target(s.id, 'title')}>${e(s.title)}</h2>`;
  const base = `id="${s.id}" data-od-id="${s.id}"`;
  if (s.type === 'hero') return `<section class="hero" ${base}><div class="hero-copy">${eyebrow}<h1 ${target(s.id, 'title')}>${e(s.title)}</h1><p class="body" ${target(s.id, 'body')}>${e(s.body)}</p>${action(s.action, s.id)}</div><figure><img src="assets/agency-site/${recipe.revision}/${s.image.file}" alt="${e(s.image.alt)}" width="1536" height="1024" fetchpriority="high" style="--focal:${s.image.focal}" ${target(s.id, 'image')}><figcaption ${target(s.id, 'caption')}>${e(s.eyebrow)}</figcaption></figure></section>`;
  if (s.type === 'collection') return `<section class="section" ${base}><div class="section-head"><div>${eyebrow}${title}</div><span class="section-no" aria-hidden="true">0${index}</span></div><div class="collection">${s.items.map((item, i) => `<article ${target(s.id, `item-${i}`)}><p class="label" ${target(s.id, `item-${i}-label`)}>${e(item.label)}</p><h3 ${target(s.id, `item-${i}-title`)}>${e(item.title)}</h3><p class="body" ${target(s.id, `item-${i}-body`)}>${e(item.body)}</p></article>`).join('')}</div></section>`;
  if (s.type === 'proof') return `<section class="proof" ${base}><div>${eyebrow}${title}<p class="body" ${target(s.id, 'body')}>${e(s.body)}</p></div><dl class="facts">${s.facts.map((fact, i) => `<div><dt ${target(s.id, `fact-${i}-label`)}>${e(fact.label)}</dt><dd ${target(s.id, `fact-${i}-value`)}>${e(fact.value)}</dd></div>`).join('')}</dl></section>`;
  return `<section class="section contact" ${base}><div>${eyebrow}${title}</div><div><p class="body" ${target(s.id, 'body')}>${e(s.body)}</p>${action(s.action, s.id)}</div></section>`;
}

/** A recipe makes a new candidate. Its saved HTML is then the editing authority. */
export function renderAgencySite(input: unknown, entry: string, approvedManifest?: unknown, options?: RenderFamilyOptions) {
  if (!/^[a-z][a-z0-9-]*\.html$/.test(entry) || entry.length > 100) throw new Error('entry: use a root-level lowercase HTML filename');
  if ((input as { schemaVersion?: unknown })?.schemaVersion === 2) return renderFamily(input, entry, approvedManifest, options);
  const recipe = parseRecipe(input);
  const b = recipe.brand;
  const tokens = `--background:${b.background};--ink:${b.ink};--muted:${b.muted};--accent:${b.accent};--surface:${b.surface};--display:${b.display === 'serif' ? 'Georgia,Times,serif' : 'Arial,Helvetica,sans-serif'}`;
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${e(recipe.description)}"><title>${e(recipe.name)}</title><style>:root{${tokens}}${styles}</style></head><body class="${recipe.direction}"><a class="skip" href="#main">Skip to content</a><div class="wrap"><header data-od-id="site-header"><a class="wordmark" href="#main" data-od-id="site-name">${e(recipe.name)}</a><a class="nav-link" href="#contact" data-od-id="site-nav">Get in touch ↗</a></header><main id="main">${recipe.sections.map((s, i) => renderSection(s, recipe, i)).join('')}</main><footer data-od-id="site-footer"><span data-od-id="footer-name">${e(recipe.name)}</span><span data-od-id="footer-description">${e(recipe.description)}</span></footer></div></body></html>\n`;
  const supportingFiles = [...new Set(recipe.sections.flatMap((s) => s.type === 'hero' ? [`assets/agency-site/${recipe.revision}/${s.image.file}`] : []))];
  const manifest = { version: 1, kind: 'html', renderer: 'html', title: recipe.name, entry, status: 'complete', exports: ['html', 'pdf', 'zip'], sourceSkillId: 'agency-site', supportingFiles, metadata: { agencySite: { version: 1, publication: 'closed-assets-v1', recipeDigest: createHash('sha256').update(JSON.stringify(recipe)).digest('hex'), rendererVersion: RENDERER_VERSION, revision: recipe.revision } } };
  return { recipe, html, manifest };
}
