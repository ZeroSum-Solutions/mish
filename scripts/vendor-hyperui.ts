#!/usr/bin/env node
// Vendor MIT HTML/CSS blocks from HyperUI (markmead/hyperui) at a pinned commit, for the
// generative UI page kinds (marketing site, web-app shell, CRM dashboard).
//
// HyperUI's examples are full standalone HTML pages built with Tailwind classes; the fast lane
// renders a static HTML string with inline CSS, so only the block markup is kept: the inner HTML
// of <body>, with every <img> and <script> removed (no kit JavaScript, no example images per the
// generative-ui design doc §3), and any element whose only content was an image dropped with it.
// Only "light" variants are kept — HyperUI ships a `<n>-dark.html` twin of every `<n>.html`.
//
// Usage:
//   node --experimental-strip-types scripts/vendor-hyperui.ts
//   node --experimental-strip-types scripts/vendor-hyperui.ts --check
//
// Flags:
//   --check   Disk-only drift check: no network, no token. Re-derives every assertion from what
//             is already committed (manifest.json's block list and byte counts, the forbidden
//             substrings, UPSTREAM.json's pinned commit, and pagekinds.json's css/<kind>.css and
//             block references) and exits 1 on any mismatch. This is the CI gate (wired into the
//             Preflight job in .github/workflows/ci.yml, right after the agency-compiler sync
//             check) — CI has no GitHub token budget and must not depend on GitHub API/raw
//             reachability. The network-fetching path below runs only for a real vendor run.
//
// Output, under plugins/_official/shared/ui-kits/hyperui/:
//   LICENSE                        copied verbatim from the pinned commit
//   UPSTREAM.json                  { repo, commit, fetchedAt }
//   manifest.json                  { upstream, tailwindCliVersion, blocks: [{ id, file, bytes,
//                                     images: 0, scripts: 0, collapsed?: true }] }
//   blocks/<group>/<name>/<n>.html one file per kept block
//
// Idempotent: re-running with nothing changed upstream rewrites nothing and leaves fetchedAt
// alone. fetchedAt only advances when the vendored block set actually changes.

import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = 'markmead/hyperui';
const COMMIT = 'ae5038979b77320793360a46b85e7c71a73beda6';

// The per-block guard from the design doc (§3): "the published HTML must stay under the 1 MiB
// per-file guard" for a rendered page, and the plan's own step 4 note ("every block under 20 KB")
// for a single vendored block. A handful of upstream blocks (dense footers with a full sitemap,
// logo walls with many inline brand SVGs) run well past that on their own, well before any page
// composition; they are skipped rather than vendored oversized, and reported.
const BLOCK_MAX_BYTES = 20 * 1024;

// Must match TAILWIND_CLI_VERSION in scripts/build-ui-kit-css.ts. Recorded here (not derived) so
// the disk-only --check and a human reading manifest.json both know which pin produced the
// committed css/<kind>.css without re-running the (author-time-only) CSS build.
const TAILWIND_CLI_VERSION = '4.3.3';

const FORBIDDEN_SUBSTRINGS = ['<script', '<img', 'http://', 'https://', 'srcset', 'url(', '<video', '<iframe'];

const GROUPS: Record<string, string[]> = {
  marketing: ['sections', 'feature-grids', 'pricing', 'ctas', 'footers', 'testimonials', 'logo-clouds', 'stats'],
  application: [
    'stats',
    'tables',
    'side-menu',
    'vertical-menu',
    'filters',
    'timelines',
    'details-list',
    'empty-states',
    'tabs',
    'charts',
  ],
};

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const kitRoot = path.join(repoRoot, 'plugins/_official/shared/ui-kits/hyperui');

interface ManifestBlock {
  id: string;
  file: string;
  bytes: number;
  images: number;
  scripts: number;
  collapsed?: true;
}

interface Manifest {
  upstream: { repo: string; commit: string; fetchedAt: string };
  tailwindCliVersion: string;
  blocks: ManifestBlock[];
}

interface PageKinds {
  [kind: string]: string[];
}

interface ContentsEntry {
  name: string;
  type: string;
}

async function fetchJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = { 'user-agent': 'open-design-vendor-hyperui' };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': 'open-design-vendor-hyperui' } });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function listLightVariants(group: string, name: string): Promise<string[]> {
  const url = `https://api.github.com/repos/${REPO}/contents/public/examples/${group}/${name}?ref=${COMMIT}`;
  const entries = (await fetchJson(url)) as ContentsEntry[] | { message?: string };
  if (!Array.isArray(entries)) {
    const message = (entries as { message?: string }).message ?? JSON.stringify(entries);
    throw new Error(`unexpected contents response for ${group}/${name}: ${message}`);
  }
  return entries
    .filter((entry) => entry.type === 'file' && entry.name.endsWith('.html') && !entry.name.includes('-dark'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Repeatedly drop a wrapping element whose entire content, once whitespace is ignored, was one or
// more <img> tags and nothing else. Runs to a fixed point so a nested wrapper (an <a> around a
// <div> around an <img>) empties all the way out, and so a grid of several images (one wrapper,
// multiple <img> siblings, no other content) is removed as a unit rather than left behind empty.
function stripImageOnlyWrappers(html: string): string {
  const wrapperPattern = /<([a-zA-Z][\w-]*)\b[^>]*>(?:\s*<img\b[^>]*\/?>)+\s*<\/\1>/g;
  let previous: string;
  let current = html;
  do {
    previous = current;
    current = current.replace(wrapperPattern, '');
  } while (current !== previous);
  return current;
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Column-utility tokens that reserve a second column/row on the wrapping element. Bare (mobile
// default) and breakpoint-prefixed (sm:/md:/lg:/xl:/2xl:) variants both count.
const COLUMN_TOKEN_PATTERN = /^(?:(?:sm|md|lg|xl|2xl):)?grid-cols-2$/;
const FLEX_WRAPPER_TOKEN_PATTERN = /^(?:(?:sm|md|lg|xl|2xl):)?flex$/;
const HALF_WIDTH_TOKEN_PATTERN = /^(?:(?:sm|md|lg|xl|2xl):)?(?:w-1\/2|basis-1\/2)$/;

function classTokens(openTag: string): string[] {
  const match = openTag.match(/\sclass="([^"]*)"/);
  const value = match?.[1];
  if (value === undefined) return [];
  return value.split(/\s+/).filter(Boolean);
}

function withoutClassTokens(openTag: string, drop: Set<string>): string {
  return openTag.replace(/\sclass="([^"]*)"/, (full, value: string) => {
    const kept = value.split(/\s+/).filter((token) => token && !drop.has(token));
    return kept.length > 0 ? ` class="${kept.join(' ')}"` : '';
  });
}

// After image stripping, a wrapper that reserved a column/row for a now-removed image sibling can
// be left with exactly one child element and a stale `grid-cols-2` (or a flex `w-1/2`/`basis-1/2`
// counterpart on that lone child) — rendering a blank half. Detected structurally (a real tag
// stack, not per-block-id): any element whose open tag carries one of the target tokens, once it
// resolves to having exactly one child ELEMENT (text/whitespace does not count), has that token
// removed so the layout collapses to one column. Applies generically to every vendored block.
function collapseSingleChildColumns(html: string): { html: string; collapsed: boolean } {
  const tagPattern = /<!--[\s\S]*?-->|<\/?[a-zA-Z][\w-]*(?:\s+[^<>]*)?\/?>/g;
  const segments: string[] = [];
  let lastIndex = 0;
  for (const match of html.matchAll(tagPattern)) {
    if (match.index > lastIndex) segments.push(html.slice(lastIndex, match.index));
    segments.push(match[0]);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < html.length) segments.push(html.slice(lastIndex));

  interface Frame {
    tagName: string;
    openSegmentIndex: number;
    childCount: number;
    lastChildSegmentIndex: number | null;
  }
  const stack: Frame[] = [];
  let collapsed = false;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;
    if (!segment.startsWith('<') || segment.startsWith('<!--')) continue;

    const isClosing = segment.startsWith('</');
    const nameMatch = segment.match(/^<\/?([a-zA-Z][\w-]*)/);
    if (!nameMatch) continue;
    const rawTagName = nameMatch[1];
    if (rawTagName === undefined) continue;
    const tagName = rawTagName.toLowerCase();

    if (isClosing) {
      const top = stack[stack.length - 1];
      if (top && top.tagName === tagName) {
        stack.pop();
        if (top.childCount === 1) {
          const openTag = segments[top.openSegmentIndex];
          if (openTag === undefined) continue;
          const tokens = classTokens(openTag);
          const columnTokens = tokens.filter((t) => COLUMN_TOKEN_PATTERN.test(t));
          if (columnTokens.length > 0) {
            const next = withoutClassTokens(openTag, new Set(columnTokens));
            if (next !== openTag) {
              segments[top.openSegmentIndex] = next;
              collapsed = true;
            }
          } else if (tokens.some((t) => FLEX_WRAPPER_TOKEN_PATTERN.test(t)) && top.lastChildSegmentIndex !== null) {
            const childOpenTag = segments[top.lastChildSegmentIndex];
            if (childOpenTag && childOpenTag.startsWith('<') && !childOpenTag.startsWith('</')) {
              const childTokens = classTokens(childOpenTag);
              const halfWidthTokens = childTokens.filter((t) => HALF_WIDTH_TOKEN_PATTERN.test(t));
              if (halfWidthTokens.length > 0) {
                const next = withoutClassTokens(childOpenTag, new Set(halfWidthTokens));
                if (next !== childOpenTag) {
                  segments[top.lastChildSegmentIndex] = next;
                  collapsed = true;
                }
              }
            }
          }
        }
      }
      continue;
    }

    const isSelfClosing = /\/>\s*$/.test(segment) || VOID_ELEMENTS.has(tagName);
    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      if (parent === undefined) throw new Error('collapseSingleChildColumns: stack invariant violated (empty top frame)');
      parent.childCount += 1;
      parent.lastChildSegmentIndex = i;
    }
    if (!isSelfClosing) {
      stack.push({ tagName, openSegmentIndex: i, childCount: 0, lastChildSegmentIndex: null });
    }
  }

  return { html: segments.join(''), collapsed };
}

function extractBlock(html: string, sourceUrl: string): { content: string; collapsed: boolean } {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) throw new Error(`no <body> found in ${sourceUrl}`);
  const bodyContent = bodyMatch[1];
  if (bodyContent === undefined) throw new Error(`<body> matched but its capture group was empty in ${sourceUrl}`);
  let block = bodyContent;

  // No kit JavaScript at all.
  block = block.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  // No example images: drop wrapper elements that existed only to hold one (or a grid of several),
  // then any image left with non-image siblings.
  block = stripImageOnlyWrappers(block);
  block = block.replace(/<img\b[^>]*\/?>/gi, '');

  // A wrapper that reserved a second column/row for the image just removed would otherwise render
  // a blank half.
  const { html: collapsedBlock, collapsed } = collapseSingleChildColumns(block);
  block = collapsedBlock;

  // Inline SVGs carry an xmlns (and sometimes xmlns:xlink) namespace URI; it is optional on an
  // <svg> embedded in an HTML document and is the one legitimate source of an "http://" string
  // once images and scripts are gone.
  block = block.replace(/\s+xmlns(:[\w-]+)?="https?:\/\/[^"]*"/gi, '');

  // Any other absolute http(s) reference left in an href/src (an upstream demo link) is a
  // placeholder the vendored block should not ship as a live external link.
  block = block.replace(/\s(href|src)="https?:\/\/[^"]*"/gi, ' $1="#"');

  // Removing a tag can leave a now-empty line with only its old indentation; git flags trailing
  // whitespace, so trim it line by line rather than reflowing the file.
  block = block
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');

  return { content: block.trim() + '\n', collapsed };
}

interface FetchedBlock {
  id: string;
  file: string;
  content: string;
  collapsed: boolean;
}

async function fetchAllBlocks(): Promise<{ blocks: FetchedBlock[]; skipped: string[] }> {
  const blocks: FetchedBlock[] = [];
  const skipped: string[] = [];
  for (const [group, names] of Object.entries(GROUPS)) {
    for (const name of names) {
      const files = await listLightVariants(group, name);
      if (files.length === 0) {
        const message = `${group}/${name}: no light variant found`;
        console.warn(`skip ${message}`);
        skipped.push(message);
        continue;
      }
      for (const file of files) {
        const n = file.replace(/\.html$/, '');
        const id = `${group}/${name}/${n}`;
        const rawUrl = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/public/examples/${group}/${name}/${file}`;
        const html = await fetchText(rawUrl);
        const { content, collapsed } = extractBlock(html, rawUrl);
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes >= BLOCK_MAX_BYTES) {
          const message = `${id}: ${bytes} bytes, over the ${BLOCK_MAX_BYTES} byte per-block guard`;
          console.warn(`skip ${message}`);
          skipped.push(message);
          continue;
        }
        blocks.push({ id, file: `blocks/${group}/${name}/${n}.html`, content, collapsed });
      }
    }
  }
  blocks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { blocks, skipped };
}

function readExisting(): { manifest: Manifest | null; upstream: { repo: string; commit: string; fetchedAt: string } | null } {
  const manifestPath = path.join(kitRoot, 'manifest.json');
  const upstreamPath = path.join(kitRoot, 'UPSTREAM.json');
  const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest) : null;
  const upstream = existsSync(upstreamPath)
    ? (JSON.parse(readFileSync(upstreamPath, 'utf8')) as { repo: string; commit: string; fetchedAt: string })
    : null;
  return { manifest, upstream };
}

function blockContentUnchanged(file: string, content: string): boolean {
  const filePath = path.join(kitRoot, file);
  if (!existsSync(filePath)) return false;
  return readFileSync(filePath, 'utf8') === content;
}

// The CI gate: everything it asserts is re-derived from files already committed to the repo. No
// fetch, no GITHUB_TOKEN — CI has neither reliable network reach nor a token budget for this, and
// per-PR runs would exhaust the unauthenticated GitHub API rate limit within a few concurrent
// jobs. Building the real vendored set (fetchAllBlocks) stays reserved for an explicit vendor
// run (no `--check` flag).
function checkDiskOnly(): string[] {
  const problems: string[] = [];

  const manifestPath = path.join(kitRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    problems.push('manifest.json missing');
    return problems;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

  const upstreamPath = path.join(kitRoot, 'UPSTREAM.json');
  if (!existsSync(upstreamPath)) {
    problems.push('UPSTREAM.json missing');
  } else {
    const upstream = JSON.parse(readFileSync(upstreamPath, 'utf8')) as { commit: string };
    if (upstream.commit !== COMMIT) {
      problems.push(`UPSTREAM.json commit ${upstream.commit} != pinned ${COMMIT}`);
    }
  }

  const licensePath = path.join(kitRoot, 'LICENSE');
  if (!existsSync(licensePath)) {
    problems.push('LICENSE missing');
  } else if (!readFileSync(licensePath, 'utf8').startsWith('MIT License')) {
    problems.push('LICENSE does not start with "MIT License"');
  }

  for (const block of manifest.blocks) {
    const blockPath = path.join(kitRoot, block.file);
    if (!existsSync(blockPath)) {
      problems.push(`${block.id}: ${block.file} missing`);
      continue;
    }
    const content = readFileSync(blockPath, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes !== block.bytes) {
      problems.push(`${block.id}: manifest says ${block.bytes} bytes, disk has ${bytes}`);
    }
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      if (content.includes(forbidden)) {
        problems.push(`${block.id}: contains forbidden substring "${forbidden}"`);
      }
    }
  }

  const pageKindsPath = path.join(kitRoot, 'pagekinds.json');
  if (!existsSync(pageKindsPath)) {
    problems.push('pagekinds.json missing');
  } else {
    const pageKinds = JSON.parse(readFileSync(pageKindsPath, 'utf8')) as PageKinds;
    for (const [kind, blockIds] of Object.entries(pageKinds)) {
      const cssPath = path.join(kitRoot, 'css', `${kind}.css`);
      if (!existsSync(cssPath)) problems.push(`page kind "${kind}": css/${kind}.css missing`);
      for (const blockId of blockIds) {
        const blockPath = path.join(kitRoot, 'blocks', `${blockId}.html`);
        if (!existsSync(blockPath)) problems.push(`page kind "${kind}": referenced block ${blockId} missing`);
      }
    }
  }

  return problems;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');

  if (check) {
    const problems = checkDiskOnly();
    if (problems.length > 0) {
      for (const problem of problems) console.error(`drift: ${problem}`);
      console.error('vendor-hyperui: drift detected. Run `node --experimental-strip-types scripts/vendor-hyperui.ts` and commit the result.');
      process.exitCode = 1;
      return;
    }
    console.log('vendor-hyperui: in sync (disk-only check, no network).');
    return;
  }

  const { blocks: fetched, skipped } = await fetchAllBlocks();
  const { manifest: existingManifest } = readExisting();

  const nextBlocks: ManifestBlock[] = fetched.map((block) => ({
    id: block.id,
    file: block.file,
    bytes: Buffer.byteLength(block.content, 'utf8'),
    images: 0,
    scripts: 0,
    ...(block.collapsed ? { collapsed: true as const } : {}),
  }));

  const existingBlocksById = new Map((existingManifest?.blocks ?? []).map((b) => [b.id, b]));
  const nextIds = new Set(nextBlocks.map((b) => b.id));

  let changed = existingBlocksById.size !== nextBlocks.length;
  for (const block of fetched) {
    const prior = existingBlocksById.get(block.id);
    if (!prior || prior.file !== `${block.file}` || Boolean(prior.collapsed) !== block.collapsed) changed = true;
    if (!blockContentUnchanged(block.file, block.content)) changed = true;
  }
  for (const id of existingBlocksById.keys()) {
    if (!nextIds.has(id)) changed = true;
  }
  if (existingManifest && existingManifest.tailwindCliVersion !== TAILWIND_CLI_VERSION) changed = true;

  const licenseUrl = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/LICENSE`;
  const license = await fetchText(licenseUrl);
  const licensePath = path.join(kitRoot, 'LICENSE');
  const licenseChanged = !existsSync(licensePath) || readFileSync(licensePath, 'utf8') !== license;
  if (licenseChanged) changed = true;

  const fetchedAt = changed ? new Date().toISOString() : (existingManifest?.upstream.fetchedAt ?? new Date().toISOString());
  const upstream = { repo: REPO, commit: COMMIT, fetchedAt };

  // Remove stale block files for ids that no longer exist upstream.
  if (existingManifest) {
    for (const block of existingManifest.blocks) {
      if (!nextIds.has(block.id)) {
        const stalePath = path.join(kitRoot, block.file);
        if (existsSync(stalePath)) rmSync(stalePath);
      }
    }
  }

  for (const block of fetched) {
    const filePath = path.join(kitRoot, block.file);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, block.content);
  }

  if (licenseChanged) writeFileSync(licensePath, license);

  writeFileSync(path.join(kitRoot, 'UPSTREAM.json'), `${JSON.stringify(upstream, null, 2)}\n`);

  const manifest: Manifest = { upstream, tailwindCliVersion: TAILWIND_CLI_VERSION, blocks: nextBlocks };
  writeFileSync(path.join(kitRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const totalBytes = nextBlocks.reduce((sum, b) => sum + b.bytes, 0);
  console.log(
    `vendor-hyperui: ${changed ? 'wrote' : 'unchanged,'} ${nextBlocks.length} blocks, ${totalBytes} bytes total (commit ${COMMIT.slice(0, 8)}).`,
  );
  if (skipped.length > 0) {
    console.log(`vendor-hyperui: skipped ${skipped.length} block(s):`);
    for (const line of skipped) console.log(`  - ${line}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export { extractBlock, stripImageOnlyWrappers };
