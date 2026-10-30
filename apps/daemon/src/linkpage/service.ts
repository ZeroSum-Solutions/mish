/**
 * The link-page service: build a page from a creator's sources, keep it in the store, and produce
 * the files that make it a site. Everything that touches the world (network, model, login) is
 * injected, so the routes and the CLI are tested with fakes.
 */
import { buildPage, linksJson, llmsTxt, renderPage } from '@mish/linkpage';
import type { BuildOptions, Llm, PageSpec } from '@mish/linkpage';
import { checkPage } from '@mish/linkpage';
import { parseLinkPageSpec } from '@mish/contracts';
import type {
  LinkPageBuildRequest,
  LinkPageBuildResponse,
  LinkPageExportFile,
  LinkPageExportResponse,
  LinkPageRecord,
  LinkPageSpec,
  LinkPageSummary,
  LinkPagePutRequest,
} from '@mish/contracts';
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
  resolveLlm: () => Llm | undefined;
  login?: LinkPageLoginProvider | undefined;
}

export interface LinkPageService {
  build(request: LinkPageBuildRequest): Promise<LinkPageBuildResponse>;
  list(): Promise<LinkPageSummary[]>;
  get(slug: string): Promise<LinkPageRecord>;
  put(slug: string, request: LinkPagePutRequest): Promise<LinkPageRecord>;
  delete(slug: string): Promise<void>;
  render(slug: string, options?: { origin?: string }): Promise<string>;
  export(slug: string, options?: { origin?: string }): Promise<LinkPageExportResponse>;
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
      const connectedAccounts = request.connectedAccounts ?? existing?.connectedAccounts ?? {};
      const loginWarnings: string[] = [];
      const logins = createLoginFetches(deps.login, connectedAccounts, loginWarnings);
      const llm = deps.resolveLlm();
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
      if (!llm) warnings.push('no model is available (install the claude command or set OPENROUTER_API_KEY): the page was built from plain signals');
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
      return renderPage(specOf(await must(slug)), { machine: true, origin: options.origin ?? '' });
    },

    async export(slug, options = {}) {
      const spec = specOf(await must(slug));
      const origin = options.origin ?? '';
      const file = (path: string, contentType: string, content: string): LinkPageExportFile => ({ path, contentType, encoding: 'utf8', content });
      const files: LinkPageExportFile[] = [
        file('index.html', 'text/html; charset=utf-8', renderPage(spec, { machine: true, origin })),
        file('llms.txt', TEXT, llmsTxt(spec, { origin })),
        file('links.json', 'application/json', `${JSON.stringify(linksJson(spec, { origin }), null, 2)}\n`),
        file('spec.json', 'application/json', `${JSON.stringify(spec, null, 2)}\n`),
      ];
      for (const asset of await store.assets(slug)) {
        files.push({ path: `assets/${asset.name}`, contentType: assetType(asset.name), encoding: 'base64', content: asset.bytes.toString('base64') });
      }
      return { slug, files };
    },
  };
}

function assetType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
