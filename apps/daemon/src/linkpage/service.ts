/**
 * The link-page service: build a page from a creator's sources, keep it in the store, and produce
 * the files that make it a site. Everything that touches the world (network, model, login) is
 * injected, so the routes and the CLI are tested with fakes.
 */
import { buildPage, linksJson, llmsTxt, renderPage } from '@mish/linkpage';
import type { BuildOptions, Llm, PageSpec } from '@mish/linkpage';
import { checkPage } from '@mish/linkpage';
import { LINKPAGE_ASSET_MAX_BYTES, LINKPAGE_ASSET_TYPES, LINKPAGE_LOGIN_CONNECTORS, isLinkPageAssetName, parseLinkPageConnectedAccounts, parseLinkPageSpec } from '@mish/contracts';
import type {
  LinkPageBuildRequest,
  LinkPageAssetResponse,
  LinkPageBuildResponse,
  LinkPageEventResponse,
  LinkPagePublishRequest,
  LinkPagePublishResult,
  LinkPageConnectedAccounts,
  LinkPageExportFile,
  LinkPageLoginConnectorId,
  LinkPageExportResponse,
  LinkPageRecord,
  LinkPageSpec,
  LinkPageSummary,
  LinkPagePutRequest,
} from '@mish/contracts';
import { recordLinkPageEvent } from './events.js';
import { createLoginFetches } from './login.js';
import type { LinkPageLoginProvider } from './login.js';
import type { LinkPageFetch } from './safe-fetch.js';
import type { LinkPageStore } from './store.js';

export class LinkPageError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_UNAVAILABLE' | 'VALIDATION_FAILED',
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LinkPageError';
  }
}

export interface LinkPageServiceDeps {
  store: LinkPageStore;
  fetch: LinkPageFetch;
  /** Called per build, so a model that appears (a key set, `claude` installed) is picked up. */
  resolveLlm: () => Llm | undefined | Promise<Llm | undefined>;
  login?: LinkPageLoginProvider | undefined;
  /**
   * The Composio connected-account id of a connector the creator already connected in Mish (Settings or
   * the Connect step), so a build that names no account still reads through the login. Ids only.
   */
  resolveConnectedAccount?: (connector: LinkPageLoginConnectorId) => string | undefined;
  now?: () => string;
}

export interface LinkPageService {
  build(request: LinkPageBuildRequest): Promise<LinkPageBuildResponse>;
  list(): Promise<LinkPageSummary[]>;
  get(slug: string): Promise<LinkPageRecord>;
  put(slug: string, request: LinkPagePutRequest): Promise<LinkPageRecord>;
  delete(slug: string): Promise<void>;
  render(slug: string, options?: { origin?: string; trackBase?: string }): Promise<string>;
  export(slug: string, options?: { origin?: string; trackBase?: string }): Promise<LinkPageExportResponse>;
  publish(slug: string, request?: LinkPagePublishRequest): Promise<LinkPagePublishResult>;
  putAsset(slug: string, name: string, bytes: Buffer, contentType: string): Promise<LinkPageAssetResponse>;
  asset(slug: string, name: string): Promise<{ bytes: Buffer; contentType: string }>;
  recordEvent(slug: string, body: unknown): Promise<LinkPageEventResponse>;
}

/** The picture formats we accept, told apart by their first bytes rather than the header alone. */
export function sniffImageType(bytes: Buffer): (typeof LINKPAGE_ASSET_TYPES)[number] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}

/** A spec from outside (a PUT, a hand-edited file) is shape-checked, then cleaned by the engine. */
export function cleanSpec(value: unknown): LinkPageSpec {
  const shape = parseLinkPageSpec(value);
  if (!shape.ok) throw new LinkPageError('VALIDATION_FAILED', 400, shape.error);
  try {
    return checkPage(shape.value as never) as unknown as LinkPageSpec;
  } catch (error) {
    throw new LinkPageError('VALIDATION_FAILED', 400, error instanceof Error ? error.message : 'the page is not valid');
  }
}

function buildOptions(request: LinkPageBuildRequest): BuildOptions {
  const { options = {} } = request;
  return {
    slug: request.slug,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.headline !== undefined ? { headline: options.headline } : {}),
    ...(options.bio !== undefined ? { bio: options.bio } : {}),
    ...(options.avatar !== undefined ? { avatar_url: options.avatar } : {}),
    ...(options.signup ? { signup: options.signup } : {}),
    ...(options.links ? { links: options.links.map((link) => ({ ...link })) } : {}),
    ...(options.theme ? { theme: options.theme } : {}),
  };
}

const TEXT = 'text/plain; charset=utf-8';

export function createLinkPageService(deps: LinkPageServiceDeps): LinkPageService {
  const { store } = deps;

  async function must(slug: string): Promise<LinkPageRecord> {
    const record = await store.get(slug);
    if (!record) throw new LinkPageError('NOT_FOUND', 404, `no link page "${slug}"`);
    return record;
  }

  function specOf(record: LinkPageRecord): PageSpec {
    // The stored file can be edited by hand: check it again before it is rendered.
    return cleanSpec(record.spec) as unknown as PageSpec;
  }

  return {
    async build(request) {
      const existing = await store.get(request.slug);
      const connectedAccounts: LinkPageConnectedAccounts = { ...(request.connectedAccounts ?? existing?.connectedAccounts ?? {}) };
      // A build that names no accounts uses the logins already connected in Mish; `{}` opts out.
      if (request.connectedAccounts === undefined && deps.resolveConnectedAccount) {
        for (const connector of LINKPAGE_LOGIN_CONNECTORS) {
          if (connectedAccounts[connector] || !request.sources.some((source) => source.connector === connector)) continue;
          const found = parseLinkPageConnectedAccounts({ [connector]: deps.resolveConnectedAccount(connector) });
          if (found.ok && found.value[connector]) connectedAccounts[connector] = found.value[connector]!;
        }
      }
      const loginWarnings: string[] = [];
      const logins = createLoginFetches(deps.login, connectedAccounts, loginWarnings);
      const llm = await deps.resolveLlm();
      let result;
      try {
        result = await buildPage({
          sources: request.sources.map(({ connector, ref }) => ({ connector, ref: ref as never })),
          options: buildOptions(request),
          logins,
          fetch: deps.fetch,
          ...(llm ? { llm } : {}),
        });
      } catch (error) {
        throw new LinkPageError('UPSTREAM_UNAVAILABLE', 502, error instanceof Error ? error.message : 'the page could not be built');
      }
      const spec = cleanSpec(result.spec);
      const warnings = [...loginWarnings, ...result.warnings];
      if (!llm) warnings.push('no model is available (add an OpenRouter key with `od agency config set --provider openrouter --key-stdin`, or install the claude command): the page was built from plain signals');
      const save = request.save !== false;
      if (save) await store.put({ spec, connectedAccounts, warnings });
      return { spec, warnings, needs: result.needs, saved: save };
    },

    list: () => store.list(),

    get: must,

    async put(slug, request) {
      if (request.spec.slug !== slug) throw new LinkPageError('BAD_REQUEST', 400, 'spec.slug must match the address');
      return store.put({ spec: cleanSpec(request.spec), ...(request.connectedAccounts ? { connectedAccounts: request.connectedAccounts } : {}) });
    },

    async delete(slug) {
      if (!(await store.delete(slug))) throw new LinkPageError('NOT_FOUND', 404, `no link page "${slug}"`);
    },

    async render(slug, options = {}) {
      return renderPage(specOf(await must(slug)), { machine: true, origin: options.origin ?? '', trackBase: options.trackBase ?? '' });
    },

    async export(slug, options = {}) {
      const spec = specOf(await must(slug));
      const origin = options.origin ?? '';
      const file = (path: string, contentType: string, content: string): LinkPageExportFile => ({ path, contentType, encoding: 'utf8', content });
      const files: LinkPageExportFile[] = [
        file('index.html', 'text/html; charset=utf-8', renderPage(spec, { machine: true, origin, trackBase: options.trackBase ?? '' })),
        file('llms.txt', TEXT, llmsTxt(spec, { origin })),
        file('links.json', 'application/json', `${JSON.stringify(linksJson(spec, { origin }), null, 2)}\n`),
        file('spec.json', 'application/json', `${JSON.stringify(spec, null, 2)}\n`),
      ];
      for (const asset of await store.assets(slug)) {
        files.push({ path: `assets/${asset.name}`, contentType: assetType(asset.name), encoding: 'base64', content: asset.bytes.toString('base64') });
      }
      return { slug, files };
    },

    async publish(slug, request = {}) {
      const exported = await this.export(slug, request);
      return {
        slug,
        // No host yet: this is the file list that would be deployed, not a deployment.
        published: false,
        ...(request.origin ? { url: `${request.origin}/${slug}` } : {}),
        files: exported.files.map((f) => f.path),
        publishedAt: (deps.now ?? (() => new Date().toISOString()))(),
      };
    },

    async putAsset(slug, name, bytes, contentType) {
      if (!isLinkPageAssetName(name)) throw new LinkPageError('BAD_REQUEST', 400, 'the file name must be letters, numbers, dashes or underscores, ending .png, .jpg, .webp or .gif');
      if (bytes.length === 0) throw new LinkPageError('BAD_REQUEST', 400, 'the picture is empty');
      if (bytes.length > LINKPAGE_ASSET_MAX_BYTES) throw new LinkPageError('BAD_REQUEST', 413, `the picture is larger than ${LINKPAGE_ASSET_MAX_BYTES / 1024 / 1024} MB`);
      const sniffed = sniffImageType(bytes);
      if (!sniffed || !(LINKPAGE_ASSET_TYPES as readonly string[]).includes(contentType.split(';')[0]!.trim().toLowerCase()) || sniffed !== contentType.split(';')[0]!.trim().toLowerCase()) {
        throw new LinkPageError('BAD_REQUEST', 415, 'only png, jpeg, webp and gif pictures are accepted, and the type must match the file');
      }
      if (assetType(name) !== sniffed) throw new LinkPageError('BAD_REQUEST', 400, 'the file extension must match the picture type');
      await store.putAsset(slug, name, bytes);
      return { slug, name, path: `assets/${name}`, contentType: sniffed, bytes: bytes.length };
    },

    async asset(slug, name) {
      const found = isLinkPageAssetName(name) ? await store.asset(slug, name) : null;
      if (!found) throw new LinkPageError('NOT_FOUND', 404, `no picture "${name}"`);
      return { bytes: found.bytes, contentType: assetType(name) };
    },

    async recordEvent(slug, body) {
      await must(slug);
      const outcome = await recordLinkPageEvent(store, slug, body, deps.now);
      if (!outcome.ok) throw new LinkPageError('BAD_REQUEST', 400, outcome.error);
      return outcome.response;
    },
  };
}

function assetType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
