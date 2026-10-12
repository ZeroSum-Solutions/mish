/**
 * Design index and Jev routing API.
 *
 * `POST /api/agency/route`            route a brief to a spine, archetype and family (one Jev call)
 * `GET  /api/agency/config`           whether this daemon can reach Jev, and from where
 * `PUT  /api/agency/config`           store or clear the daemon's own TypeSafe key
 * `GET  /api/design-index/taxonomy`   the design taxonomy vocabularies (for search facets)
 * `POST /api/design-index/profile`    profile a page or text with Jev; `add: true` also stores it
 * `POST /api/design-index`            store an already-computed profile
 * `GET  /api/design-index`            search the index (query params below) or list it
 * `GET  /api/design-index/:digest`    one stored profile
 * `DELETE /api/design-index/:digest`  remove one stored profile
 *
 * The DTOs mirror the fast lane's own types field for field (`packages/agency-fast-lane/src/route.ts`
 * `RouteDecision`, `src/profile.ts` `DesignProfile`, `src/taxonomy.ts` `DesignTaxonomy`) so the daemon
 * passes the fast lane's objects through unchanged and asserts the match at compile time with
 * `satisfies`. Keep the two in step: a field added on one side is added on the other in the same PR.
 */

export type DesignJudgment = {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type RouteBasis = 'exact' | 'same-spine' | 'compatible';

/** What kind of page a family builds. Mirrors `PageKind` in the fast lane's `atlas.ts`. */
export type PageKind = 'site' | 'app' | 'dashboard';

export type RouteCandidate = {
  family: string;
  probability: number;
  basis: string;
  transfer: number;
  archetype: string;
  skin: string;
  viaSpine: string;
};

export type RouteFamilyPick = {
  id: string;
  probability: number;
  basis: RouteBasis;
  transfer: number;
  /** The spine the family was admitted from (the winning candidate's `viaSpine`). It differs from
   * `spine.code` when the family reached through a runner-up spine. Absent on older decisions. */
  viaSpine?: string;
};

/** One consensus member's outcome — mirrors the fast lane's own `RouteVote`. `family` is present
 * only for a `routed` vote; `reason` only for `unrouted` (including a failed/timed-out vote,
 * recorded as `reason: 'consensus:vote-failed'`). */
export type RouteVote = {
  decision: 'routed' | 'unrouted';
  family?: string;
  reason?: string;
};

export type RouteDecision = {
  decision: 'routed' | 'unrouted';
  reason?: string;
  spine: { code: string; name: string; confidence: number; probabilities: Record<string, number> };
  spines: Array<{ code: string; probability: number }>;
  archetype?: { id: string; name: string; confidence: number };
  skin: { choice: string; confidence: number };
  family?: RouteFamilyPick;
  /** The `pageKind` answer, when one was given — absent for an older caller that never asked the
   * question. Recorded even when it changed nothing; see the fast lane's `resolveRoute` docblock. */
  pageKind?: { choice: PageKind | 'none'; confidence: number };
  candidates: RouteCandidate[];
  warnings: string[];
  ms: number;
  /** Total Jev requests behind this decision. No longer `1`: the fast lane's variance-aware
   * consensus (`consensusK`, default 3) sums every concurrent attempt's own call count (1, or 2
   * when the exclusion gate's second request ran), so this can be up to `2 * consensusK`. */
  calls: number;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** Every consensus attempt's own outcome, present only on a consensus decision. Absent for a
   * bare single-attempt result (an older caller, or `consensusK: 1`... no — `consensusK: 1` still
   * populates a length-1 array; only a caller that never went through consensus at all has no
   * `votes` at all). */
  votes?: RouteVote[];
  /** How many votes the decision was computed from — the fast lane's `JevRouterOptions.consensusK`
   * (default 3), logged on the decision itself so a caller can see the k the build ran with
   * without threading it through separately. Present only alongside `votes`. */
  consensusK?: number;
  /** How many routing REQUESTS `routeBuild` itself sent — 1, or 2 after its own bounded retry
   * (see the fast lane's `shouldRetryRoute`). A separate count from `calls`/`consensusK`: this is
   * the build-layer retry, not the consensus layer. Absent for a decision straight from a router. */
  routeAttempts?: number;
};

export interface AgencyRouteRequest {
  /** The client brief, plain text. Required, non-empty, at most `AGENCY_ROUTE_MAX_CHARS`. */
  brief: string;
  /** Family probability gate, default 0.5 (inclusive). */
  threshold?: number;
  /** Minimum atlas transfer score for a compatible-spine candidate, default 2. */
  minTransfer?: number;
  /** Runner-up spines at or above this share of the top spine's mass are also searched, default 0.25. */
  spineShare?: number;
}

export interface AgencyRouteResponse {
  decision: RouteDecision;
}

export const AGENCY_ROUTE_MAX_CHARS = 64_000;

/**
 * Where the TypeSafe (Jev) credential in effect right now comes from, in resolution order:
 *
 *   `env`    the `TYPESAFE_API_KEY` environment variable of the daemon process
 *   `stored` the key saved through `PUT /api/agency/config`, in the daemon's own 0600 file
 *   `vault`  the machine's local secret store — the owner's original setup, still supported
 *   `unset`  none of the three answered; Jev requests will fail with 503 `JEV_UNAVAILABLE`
 */
export type AgencyJevConfigSource = 'env' | 'stored' | 'vault' | 'unset';

/**
 * The answer to both `GET` and `PUT /api/agency/config`. It carries no key, no tail and no
 * suffix: the daemon never hands a credential back to a client, not even the one that just sent
 * it, so a Settings screen can say "configured" without the secret re-entering the DOM.
 */
export interface AgencyJevConfigResponse {
  configured: boolean;
  source: AgencyJevConfigSource;
  /**
   * The fast lane's fill-model keys, one status per provider, resolved the same way as the Jev
   * key: the provider's environment variable (`AGENCY_MODEL_KEY_ENV`), then the stored key, then
   * the local vault. Status only — never a key, a tail or a suffix.
   */
  models: Record<AgencyModelProvider, AgencyKeyStatus>;
}

/**
 * `POST /api/agency/config/repair` takes exactly `{ confirm: true }`. It renames a stored key file
 * that cannot be read or parsed to `agency-config.json.corrupt-<timestamp>` (never deletes it), so
 * the next save starts fresh; a missing or healthy file is left alone. Saves and clears never do
 * this on their own: they answer 409 `AGENCY_CONFIG_UNREADABLE` and keep the file's bytes.
 */
export interface AgencyConfigRepairRequest {
  confirm: true;
}

/** The status after the repair, plus what it did. `movedTo` is a file name, never a path. */
export interface AgencyConfigRepairResponse extends AgencyJevConfigResponse {
  repaired: boolean;
  movedTo: string | null;
}

/** Environment overrides for the fill-model keys, read from the daemon process. */
export const AGENCY_MODEL_KEY_ENV = { deepseek: 'DEEPSEEK_API_KEY', cerebras: 'CEREBRAS_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as const;

/** A fast-lane fill provider whose key `PUT /api/agency/config` can store. */
export type AgencyModelProvider = keyof typeof AGENCY_MODEL_KEY_ENV;

export const AGENCY_MODEL_PROVIDERS = Object.keys(AGENCY_MODEL_KEY_ENV) as AgencyModelProvider[];

/** Where one key comes from and whether it resolves at all. See `AgencyJevConfigSource`. */
export interface AgencyKeyStatus {
  configured: boolean;
  source: AgencyJevConfigSource;
}

/**
 * `PUT /api/agency/config` takes exactly one of these shapes. Without `provider` it acts on the
 * Jev key; with `provider` it acts on that fill model's key. Anything else — both `apiKey` and
 * `clear`, a non-string key, an empty or whitespace-bearing key, `clear: false`, an unknown
 * provider — is a 400, because a credential write is the wrong place to guess what the caller
 * meant.
 */
export type AgencyJevConfigRequest =
  | { apiKey: string }
  | { clear: true }
  | { provider: AgencyModelProvider; apiKey: string }
  | { provider: AgencyModelProvider; clear: true };

/**
 * Why a `PUT /api/agency/config` body was refused, as a stable identifier rather than a sentence.
 * The daemon has no locale, so a message it composes is English on a Japanese screen; the client
 * maps these to its own copy and falls back to one generic localized line for a reason it does
 * not know. `shape` covers every structural refusal at once — a body that is not an object, an
 * array, neither field, both fields, a key that is not a string, `clear` that is not `true`, an
 * unknown extra field, and a body the JSON parser could not read at all.
 */
export type AgencyJevConfigErrorReason = 'empty' | 'whitespace' | 'too-long' | 'shape';

/** Carried as `ApiError.details` on every 400 from `PUT /api/agency/config`. */
export interface AgencyJevConfigErrorDetails {
  kind: 'agency-jev-config';
  reason: AgencyJevConfigErrorReason;
}

/** A TypeSafe key is far shorter than this; the cap exists so a stray paste cannot fill the file. */
export const AGENCY_JEV_KEY_MAX_CHARS = 512;

/** Environment override, read from the daemon process. Beats a stored key and the local vault. */
export const AGENCY_JEV_KEY_ENV = 'TYPESAFE_API_KEY';

export type DesignProfileSourceKind = 'prompt' | 'brief' | 'spec' | 'html';

export type DesignProfileSource = {
  kind: DesignProfileSourceKind;
  id?: string;
  title?: string;
  ref?: string;
  chars: number;
  digest: string;
};

export type DesignProfileResolvedRoute = {
  archetypeId?: string;
  familyId?: string;
  basis?: string;
  transfer?: number;
};

export type DesignProfileRoute = {
  spine: DesignJudgment;
  archetype?: DesignJudgment;
  skin: DesignJudgment;
  format: DesignJudgment;
  action: DesignJudgment;
  family: DesignJudgment;
  resolved: DesignProfileResolvedRoute;
};

export const DESIGN_STYLE_AXES = ['ground', 'accent', 'typography', 'imagery', 'topology', 'density'] as const;
export type DesignStyleAxis = (typeof DESIGN_STYLE_AXES)[number];

export type DesignQualityResult = { score: number; legend: string; confidence: number };

export type DesignProfile = {
  schema: 'design-profile/1';
  taxonomy: string;
  model: string;
  at: string;
  ms: number;
  calls: number;
  usage?: { input_tokens: number; output_tokens: number };
  source: DesignProfileSource;
  route: DesignProfileRoute;
  sections: Record<string, number>;
  components: Record<string, number>;
  mechanics: Record<string, number>;
  depth: Record<string, number>;
  style: Record<DesignStyleAxis, DesignJudgment>;
  quality: Record<string, DesignQualityResult>;
  truthRisk: number;
  meta?: Record<string, string | number | boolean>;
};

export interface DesignIndexProfileRequest {
  kind: DesignProfileSourceKind;
  /** The page HTML (`kind: 'html'`) or the prompt, brief or spec text. Required, non-empty, at most `DESIGN_INDEX_INPUT_MAX_CHARS`. */
  input: string;
  id?: string;
  title?: string;
  ref?: string;
  /** Also store the profile in the index. Default false: profiling alone stores nothing. */
  add?: boolean;
  threshold?: number;
  minTransfer?: number;
  spineShare?: number;
}

export const DESIGN_INDEX_INPUT_MAX_CHARS = 512_000;

export interface DesignIndexProfileResponse {
  profile: DesignProfile;
  /** True when the profile was stored by this request. False when `add` was not set, or the digest was already in the index. */
  added: boolean;
}

export interface DesignIndexAddRequest {
  profile: DesignProfile;
  /**
   * Overwrite an already-stored profile with the same `source.digest` instead of keeping it.
   * Default false, which is first-write-wins. A replaced entry keeps its position in the index.
   */
  replace?: boolean;
}

export interface DesignIndexAddResponse {
  profile: DesignProfile;
  /** False when a profile with the same `source.digest` was already stored; the stored one is returned. */
  added: boolean;
  /**
   * True when `replace` overwrote an already-stored profile of the same `source.digest`.
   * `added` and `replaced` are mutually exclusive; both false means the request stored nothing.
   */
  replaced: boolean;
  /** Index size after the request. */
  total: number;
}

/**
 * `GET /api/design-index` query parameters. Repeatable keys accept several values
 * (`?section=hero&section=footer`); every given value must match. Scalar keys take one value.
 * `min` (default 0.5) is the probability a label needs to count as present; `limit` (default 50,
 * maximum 500) caps the returned list. With no filter the whole index is listed, newest first.
 */
export const DESIGN_INDEX_QUERY_LIST_KEYS = ['section', 'component', 'mechanic', 'depth'] as const;
export const DESIGN_INDEX_QUERY_SCALAR_KEYS = [
  'skin',
  'spine',
  'archetype',
  'family',
  'format',
  'action',
  'ground',
  'accent',
  'typography',
  'imagery',
  'topology',
  'density',
  'text',
] as const;
export type DesignIndexQueryListKey = (typeof DESIGN_INDEX_QUERY_LIST_KEYS)[number];
export type DesignIndexQueryScalarKey = (typeof DESIGN_INDEX_QUERY_SCALAR_KEYS)[number];
export const DESIGN_INDEX_DEFAULT_MIN = 0.5;
export const DESIGN_INDEX_DEFAULT_LIMIT = 50;
export const DESIGN_INDEX_MAX_LIMIT = 500;

export interface DesignIndexFindResponse {
  profiles: DesignProfile[];
  /** Profiles that matched before `limit` was applied. */
  matched: number;
  /** Index size. */
  total: number;
}

export interface DesignIndexGetResponse {
  profile: DesignProfile;
}

export interface DesignIndexRemoveResponse {
  removed: boolean;
  total: number;
}

export type DesignTaxonomyLabel = { id: string; definition: string };
export type DesignQualityDimension = { id: string; rubric: string; levels: string[] };
export type DesignTruthRiskQuestion = {
  id: string;
  instructions: string;
  criteriaTrue: string;
  criteriaFalse: string;
};

export type DesignTaxonomy = {
  version: string;
  sections: DesignTaxonomyLabel[];
  components: DesignTaxonomyLabel[];
  mechanics: DesignTaxonomyLabel[];
  depth: DesignTaxonomyLabel[];
  style: Record<DesignStyleAxis, DesignTaxonomyLabel[]>;
  quality: DesignQualityDimension[];
  truthRisk: DesignTruthRiskQuestion;
  action: DesignTaxonomyLabel[];
};

export interface DesignIndexTaxonomyResponse {
  taxonomy: DesignTaxonomy;
}
