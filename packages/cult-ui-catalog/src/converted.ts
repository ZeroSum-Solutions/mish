/**
 * The converter's output in the private source kit (`converted/`, written by the kit's
 * `scripts/convert.mjs`) and the rules that turn it into catalog.json conversion fields and into
 * the committed adapters under `generated/`.
 *
 * Layout read here: `converted/<name>/report.json` (one block's status, refusal reasons and
 * measured sizes) and `converted/<name>/adapter.ts` (present only when the block is insertable).
 * Only blocks that are catalog rows are read: `cult:<name>` for a registry item, and
 * `cult:<page>--<section>` for a section the converter cut from a fetched page (src/derived.ts).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AdapterRef, Conversion, MeasuredBytes } from './types.ts';

/** HTML (worst-case fill, minified) plus CSS (minified) one adapter may add to a page. */
export const ADAPTER_BYTE_LIMIT = 48 * 1024;

/** A preview stored in the product must stay this small (WebP). */
export const PREVIEW_BYTE_LIMIT = 40 * 1024;

const CONVERTED_STATUSES = ['insertable', 'adapter-needed', 'app-only', 'pending-fetch'] as const;
export type ConvertedStatus = (typeof CONVERTED_STATUSES)[number];

export interface ConvertedReason { code: string; detail?: string }

export interface ConvertedBlock {
  name: string;
  status: ConvertedStatus;
  reasons: ConvertedReason[];
  /** Minified HTML (source fill) and CSS bytes, as the converter measured them. */
  htmlMin: number | null;
  cssMin: number | null;
  sourceSha256: string | null;
  /** Kit adapter source; set only for insertable blocks. */
  adapterSource: string | null;
}

export type ConvertedSet = ReadonlyMap<string, ConvertedBlock>;

/** The id an adapter and its catalog row share: the overlay's `data-od-selected-section`. */
export function cultAdapterId(name: string): string {
  return `cult:${name}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Parses one `converted/<name>/report.json`; throws on a shape the importer cannot trust. */
export function parseConvertedReport(value: unknown, name: string): Omit<ConvertedBlock, 'adapterSource'> {
  const where = `converted/${name}/report.json`;
  if (!isObject(value)) throw new Error(`${where}: expected an object`);
  if (value.name !== name) throw new Error(`${where}: name ${JSON.stringify(value.name)} does not match`);
  const status = value.status;
  if (typeof status !== 'string' || !(CONVERTED_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`${where}: unknown status ${JSON.stringify(status)}`);
  }
  const reasons: ConvertedReason[] = [];
  for (const raw of Array.isArray(value.reasons) ? value.reasons : []) {
    if (!isObject(raw) || typeof raw.code !== 'string' || raw.code.length === 0) throw new Error(`${where}: malformed reason`);
    reasons.push(typeof raw.detail === 'string' ? { code: raw.code, detail: raw.detail } : { code: raw.code });
  }
  if (status === 'adapter-needed' && reasons.length === 0) throw new Error(`${where}: adapter-needed without a reason`);
  if (status === 'insertable' && reasons.length > 0) throw new Error(`${where}: insertable with refusal reasons`);
  const sizes = isObject(value.sizes) ? value.sizes : {};
  const html = isObject(sizes.html) ? num(sizes.html.min) : null;
  const css = isObject(sizes.css) ? num(sizes.css.min) : null;
  const sha = typeof value.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sourceSha256) ? value.sourceSha256 : null;
  if (status === 'insertable' && (html === null || css === null || sha === null)) {
    throw new Error(`${where}: an insertable block needs measured html/css bytes and a sourceSha256`);
  }
  return { name, status: status as ConvertedStatus, reasons, htmlMin: html, cssMin: css, sourceSha256: sha };
}

/** Reads the converter output for every name given; null when the kit has no `converted/` dir. */
export function readConverted(kitDir: string, names: readonly string[]): Map<string, ConvertedBlock> | null {
  const root = join(kitDir, 'converted');
  if (!existsSync(root)) return null;
  const out = new Map<string, ConvertedBlock>();
  for (const name of names) {
    const reportPath = join(root, name, 'report.json');
    if (!existsSync(reportPath)) continue;
    const block = parseConvertedReport(JSON.parse(readFileSync(reportPath, 'utf8')), name);
    const adapterPath = join(root, name, 'adapter.ts');
    const adapterSource = block.status === 'insertable' ? (existsSync(adapterPath) ? readFileSync(adapterPath, 'utf8') : null) : null;
    if (block.status === 'insertable' && adapterSource === null) throw new Error(`converted/${name}: insertable but adapter.ts is missing`);
    out.set(name, { ...block, adapterSource });
  }
  return out;
}

/**
 * The converter's source hash: SHA-256 over every registry item file's `content`, concatenated
 * with no separator in `path` order (plain code-unit comparison). Mirrors `sourceSha` in the kit's
 * `scripts/convert.mjs` exactly.
 */
export function converterSourceSha(files: ReadonlyArray<{ path: string; content: string }>): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) hash.update(file.content);
  return hash.digest('hex');
}

/** The `version: "…"` field of a converted adapter module. */
export function adapterVersionOf(source: string): string {
  const match = /^ {2}version: "([^"\\]+)",$/m.exec(source);
  if (!match?.[1]) throw new Error('adapter source has no version field');
  return match[1];
}

const KIT_IMPORT = "import { escapeHtml, type SectionAdapter } from './section-adapter.ts';";
const PRODUCT_IMPORT = "import { escapeHtml, type SectionAdapter } from '../section-adapter.ts';";

function replaceOnce(source: string, from: string, to: string, what: string): string {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + 1) >= 0) throw new Error(`expected exactly one ${what}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

/**
 * The committed form of one kit adapter: the only two edits are the import (the kit's
 * `./section-adapter.ts` sits next to the adapter; the product's shim is one level up) and the
 * id, which becomes the catalog id `cult:<name>` so the overlay's `data-od-selected-section`
 * equals the catalog entry id. Everything else, including CSS and `render`, is byte-identical.
 */
export function productAdapterSource(kitSource: string, name: string): string {
  let out = replaceOnce(kitSource, KIT_IMPORT, PRODUCT_IMPORT, 'section-adapter import');
  out = replaceOnce(out, `\n  id: "cult-${name}",\n`, `\n  id: "${cultAdapterId(name)}",\n`, `id "cult-${name}"`);
  // The converter already names the source block by its catalog id; refuse anything else.
  replaceOnce(out, `\n  sourceBlockId: "${cultAdapterId(name)}",\n`, '', `sourceBlockId "${cultAdapterId(name)}"`);
  const header = '// Copied by packages/cult-ui-catalog/scripts/adapters.ts: only the import path and the id differ\n'
    + `// from the kit's converted/${name}/adapter.ts. Do not edit; re-run \`pnpm --filter @mish/cult-ui-catalog adapters\`.\n`;
  return header + out;
}

export interface ConversionFields {
  conversion: Conversion;
  adapter: AdapterRef | null;
  measuredBytes: MeasuredBytes;
  previewId: string | null;
}

/** Preview id of an insertable row: the file under `generated/previews/`. */
export function previewIdFor(name: string): string {
  return `${name}.webp`;
}

/**
 * Catalog fields for one row from its converter result. App rows stay `app-only` whatever the
 * converter said; pending rows stay pending; a refusal becomes `adapter-needed` with its reason
 * codes; an insertable block gets its adapter reference and measured bytes.
 */
export function conversionFields(
  row: { name: string; assetKind: string; conversion: Conversion },
  block: ConvertedBlock | undefined,
): ConversionFields | null {
  if (!block || row.conversion.status === 'pending-fetch' || row.assetKind === 'app') return null;
  if (block.status === 'insertable') {
    return {
      conversion: { status: 'insertable' },
      adapter: { id: cultAdapterId(row.name), version: adapterVersionOf(block.adapterSource ?? ''), sourceSha256: block.sourceSha256 ?? '' },
      measuredBytes: { html: block.htmlMin, css: block.cssMin, js: 0 },
      previewId: previewIdFor(row.name),
    };
  }
  if (block.status === 'adapter-needed') {
    const codes = [...new Set(block.reasons.map((r) => r.code))];
    return {
      conversion: { status: 'adapter-needed', reason: `converter refused: ${codes.join(', ')}` },
      adapter: null,
      measuredBytes: { html: block.htmlMin, css: block.cssMin, js: null },
      previewId: null,
    };
  }
  return null;
}
