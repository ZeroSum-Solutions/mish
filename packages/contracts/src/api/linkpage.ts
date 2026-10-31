/**
 * Link pages: the web/daemon/CLI contract for `@mish/linkpage`.
 *
 * A creator names the places they already have online; the daemon reads them into a page spec, stores
 * it, and renders it (HTML, llms.txt, links.json). Endpoints: `/api/linkpages*` in
 * `apps/daemon/src/routes/linkpage.ts`; CLI: `od linkpage …`.
 *
 * Pure TypeScript with runtime validators the daemon and the CLI share. The spec types mirror
 * `@mish/linkpage`'s `PageSpec`; `apps/daemon/tests/linkpage-routes.test.ts` asserts the two stay
 * assignable, so a change to the engine fails a typecheck rather than a user.
 */

/** Slug of a page: lowercase letters, numbers and dashes, at most 60 characters. */
export const LINKPAGE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const LINKPAGE_SLUG_MAX = 60;

export const LINKPAGE_CONNECTORS = ['website', 'substack', 'instagram', 'tiktok', 'manual'] as const;
export type LinkPageConnectorId = (typeof LINKPAGE_CONNECTORS)[number];

/** Connectors that can read more through the creator's own login (a Composio connected account). */
export const LINKPAGE_LOGIN_CONNECTORS = ['instagram', 'tiktok'] as const;
export type LinkPageLoginConnectorId = (typeof LINKPAGE_LOGIN_CONNECTORS)[number];

export const LINKPAGE_BACKGROUNDS = ['glaze', 'mesh', 'grid', 'bubbles'] as const;
export type LinkPageBackground = (typeof LINKPAGE_BACKGROUNDS)[number];

export const LINKPAGE_MOODS = ['editorial', 'modern', 'raw', 'playful'] as const;
export type LinkPageMood = (typeof LINKPAGE_MOODS)[number];

export const LINKPAGE_MAX_SOURCES = 8;
export const LINKPAGE_MAX_LINKS = 40;
export const LINKPAGE_MAX_BLOCKS = 80;

// Request ------------------------------------------------------------------------------------------

/** What a source's `ref` is: an address or handle, or (for `manual`) a signal typed in by hand. */
export type LinkPageSourceRef = string | Record<string, unknown>;

export interface LinkPageSource {
  connector: LinkPageConnectorId;
  ref: LinkPageSourceRef;
}

export interface LinkPageLinkInput {
  label: string;
  url: string;
  description?: string;
  featured?: boolean;
}

export interface LinkPageBuildOptions {
  name?: string;
  headline?: string;
  bio?: string;
  /** A web address, or `assets/<file>` for a picture that ships with the page. */
  avatar?: string;
  theme?: {
    palette?: { bg?: string; text?: string; accent?: string };
    background?: LinkPageBackground;
  };
  links?: LinkPageLinkInput[];
  signup?: { endpoint: string };
}

/**
 * A creator's connected accounts: connector id to Composio connected-account id. Ids only, never a
 * token or a secret; the daemon's Composio provider holds the credentials.
 */
export type LinkPageConnectedAccounts = Partial<Record<LinkPageLoginConnectorId, string>>;

export interface LinkPageBuildRequest {
  slug: string;
  sources: LinkPageSource[];
  options?: LinkPageBuildOptions;
  connectedAccounts?: LinkPageConnectedAccounts;
  /** Save the page when the build succeeds. Defaults to true. */
  save?: boolean;
}

// Spec ---------------------------------------------------------------------------------------------

export interface LinkPageFontChoice {
  family: string;
  kind: 'serif' | 'sans' | 'mono' | 'display';
  stack: string;
  google: boolean;
}

export interface LinkPagePalette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  dark: boolean;
}

export interface LinkPageTheme {
  mood: LinkPageMood;
  radius: number;
  background: string;
  palette: LinkPagePalette;
  fonts: { heading: LinkPageFontChoice; body: LinkPageFontChoice };
}

export interface LinkPageProfile {
  name: string;
  headline: string;
  bio: string;
  about: string;
  themes: string[];
  avatar_url: string;
  site_url: string;
}

export type LinkPageBlock =
  | { type: 'link'; id: string; label: string; url: string; description: string; image_url: string; featured: boolean }
  | { type: 'social'; id: string; items: { kind: string; url: string; handle: string }[] }
  | { type: 'posts'; id: string; heading: string; items: { title: string; url: string; image_url: string }[] }
  | { type: 'email'; id: string; heading: string; button: string; note: string; endpoint: string }
  | { type: 'text'; id: string; body: string };

export interface LinkPageSpec {
  version: 1;
  slug: string;
  profile: LinkPageProfile;
  theme: LinkPageTheme;
  blocks: LinkPageBlock[];
}

/** A platform that showed little without the creator's login, and why signing in would help. */
export interface LinkPageLoginNeed {
  platform: string;
  why: string;
}

// Response -----------------------------------------------------------------------------------------

export interface LinkPageBuildResponse {
  spec: LinkPageSpec;
  warnings: string[];
  needs: LinkPageLoginNeed[];
  /** True when the page was written to the store. */
  saved: boolean;
}

export interface LinkPageRecord {
  slug: string;
  spec: LinkPageSpec;
  connectedAccounts: LinkPageConnectedAccounts;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LinkPageSummary {
  slug: string;
  name: string;
  headline: string;
  updatedAt: string;
}

export interface LinkPageListResponse {
  pages: LinkPageSummary[];
}

/**
 * A saved page as the browser sees it: the stored record without its connected-account ids. Those ids
 * stay in the daemon (they are what a build reads a creator's login with); `od linkpage build` can name
 * them, a page edit cannot change them.
 */
export type LinkPagePublicRecord = Omit<LinkPageRecord, 'connectedAccounts'>;

export interface LinkPageGetResponse {
  page: LinkPagePublicRecord;
}

/** `PUT /api/linkpages/:slug` body. Connected accounts are not part of an edit and are refused. */
export interface LinkPagePutRequest {
  spec: LinkPageSpec;
}

export interface LinkPageDeleteResponse {
  slug: string;
  deleted: true;
}

export interface LinkPageExportFile {
  path: string;
  contentType: string;
  encoding: 'utf8' | 'base64';
  content: string;
}

/** `GET /api/linkpages/:slug/export`: the files of a deployable site, `index.html` first. */
export interface LinkPageExportResponse {
  slug: string;
  files: LinkPageExportFile[];
}

/**
 * `POST /api/linkpages/:slug/publish` body. Both fields are optional.
 * `origin` is the public address the page will live at; `trackBase` sends each link click through
 * `<trackBase>/<slug>/<block>/<index>` so a host can count it.
 */
export interface LinkPagePublishRequest {
  origin?: string;
  trackBase?: string;
}

/**
 * The result of publishing a page. Hosting is a later step, so today `published` is false and `files`
 * is the list of paths ready to deploy; `url` is the address the page will have under `origin`.
 */
export interface LinkPagePublishResult {
  slug: string;
  published: boolean;
  url?: string;
  files: string[];
  publishedAt: string;
}

/** `PUT /api/linkpages/:slug/assets/:name`: a picture that ships with the page. */
export const LINKPAGE_ASSET_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const LINKPAGE_ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const LINKPAGE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][\w-]{0,60}\.(?:png|jpe?g|webp|gif)$/i;

export interface LinkPageAssetResponse {
  slug: string;
  name: string;
  /** What to put in the spec: `assets/<name>`. */
  path: string;
  contentType: string;
  bytes: number;
}

/** `POST /api/linkpages/:slug/events` answer. `stored` is false for a dropped bot post. */
export interface LinkPageEventResponse {
  ok: true;
  stored: boolean;
}

// Events -------------------------------------------------------------------------------------------

export interface LinkPageViewEvent {
  kind: 'view';
  slug: string;
  at: string;
}

export interface LinkPageClickEvent {
  kind: 'click';
  slug: string;
  block: string;
  index: number;
  at: string;
}

export interface LinkPageSignupEvent {
  kind: 'signup';
  slug: string;
  email: string;
  at: string;
}

export type LinkPageEvent = LinkPageViewEvent | LinkPageClickEvent | LinkPageSignupEvent;

// Validators ---------------------------------------------------------------------------------------

export type LinkPageParse<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const hasOwn = (record: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

export function isLinkPageSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= LINKPAGE_SLUG_MAX && LINKPAGE_SLUG_PATTERN.test(value);
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FONT_FAMILY = /^[A-Za-z0-9 ._-]{1,80}$/;
const FONT_STACK = /^[A-Za-z0-9 ,"'._-]{1,240}$/;
const ASSET_REF = /^assets\/[\w.-]+$/;

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function optionalText(record: Record<string, unknown>, key: string, max: number): LinkPageParse<string | undefined> {
  const value = record[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length > max) return fail(`${key} must be text of at most ${max} characters`);
  return { ok: true, value };
}

export function parseLinkPageConnectedAccounts(value: unknown): LinkPageParse<LinkPageConnectedAccounts> {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail('connectedAccounts must be an object of connector to connected-account id');
  const out: LinkPageConnectedAccounts = {};
  for (const [connector, id] of Object.entries(value)) {
    if (!(LINKPAGE_LOGIN_CONNECTORS as readonly string[]).includes(connector)) {
      return fail(`connectedAccounts.${connector}: only ${LINKPAGE_LOGIN_CONNECTORS.join(', ')} take a login`);
    }
    if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) {
      return fail(`connectedAccounts.${connector} must be a connected-account id (letters, numbers, dashes)`);
    }
    out[connector as LinkPageLoginConnectorId] = id;
  }
  return { ok: true, value: out };
}

function parseSource(value: unknown, index: number): LinkPageParse<LinkPageSource> {
  const at = `sources[${index}]`;
  if (!isRecord(value)) return fail(`${at} must be an object`);
  const connector = value.connector;
  if (typeof connector !== 'string' || !(LINKPAGE_CONNECTORS as readonly string[]).includes(connector)) {
    return fail(`${at}.connector must be one of ${LINKPAGE_CONNECTORS.join(', ')}`);
  }
  const ref = value.ref;
  if (connector === 'manual') {
    if (!isRecord(ref)) return fail(`${at}.ref must be an object for the manual connector`);
    return { ok: true, value: { connector: 'manual', ref } };
  }
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 2000) return fail(`${at}.ref must be an address or handle`);
  if ((connector === 'website' || connector === 'substack') && !httpUrl(ref)) {
    return fail(`${at}.ref must be a web address starting with http or https`);
  }
  return { ok: true, value: { connector: connector as LinkPageConnectorId, ref: ref.trim() } };
}

function parseOptions(value: unknown): LinkPageParse<LinkPageBuildOptions | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value)) return fail('options must be an object');
  const out: LinkPageBuildOptions = {};
  for (const [key, max] of [['name', 120], ['headline', 90], ['bio', 400]] as const) {
    const text = optionalText(value, key, max);
    if (!text.ok) return text;
    if (text.value !== undefined) out[key] = text.value;
  }
  if (value.avatar !== undefined) {
    if (typeof value.avatar !== 'string' || !(ASSET_REF.test(value.avatar) || httpUrl(value.avatar))) {
      return fail('options.avatar must be a web address or assets/<file>');
    }
    out.avatar = value.avatar;
  }
  if (value.theme !== undefined) {
    if (!isRecord(value.theme)) return fail('options.theme must be an object');
    const theme: NonNullable<LinkPageBuildOptions['theme']> = {};
    if (value.theme.palette !== undefined) {
      if (!isRecord(value.theme.palette)) return fail('options.theme.palette must be an object');
      const palette: NonNullable<NonNullable<LinkPageBuildOptions['theme']>['palette']> = {};
      for (const key of ['bg', 'text', 'accent'] as const) {
        const color = value.theme.palette[key];
        if (color === undefined) continue;
        if (typeof color !== 'string' || !HEX_COLOR.test(color)) return fail(`options.theme.palette.${key} must be a hex colour like #1a2b3c`);
        palette[key] = color;
      }
      theme.palette = palette;
    }
    if (value.theme.background !== undefined) {
      if (typeof value.theme.background !== 'string' || !(LINKPAGE_BACKGROUNDS as readonly string[]).includes(value.theme.background)) {
        return fail(`options.theme.background must be one of ${LINKPAGE_BACKGROUNDS.join(', ')}`);
      }
      theme.background = value.theme.background as LinkPageBackground;
    }
    out.theme = theme;
  }
  if (value.links !== undefined) {
    if (!Array.isArray(value.links) || value.links.length > LINKPAGE_MAX_LINKS) return fail(`options.links must be a list of at most ${LINKPAGE_MAX_LINKS}`);
    const links: LinkPageLinkInput[] = [];
    for (const [i, raw] of value.links.entries()) {
      if (!isRecord(raw)) return fail(`options.links[${i}] must be an object`);
      if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 120) return fail(`options.links[${i}].label is required (at most 120 characters)`);
      const url = httpUrl(raw.url);
      if (!url) return fail(`options.links[${i}].url must be a web address starting with http or https`);
      const description = optionalText(raw, 'description', 200);
      if (!description.ok) return fail(`options.links[${i}].${description.error}`);
      if (raw.featured !== undefined && typeof raw.featured !== 'boolean') return fail(`options.links[${i}].featured must be true or false`);
      links.push({
        label: raw.label.trim(),
        url,
        ...(description.value !== undefined ? { description: description.value } : {}),
        ...(raw.featured !== undefined ? { featured: raw.featured } : {}),
      });
    }
    out.links = links;
  }
  if (value.signup !== undefined) {
    if (!isRecord(value.signup)) return fail('options.signup must be an object');
    const endpoint = httpUrl(value.signup.endpoint);
    if (!endpoint) return fail('options.signup.endpoint must be a web address starting with http or https');
    out.signup = { endpoint };
  }
  return { ok: true, value: out };
}

/** Checks a build request at the boundary. Daemon route and CLI share it. */
export function parseLinkPageBuildRequest(value: unknown): LinkPageParse<LinkPageBuildRequest> {
  if (!isRecord(value)) return fail('the request must be an object');
  if (!isLinkPageSlug(value.slug)) return fail('slug must be lowercase letters, numbers and dashes (at most 60)');
  if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > LINKPAGE_MAX_SOURCES) {
    return fail(`sources must be a list of 1 to ${LINKPAGE_MAX_SOURCES}`);
  }
  const sources: LinkPageSource[] = [];
  for (const [i, raw] of value.sources.entries()) {
    const source = parseSource(raw, i);
    if (!source.ok) return source;
    sources.push(source.value);
  }
  const options = parseOptions(value.options);
  if (!options.ok) return options;
  const accounts = parseLinkPageConnectedAccounts(value.connectedAccounts);
  if (!accounts.ok) return accounts;
  if (value.save !== undefined && typeof value.save !== 'boolean') return fail('save must be true or false');
  return {
    ok: true,
    value: {
      slug: value.slug,
      sources,
      ...(options.value ? { options: options.value } : {}),
      ...(hasOwn(value, 'connectedAccounts') ? { connectedAccounts: accounts.value } : {}),
      ...(value.save !== undefined ? { save: value.save } : {}),
    },
  };
}

function parseFont(value: unknown, at: string): string | null {
  if (!isRecord(value)) return `${at} must be an object`;
  if (typeof value.family !== 'string' || !FONT_FAMILY.test(value.family)) return `${at}.family has characters a font name does not use`;
  if (!['serif', 'sans', 'mono', 'display'].includes(value.kind as string)) return `${at}.kind must be serif, sans, mono or display`;
  if (typeof value.stack !== 'string' || !FONT_STACK.test(value.stack) || (value.stack.match(/"/g)?.length ?? 0) % 2 !== 0 || (value.stack.match(/'/g)?.length ?? 0) % 2 !== 0) {
    return `${at}.stack has characters a font stack does not use`;
  }
  if (typeof value.google !== 'boolean') return `${at}.google must be true or false`;
  return null;
}

/**
 * Checks the theme of a stored spec. The renderer writes theme values straight into a stylesheet, so
 * a spec that did not come from the builder (a hand edit, a PUT) must pass this before it is stored
 * or rendered.
 */
export function parseLinkPageTheme(value: unknown): LinkPageParse<LinkPageTheme> {
  if (!isRecord(value)) return fail('theme must be an object');
  if (!(LINKPAGE_MOODS as readonly string[]).includes(value.mood as string)) return fail(`theme.mood must be one of ${LINKPAGE_MOODS.join(', ')}`);
  if (typeof value.radius !== 'number' || !Number.isFinite(value.radius) || value.radius < 0 || value.radius > 1000) return fail('theme.radius must be a number from 0 to 1000');
  if (typeof value.background !== 'string' || !(value.background === '' || (LINKPAGE_BACKGROUNDS as readonly string[]).includes(value.background))) {
    return fail(`theme.background must be empty or one of ${LINKPAGE_BACKGROUNDS.join(', ')}`);
  }
  const palette = value.palette;
  if (!isRecord(palette)) return fail('theme.palette must be an object');
  for (const key of ['bg', 'surface', 'text', 'muted', 'accent', 'accentText'] as const) {
    if (typeof palette[key] !== 'string' || !HEX_COLOR.test(palette[key])) return fail(`theme.palette.${key} must be a hex colour like #1a2b3c`);
  }
  if (typeof palette.dark !== 'boolean') return fail('theme.palette.dark must be true or false');
  const fonts = value.fonts;
  if (!isRecord(fonts)) return fail('theme.fonts must be an object');
  const heading = parseFont(fonts.heading, 'theme.fonts.heading');
  if (heading) return fail(heading);
  const body = parseFont(fonts.body, 'theme.fonts.body');
  if (body) return fail(body);
  return { ok: true, value: value as unknown as LinkPageTheme };
}

const BLOCK_TYPES = ['link', 'social', 'posts', 'email', 'text'];

/**
 * Checks the shape of a stored spec: slug, version, theme and block types. Each block's fields are
 * then cleaned by `@mish/linkpage`'s `checkPage` on the daemon, which owns the block rules.
 */
export function parseLinkPageSpec(value: unknown): LinkPageParse<LinkPageSpec> {
  if (!isRecord(value)) return fail('spec must be an object');
  if (value.version !== 1) return fail('spec.version must be 1');
  if (!isLinkPageSlug(value.slug)) return fail('spec.slug must be lowercase letters, numbers and dashes (at most 60)');
  if (!isRecord(value.profile) || typeof value.profile.name !== 'string' || !value.profile.name.trim()) return fail('spec.profile needs a name');
  const theme = parseLinkPageTheme(value.theme);
  if (!theme.ok) return fail(`spec.${theme.error}`);
  if (!Array.isArray(value.blocks) || value.blocks.length > LINKPAGE_MAX_BLOCKS) return fail(`spec.blocks must be a list of at most ${LINKPAGE_MAX_BLOCKS}`);
  for (const [i, block] of value.blocks.entries()) {
    if (!isRecord(block) || !BLOCK_TYPES.includes(block.type as string)) return fail(`spec.blocks[${i}] has an unknown type`);
  }
  return { ok: true, value: value as unknown as LinkPageSpec };
}

export function parseLinkPagePutRequest(value: unknown): LinkPageParse<LinkPagePutRequest> {
  if (!isRecord(value)) return fail('the request must be an object');
  const spec = parseLinkPageSpec(value.spec);
  if (!spec.ok) return spec;
  if (hasOwn(value, 'connectedAccounts')) return fail('connectedAccounts cannot be changed by editing a page; connect the account in Mish or name it in a build request');
  return { ok: true, value: { spec: spec.value } };
}

export function isLinkPageAssetName(value: unknown): value is string {
  return typeof value === 'string' && LINKPAGE_ASSET_NAME_PATTERN.test(value);
}

export function parseLinkPagePublishRequest(value: unknown): LinkPageParse<LinkPagePublishRequest> {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isRecord(value)) return fail('the request must be an object');
  const out: LinkPagePublishRequest = {};
  for (const key of ['origin', 'trackBase'] as const) {
    if (value[key] === undefined || value[key] === '') continue;
    const url = httpUrl(value[key]);
    if (!url) return fail(`${key} must be a web address starting with http or https`);
    out[key] = key === 'origin' ? new URL(url).origin : url;
  }
  return { ok: true, value: out };
}

/** Checks an event a page sends home. Signup keeps only a plausible address. */
export function parseLinkPageEvent(value: unknown, now: () => string): LinkPageParse<LinkPageEvent> {
  if (!isRecord(value)) return fail('the event must be an object');
  if (!isLinkPageSlug(value.slug)) return fail('slug must be lowercase letters, numbers and dashes (at most 60)');
  const at = now();
  if (value.kind === 'view') return { ok: true, value: { kind: 'view', slug: value.slug, at } };
  if (value.kind === 'click') {
    if (typeof value.block !== 'string' || !/^[\w-]{1,40}$/.test(value.block)) return fail('block must be a block id');
    if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0 || value.index > 1000) return fail('index must be a whole number');
    return { ok: true, value: { kind: 'click', slug: value.slug, block: value.block, index: value.index, at } };
  }
  if (value.kind === 'signup') {
    const email = typeof value.email === 'string' ? value.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('email looks incomplete');
    return { ok: true, value: { kind: 'signup', slug: value.slug, email, at } };
  }
  return fail('kind must be view, click or signup');
}
