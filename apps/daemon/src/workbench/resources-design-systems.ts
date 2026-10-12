import { createHash } from 'node:crypto';
import { kitTokenAxes, kitTokenNames } from './component-kit.js';
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ResourceCandidate, ResourceRef, ResourceRequestContext, ResourceSourceSnapshot } from '@open-design/contracts';
import { designSystemPackageFileUrl } from '../routes/design-systems.js';
import type { ResourceSourceAdapter } from './resources.js';
import type { TokenSpecimen } from './token-evidence.js';
import { userKitItems, type OwnedKitListing, type UserKitReason } from './resources-user-design-systems.js';

/**
 * AC-R04.1/AC-R04.2 inventory for the design-system packages under the daemon's
 * design-systems *resource* root (the bundled catalog, never the daemon data root).
 *
 * Every package that ships `manifest.json` (every bundled entry does, see
 * design-systems/_schema/AGENTS.md) yields the design system itself plus one item
 * per token cohort its own `design-tokens.json` actually declares. A category with
 * no declared tokens is omitted, never synthesized; a declared file that cannot be
 * read degrades the source with a named reason instead of silently shrinking it
 * (an unreadable declared token stylesheet also withdraws the cohort previews,
 * which are styled by it).
 * Readiness stays `unverified`: no per-item acceptance evidence exists, so nothing
 * here can be `usable` or adoptable.
 */
const MANIFEST_SCHEMA = 'od-design-system-project/v1';
const TOKENS_FORMAT = 'od-design-tokens/v1';
const PACKAGE_ID = /^[a-z0-9-]+$/;
const FILE_LIMIT = 2 * 1024 * 1024;
/** Work budgets, not inventory quotas: exceeding one is reported as a degraded reason. */
type Limits = { readonly packages: number; readonly previewPages: number; readonly fonts: number };
export const DESIGN_SYSTEM_INVENTORY_LIMITS: Limits = Object.freeze({ packages: 256, previewPages: 32, fonts: 64 });

type TokenCategory = 'color-palette' | 'type-scale' | 'spacing-scale' | 'motion';
type DesignToken = { name: string; type: string; value: string };
type ManifestFont = { family: string; file: string };
type PreviewPage = { path: string; role?: string };
interface PackageManifest {
  id: string; name: string; sourceType: string; origin: string | null;
  design: string; tokens: string; tokensDeclared: boolean; designTokens: string | null; fonts: ManifestFont[]; pages: PreviewPage[];
}
/** Listing-level reasons, reported in this order when present. */
const REASONS = ['invalid-design-system-package', 'package-outside-root', 'package-limit-exceeded', 'design-tokens-unreadable', 'tokens-css-unreadable', 'preview-page-unreadable', 'preview-page-limit-exceeded', 'font-file-unreadable', 'font-limit-exceeded'] as const;
type Reason = typeof REASONS[number];
type Tally = Map<Reason, number>;
const note = (tally: Tally, reason: Reason, count = 1) => { if (count > 0) tally.set(reason, (tally.get(reason) ?? 0) + count); };

/** Which declared tokens make up each cohort, and which declared preview-page role shows it. */
const COHORTS: ReadonlyArray<{ category: TokenCategory; label: string; role: string; matches(token: DesignToken): boolean }> = [
  { category: 'color-palette', label: 'color palette', role: 'colors', matches: token => token.type === 'color' },
  { category: 'type-scale', label: 'type scale', role: 'typography', matches: token => /^--(text|leading|tracking)-/.test(token.name) },
  { category: 'spacing-scale', label: 'spacing scale', role: 'spacing', matches: token => token.type === 'dimension' && token.name.startsWith('--space-') },
  { category: 'motion', label: 'motion', role: 'motion', matches: token => token.type === 'duration' || token.type === 'cubicBezier' },
];

class InvalidPackage extends Error {}
class OutsideRoot extends Error {}
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const within = (parent: string, child: string) => child.startsWith(parent + path.sep);
/** Readable slug plus a short hash of the exact family, so `Inter Display` and `inter_display` never collide. */
const fontItemSlug = (family: string) => `${family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'font'}-${sha256(family).slice(0, 8)}`;

/**
 * A package-relative regular file, read at most FILE_LIMIT bytes. Opens first with
 * O_NOFOLLOW, then requires the open handle to be the same inode as the realpath that
 * lies inside the package, so a swapped symlink or an escaping parent directory is refused.
 */
export async function readPackageFile(packageRoot: string, relative: string): Promise<Buffer | null> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => part === '..' || part === '')) return null;
  const filename = path.join(packageRoot, relative);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > FILE_LIMIT) return null;
    const real = await realpath(filename);
    if (!within(packageRoot, real)) return null;
    const checked = await stat(real);
    if (checked.dev !== opened.dev || checked.ino !== opened.ino) return null;
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length <= FILE_LIMIT;) {
      ({ bytesRead: read } = await handle.read(buffer, length, buffer.length - length, null));
      length += read;
    }
    return length > FILE_LIMIT ? null : buffer.subarray(0, length);
  } catch { return null; } finally { await handle?.close(); }
}

function parseManifest(raw: Buffer, dirName: string): PackageManifest {
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw new InvalidPackage('manifest-json'); }
  if (!isRecord(value) || value.schemaVersion !== MANIFEST_SCHEMA || value.id !== dirName || !PACKAGE_ID.test(dirName)) throw new InvalidPackage('manifest-identity');
  const name = text(value.name);
  const source = isRecord(value.source) ? value.source : null;
  const files = isRecord(value.files) ? value.files : null;
  if (!name || !source || !text(source.type) || !files) throw new InvalidPackage('manifest-shape');
  const fonts = Array.isArray(value.fonts) ? value.fonts.flatMap(font => isRecord(font) && text(font.family) && text(font.file) ? [{ family: text(font.family)!, file: text(font.file)! }] : []) : [];
  const preview = isRecord(value.preview) && Array.isArray(value.preview.pages) ? value.preview.pages : [];
  const pages = preview.flatMap(page => isRecord(page) && text(page.path) ? [{ path: text(page.path)!, ...(text(page.role) ? { role: text(page.role)! } : {}) }] : []);
  return {
    id: dirName, name, sourceType: text(source.type)!, origin: text(source.origin),
    design: text(files.design) ?? 'DESIGN.md', tokens: text(files.tokens) ?? 'tokens.css', tokensDeclared: text(files.tokens) !== null,
    designTokens: text(files.designTokens), fonts, pages,
  };
}

/** Declared token JSON that does not parse as the token format is unreadable, not empty. */
function parseTokens(raw: Buffer | null): DesignToken[] | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (!isRecord(value) || value.format !== TOKENS_FORMAT || !Array.isArray(value.tokens)) return null;
    return value.tokens.flatMap(token => isRecord(token) && text(token.name) && text(token.type) && typeof token.value === 'string' ? [{ name: text(token.name)!, type: text(token.type)!, value: token.value }] : []);
  } catch { return null; }
}

/** Builds one package's items, or throws. Paths never leave this function. */
async function packageItems(root: string, dirName: string, limits: Limits, tally: Tally): Promise<ResourceCandidate[] | null> {
  const packageRoot = await realpath(path.join(root, dirName));
  // A top-level entry (including a symlink) must resolve strictly inside the resource root.
  if (!within(root, packageRoot)) throw new OutsideRoot();
  const manifestBytes = await readPackageFile(packageRoot, 'manifest.json');
  if (!manifestBytes) {
    // A folder with neither manifest nor DESIGN.md is not a package (e.g. `_schema`).
    // A DESIGN.md-only folder is a package this adapter cannot index: report it.
    if (await readPackageFile(packageRoot, 'DESIGN.md')) throw new InvalidPackage('manifest-missing');
    return null;
  }
  const manifest = parseManifest(manifestBytes, dirName);
  const design = await readPackageFile(packageRoot, manifest.design);
  if (!design) throw new InvalidPackage('design-missing');
  const tokensCss = await readPackageFile(packageRoot, manifest.tokens);
  // The cohort preview pages link the declared token stylesheet; without it
  // they would render unstyled, so none is offered and the listing says why.
  const tokensCssUnreadable = manifest.tokensDeclared && !tokensCss;
  if (tokensCssUnreadable) note(tally, 'tokens-css-unreadable');
  const tokensJson = manifest.designTokens ? await readPackageFile(packageRoot, manifest.designTokens) : null;
  const parsedTokens = manifest.designTokens ? parseTokens(tokensJson) : [];
  if (parsedTokens === null) note(tally, 'design-tokens-unreadable');
  const tokens = parsedTokens ?? [];
  if (manifest.pages.length > limits.previewPages) note(tally, 'preview-page-limit-exceeded');
  if (manifest.fonts.length > limits.fonts) note(tally, 'font-limit-exceeded');
  const pages = manifest.pages.slice(0, limits.previewPages);
  const fonts = manifest.fonts.slice(0, limits.fonts);
  const pageBytes = new Map<string, Buffer>();
  for (const page of pages) {
    const bytes = await readPackageFile(packageRoot, page.path);
    if (bytes) pageBytes.set(page.path, bytes);
  }
  const fontFiles = new Map<string, Buffer>();
  for (const font of fonts) {
    const bytes = await readPackageFile(packageRoot, font.file);
    if (bytes) fontFiles.set(font.file, bytes);
  }
  // One package revision fences every item: any byte change makes old refs stale.
  const revision = `sha256:${sha256(JSON.stringify([
    ['manifest.json', sha256(manifestBytes)], [manifest.design, sha256(design)], [manifest.tokens, tokensCss ? sha256(tokensCss) : null],
    [manifest.designTokens, tokensJson ? sha256(tokensJson) : null],
    ...[...pageBytes].map(([file, bytes]) => [file, sha256(bytes)]), ...[...fontFiles].map(([file, bytes]) => [file, sha256(bytes)]),
  ]))}`;
  // Rights come from the package's own provenance: a bundled package ships with the
  // app; imported provenance (local/github/shadcn) carries no rights claim here.
  const bundled = manifest.sourceType === 'bundled';
  const attribution = { title: [manifest.name, manifest.origin ?? manifest.sourceType].join(' · ') };
  // Path form: the query form redirects HTML for unbound kits, and the web preview
  // harness refuses redirects. The path form also keeps package-relative URLs working.
  const staticUrl = (relative: string) => designSystemPackageFileUrl(manifest.id, relative);
  const item = (itemId: string, title: string, category: ResourceCandidate['category'], nativeFormat: string, preview: ResourceCandidate['previewCapability']): ResourceCandidate => ({
    ref: { sourceType: 'library', sourceId: 'design-systems', itemId, revisionOrDigest: revision } satisfies ResourceRef,
    title, category, readiness: 'unverified',
    compatibility: { nativeFormat, targets: [], state: 'unverified', reason: 'Per-item acceptance evidence is pending' },
    rightsStatus: bundled ? 'permitted' : 'unknown', fitReasons: [], previewCapability: preview,
    adoptionCapability: { available: false, reason: 'adapter-missing' }, sourceAttribution: attribution,
    implementationOrigin: bundled ? 'bundled' : `imported-${manifest.sourceType}`, styleTags: [category],
    operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Project need is not assessed by inventory discovery',
  });
  const items: ResourceCandidate[] = [
    item(manifest.id, manifest.name, 'design-system', MANIFEST_SCHEMA, { available: true, kind: 'html', url: `/api/design-systems/${encodeURIComponent(manifest.id)}/preview`, reason: null }),
  ];
  items[0]!.kitTokenAxes = kitTokenAxes(tokensCss?.toString('utf8') ?? '');
  items[0]!.kitTokenNames = kitTokenNames(tokensCss?.toString('utf8') ?? '');
  for (const cohort of COHORTS) {
    if (!tokens.some(cohort.matches)) continue;
    const declared = pages.filter(candidate => candidate.role === cohort.role);
    const page = declared.find(candidate => pageBytes.has(candidate.path));
    if (declared.length && !page) note(tally, 'preview-page-unreadable');
    const preview: ResourceCandidate['previewCapability'] = tokensCssUnreadable
      ? { available: false, kind: 'none', reason: 'tokens-css-unreadable' }
      : page
        ? { available: true, kind: 'html', url: staticUrl(page.path), reason: null }
        : { available: false, kind: 'none', reason: declared.length ? 'preview-page-unreadable' : 'no-declared-preview-page' };
    const entry = item(`${manifest.id}/${cohort.category}`, `${manifest.name} ${cohort.label}`, cohort.category, 'css-custom-properties', preview);
    if (cohort.category === 'motion' && tokensCss && /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/.test(tokensCss.toString('utf8'))) {
      entry.motionMetadata = { state: 'reduced-compatible', basis: 'declared', sourceRevisionOrDigest: revision, field: `${manifest.tokens} prefers-reduced-motion block`.slice(0, 200) };
    }
    items.push(entry);
  }
  const families = new Map<string, ManifestFont>();
  for (const font of fonts) if (!families.has(font.family)) families.set(font.family, font);
  for (const [family, font] of families) {
    if (!fontFiles.has(font.file)) note(tally, 'font-file-unreadable');
    const preview: ResourceCandidate['previewCapability'] = fontFiles.has(font.file) ? { available: true, kind: 'reference', url: staticUrl(font.file), reason: null } : { available: false, kind: 'none', reason: 'font-file-unavailable' };
    // Font rights are per family file, not inherited from the package's provenance.
    items.push({ ...item(`${manifest.id}/font/${fontItemSlug(family)}`, `${family} (${manifest.name})`, 'font', path.extname(font.file).slice(1) || 'font', preview), rightsStatus: 'unknown' });
  }
  return items;
}

/** `userKits` lists the caller's own visible kits under the daemon data root for THIS
 * request (see resources-user-design-systems.ts); omitted, only the bundled catalog is
 * listed. `preview` renders a user kit's token cohort for the workbench preview route. */
export function createDesignSystemsResourceSource(deps: { root: string; limits?: Partial<Limits>; userKits?: () => Promise<OwnedKitListing> }): ResourceSourceAdapter & Required<Pick<ResourceSourceAdapter, 'preview'>> {
  const limits: Limits = { ...DESIGN_SYSTEM_INVENTORY_LIMITS, ...deps.limits };
  const collect = async (context: ResourceRequestContext): Promise<{ snapshot: ResourceSourceSnapshot; specimens: TokenSpecimen[] }> => {
    const tally: Tally = new Map();
    const items: ResourceCandidate[] = [];
    let rootUnreadable = false;
    try {
      const root = await realpath(deps.root);
      const entries = (await readdir(root, { withFileTypes: true })).filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.')).map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'en'));
      note(tally, 'package-limit-exceeded', entries.length - limits.packages);
      for (const name of entries.slice(0, limits.packages)) {
        const local: Tally = new Map();
        try {
          const found = await packageItems(root, name, limits, local);
          if (found) items.push(...found);
          for (const [reason, count] of local) note(tally, reason, count);
        } catch (error) { note(tally, error instanceof OutsideRoot ? 'package-outside-root' : 'invalid-design-system-package'); }
      }
    } catch { rootUnreadable = true; }
    // The caller's own kits, listed for this request only, after the bundled catalog.
    const specimens: TokenSpecimen[] = [];
    const userReasons = new Map<string, number>();
    const userNote = (reason: string, count = 1) => userReasons.set(reason, (userReasons.get(reason) ?? 0) + count);
    if (deps.userKits) {
      try {
        const listing = await deps.userKits();
        if (listing.reason) userNote(listing.reason);
        if (listing.kits.length > limits.packages) userNote('user-kit-limit-exceeded', listing.kits.length - limits.packages);
        for (const kit of listing.kits.slice(0, limits.packages)) {
          const found = await userKitItems(kit, context, listing.workspace, (reason: UserKitReason) => userNote(reason));
          items.push(...found.items); specimens.push(...found.specimens);
        }
      } catch { userNote('user-kits-unreadable'); }
    }
    const reason = [
      ...(rootUnreadable ? ['resource-root-unreadable'] : []),
      ...REASONS.flatMap(key => tally.has(key) ? [`${key}:${tally.get(key)}`] : []),
      ...[...userReasons].map(([key, count]) => `${key}:${count}`),
    ].join('; ') || null;
    if (rootUnreadable && !items.length) return { snapshot: { items: [], status: { sourceId: 'design-systems', state: 'degraded', reason, itemCount: null, listingDigest: null } }, specimens };
    const listingDigest = sha256(JSON.stringify(items.map(item => [item.ref.itemId, item.ref.revisionOrDigest])));
    return { snapshot: { items, status: { sourceId: 'design-systems', state: reason ? 'degraded' : 'searched', reason, itemCount: items.length, listingDigest } }, specimens };
  };
  return {
    sourceId: 'design-systems',
    async list(context) { return (await collect(context)).snapshot; },
    async preview(ref, context) {
      const { snapshot, specimens } = await collect(context);
      return { snapshot, specimen: specimens.find(entry => entry.itemId === ref.itemId && entry.revision === ref.revisionOrDigest) ?? null };
    },
  };
}
