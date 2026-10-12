import type { Express, NextFunction, Request, Response } from 'express';
import type {
  AgencyConfigRepairResponse,
  AgencyJevConfigErrorDetails,
  AgencyJevConfigErrorReason,
  AgencyJevConfigResponse,
  AgencyRouteResponse,
  ApiErrorCode,
  DesignIndexAddResponse,
  DesignIndexFindResponse,
  DesignIndexGetResponse,
  DesignIndexProfileResponse,
  DesignIndexRemoveResponse,
  DesignIndexTaxonomyResponse,
} from '@open-design/contracts';
import {
  AGENCY_ROUTE_MAX_CHARS,
  DESIGN_INDEX_DEFAULT_LIMIT,
  DESIGN_INDEX_DEFAULT_MIN,
  DESIGN_INDEX_INPUT_MAX_CHARS,
  DESIGN_INDEX_MAX_LIMIT,
  DESIGN_INDEX_QUERY_LIST_KEYS,
  DESIGN_INDEX_QUERY_SCALAR_KEYS,
} from '@open-design/contracts';
import type { FamilyRegistry, ShapeAtlas } from '@open-design/agency-fast-lane/atlas';
import type { FindQuery } from '@open-design/agency-fast-lane/design-index';
import { htmlFacts } from '@open-design/agency-fast-lane/html-facts';
import type {
  DesignProfile,
  JevProfiler,
  ProfileInput,
  ProfileSourceKind,
} from '@open-design/agency-fast-lane/profile';
import type { JevRouter, RouteDecision as FastLaneRouteDecision } from '@open-design/agency-fast-lane/route';
import type { DesignTaxonomy } from '@open-design/agency-fast-lane/taxonomy';
import { parseDesignProfile } from '../design-profile-parse.js';
import { createDesignIndexStore } from '../design-index-store.js';
import type { AgencyJevKeyStore } from '../storage/agency-config.js';
import { AgencyConfigSectionInvalidError, AgencyJevConfigUnreadableError, checkAgencyJevConfigBody } from '../storage/agency-config.js';
import type { RouteDeps } from '../server-context.js';

/**
 * The design index and Jev routing API (`docs/plans/2026-09-19-design-index-app-wiring-design.md`
 * section 5). Every handler calls the same fast-lane functions the `fast-lane` and `design-index`
 * CLIs call, so the web UI, `od` and the CLI cannot drift apart.
 *
 * Jev runs only on an explicit user action (`POST /api/agency/route`, `POST
 * /api/design-index/profile`); nothing here calls it on a read. The router and profiler arrive
 * injected, so a test never needs a key and never reaches the network.
 *
 * `GET`/`PUT /api/agency/config` are the local-only pair that decides whether Jev is reachable
 * on this machine at all (`apps/daemon/src/agency-config.ts`). They answer with a source and a
 * boolean; the key itself is never in a response.
 *
 * No handler logs or stores the input text. A profile carries labels, a digest and a length — not
 * the page — and a failed Jev call answers with a fixed sentence rather than Jev's own response
 * body, which for a 4xx can be the request echoed back.
 */

/** The key the daemon needs for Jev could not be read. Mapped to 503; carries no detail of its
 * own, so the secret store's message (which names the entry it tried) never reaches a client. */
export class JevKeyUnavailableError extends Error {
  constructor() {
    super('jev key unavailable');
    this.name = 'JevKeyUnavailableError';
  }
}

/**
 * Wraps a secret read so every failure becomes one recognisable error. Startup must not call it:
 * pass this to `createJevRouter` / `createJevProfiler` as their `apiKey` resolver and the read
 * happens on the first Jev request of the process.
 */
export function jevKeyResolver(read: () => Promise<string>): () => Promise<string> {
  return async () => {
    try {
      return await read();
    } catch {
      throw new JevKeyUnavailableError();
    }
  };
}

export interface DesignIndexDeps {
  atlas: ShapeAtlas;
  registry: FamilyRegistry;
  taxonomy: DesignTaxonomy;
  router: JevRouter;
  profiler: JevProfiler;
  /** Backs `GET`/`PUT /api/agency/config`; the same store the router's key resolver reads. */
  jevKeyStore: AgencyJevKeyStore;
  /** `<RUNTIME_DATA_DIR>/design-index/index.json`. A missing file is an empty index. */
  indexFile: string;
}

export interface RegisterDesignIndexRoutesDeps extends RouteDeps<'http'> {
  designIndex: DesignIndexDeps;
}

/**
 * The one path the Jev credential travels on. Declared once because the route registration and
 * the parse-error sanitizer below MUST agree about what it means — a sanitizer that matches
 * fewer spellings than the route leaks, and one that matches more absorbs errors it does not own.
 */
const AGENCY_CONFIG_PATH = '/api/agency/config';
/** Renames an unreadable key file aside. Carries no credential, so it needs no parse sanitizer. */
const AGENCY_CONFIG_REPAIR_PATH = '/api/agency/config/repair';

/**
 * Does `path` reach `AGENCY_CONFIG_PATH`'s handlers?
 *
 * This daemon leaves Express's `case sensitive routing` and `strict routing` at their defaults,
 * so `app.put('/api/agency/config')` also answers `/API/AGENCY/CONFIG` and
 * `/api/agency/config/`. It does NOT answer a doubled slash or a percent-encoded spelling —
 * both 404 — so neither is matched here either.
 */
export function isAgencyConfigPath(path: string): boolean {
  const withoutTrailingSlash = path.endsWith('/') ? path.slice(0, -1) : path;
  return withoutTrailingSlash.toLowerCase() === AGENCY_CONFIG_PATH;
}

const SOURCE_KINDS: ProfileSourceKind[] = ['prompt', 'brief', 'spec', 'html'];
/** The Website Shape Atlas's compatibility scores run 0 (different spine) to 3 (close transfer). */
const MAX_MIN_TRANSFER = 3;

type Body = Record<string, unknown>;
type Query = Record<string, unknown>;

type Invalid = { error: string };
const isInvalid = (value: unknown): value is Invalid =>
  typeof value === 'object' && value !== null && typeof (value as Invalid).error === 'string';

/** A finite number in `[min, max]`, or absent. Anything else is a request error. */
function optionalNumber(body: Body, key: string, min: number, max: number): number | undefined | Invalid {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return { error: `${key} must be a finite number between ${min} and ${max}` };
  }
  return value;
}

function optionalString(body: Body, key: string): string | undefined | Invalid {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return { error: `${key} must be a string` };
  return value;
}

/** `threshold`, `minTransfer` and `spineShare` are shared by the route and profile requests and
 * are forwarded to the fast lane's own resolution policy unchanged. */
function resolveOptions(body: Body): { threshold?: number; minTransfer?: number; spineShare?: number } | Invalid {
  const threshold = optionalNumber(body, 'threshold', 0, 1);
  if (isInvalid(threshold)) return threshold;
  const minTransfer = optionalNumber(body, 'minTransfer', 0, MAX_MIN_TRANSFER);
  if (isInvalid(minTransfer)) return minTransfer;
  const spineShare = optionalNumber(body, 'spineShare', 0, 1);
  if (isInvalid(spineShare)) return spineShare;
  return {
    ...(threshold !== undefined ? { threshold } : {}),
    ...(minTransfer !== undefined ? { minTransfer } : {}),
    ...(spineShare !== undefined ? { spineShare } : {}),
  };
}

function queryValues(query: Query, key: string): string[] | Invalid {
  const value = query[key];
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[];
  return { error: `${key} must be given as text` };
}

/**
 * A scalar filter takes one value. Express turns `?skin=a&skin=b` into an array, and the two
 * plausible readings of that — "the first one wins" and "both must match" — disagree about what
 * the result should be, so neither is guessed: a repeated scalar key is a 400. Only the four keys
 * in `DESIGN_INDEX_QUERY_LIST_KEYS` repeat.
 */
function queryScalar(query: Query, key: string): string | undefined | Invalid {
  const values = queryValues(query, key);
  if (isInvalid(values)) return values;
  if (values.length === 0) return undefined;
  if (values.length > 1) return { error: `${key} accepts a single value; only section, component, mechanic and depth repeat` };
  return values[0];
}

function queryNumber(query: Query, key: string, fallback: number, min: number, max: number): number | Invalid {
  const raw = queryScalar(query, key);
  if (isInvalid(raw)) return raw;
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    return { error: `${key} must be a number between ${min} and ${max}` };
  }
  return value;
}

export function registerDesignIndexRoutes(app: Express, ctx: RegisterDesignIndexRoutesDeps) {
  const { isLocalSameOrigin, resolvedPortRef, sendApiError } = ctx.http;
  const { atlas, registry, taxonomy, router, profiler, jevKeyStore, indexFile } = ctx.designIndex;
  const store = createDesignIndexStore(indexFile);

  const fail = (res: Response, status: number, code: ApiErrorCode, message: string) =>
    sendApiError(res, status, code, message);

  /**
   * The only two outcomes a failed Jev call may produce. The message is fixed text in both cases:
   * `RouteError` carries `jev <status>: <body>`, and a 4xx body can be the request — which is the
   * caller's brief or page — echoed back.
   */
  const failJev = (res: Response, error: unknown) => {
    if (error instanceof JevKeyUnavailableError) {
      return fail(res, 503, 'JEV_UNAVAILABLE', 'Jev is not available on this daemon');
    }
    const name = error instanceof Error ? error.name : 'Error';
    console.error(`[design-index] jev request failed (${name})`);
    return fail(res, 502, 'JEV_FAILED', 'the Jev request failed');
  };

  /**
   * `router.route()` never throws once every vote in its consensus round has failed — a
   * `consensusK`-way vote that cannot complete a single attempt resolves `unrouted` with reason
   * `consensus:vote-failed` per vote (see `route.ts`'s own docblock) rather than rejecting
   * `route()` into this handler's catch, so a resolvable-but-unreachable key (or any other
   * per-vote failure) no longer reaches `failJev` above. When EVERY vote in the round failed that
   * way, no attempt produced a real answer — the same outcome the old single-request contract
   * threw `JevKeyUnavailableError` for — so this still has to answer 503 JEV_UNAVAILABLE, not the
   * 200 an ordinary "no family fits" `unrouted` decision gets. A decision where only SOME votes
   * failed (or where `votes` is absent, i.e. `consensusK` was never enabled) is a real answer and
   * passes through untouched.
   */
  const isUnanimousVoteFailure = (decision: FastLaneRouteDecision): boolean =>
    decision.decision === 'unrouted'
    && Array.isArray(decision.votes)
    && decision.votes.length > 0
    && decision.votes.every((vote) => vote.reason === 'consensus:vote-failed');

  // ---- Route ---------------------------------------------------------------

  app.post('/api/agency/route', async (req, res) => {
    try {
      const request = (req.body ?? {}) as Body;
      const brief = request.brief;
      if (typeof brief !== 'string' || brief.trim().length === 0) {
        return fail(res, 400, 'BAD_REQUEST', 'brief is required');
      }
      if (brief.length > AGENCY_ROUTE_MAX_CHARS) {
        return fail(res, 400, 'BAD_REQUEST', `brief must be at most ${AGENCY_ROUTE_MAX_CHARS} characters`);
      }
      const options = resolveOptions(request);
      if (isInvalid(options)) return fail(res, 400, 'BAD_REQUEST', options.error);

      let decision: FastLaneRouteDecision;
      try {
        decision = await router.route({ brief, atlas, registry, ...options });
      } catch (error: unknown) {
        return failJev(res, error);
      }
      // An unrouted decision is ordinarily a result, not an error — the brief still has a spine
      // and an archetype, and no bundled family covers it yet — but a round where every vote
      // failed produced no such result; see `isUnanimousVoteFailure`'s own docblock above.
      if (isUnanimousVoteFailure(decision)) {
        return fail(res, 503, 'JEV_UNAVAILABLE', 'Jev is not available on this daemon');
      }
      const body = { decision } satisfies AgencyRouteResponse;
      res.json(body);
    } catch (err: any) {
      fail(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  // ---- Jev credential ------------------------------------------------------

  /**
   * Both verbs are for the local Settings screen and the local `od` CLI only. A page on another
   * origin must not be able to read whether this machine holds a TypeSafe key, and certainly not
   * to overwrite it, so the same-origin guard the MCP and media panels use applies here too.
   */
  const requireLocalOrigin = (req: Request, res: Response): boolean => {
    if (isLocalSameOrigin(req, resolvedPortRef.current)) return true;
    fail(res, 403, 'FORBIDDEN', 'cross-origin request rejected');
    return false;
  };

  /**
   * A 400 from this pair carries a stable `reason` beside the sentence. The daemon has no locale,
   * so its own message is English on every screen; the reason is what a client builds its copy
   * from. The sentence stays for `curl` and for the CLI.
   */
  const failConfigBody = (res: Response, message: string, reason: AgencyJevConfigErrorReason) =>
    sendApiError(res, 400, 'BAD_REQUEST', message, {
      details: { kind: 'agency-jev-config', reason } satisfies AgencyJevConfigErrorDetails,
    });

  /**
   * A stored-key file that is present but unreadable is its own answer, separate from "no key".
   * The message is fixed: the underlying error names the path and, for a JSON failure, a slice
   * of the file — which on this one file is the credential.
   */
  const failConfigRead = (res: Response, error: unknown) => {
    if (error instanceof AgencyJevConfigUnreadableError) {
      return fail(res, 500, 'AGENCY_CONFIG_UNREADABLE', 'the daemon could not read its stored Jev key');
    }
    return fail(res, 500, 'INTERNAL_ERROR', 'the Jev configuration could not be read');
  };

  app.get(AGENCY_CONFIG_PATH, async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    try {
      const body = (await jevKeyStore.status()) satisfies AgencyJevConfigResponse;
      res.json(body);
    } catch (error: unknown) {
      failConfigRead(res, error);
    }
  });

  app.put(AGENCY_CONFIG_PATH, async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    try {
      const checked = checkAgencyJevConfigBody(req.body ?? {});
      if ('error' in checked) return failConfigBody(res, checked.error, checked.reason);
      // The answer is the same status shape either way, and carries no key: the caller already
      // has the key it sent, and nothing else is ever entitled to it.
      // With `provider`, the write is that fill model's key; without it, the Jev key.
      const body = (checked.provider
        ? ('clear' in checked
          ? await jevKeyStore.clearModelKey(checked.provider)
          : await jevKeyStore.saveModelKey(checked.provider, checked.apiKey))
        : ('clear' in checked
          ? await jevKeyStore.clear()
          : await jevKeyStore.save(checked.apiKey))) satisfies AgencyJevConfigResponse;
      res.json(body);
    } catch (error: unknown) {
      // Refused before any write: the file cannot be read, or another section of it is malformed.
      // The file keeps its bytes (it may hold the other keys).
      if (error instanceof AgencyConfigSectionInvalidError) {
        return fail(res, 409, 'AGENCY_CONFIG_UNREADABLE', 'the stored key file is unreadable or has a malformed section, so nothing was saved; run od agency config repair --confirm to set it aside, then try again');
      }
      // A write failure is a filesystem fault. Its message can name the temp path the key was
      // being written into, so it is answered with fixed text like every other case here.
      failConfigRead(res, error);
    }
  });

  /**
   * The explicit way out of an unreadable key file. `{ confirm: true }` and nothing else, so no
   * stray POST moves the file; the file is renamed aside (never deleted) and the answer names the
   * new file, not its path.
   */
  app.post(AGENCY_CONFIG_REPAIR_PATH, async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    const body = req.body as unknown;
    const confirmed = typeof body === 'object' && body !== null && !Array.isArray(body)
      && Object.keys(body).length === 1 && (body as { confirm?: unknown }).confirm === true;
    if (!confirmed) return fail(res, 400, 'BAD_REQUEST', 'repair needs { "confirm": true }');
    try {
      const answer = (await jevKeyStore.repair()) satisfies AgencyConfigRepairResponse;
      res.json(answer);
    } catch (error: unknown) {
      failConfigRead(res, error);
    }
  });

  /**
   * The body parser rejects a malformed body before any handler runs, and `body-parser`'s error
   * carries the offending bytes on `err.body` and a slice of them in `err.message`. On the one
   * route whose body IS a credential, Express's default handler would put that slice in the
   * response — and, outside production, a stack with it. This turns it into the same fixed 400
   * every other bad shape gets, and touches neither field.
   *
   * Registered here rather than globally so it can only ever change the answer for this route;
   * every other parse failure is passed straight on to the handlers that already own it.
   *
   * The predicate has to be the route's own semantics, not a string comparison that looks like
   * them: `req.path === AGENCY_CONFIG_PATH` misses `/api/agency/config/` and `/API/AGENCY/CONFIG`,
   * which Express routes to the PUT handler all the same — so the credential-bearing body would
   * reach Express's default error handler by any of those spellings. `isAgencyConfigPath` is
   * shared with the registrations above so the two cannot drift apart again, and the method check
   * keeps a POST to the same path with the handlers that own it.
   */
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const type = err !== null && typeof err === 'object' ? (err as { type?: unknown }).type : undefined;
    if (type !== 'entity.parse.failed') return next(err);
    if (req.method !== 'PUT' || !isAgencyConfigPath(req.path)) return next(err);
    return failConfigBody(res, 'the request body is not valid JSON', 'shape');
  });

  // ---- Design index --------------------------------------------------------

  // Registered before `/api/design-index/:digest` so the literal path wins over the parameter.
  app.get('/api/design-index/taxonomy', (_req, res) => {
    const body = { taxonomy } satisfies DesignIndexTaxonomyResponse;
    res.json(body);
  });

  app.post('/api/design-index/profile', async (req, res) => {
    try {
      const request = (req.body ?? {}) as Body;
      const kind = request.kind;
      if (typeof kind !== 'string' || !SOURCE_KINDS.includes(kind as ProfileSourceKind)) {
        return fail(res, 400, 'BAD_REQUEST', `kind must be one of ${SOURCE_KINDS.join(', ')}`);
      }
      const input = request.input;
      if (typeof input !== 'string' || input.length === 0) {
        return fail(res, 400, 'BAD_REQUEST', 'input is required');
      }
      if (input.length > DESIGN_INDEX_INPUT_MAX_CHARS) {
        return fail(res, 400, 'BAD_REQUEST', `input must be at most ${DESIGN_INDEX_INPUT_MAX_CHARS} characters`);
      }
      if (request.add !== undefined && typeof request.add !== 'boolean') {
        return fail(res, 400, 'BAD_REQUEST', 'add must be true or false');
      }
      const add = request.add === true;

      const title = optionalString(request, 'title');
      if (isInvalid(title)) return fail(res, 400, 'BAD_REQUEST', title.error);
      const ref = optionalString(request, 'ref');
      if (isInvalid(ref)) return fail(res, 400, 'BAD_REQUEST', ref.error);
      const id = optionalString(request, 'id');
      if (isInvalid(id)) return fail(res, 400, 'BAD_REQUEST', id.error);
      const options = resolveOptions(request);
      if (isInvalid(options)) return fail(res, 400, 'BAD_REQUEST', options.error);

      // `kind: 'html'` derives both halves of the profiler's state the way `design-index-cli.ts`
      // does for `--kind html`: the extracted facts alongside the page's own visible text.
      const facts = kind === 'html' ? htmlFacts(input) : undefined;
      const text = facts ? facts.text : input;
      const profileInput: ProfileInput = {
        text,
        ...(facts ? { facts } : {}),
        atlas,
        registry,
        taxonomy,
        ...options,
        source: {
          kind: kind as ProfileSourceKind,
          ...(id !== undefined ? { id } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(ref !== undefined ? { ref } : {}),
        },
      };

      let profile: DesignProfile;
      try {
        profile = await profiler.profile(profileInput);
      } catch (error: unknown) {
        return failJev(res, error);
      }

      // `add: false` (the default) profiles and stores nothing; `added` is also false when the
      // same input was profiled before, since its digest is already in the index.
      const stored = add ? await store.add(profile) : { added: false };
      const body = { profile, added: stored.added } satisfies DesignIndexProfileResponse;
      res.json(body);
    } catch (err: any) {
      fail(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.post('/api/design-index', async (req, res) => {
    try {
      const request = (req.body ?? {}) as Body;
      if (request.replace !== undefined && typeof request.replace !== 'boolean') {
        return fail(res, 400, 'BAD_REQUEST', 'replace must be true or false');
      }
      // Parsed, not merely checked: the caller's object is never the object that gets stored.
      // A stored profile is served back verbatim by GET /api/design-index/:digest, so a
      // `source.text` carrying the profiled page — the one thing the fast lane's profiler
      // deliberately keeps out of a profile — would otherwise be persisted and handed back.
      const parsed = parseDesignProfile(request.profile);
      if ('error' in parsed) return fail(res, 400, 'BAD_REQUEST', parsed.error);
      // Without `replace` the stored profile wins and nothing is written; with it the entry of
      // the same digest is overwritten in place and `replaced` says so.
      const stored = await store.add(parsed.profile, { replace: request.replace === true });
      const responseBody = stored satisfies DesignIndexAddResponse;
      res.json(responseBody);
    } catch (err: any) {
      fail(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.get('/api/design-index', async (req, res) => {
    try {
      const query = (req.query ?? {}) as Query;
      const min = queryNumber(query, 'min', DESIGN_INDEX_DEFAULT_MIN, 0, 1);
      if (isInvalid(min)) return fail(res, 400, 'BAD_REQUEST', min.error);
      const limit = queryNumber(query, 'limit', DESIGN_INDEX_DEFAULT_LIMIT, 1, DESIGN_INDEX_MAX_LIMIT);
      if (isInvalid(limit)) return fail(res, 400, 'BAD_REQUEST', limit.error);

      // Repeatable keys map to the fast lane's plural `FindQuery` fields; every other key it
      // knows takes one value. Anything else in the query string is ignored.
      const findQuery: FindQuery = { min };
      let filtered = false;
      for (const key of DESIGN_INDEX_QUERY_LIST_KEYS) {
        const values = queryValues(query, key);
        if (isInvalid(values)) return fail(res, 400, 'BAD_REQUEST', values.error);
        if (values.length === 0) continue;
        filtered = true;
        if (key === 'section') findQuery.sections = values;
        else if (key === 'component') findQuery.components = values;
        else if (key === 'mechanic') findQuery.mechanics = values;
        else findQuery.depths = values;
      }
      for (const key of DESIGN_INDEX_QUERY_SCALAR_KEYS) {
        const value = queryScalar(query, key);
        if (isInvalid(value)) return fail(res, 400, 'BAD_REQUEST', value.error);
        if (value === undefined) continue;
        filtered = true;
        findQuery[key] = value;
      }

      // `findProfiles` rejects a label that is not in the taxonomy, naming the valid ids, rather
      // than silently matching nothing — a request error, not a daemon fault.
      let result;
      try {
        result = filtered ? await store.find(findQuery, taxonomy, limit) : await store.list(limit);
      } catch (err: any) {
        return fail(res, 400, 'BAD_REQUEST', String(err?.message || err));
      }
      const body = result satisfies DesignIndexFindResponse;
      res.json(body);
    } catch (err: any) {
      fail(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.get('/api/design-index/:digest', async (req, res) => {
    try {
      const profile = await store.get(req.params.digest);
      if (!profile) return fail(res, 404, 'NOT_FOUND', 'profile not found');
      const body = { profile } satisfies DesignIndexGetResponse;
      res.json(body);
    } catch (err: any) {
      fail(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.delete('/api/design-index/:digest', async (req, res) => {
    try {
      const removed = await store.remove(req.params.digest);
      if (!removed.removed) return fail(res, 404, 'NOT_FOUND', 'profile not found');
      const body = { removed: true, total: removed.total } satisfies DesignIndexRemoveResponse;
      res.json(body);
    } catch (err: any) {
      fail(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });
}
