import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import * as tar from 'tar';
import type { React95Edit, React95Kit, React95KitFile, React95Patch, React95PatchReason, React95VendoredFile } from '../../src/workbench/kits/react95/kit-types.js';
import { applyEdits, react95UnitFiles, unitPathOf, unitSpecifierOf } from '../../src/workbench/kits/react95/unit.js';
import { typecheckUnit } from './react95-typecheck.js';

/**
 * R17 / AC-R17.1 acquisition (deterministic; runs only on demand, never in an
 * ordinary test run, and never fetches anything). Input is the GitHub archive
 * of the exact requested source, `react95-io/React95@871d5335…`, downloaded
 * once by a person. The archive's pax header must name that commit; nothing
 * else (in particular not `arturbien/React95`, which the upstream manifest
 * links) is accepted.
 *
 * Output is the kit module the daemon ships (`src/workbench/kits/react95/kit.generated.ts`)
 * and its evidence copy without file texts. It records:
 * - the shipped inventory: every source file the upstream Rollup build ships
 *   (the import graph of `src/index.ts` and `src/types.ts`, the themes, the
 *   font and image files it copies), grouped per exported component, each
 *   with its git blob id and SHA-256, so it can be compared with
 *   `git ls-tree` of the commit;
 * - the vendored bytes: only the source closure the two admitted templates
 *   import, plus the code licence, the font licence/readme notices and
 *   `src/index.ts`. Font and image binaries are inventoried, never vendored;
 * - the two authored templates from `apps/daemon/kits/react95/templates/`.
 *
 * Regenerate with
 * `OD_REACT95_UPSTREAM_ARCHIVE=<path to the .tar.gz> pnpm --filter @open-design/daemon exec vitest run tests/workbench/react95-kit-source.test.ts`.
 */
export const REACT95_REPOSITORY = 'https://github.com/react95-io/React95';
export const REACT95_COMMIT = '871d5335daebdda1469f66f81266523f4191a595';
export const REACT95_ARCHIVE_URL = `https://codeload.github.com/react95-io/React95/tar.gz/${REACT95_COMMIT}`;

const daemonRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export const REACT95_TEMPLATE_DIR = join(daemonRoot, 'kits', 'react95', 'templates');
export const REACT95_KIT_MODULE_PATH = join(daemonRoot, 'src', 'workbench', 'kits', 'react95', 'kit.generated.ts');
export const REACT95_KIT_DOC_PATH = join(repoRoot, 'docs', 'plans', '2026-10-02-design-workbench', 'evidence', 'implementation-start', 'react95-source-inventory.json');
/** Template id → authored file. The order is the catalogue order. */
export const REACT95_ADAPTER_FILES = ['React95Theme.d.ts'] as const;
export const REACT95_TEMPLATE_FILES = [
  { id: 'window-app', file: 'React95WindowApp.tsx', title: 'Windows95 application window' },
  { id: 'settings-form', file: 'React95SettingsForm.tsx', title: 'Windows95 settings form' },
] as const;
const EXTERNALS = ['react', 'react/*', 'react-dom', 'react-dom/*', 'styled-components'];

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** The id git gives the same bytes (`git hash-object`), comparable with `git ls-tree <commit>`. */
export const gitBlobId = (bytes: Buffer) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
const posix = (value: string) => value.split('\\').join('/');
const describe = (root: string, path: string): React95KitFile => {
  const bytes = readFileSync(join(root, path));
  return { path, gitBlob: gitBlobId(bytes), sha256: sha256(bytes), bytes: bytes.length };
};

/** The pax global header of a GitHub archive carries `comment=<commit>`. */
export function archiveCommit(archive: Buffer): string | null {
  const tarBytes = gunzipSync(archive);
  const header = tarBytes.subarray(0, 512);
  if (String.fromCharCode(header[156]!) !== 'g') return null;
  const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim(), 8);
  const body = tarBytes.subarray(512, 512 + size).toString('utf8');
  return /\d+ comment=([a-f0-9]{40})\n/u.exec(body)?.[1] ?? null;
}

function walk(root: string, dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir)).sort()) {
    const path = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, path)).isDirectory()) walk(root, path, out);
    else out.push(path);
  }
  return out;
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}(?:\/[^'"]+)?)['"]/gu;
/** Relative specifiers a TypeScript file imports or re-exports (type-only ones included), with their offsets. */
function specifierSites(text: string): { specifier: string; at: number }[] {
  return [...text.matchAll(SPECIFIER)].map(match => ({ specifier: match[1]!, at: match.index! + match[0].lastIndexOf(match[1]!) }));
}
function relativeSpecifiers(text: string): string[] {
  return [...new Set(specifierSites(text).map(site => site.specifier))];
}
function resolveRelative(root: string, from: string, specifier: string): string {
  const base = posix(join(from, '..', specifier)).replace(/^\.\//u, '');
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(join(root, candidate)) && statSync(join(root, candidate)).isFile()) return candidate;
  }
  throw new Error(`Unresolved import ${specifier} from ${from}`);
}
/**
 * The full source closure a TypeScript project needs, type-only imports
 * included (a bundler drops those, a type checker does not).
 */
export function importClosure(root: string, entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const specifier of relativeSpecifiers(readFileSync(join(root, path), 'utf8'))) queue.push(resolveRelative(root, path, specifier));
  }
  return [...seen].sort();
}

async function metafileInputs(absWorkingDir: string, entryPoints: string[]): Promise<string[]> {
  const result = await build({
    entryPoints, absWorkingDir, bundle: true, write: false, metafile: true, logLevel: 'silent', platform: 'browser',
    format: 'esm', jsx: 'automatic', external: EXTERNALS, outdir: 'out',
  }).catch((error: { errors?: { text: string; location?: { file: string } | null }[] }) => {
    throw new Error(`esbuild: ${(error.errors ?? []).map(e => `${e.location?.file ?? '?'}: ${e.text}`).join('; ')}`);
  });
  return Object.keys(result.metafile!.inputs).map(posix).sort();
}

export async function buildReact95Kit(archivePath: string): Promise<React95Kit> {
  const archive = readFileSync(archivePath);
  const commit = archiveCommit(archive);
  if (commit !== REACT95_COMMIT) throw new Error(`The archive is not react95-io/React95@${REACT95_COMMIT} (pax commit ${commit ?? 'missing'})`);
  const work = mkdtempSync(join(tmpdir(), 'react95-kit-'));
  try {
    const extracted = join(work, 'archive');
    mkdirSync(extracted);
    await tar.x({ file: archivePath, cwd: extracted });
    const top = readdirSync(extracted);
    if (top.length !== 1 || top[0] !== `React95-${REACT95_COMMIT}`) throw new Error(`Unexpected archive layout: ${top.join(', ')}`);
    const upstream = join(extracted, top[0]!);
    const manifest = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8')) as { name: string; version: string; license: string; peerDependencies: Record<string, string>; repository: string; files: string[] };
    if (manifest.name !== 'react95') throw new Error(`Unexpected package ${manifest.name}`);

    // Shipped set: what the upstream rollup build emits from src (index/types graph, themes) and copies (fonts/dist, images).
    const graph = await metafileInputs(upstream, ['src/index.ts', 'src/types.ts']);
    const all = walk(upstream, 'src');
    const themes = all.filter(path => path.startsWith('src/common/themes/'));
    const fonts = all.filter(path => path.startsWith('src/assets/fonts/'));
    const images = all.filter(path => path.startsWith('src/assets/images/'));
    const shippedSource = [...new Set([...graph.filter(path => path.startsWith('src/')), ...themes])].sort();

    // Component groups follow the export lines of src/index.ts.
    const index = readFileSync(join(upstream, 'src', 'index.ts'), 'utf8');
    const exportPaths = [...index.matchAll(/^export \* from '\.\/([^']+)';$/gmu)].map(match => match[1]!);
    const components = exportPaths.map(exported => {
      const legacy = exported.startsWith('legacy/');
      const name = exported.split('/').pop()!;
      const prefix = legacy ? `src/${exported}.` : `src/${exported.split('/')[0]}/`;
      const files = shippedSource.filter(path => path.startsWith(prefix)).map(path => describe(upstream, path));
      if (!files.length) throw new Error(`No shipped files for ${exported}`);
      return { id: `${legacy ? 'legacy-' : ''}${name.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()}`, name, exportPath: `./${exported}`, legacy, files };
    });
    const grouped = new Set(components.flatMap(component => component.files.map(file => file.path)));
    const shared = shippedSource.filter(path => !grouped.has(path) && !path.startsWith('src/common/themes/')).map(path => describe(upstream, path));

    // Flat unit layout: every shipped upstream source file under its flat name, with its
    // relative imports rewritten (declared `flat-layout` edits against the upstream text).
    const vendor = (path: string): React95VendoredFile => ({ ...describe(upstream, path), text: readFileSync(join(upstream, path), 'utf8') });
    const layoutEdits = new Map<string, React95Edit[]>();
    const unit = join(work, 'unit');
    mkdirSync(unit);
    const flatToUpstream = new Map<string, string>();
    for (const path of shippedSource) {
      const text = readFileSync(join(upstream, path), 'utf8');
      const edits = specifierSites(text).map(site => ({ at: site.at, deleteCount: site.specifier.length, insert: unitSpecifierOf(resolveRelative(upstream, path, site.specifier)) }));
      layoutEdits.set(path, edits);
      flatToUpstream.set(unitPathOf(path), path);
      writeFileSync(join(unit, unitPathOf(path)), applyEdits(text, edits));
    }
    const templates = REACT95_TEMPLATE_FILES.map(template => {
      const text = readFileSync(join(REACT95_TEMPLATE_DIR, template.file), 'utf8');
      writeFileSync(join(unit, template.file), text);
      return { ...template, text, sha256: sha256(text) };
    });
    const closures = new Map<string, string[]>();
    for (const template of templates) {
      // Runtime (bundler) inputs must be a subset of the type-inclusive closure.
      const runtime = (await metafileInputs(unit, [template.file])).filter(path => flatToUpstream.has(path));
      const full = importClosure(unit, [template.file]).filter(path => path !== template.file);
      for (const path of full) if (!flatToUpstream.has(path)) throw new Error(`Template imports an unshipped upstream file: ${path}`);
      for (const path of runtime) if (!full.includes(path)) throw new Error(`Closure scan missed ${path}`);
      closures.set(template.id, full.map(path => flatToUpstream.get(path)!).sort());
    }
    const closure = [...new Set([...closures.values()].flat())].sort();

    const adapters = REACT95_ADAPTER_FILES.map(file => {
      const text = readFileSync(join(REACT95_TEMPLATE_DIR, file), 'utf8');
      return { file, sha256: sha256(text), text };
    });
    const patches = patchForProjectProfile(join(work, 'typecheck'), templates, adapters, closure.map(vendor), layoutEdits);
    const fontFamilies = ['ms-sans-serif', 'ms-sans-serif-bold'].map(dir => ({
      family: dir === 'ms-sans-serif' ? 'MS Sans Serif' : 'MS Sans Serif Bold',
      licence: vendor(`src/assets/fonts/src/${dir}/license.txt`),
      readme: vendor(`src/assets/fonts/src/${dir}/readme.txt`),
      files: fonts.filter(path => path.startsWith(`src/assets/fonts/src/${dir}/`) && /\.(?:ttf|otf)$/u.test(path)).map(path => describe(upstream, path)),
    }));
    const kit: React95Kit = {
      schema: 'react95-kit/1',
      source: {
        repository: REACT95_REPOSITORY, commit: REACT95_COMMIT,
        archive: { url: REACT95_ARCHIVE_URL, sha256: sha256(archive), paxCommit: commit },
        packageName: manifest.name, packageVersion: manifest.version, manifestLicense: manifest.license, manifestRepository: manifest.repository,
        peerDependencies: manifest.peerDependencies, packageFiles: manifest.files,
        packageJson: describe(upstream, 'package.json'),
      },
      inventory: {
        components, shared,
        themes: themes.map(path => describe(upstream, path)),
        fonts: fonts.map(path => describe(upstream, path)),
        images: images.map(path => describe(upstream, path)),
      },
      notices: { code: vendor('LICENSE'), fonts: fontFamilies },
      vendored: [...closure, 'src/index.ts'].sort().map(vendor),
      templates: templates.map(template => ({ id: template.id, title: template.title, file: template.file, sha256: template.sha256, text: template.text, closure: closures.get(template.id)! })),
      adapters, patches,
    };
    return kit;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Diagnostics that a declared edit resolves; any other diagnostic fails the acquisition. */
const TYPE_ONLY_EXPORT = 1205;
const TYPE_ONLY_IMPORT = 1484;
const NODE_GLOBAL = 2591;
const BUFFER_CAST = '(globalThis as unknown as { Buffer: { from(value: string): { toString(encoding: string): string } } }).Buffer';

/**
 * Computes the declared edits that make the vendored closure type-check under
 * `REACT95_TYPECHECK_PROFILE`: type-only names in export and import lists get
 * an inline `type` modifier, and the Node-only `Buffer` reference (a fallback
 * that browsers never take) is read from `globalThis` so DOM-only projects
 * type-check. Templates and adapters must already be clean.
 */
function patchForProjectProfile(dir: string, templates: readonly { file: string; text: string }[], adapters: readonly { file: string; text: string }[], vendored: readonly React95VendoredFile[], layout: ReadonlyMap<string, readonly React95Edit[]>): React95Patch[] {
  const write = (editsOf: (path: string) => readonly React95Edit[]) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const file of [...templates, ...adapters]) writeFileSync(join(dir, file.file), file.text);
    for (const file of vendored) writeFileSync(join(dir, unitPathOf(file.path)), applyEdits(file.text, editsOf(file.path)));
  };
  const byFlat = new Map(vendored.map(file => [unitPathOf(file.path), file]));
  /** Maps an offset in the layout-edited text back to the upstream text (type edits never fall inside a rewritten specifier). */
  const toUpstream = (edits: readonly React95Edit[], offset: number) => {
    let delta = 0;
    for (const edit of [...edits].sort((a, b) => a.at - b.at)) {
      const start = edit.at + delta;
      if (offset < start) break;
      if (offset < start + edit.insert.length) throw new Error('A type edit falls inside a rewritten import specifier');
      delta += edit.insert.length - edit.deleteCount;
    }
    return offset - delta;
  };
  const entries = [...templates.map(t => t.file), ...adapters.map(a => a.file)];
  write(path => layout.get(path) ?? []);
  const typeEdits = new Map<string, Map<number, React95Edit & { reason: React95PatchReason }>>();
  for (const diagnostic of typecheckUnit(dir, entries)) {
    const file = diagnostic.file ? byFlat.get(diagnostic.file) : undefined;
    if (!file || diagnostic.start === null) throw new Error(`Unexpected diagnostic outside the vendored closure: ${diagnostic.file ?? '?'} TS${diagnostic.code} ${diagnostic.message}`);
    const at = toUpstream(layout.get(file.path) ?? [], diagnostic.start);
    const forFile = typeEdits.get(file.path) ?? new Map();
    typeEdits.set(file.path, forFile);
    if (diagnostic.code === TYPE_ONLY_EXPORT || diagnostic.code === TYPE_ONLY_IMPORT) forFile.set(at, { at, deleteCount: 0, insert: 'type ', reason: diagnostic.code === TYPE_ONLY_EXPORT ? 'TS1205' : 'TS1484' });
    else if (diagnostic.code === NODE_GLOBAL && file.text.slice(at, at + 6) === 'Buffer') forFile.set(at, { at, deleteCount: 6, insert: BUFFER_CAST, reason: 'TS2591' });
    else throw new Error(`No declared edit resolves ${file.path} TS${diagnostic.code}: ${diagnostic.message}`);
  }
  const patches: React95Patch[] = vendored.flatMap(file => {
    const layoutList = (layout.get(file.path) ?? []).map(edit => ({ ...edit, reason: 'flat-layout' as const }));
    const list = [...layoutList, ...(typeEdits.get(file.path)?.values() ?? [])].sort((a, b) => a.at - b.at);
    if (!list.length) return [];
    const patched = applyEdits(file.text, list);
    const order: React95PatchReason[] = ['flat-layout', 'TS1205', 'TS1484', 'TS2591'];
    return [{ path: file.path, upstreamSha256: file.sha256, patchedSha256: sha256(patched), reasons: order.filter(reason => list.some(edit => edit.reason === reason)), edits: list.map(({ reason: _reason, ...edit }) => edit) }];
  });
  write(path => patches.find(patch => patch.path === path)?.edits ?? []);
  const remaining = typecheckUnit(dir, entries);
  if (remaining.length) throw new Error(`Patched closure still fails the profile: ${remaining.map(d => `${d.file ?? '?'} TS${d.code}`).join(', ')}`);
  return patches;
}

/** The evidence copy: every identity and digest, without file texts. */
export function react95KitEvidence(kit: React95Kit): unknown {
  const strip = ({ text: _text, ...file }: React95VendoredFile) => file;
  return {
    ...kit,
    notices: { code: strip(kit.notices.code), fonts: kit.notices.fonts.map(font => ({ ...font, licence: strip(font.licence), readme: strip(font.readme) })) },
    vendored: kit.vendored.map(strip),
    templates: kit.templates.map(({ text: _text, ...template }) => template),
    adapters: kit.adapters.map(({ text: _text, ...adapter }) => adapter),
  };
}

export function writeReact95Kit(kit: React95Kit): void {
  mkdirSync(join(REACT95_KIT_MODULE_PATH, '..'), { recursive: true });
  writeFileSync(REACT95_KIT_DOC_PATH, `${JSON.stringify(react95KitEvidence(kit), null, 2)}\n`);
  writeFileSync(REACT95_KIT_MODULE_PATH, [
    '// Generated by apps/daemon/tests/workbench/react95-kit-build.ts; do not edit.',
    '// Exact requested source react95-io/React95@871d5335daebdda1469f66f81266523f4191a595; evidence copy:',
    '// docs/plans/2026-10-02-design-workbench/evidence/implementation-start/react95-source-inventory.json.',
    "import type { React95Kit } from './kit-types.js';",
    '',
    `export const REACT95_KIT: React95Kit = ${JSON.stringify(kit, null, 2)};`,
    '',
  ].join('\n'));
}

/** Writes each template's unit (exactly the files apply writes) into `dir`. */
export function materializeReact95Unit(kit: React95Kit, dir: string, templateIds: readonly string[] = kit.templates.map(t => t.id)): void {
  for (const id of templateIds) {
    for (const file of react95UnitFiles(kit, id)!) {
      mkdirSync(join(dir, file.path, '..'), { recursive: true });
      writeFileSync(join(dir, file.path), file.bytes);
    }
  }
}

export const relativeToRepo = (path: string) => posix(relative(repoRoot, path));
export const kitTemplatePath = (file: string) => join(REACT95_TEMPLATE_DIR, file);
export const react95KitExists = () => existsSync(REACT95_KIT_MODULE_PATH);
