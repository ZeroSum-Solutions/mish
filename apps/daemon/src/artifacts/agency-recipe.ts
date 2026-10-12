import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, type CheerioAPI } from 'cheerio';
import type { AgencyRecipeAsset, AgencyRecipeChange, AgencyRecipeConflict, AgencyRecipeData, ReconcileAgencyRecipeRequest, ReconcileAgencyRecipeResponse } from '@open-design/contracts';
import { agencyPublicationScope } from './deploy-scope.js';

type DocumentNode = ReturnType<CheerioAPI['root']>[number];
type Node = DocumentNode | DocumentNode['children'][number];
type ApprovedInput = Omit<AgencyRecipeAsset, 'sha256' | 'mediaType' | 'bytes'> & Partial<Pick<AgencyRecipeAsset, 'sha256' | 'mediaType' | 'bytes'>>;
interface FamilyRuntime {
  validateWatsonRecipe(input: unknown): AgencyRecipeData;
  getWatsonAssetRequirements(input: unknown): Array<{ id: string; kind: AgencyRecipeAsset['kind'] }>;
  renderWatson(input: unknown, paths: Record<string, string>): string;
}
/** The shared compiler's effect placements (`agency-site/scripts/effects.ts`), loaded only for a
 * baseline that carries applied effects. Structural: this module reads only these two calls. */
type EffectHost = { id: string } | { odId: string };
interface EffectDeclaration { placements: Partial<Record<string, { host: EffectHost; allow: string[] }>> }
interface EffectPlan { effects: Array<{ placement: string; componentId: string; source: 'hint' | 'jev' | 'repair' }> }
interface EffectsRuntime {
  readFamilyEffectDeclaration(family: string): EffectDeclaration | null;
  applyEffectPlan(html: string, plan: EffectPlan, declaration: EffectDeclaration | null): { html: string };
}
interface AssetRuntime {
  resolveApprovedAssets(input: unknown, requirements: Array<{ id: string; kind: AgencyRecipeAsset['kind'] }>, revision: string): { paths: Record<string, string>; assets: Array<ApprovedInput & { destination: string }> };
  readApprovedAsset(root: string, asset: ApprovedInput): Promise<Buffer>;
}
export interface ReconcileAgencyRecipeOptions {
  projectRoot: string;
  templatesRoot: string;
  entry: string;
  skillId: string | null;
  baseSource: string;
  baseVersionDigest: string | undefined;
  request: ReconcileAgencyRecipeRequest;
}
const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2' };
class Conflict extends Error {
  constructor(readonly code: string, message: string, readonly target?: string) { super(message); }
}

/** Every component, including intermediate directories, must stay within this project. */
async function safePath(root: string, relative: string): Promise<string> {
  if (!relative || relative.length > 240 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(relative)
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Conflict('unsafe-path', 'Expected a bounded project-relative path.');
  let current = await realpath(root);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Conflict('unsafe-path', 'Reconciliation inputs must not contain symlinks.');
  }
  return current;
}
async function readBounded(root: string, relative: string, limit: number): Promise<Buffer> {
  const file = await safePath(root, relative);
  const info = await lstat(file);
  if (!info.isFile() || info.size > limit) throw new Conflict('invalid-input', 'Input is not a bounded regular file.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Conflict('invalid-input', 'Input is not a bounded regular file.');
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new Conflict('invalid-input', 'Input exceeds its byte limit.');
    return bytes;
  } finally { await handle.close(); }
}

/** Fixed bundled imports: no project/module path or code is selected by the recipe. Node 24 strips these resource TS files. */
export async function loadAgencyRecipeRuntime(templatesRoot: string) {
  const root = path.join(templatesRoot, 'agency-site/scripts');
  const family = await import(/* @vite-ignore */ pathToFileURL(path.join(root, 'families/watson/render.ts')).href) as FamilyRuntime;
  const assets = await import(/* @vite-ignore */ pathToFileURL(path.join(root, 'assets.ts')).href) as AssetRuntime;
  return { family, assets };
}

/** Loaded on demand: a page without applied effects never needs it, so a copy that predates
 * effects keeps reconciling exactly as before. */
async function loadEffectsRuntime(templatesRoot: string): Promise<EffectsRuntime> {
  return await import(/* @vite-ignore */ pathToFileURL(path.join(templatesRoot, 'agency-site/scripts/effects.ts')).href) as EffectsRuntime;
}

/** The one element a declared host names, or none when it is absent or ambiguous. */
function hostElement($: CheerioAPI, host: EffectHost) {
  const found = 'id' in host
    ? $('[id]').filter((_, element) => $(element).attr('id') === host.id)
    : $('[data-od-id]').filter((_, element) => $(element).attr('data-od-id') === host.odId);
  return found.length === 1 ? found : undefined;
}

/**
 * The effect plan a saved baseline was built with, read back from the baseline itself: every
 * declared placement whose host carries a `data-genui` component in the saved page but not in the
 * plain family render. The daemon's build record is not reachable from a project, and the saved
 * version is the authority here anyway — and nothing is trusted on its word: the caller re-renders
 * the recipe WITH this plan (the compiler re-checks every id against the family allowlist) and
 * still requires an exact match, so a forged attribute only produces a mismatch.
 */
function savedEffectPlan(plain: string, saved: string, declaration: EffectDeclaration | null): EffectPlan {
  const effects: EffectPlan['effects'] = [];
  if (!declaration) return { effects };
  const $plain = load(plain), $saved = load(saved);
  for (const [placement, entry] of Object.entries(declaration.placements)) {
    if (!entry) continue;
    const componentId = hostElement($saved, entry.host)?.attr('data-genui');
    if (!componentId || hostElement($plain, entry.host)?.attr('data-genui') !== undefined) continue;
    // Replayed, never chosen here: `repair` is provenance only (the compiler reads no policy from it).
    effects.push({ placement, componentId, source: 'repair' });
  }
  return { effects };
}

function normalized(node: Node, ignoreImageHints: boolean): unknown {
  if ('attribs' in node) {
    const attrs = Object.fromEntries(Object.entries(node.attribs).filter(([key]) => !(ignoreImageHints && ['img', 'source'].includes(node.name) && key === 'data-asset-id')).sort(([a], [b]) => a.localeCompare(b)));
    return [node.type, node.name, attrs, node.children.map((child) => normalized(child, ignoreImageHints))];
  }
  if ('data' in node) return [node.type, node.type === 'directive' ? node.data.toLowerCase() : node.data];
  return [node.type, 'children' in node ? node.children.filter((child) => child.type !== 'text' || child.data.trim()).map((child) => normalized(child, ignoreImageHints)) : []];
}
function sameHtml(a: string, b: string, ignoreImageHints = false): boolean {
  return JSON.stringify(normalized(load(a).root()[0]!, ignoreImageHints)) === JSON.stringify(normalized(load(b).root()[0]!, ignoreImageHints));
}
function target($: CheerioAPI, id: string) {
  const found = $('[data-od-id]').filter((_, element) => $(element).attr('data-od-id') === id);
  if (found.length !== 1) throw new Conflict('target-conflict', 'Expected exactly one saved edit target.', id);
  return found;
}
function unsupportedDifference(expected: string, current: CheerioAPI): AgencyRecipeConflict {
  const generated = load(expected);
  for (const element of generated('[data-od-id]').toArray()) {
    const id = generated(element).attr('data-od-id')!;
    const actual = current('[data-od-id]').filter((_, e) => current(e).attr('data-od-id') === id);
    if (actual.length !== 1) return { code: 'target-conflict', message: 'An editable target was removed or duplicated.', target: id };
    if (generated(element).closest('a').attr('href') !== actual.closest('a').attr('href')) return { code: 'derived-link-conflict', message: 'Saved label and derived link do not agree with the recipe.', target: id };
  }
  return { code: 'unsupported-html-change', message: 'Saved HTML contains structure, style, attributes, script or unbound content changes that this recipe cannot preserve.' };
}

/** Read-only. Call under the authorized project's existing per-entry version lock. */
export async function reconcileAgencyRecipe(options: ReconcileAgencyRecipeOptions): Promise<ReconcileAgencyRecipeResponse> {
  let sourceDigest = '';
  const baseVersionId = typeof options.request?.baseVersionId === 'string' ? options.request.baseVersionId : '';
  const failure = (conflicts: AgencyRecipeConflict[]): ReconcileAgencyRecipeResponse => ({ ok: false, regenerationSafe: false, sourceDigest, baseVersionId, conflicts });
  try {
    const { projectRoot, entry, request } = options;
    if (options.skillId !== 'agency-site') throw new Conflict('unsupported-project', 'Reconciliation requires a persisted Agency Site project.');
    if (!/^[a-z][a-z0-9-]*\.html$/.test(entry)) throw new Conflict('unsafe-path', 'Expected a root Agency Site HTML entry.');
    const fields = ['baseRecipeFile', 'approvedAssetManifestFile', 'baseVersionId', 'expectedSourceDigest'];
    if (!request || Object.keys(request).length !== fields.length || fields.some((key) => typeof (request as unknown as Record<string, unknown>)[key] !== 'string')
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(baseVersionId) || !/^[a-f0-9]{64}$/.test(request.expectedSourceDigest)
      || !request.baseRecipeFile.endsWith('.json') || !request.approvedAssetManifestFile.endsWith('.json')) throw new Conflict('invalid-request', 'Expected recipe/roster JSON paths, a saved base version and a current SHA-256.');
    const source = (await readBounded(projectRoot, entry, 2 * 1024 * 1024)).toString('utf8');
    sourceDigest = sha(source);
    if (sourceDigest !== request.expectedSourceDigest) throw new Conflict('stale-source', 'The saved HTML changed. Read its current digest and reconcile again.');
    const manifestBytes = await readBounded(projectRoot, `${entry}.artifact.json`, 256 * 1024);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const scope = agencyPublicationScope(manifest, entry, true)!;
    const marker = manifest.metadata.agencySite;
    if (marker.publication !== 'closed-assets-v2' || marker.family !== 'watson') throw new Conflict('unsupported-family', 'Only the Watson v2 family has verified reconciliation bindings. Emmpo and v1 remain HTML-authoritative.');
    if (Buffer.byteLength(options.baseSource) > 2 * 1024 * 1024 || options.baseVersionDigest !== sha(options.baseSource)) throw new Conflict('base-version-digest', 'The saved baseline version failed its content digest check.');
    const { family, assets } = await loadAgencyRecipeRuntime(options.templatesRoot);
    const recipe = family.validateWatsonRecipe(JSON.parse((await readBounded(projectRoot, request.baseRecipeFile, 64 * 1024)).toString('utf8')));
    if (sha(JSON.stringify(recipe)) !== marker.recipeDigest || `watson-r${recipe.revision}` !== marker.revision) throw new Conflict('recipe-digest', 'The base recipe does not match the selected artifact generation digest/revision.');
    const roster: { version: 1; assets: ApprovedInput[] } = JSON.parse((await readBounded(projectRoot, request.approvedAssetManifestFile, 64 * 1024)).toString('utf8'));
    const resolved = assets.resolveApprovedAssets(roster, family.getWatsonAssetRequirements(recipe), marker.revision);
    let renderedBase = family.renderWatson(recipe, resolved.paths);
    // A page built with effects (Sol ruling 2026-09-25) is the family render plus the compiler's
    // deterministic decoration. Replay that same plan on every re-render below, so the baseline and
    // the regenerated page are compared like with like.
    let withEffects = (html: string) => html;
    if (!sameHtml(renderedBase, options.baseSource)) {
      const effectsRuntime = await loadEffectsRuntime(options.templatesRoot).catch(() => undefined);
      const declaration = effectsRuntime?.readFamilyEffectDeclaration('watson') ?? null;
      const plan = effectsRuntime ? savedEffectPlan(renderedBase, options.baseSource, declaration) : { effects: [] };
      if (effectsRuntime && plan.effects.length > 0) {
        withEffects = (html) => effectsRuntime.applyEffectPlan(html, plan, declaration).html;
        renderedBase = withEffects(renderedBase);
      }
      if (!sameHtml(renderedBase, options.baseSource)) throw new Conflict('baseline-render-mismatch', 'The supplied baseline is not this recipe rendered by the current trusted family. Edited baselines and renderer drift are refused.');
    }
    const next = structuredClone(recipe), current = load(source), baseline = load(renderedBase);
    const changes: AgencyRecipeChange[] = [];
    const promotedAssets: AgencyRecipeAsset[] = [];
    const sourcePaths = new Map(roster.assets.map((asset) => [asset.id, `assets/agency-site/${marker.revision}/${asset.file}`]));
    const descriptors = new Map(roster.assets.map((asset) => [asset.id, asset]));
    const prefix = `assets/agency-site/${marker.revision}/`;
    const verified = new Map<string, AgencyRecipeAsset>();
    async function verify(id: string): Promise<AgencyRecipeAsset> {
      const cached = verified.get(id); if (cached) return cached;
      const descriptor = descriptors.get(id)!, relative = sourcePaths.get(id)!;
      if (!scope.has(relative)) throw new Conflict('undeclared-asset', 'An asset is outside the saved artifact publication scope.', id);
      await safePath(projectRoot, relative);
      const bytes = await assets.readApprovedAsset(path.join(projectRoot, prefix), descriptor);
      const mediaType = MIME[path.extname(descriptor.file).slice(1)];
      if (!mediaType) throw new Conflict('unsupported-asset', 'Watson requires raster images or WOFF fonts.', id);
      const value: AgencyRecipeAsset = { ...descriptor, sha256: sha(bytes), mediaType, bytes: bytes.length };
      verified.set(id, value); return value;
    }
    // A roster may not invent the original file identities or hashes.
    for (const { id } of family.getWatsonAssetRequirements(recipe)) await verify(id);
    async function imageId(relative: string, editId: string): Promise<string> {
      if (!scope.has(relative) || !relative.startsWith(prefix) || !/^[a-z0-9][a-z0-9-]*\.(png|jpe?g|webp|avif)$/.test(relative.slice(prefix.length))) throw new Conflict('undeclared-asset', 'Image must be a declared raster in the current saved revision.', editId);
      const matches = [...sourcePaths].filter(([, value]) => value === relative);
      if (matches.length > 1) throw new Conflict('asset-id-conflict', 'More than one approved ID maps to this image.', editId);
      if (matches[0]) { const value = await verify(matches[0][0]); if (value.kind !== 'image') throw new Conflict('asset-role', 'Expected an approved image.', editId); return value.id; }
      const bytes = await readBounded(projectRoot, relative, 10 * 1024 * 1024);
      const id = `manual-image-${sha(`${relative}\0${sha(bytes)}`)}`;
      if (descriptors.has(id)) throw new Conflict('asset-id-conflict', 'The generated local image ID collides with the approved roster.', editId);
      const descriptor: ApprovedInput = { id, file: relative.slice(prefix.length), kind: 'image', sha256: sha(bytes), bytes: bytes.length };
      descriptors.set(id, descriptor); sourcePaths.set(id, relative);
      const validated = await verify(id); promotedAssets.push(validated);
      return id;
    }
    for (const section of next.sections) {
      const set = (group: 'content' | 'assets', key: string, value: string) => {
        const before = section[group][key]!;
        if (before !== value) { changes.push({ sectionId: section.id, field: `${group}.${key}`, before, after: value }); section[group][key] = value; }
      };
      for (const key of Object.keys(section.content)) {
        const id = `${section.id}:${key}`;
        if (!baseline('[data-od-id]').toArray().some((e) => baseline(e).attr('data-od-id') === id)) continue;
        set('content', key, target(current, id).text());
      }
      const alts = new Map<string, Array<{ value: string; id: string }>>();
      for (const key of Object.keys(section.assets)) {
        const id = `${section.id}:${key}`, element = target(current, id), tag = element[0]!.type === 'tag' ? element[0]!.name : '';
        if (tag !== 'img' && tag !== 'source') throw new Conflict('target-conflict', 'Image slot is no longer an image/source element.', id);
        set('assets', key, await imageId(element.attr(tag === 'img' ? 'src' : 'srcset') ?? '', id));
        const altKey = section.type === 'footer' && key === 'awardDesktop' ? 'awardAlt' : section.type === 'statement' ? (key.startsWith('top') ? 'topAlt' : 'bottomAlt') : undefined;
        if (tag === 'img' && altKey) alts.set(altKey, [...(alts.get(altKey) ?? []), { value: element.attr('alt') ?? '', id }]);
      }
      for (const [key, values] of alts) {
        if (new Set(values.map(({ value }) => value)).size !== 1) throw new Conflict('shared-field-conflict', 'Images sharing one recipe alt field have different saved alt text.', values.map(({ id }) => id).join(', '));
        set('content', key, values[0]!.value);
      }
    }
    family.validateWatsonRecipe(next);
    const needed = family.getWatsonAssetRequirements(next);
    const approved = await Promise.all(needed.map(({ id }) => verify(id)));
    const paths = Object.fromEntries(needed.map(({ id }) => [id, sourcePaths.get(id)!]));
    const expected = withEffects(family.renderWatson(next, paths));
    if (!sameHtml(expected, source, true)) return failure([unsupportedDifference(expected, current)]);
    // External file writers do not participate in the native lock; detect a changed source before returning.
    if (sha(await readBounded(projectRoot, entry, 2 * 1024 * 1024)) !== sourceDigest) throw new Conflict('stale-source', 'The saved HTML changed during reconciliation. Retry from its current digest.');
    if (sha(await readBounded(projectRoot, `${entry}.artifact.json`, 256 * 1024)) !== sha(manifestBytes)) throw new Conflict('stale-manifest', 'The saved publication scope changed during reconciliation. Retry with its current state.');
    return { ok: true, regenerationSafe: true, sourceDigest, baseVersionId, recipe: next, approvedAssetManifest: { version: 1, assets: approved }, assetSources: approved.map((asset) => ({ ...asset, sourcePath: sourcePaths.get(asset.id)! })), promotedAssets, changes, conflicts: [] };
  } catch (error) {
    return failure([error instanceof Conflict ? { code: error.code, message: error.message, ...(error.target ? { target: error.target } : {}) } : { code: 'invalid-input', message: 'A recipe, asset, manifest or trusted renderer failed validation. No regeneration-safe data was produced.' }]);
  }
}
