// Saved upstream references, private upstream source, and separately authored alternatives.
export const TWENTY1ST_RIGHTS = ['mit', 'reference-only'] as const;
export type Twenty1stRights = (typeof TWENTY1ST_RIGHTS)[number];

/**
 * Only a `mit` row may ship any locally held copy of the actual upstream component's screenshot —
 * a re-encoded fetch of 21st.dev's own CDN preview (`packages/21st-catalog/scripts/
 * twenty-first-thumbnails.ts`, served from `generated/21st-thumbnails/`) or a locally rendered
 * capture of a private implementation (`e2e/scripts/catalog-thumbnails.ts`, served from
 * `generated/21st-live-thumbnails/`). A `reference-only` row never gets either kind of local
 * image, even when a private implementation exists to render it from: its card shows the neutral
 * "no preview" placeholder (`Twenty1stPreview` kind `'none'`) instead. Both generators and the
 * daemon's `toItem()` projection (`apps/daemon/src/routes/twenty1st.ts`) gate on this one rule so
 * none of the three can drift from the other two.
 */
export function twenty1stMayShipLocalImage(rights: Twenty1stRights): boolean {
  return rights === 'mit';
}

/**
 * A catalog card's preview image for a 21st.dev row. `image` means the daemon serves a WebP at
 * `twenty1stPreviewUrl(id)` (`GET /api/21st/:id/reference-preview`) — a re-encoded copy of the
 * preview image 21st.dev itself publishes for the item on its own CDN (`cdn.21st.dev`), recorded
 * in the kit's per-item registry file and committed under `generated/21st-thumbnails/`
 * (`packages/21st-catalog/scripts/twenty-first-thumbnails.ts`) — never a remote CDN URL handed
 * to the browser. Because that committed copy still redistributes the upstream screenshot, it
 * only ever exists for a row `twenty1stMayShipLocalImage` allows (`rights === 'mit'`); every
 * `reference-only` row is `none`. `none` means the row has no image on record; the client builds
 * the image URL from the public id.
 */
export type Twenty1stPreview = { kind: 'none' } | { kind: 'image'; source: 'twenty-first-dev-cdn' };

/** The same-origin preview route of one 21st.dev row (`GET /api/21st/:id/reference-preview`). */
export function twenty1stPreviewUrl(id: string): string {
  return `/api/21st/${encodeURIComponent(id)}/reference-preview`;
}

export interface Twenty1stItem {
  /** `21st:<author>-<slug>`, stable and unique across the hand-picked set. */
  id: string;
  slug: string;
  name: string;
  /** Optional browse terms for a catalog adapter; the 21st route keeps its legacy item shape. */
  tags?: string[];
  author: string;
  authorProfileUrl: string;
  /** The item's own page on 21st.dev — never a Mishh-served source route. */
  itemUrl: string;
  rights: Twenty1stRights;
  /** "MIT © <holder>"; set only for `rights === 'mit'`. */
  licenseLabel: string | null;
  /** The upstream LICENSE's own URL (also the link to the upstream source repo); set only for
   * `rights === 'mit'`. */
  licenseUrl: string | null;
  /** The full upstream MIT notice (copyright line + permission text); set only for `rights === 'mit'`. */
  licenseNotice: string | null;
  /** Informational only (mirrors `rights === 'mit'`); owned alternative source actions are separate from upstream copyability. */
  copyable: boolean;
  /** Actual upstream source held in the user's private library; does not grant new rights. */
  privateImplementation?: Twenty1stPrivateImplementation;
  ownedAlternative?: Twenty1stOwnedAlternative;
  preview: Twenty1stPreview;
}

export interface Twenty1stListResponse {
  catalog: {
    profile: string;
    items: Twenty1stItem[];
  };
}

export const TWENTY1ST_BROWSE_TAGS: Record<string, string[]> = {
  '21st:dhileepkumargm-3d-cards-slider': ['card', 'slider'],
  '21st:jatin-yadav05-animated-geometric-card': ['card', 'animation'],
  '21st:ravikatiyar162-card': ['card'],
  '21st:hero-ui-card': ['card'],
  '21st:isaiahbjork-coach-scheduling-card': ['card', 'scheduling'],
  '21st:uniquesonu-dashboard-activities': ['dashboard'],
  '21st:efferd-dialog': ['dialog'],
  '21st:ruixen-ui-gallery-hover-carousel': ['gallery', 'carousel'],
  '21st:jahed-glass-testimonial-swiper': ['testimonial', 'slider'],
  '21st:moumensoliman-glassmorphism-listen-app': ['app', 'music'],
  '21st:moumensoliman-glassmorphism-portfolio': ['portfolio', 'app'],
  '21st:ruixen-ui-image-stream-hero': ['hero', 'gallery'],
  '21st:ravikatiyar162-offer-carousel': ['carousel', 'card'],
  '21st:xordev-phosphor-30': ['animation', 'background'],
  '21st:legionwebdev-radar-chart': ['chart', 'dashboard'],
  '21st:ruixen-ui-ruixenmonochat': ['app', 'chat'],
  '21st:rahil1202-scannercardstream': ['card', 'animation'],
  '21st:jahed-shared-element-gallery': ['gallery'],
  '21st:ruixen-ui-socialpostcard': ['card', 'social'],
  '21st:serafimcloud-spline-scene': ['animation', 'hero'],
  '21st:isaiahbjork-system-monitor': ['dashboard', 'chart'],
  '21st:kokonutd-background-paths': ['background', 'hero'],
};

export function twenty1stBrowseTags(item: Pick<Twenty1stItem, 'id'>): readonly string[] {
  return ('tags' in item && Array.isArray(item.tags) ? item.tags : TWENTY1ST_BROWSE_TAGS[item.id]) ?? [];
}

export interface Twenty1stListFilters {
  query?: string | undefined;
  tag?: string | undefined;
  rights?: string | undefined;
}

/** A single query contract for the web catalog and `od 21st list`. */
export function twenty1stListQuery(filters: Twenty1stListFilters): string {
  const params = new URLSearchParams();
  if (filters.query?.trim()) params.set('query', filters.query.trim());
  if (filters.tag && filters.tag !== 'all') params.set('tag', filters.tag);
  if (filters.rights && filters.rights !== 'all') params.set('rights', filters.rights);
  return params.size ? `?${params}` : '';
}

export function filterTwenty1stItems(items: readonly Twenty1stItem[], filters: Twenty1stListFilters): Twenty1stItem[] {
  const words = filters.query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return items.filter((item) => {
    if (filters.tag && filters.tag !== 'all' && !twenty1stBrowseTags(item).includes(filters.tag)) return false;
    if (filters.rights && filters.rights !== 'all' && item.rights !== filters.rights) return false;
    const haystack = [item.name, ...twenty1stBrowseTags(item), item.privateImplementation?.description,
      item.ownedAlternative?.description].filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

export interface Twenty1stItemResponse {
  item: Twenty1stItem;
}

function isTwenty1stRights(value: unknown): value is Twenty1stRights {
  return typeof value === 'string' && (TWENTY1ST_RIGHTS as readonly string[]).includes(value);
}

function parseTwenty1stPreview(value: unknown): Twenty1stPreview {
  const row = asRecord(value);
  if (row.kind === 'none') return { kind: 'none' };
  if (row.kind === 'image' && row.source === 'twenty-first-dev-cdn') return { kind: 'image', source: 'twenty-first-dev-cdn' };
  throw new Error('preview must be { kind: "none" } or { kind: "image", source: "twenty-first-dev-cdn" }');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('expected an object');
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') throw new Error(`${field} must be a string or null`);
  return value;
}

export function parseTwenty1stItem(value: unknown): Twenty1stItem {
  const row = asRecord(value);
  if (row.tags !== undefined && !Array.isArray(row.tags)) throw new Error('tags must be an array');
  if ('externalInstallCommand' in row) throw new Error('a 21st item must not carry an install command (round 2, withheld)');
  const rights = row.rights;
  if (!isTwenty1stRights(rights)) throw new Error(`rights must be one of ${TWENTY1ST_RIGHTS.join(', ')}`);
  const licenseLabel = asNullableString(row.licenseLabel, 'licenseLabel');
  const licenseUrl = asNullableString(row.licenseUrl, 'licenseUrl');
  const licenseNotice = asNullableString(row.licenseNotice, 'licenseNotice');
  const mitFields = [licenseLabel, licenseUrl, licenseNotice];
  if (rights === 'mit' && mitFields.some((f) => f === null)) throw new Error('a mit item must carry licenseLabel, licenseUrl and licenseNotice');
  if (rights === 'reference-only' && mitFields.some((f) => f !== null)) throw new Error('a reference-only item must not carry licence fields');
  const copyable = row.copyable;
  if (typeof copyable !== 'boolean') throw new Error('copyable must be a boolean');
  if (copyable !== (rights === 'mit')) throw new Error('copyable must equal (rights === "mit")');
  return {
    id: asString(row.id, 'id'),
    slug: asString(row.slug, 'slug'),
    name: asString(row.name, 'name'),
    ...(row.tags === undefined ? {} : { tags: (row.tags as unknown[]).map((tag) => asString(tag, 'tag')) }),
    author: asString(row.author, 'author'),
    authorProfileUrl: asString(row.authorProfileUrl, 'authorProfileUrl'),
    itemUrl: asString(row.itemUrl, 'itemUrl'),
    rights,
    licenseLabel,
    licenseUrl,
    licenseNotice,
    copyable,
    ...(row.privateImplementation === undefined ? {} : { privateImplementation: parsePrivateImplementation(row.privateImplementation) }),
    ...(row.ownedAlternative === undefined ? {} : { ownedAlternative: parseOwnedAlternative(row.ownedAlternative) }),
    preview: parseTwenty1stPreview(row.preview),
  };
}

export function parseTwenty1stListResponse(value: unknown): Twenty1stListResponse {
  const root = asRecord(value);
  const catalog = asRecord(root.catalog);
  const items = catalog.items;
  if (!Array.isArray(items)) throw new Error('catalog.items must be an array');
  return { catalog: { profile: asString(catalog.profile, 'catalog.profile'), items: items.map(parseTwenty1stItem) } };
}

export function parseTwenty1stItemResponse(value: unknown): Twenty1stItemResponse {
  const root = asRecord(value);
  return { item: parseTwenty1stItem(root.item) };
}

/** Revision identifies the exact static image rendered from this implementation's source. */
export interface Twenty1stImplementationThumbnail { revision: string }

/** Prefer the selected local implementation's thumbnail, with a saved CDN reference fallback. */
export function twenty1stCardPreviewUrl(item: Twenty1stItem): string {
  const implementation = item.privateImplementation ?? item.ownedAlternative;
  return implementation?.thumbnail
    ? `/api/21st/${encodeURIComponent(item.id)}/implementation-thumbnail?revision=${implementation.thumbnail.revision}`
    : twenty1stPreviewUrl(item.id);
}

/** Owned code is a separate work. Upstream rights/copyable never grant these actions. */
export interface Twenty1stOwnedAlternative {
  title: string;
  description: string;
  provenance: 'independently-authored';
  sourceSha256: string;
  sourceUrl: string;
  previewUrl: string;
  thumbnail?: Twenty1stImplementationThumbnail;
}
/** Disclosed copy changes applied only after original private input checksums pass. */
export interface Twenty1stCopyRefinement { originalSourceSha256: string; note: string; }
/** Syntactic local-file closure only. This says nothing about rights, packages, builds, or adoption. */
export type Twenty1stLocalImportClosure =
  | { status: 'resolved' }
  | { status: 'missing'; missing: Array<{ importer: string; specifier: string; resolvedCandidate: string }> }
  | { status: 'unverified'; reason: 'parse-error' | 'dynamic-local-import' | 'invalid-tsconfig' | 'ambiguous-baseurl-import' | 'unsafe-local-path' | 'limit-exceeded' };
export interface Twenty1stPrivateImplementation {
  title: string;
  description: string;
  provenance: 'upstream-private';
  sourceSha256: string;
  sourceUrl: string;
  previewUrl: string;
  sourceVerified: boolean;
  localImportClosure?: Twenty1stLocalImportClosure;
  refinement?: Twenty1stCopyRefinement;
  thumbnail?: Twenty1stImplementationThumbnail;
}
export interface Twenty1stSourceFile { path: string; content: string; sha256: string }
interface Twenty1stSourceBase {
  id: string;
  title: string;
  referenceUrl: string;
  referenceAuthor: string;
  sourceSha256: string;
  files: Twenty1stSourceFile[];
  /** Explicit component entry, separate from demo, helpers and generated setup. */
  primarySourcePath?: string;
}
export type Twenty1stSourceResponse = Twenty1stSourceBase & (
  | { provenance: 'independently-authored' }
  | { provenance: 'upstream-private'; sourceVerified: boolean; localImportClosure?: Twenty1stLocalImportClosure; refinement?: Twenty1stCopyRefinement }
);
function asSha256(value: unknown): string {
  const text = asString(value, 'sha256');
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('sha256 must be 64 lowercase hexadecimal characters');
  return text;
}
function parseOwnedAlternative(value: unknown): Twenty1stOwnedAlternative {
  const row = asRecord(value);
  if (row.provenance !== 'independently-authored') throw new Error('owned alternative needs independent provenance');
  const sourceUrl = asString(row.sourceUrl, 'sourceUrl');
  const previewUrl = asString(row.previewUrl, 'previewUrl');
  if (!/^\/api\/21st\/[^/]+\/source$/.test(sourceUrl) || !/^\/api\/21st\/[^/]+\/preview$/.test(previewUrl)) throw new Error('owned source and preview must use local 21st routes');
  return { title: asString(row.title,'title'), description: asString(row.description,'description'), provenance: row.provenance, sourceSha256: asSha256(row.sourceSha256), sourceUrl, previewUrl, ...(row.thumbnail === undefined ? {} : { thumbnail: parseImplementationThumbnail(row.thumbnail) }) };
}
function parseCopyRefinement(value: unknown): Twenty1stCopyRefinement {
  const row = asRecord(value), note = asString(row.note, 'refinement note');
  if (!note.trim() || note.length > 1000) throw new Error('invalid refinement note');
  return { originalSourceSha256: asSha256(row.originalSourceSha256), note };
}
function parseImplementationThumbnail(value: unknown): Twenty1stImplementationThumbnail {
  return { revision: asSha256(asRecord(value).revision) };
}
function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}
function parseLocalImportClosure(value: unknown): Twenty1stLocalImportClosure {
  const row = asRecord(value);
  if (row.status === 'resolved') return { status: 'resolved' };
  if (row.status === 'unverified' && ['parse-error','dynamic-local-import','invalid-tsconfig','ambiguous-baseurl-import','unsafe-local-path','limit-exceeded'].includes(String(row.reason)))
    return { status: 'unverified', reason: row.reason as Extract<Twenty1stLocalImportClosure, { status: 'unverified' }>['reason'] };
  if (row.status === 'missing' && Array.isArray(row.missing) && row.missing.length > 0 && row.missing.length <= 32) {
    return { status: 'missing', missing: row.missing.map(value => {
      const detail = asRecord(value);
      const specifier = asString(detail.specifier, 'specifier');
      if (!specifier || specifier.length > 512) throw new Error('invalid local import specifier');
      return { importer: safeSourcePath(detail.importer), specifier, resolvedCandidate: safeSourcePath(detail.resolvedCandidate) };
    }) };
  }
  throw new Error('invalid local import closure');
}
function parsePrivateImplementation(value: unknown): Twenty1stPrivateImplementation {
  const row = asRecord(value);
  if (row.provenance !== 'upstream-private') throw new Error('private implementation needs upstream-private provenance');
  const sourceUrl = asString(row.sourceUrl, 'sourceUrl');
  const previewUrl = asString(row.previewUrl, 'previewUrl');
  for (const [url, suffix] of [[sourceUrl, 'source'], [previewUrl, 'preview']] as const) {
    const match = /^\/api\/21st\/([^/?#]+)\/(source|preview)$/.exec(url);
    if (!match || match[2] !== suffix) throw new Error('private source and preview must use local 21st routes');
    let id: string;
    try { id = decodeURIComponent(match[1]!); } catch { throw new Error('invalid private source route'); }
    if (id === '.' || id === '..' || /[/\\\x00-\x1f]/.test(id)) throw new Error('invalid private source route');
  }
  return {
    title: asString(row.title, 'title'), description: asString(row.description, 'description'),
    provenance: row.provenance, sourceSha256: asSha256(row.sourceSha256), sourceUrl, previewUrl,
    sourceVerified: asBoolean(row.sourceVerified, 'sourceVerified'),
    ...(row.localImportClosure === undefined ? {} : { localImportClosure: parseLocalImportClosure(row.localImportClosure) }),
    ...(row.refinement === undefined ? {} : { refinement: parseCopyRefinement(row.refinement) }),
    ...(row.thumbnail === undefined ? {} : { thumbnail: parseImplementationThumbnail(row.thumbnail) }),
  };
}
function safeSourcePath(value: unknown): string {
  const path = asString(value, 'path');
  if (path.length === 0 || path.length > 512 || !/^[A-Za-z0-9_.@()+ -]+(?:\/[A-Za-z0-9_.@()+ -]+)*$/.test(path)
    || path.split('/').some(part => part === '.' || part === '..' || part.trim() !== part || part.endsWith('.'))) throw new Error('unsafe source file path');
  return path;
}
/** Count UTF-8 without depending on Node or browser encoding APIs. */
function utf8Size(content: string): number {
  let bytes = 0;
  for (const character of content) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > 2 * 1024 * 1024) throw new Error('source file size exceeds 2 MiB');
  }
  return bytes;
}
export function parseTwenty1stSourceResponse(value: unknown): Twenty1stSourceResponse {
  const row = asRecord(value);
  if (row.provenance !== 'independently-authored' && row.provenance !== 'upstream-private') throw new Error('invalid source provenance');
  const privateSource = row.provenance === 'upstream-private';
  const verification = privateSource ? { sourceVerified: asBoolean(row.sourceVerified, 'sourceVerified') } : {};
  if (!Array.isArray(row.files) || row.files.length < 1 || row.files.length > 128) throw new Error('source bundle needs 1 to 128 files');
  if (!privateSource && row.files.length !== 7) throw new Error('source bundle needs all seven standalone files');
  const allowed = new Set(['index.ts','runtime.ts','component.js','style.css','index.html','NOTICE.txt','README.md']);
  const seen = new Set<string>();
  let totalSize = 0;
  const files = row.files.map(value => {
    const f = asRecord(value), path = safeSourcePath(f.path);
    if (seen.has(path) || (!privateSource && !allowed.delete(path))) throw new Error('unexpected or duplicate source file path');
    seen.add(path);
    const content = asString(f.content, 'content');
    totalSize += utf8Size(content);
    if (totalSize > 8 * 1024 * 1024) throw new Error('source bundle size exceeds 8 MiB');
    return { path, content, sha256: asSha256(f.sha256) };
  });
  const primarySourcePath = row.primarySourcePath === undefined ? undefined : safeSourcePath(row.primarySourcePath);
  if (primarySourcePath !== undefined && !seen.has(primarySourcePath)) throw new Error('primary source file is missing from bundle');
  const base = { id:asString(row.id,'id'), title:asString(row.title,'title'), referenceUrl:asString(row.referenceUrl,'referenceUrl'), referenceAuthor:asString(row.referenceAuthor,'referenceAuthor'), sourceSha256:asSha256(row.sourceSha256), files,
    ...(primarySourcePath === undefined ? {} : { primarySourcePath }) };
  return privateSource
    ? { ...base, provenance: 'upstream-private', sourceVerified: verification.sourceVerified!, ...(row.localImportClosure === undefined ? {} : { localImportClosure: parseLocalImportClosure(row.localImportClosure) }), ...(row.refinement === undefined ? {} : { refinement: parseCopyRefinement(row.refinement) }) }
    : { ...base, provenance: 'independently-authored' };
}

/** One selection rule for both UI and CLI; older bundles use deterministic fallback ordering. */
export function selectTwenty1stPrimarySourceFile(bundle: Twenty1stSourceResponse): Twenty1stSourceFile {
  const files = [...bundle.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const component = (file: Twenty1stSourceFile) => /\.tsx?$/.test(file.path) && !/(^|\/)demo\.tsx?$/.test(file.path);
  const primary = files.find(file => file.path === bundle.primarySourcePath)
    ?? files.find(file => file.path === 'component.js')
    ?? files.find(file => file.path.includes('/components/twentyfirst/') && component(file))
    ?? files.find(component) ?? files[0];
  if (!primary) throw new Error('source bundle has no files');
  return primary;
}
