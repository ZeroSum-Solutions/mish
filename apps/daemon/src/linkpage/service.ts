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
  LinkPageGate,
  LinkPageModelInfo,
  LinkPageModelLaneChoice,
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
import type { JevGate } from './gate.js';
import { LINKPAGE_RETRY_LANE } from './model-lanes.js';
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
  resolveLlm: (lane?: LinkPageModelLaneChoice) => (Llm & { report?: () => LinkPageModelInfo }) | undefined | Promise<(Llm & { report?: () => LinkPageModelInfo }) | undefined>;
  /** The Jev quality gate. Absent: no gate runs and the build response has no `gate`. */
  gate?: JevGate | undefined;
  /** The lane a build uses when its request names none (OD_LINKPAGE_MODEL_LANE). Decides whether the auto retry applies. Default 'auto'. */
  defaultLane?: () => LinkPageModelLaneChoice;
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

const LANE_NAMES = { openrouter: 'OpenRouter', deepseek: 'DeepSeek', baseten: 'Baseten' } as const;

/** A plain line for a fallback. Fixed wording per reason code: nothing from an error body, key or URL. */
export function fallbackWarning(info: LinkPageModelInfo): string | undefined {
  const from = info.fellBackFrom;
  if (!from) return undefined;
  const name = LANE_NAMES[from.lane];
  const to = info.lane === 'deepseek' ? 'DeepSeek (text only)' : info.lane === 'baseten' ? 'Baseten' : 'the Claude CLI';
  switch (from.reason) {
    case 'no-key': return `No ${name} key is set; used ${to}`;
    case 'out-of-credits': return `${name} is out of credits; used ${to}`;
    case 'bad-key': return `${name} rejected the key; used ${to}`;
    default: return `${name} failed (${from.reason}); used ${to}`;
  }
}

/** The line for a build that ran with no model at all, per the lane the owner picked. */
export function noModelWarning(lane: LinkPageModelLaneChoice | undefined): string {
  if (lane === 'claude-cli') return 'The Claude CLI lane was chosen but no claude command was found (install and sign in to claude): the page was built from plain signals';
  if (lane === 'openrouter') return 'The OpenRouter lane was chosen but no OpenRouter key is set (`od agency config set --provider openrouter --key-stdin`): the page was built from plain signals';
  if (lane === 'baseten') return 'The Baseten lane was chosen but no Baseten key is set (`od agency config set --provider baseten --key-stdin`): the page was built from plain signals';
  if (lane === 'deepseek') return 'The DeepSeek lane was chosen but no DeepSeek key is set (`od agency config set --provider deepseek --key-stdin`): the page was built from plain signals';
  return 'no model is available (add an OpenRouter or DeepSeek key with `od agency config set --provider openrouter --key-stdin`, or install the claude command): the page was built from plain signals';
}

/** A forced metered lane that failed: no fallback, so the page came from plain signals. */
export function failedWarning(info: LinkPageModelInfo): string | undefined {
  if (!info.failed) return undefined;
  const name = LANE_NAMES[info.failed.lane];
  if (info.failed.reason === 'model-not-set') return `The ${name} lane was chosen but no model is set (OD_BASETEN_MODEL): the page was built from plain signals`;
  return `${name} failed (${info.failed.reason}); the ${name} lane was chosen, so the page was built from plain signals`;
}

/** One read-and-build, with the gate's verdict when a gate ran. */
interface Attempt {
  spec: LinkPageSpec;
  warnings: string[];
  model: LinkPageModelInfo;
  needs: LinkPageBuildResponse['needs'];
  gate?: LinkPageGate;
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
      // A build that names no accounts uses the logins connected in Mish right now, over an id saved with the
      // page (which may be a login since replaced or revoked); the saved id stays only when none resolves.
      // `{}` opts out.
      if (request.connectedAccounts === undefined && deps.resolveConnectedAccount) {
        for (const connector of LINKPAGE_LOGIN_CONNECTORS) {
          if (!request.sources.some((source) => source.connector === connector)) continue;
          const found = parseLinkPageConnectedAccounts({ [connector]: deps.resolveConnectedAccount(connector) });
          if (found.ok && found.value[connector]) connectedAccounts[connector] = found.value[connector]!;
        }
      }
      const loginWarnings: string[] = [];
      const logins = createLoginFetches(deps.login, connectedAccounts, loginWarnings);
      const requested = request.options?.modelLane;
      const fromOptions = { headline: request.options?.headline !== undefined, bio: request.options?.bio !== undefined };

      /** One full read-and-build on a lane, then the quality gate on what it produced. */
      const attempt = async (lane: LinkPageModelLaneChoice | undefined): Promise<Attempt> => {
        const llm = await deps.resolveLlm(lane);
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
        const built = cleanSpec(result.spec);
        const warnings = [...loginWarnings, ...result.warnings];
        const model: LinkPageModelInfo = !llm ? { lane: 'none', calls: 0 } : (llm.report?.() ?? { lane: 'none', calls: 0 });
        if (!llm) warnings.push(noModelWarning(lane));
        const fallback = fallbackWarning(model) ?? failedWarning(model);
        if (fallback) warnings.push(fallback);
        const gated = deps.gate ? await deps.gate.review({ spec: built, facts: result.facts, fromOptions }) : undefined;
        return { spec: gated?.spec ?? built, warnings, model, needs: result.needs, ...(gated ? { gate: gated.gate } : {}) };
      };

      let kept = await attempt(requested);
      // The auto lane gets one more read on the next lane when the bio and headline came out thin. Forced lanes
      // (in the request or as the daemon default) never move.
      const effective = requested ?? deps.defaultLane?.() ?? 'auto';
      const retryLane = effective === 'auto' && kept.gate?.insufficient ? LINKPAGE_RETRY_LANE[kept.model.lane] : undefined;
      if (retryLane && kept.gate) {
        const first = kept;
        const again = await attempt(retryLane);
        const better = again.gate?.ran === true && (again.gate.sufficiency ?? -1) > (first.gate?.insufficient?.probability ?? 1);
        kept = better ? again : first;
        kept.gate = { ...kept.gate!, retried: { lane: retryLane, kept: better ? 'retry' : 'first' } };
      }
      const { spec, warnings, model, needs, gate } = kept;
      const save = request.save !== false;
      if (save) await store.put({ spec, connectedAccounts, warnings });
      return { spec, warnings, model, ...(gate ? { gate } : {}), needs, saved: save };
    },

    list: () => store.list(),

    get: must,

    async put(slug, request) {
      if (request.spec.slug !== slug) throw new LinkPageError('BAD_REQUEST', 400, 'spec.slug must match the address');
      // An edit never touches the connected accounts: the store keeps what the page already has.
      return store.put({ spec: cleanSpec(request.spec) });
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
      const trackBase = options.trackBase ?? '';
      const file = (path: string, contentType: string, content: string): LinkPageExportFile => ({ path, contentType, encoding: 'utf8', content });
      const files: LinkPageExportFile[] = [
        file('index.html', 'text/html; charset=utf-8', renderPage(spec, { machine: true, origin, trackBase })),
        file('llms.txt', TEXT, llmsTxt(spec, { origin, trackBase })),
        file('links.json', 'application/json', `${JSON.stringify(linksJson(spec, { origin, trackBase }), null, 2)}\n`),
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
        // The site is served at its own root (one subdomain or domain per creator), so the address has no slug.
        ...(request.origin ? { url: `${request.origin}/` } : {}),
        files: exported.files.map((f) => f.path),
        publishedAt: (deps.now ?? (() => new Date().toISOString()))(),
      };
    },

    async putAsset(slug, name, bytes, contentType) {
      await must(slug);
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
