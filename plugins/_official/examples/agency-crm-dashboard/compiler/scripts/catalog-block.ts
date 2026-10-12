import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Embed one owned GenUI catalog component (packages/genui-catalog) in a family page.
 *
 * A family declares the components it uses in `families/<family>/catalog.json`
 * (`{"catalogComponents": ["<id>", ...]}`). `packages/genui-catalog/scripts/sync-catalog-assets.ts`
 * then copies exactly those components' built files into `catalog/components/<id>/` next to this
 * file, in every compiler copy that carries the family, so the read below resolves inside a packed
 * plugin and inside the Agency Site template. A component the family did not declare is not on
 * disk, and `catalogBlock` fails loudly rather than emitting a bare class hook.
 *
 * `catalogBlock(id, markup, opts)` returns the component's host element around `markup` (trusted,
 * already-escaped HTML), preceded by the component's CSS in a `<style>` element and, with
 * `script: true`, followed by its auto-mount script in a `<script type="module">`. Pass one
 * `emitted` set per page to inline each component's CSS and script only on its first block.
 *
 * `script: true` needs a page CSP that allows inline scripts. Without it the block is CSS-only:
 * the host carries the `genui-<id>` class the component's stylesheet keys on, which is the whole
 * effect for a css-only component.
 */

export type CatalogFile = 'styles.css' | 'auto.js';

export interface CatalogBlockOptions {
  /** Host element name. Default `div`. */
  tag?: string;
  /** Classes added after `genui-<id>`. */
  className?: string;
  /** Extra attributes on the host; values are escaped. */
  attrs?: Readonly<Record<string, string>>;
  /** Component custom properties, written as `--genui-<id>-<key>` in the host's `style`. */
  vars?: Readonly<Record<string, string | number>>;
  /** Component options, written as the host's `data-genui-opts` JSON (read at mount). */
  options?: Readonly<Record<string, string | number | boolean>>;
  /** Inline the component's auto-mount script after the host. */
  script?: boolean;
  /** Per-page record of components whose assets are already inlined. */
  emitted?: Set<string>;
}

const COMPONENTS_DIR = path.join(import.meta.dirname, 'catalog/components');
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const NAME = /^[a-z][a-z0-9-]*$/;
const cache = new Map<string, string>();

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

/** The synced copy of one built component file. Throws when the family did not declare it. */
export function catalogAsset(id: string, file: CatalogFile): string {
  if (!ID.test(id)) throw new Error(`catalog component id: expected lowercase letters, digits and hyphens, got ${JSON.stringify(id)}`);
  const key = `${id}/${file}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const source = path.join(COMPONENTS_DIR, id, file);
  let text: string;
  try {
    text = readFileSync(source, 'utf8');
  } catch {
    throw new Error(`catalog component ${id}: ${file} is not in this compiler copy — declare "${id}" in the family's catalog.json and run the genui-catalog sync-assets script`);
  }
  // The text is inlined into a <style> or <script> element, so it must not be able to close it.
  if (/<\/(style|script)|<!--/i.test(text)) throw new Error(`catalog component ${id}: ${file} contains a closing tag or comment opener and cannot be inlined`);
  cache.set(key, text);
  return text;
}

export function catalogBlock(id: string, markup: string, opts: CatalogBlockOptions = {}): string {
  const tag = opts.tag ?? 'div';
  if (!NAME.test(tag)) throw new Error(`catalog block ${id}: invalid tag ${JSON.stringify(tag)}`);
  const first = !opts.emitted?.has(id);
  opts.emitted?.add(id);
  const css = catalogAsset(id, 'styles.css');
  const js = opts.script ? catalogAsset(id, 'auto.js') : '';
  const classes = [`genui-${id}`, ...(opts.className ? [opts.className] : [])].join(' ');
  const attrs: string[] = [`class="${escapeAttr(classes)}"`, `data-genui="${id}"`];
  if (opts.options) attrs.push(`data-genui-opts="${escapeAttr(JSON.stringify(opts.options))}"`);
  const vars = Object.entries(opts.vars ?? {});
  for (const [name] of vars) if (!NAME.test(name)) throw new Error(`catalog block ${id}: invalid var name ${JSON.stringify(name)}`);
  if (vars.length > 0) attrs.push(`style="${escapeAttr(vars.map(([name, value]) => `--genui-${id}-${name}:${value}`).join(';'))}"`);
  for (const [name, value] of Object.entries(opts.attrs ?? {})) {
    if (!NAME.test(name) || ['class', 'style', 'data-genui', 'data-genui-opts'].includes(name)) throw new Error(`catalog block ${id}: invalid attribute ${JSON.stringify(name)}`);
    attrs.push(`${name}="${escapeAttr(value)}"`);
  }
  const style = first ? `<style data-genui-style="${id}">${css}</style>` : '';
  const script = first && opts.script ? `<script type="module" data-genui-script="${id}">${js}</script>` : '';
  return `${style}<${tag} ${attrs.join(' ')}>${markup}</${tag}>${script}`;
}
