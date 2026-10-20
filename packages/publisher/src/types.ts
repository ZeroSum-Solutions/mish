/**
 * The shapes the publisher passes to and receives from one Agency Site compiler copy
 * (`plugins/_official/shared/agency-compiler/scripts/`, fanned out to every family package).
 * Structural on purpose: a compiler copy runs outside the workspace and imports nothing from here.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Static text a compiler copy reads while it renders, keyed by path relative to its `scripts/`. */
export type CompilerResources = Readonly<Record<string, string>>;

export type ApprovedAsset = { id: string; file: string; kind: string; sha256?: string; mediaType?: string; bytes?: number };
/** An approved asset a render placed on the page, with the path it is served from. */
export type ResolvedAsset = ApprovedAsset & { destination: string };

export type EffectPlacement = { host: { id: string } | { odId: string }; allow: string[] };
export type FamilyEffectDeclaration = {
  scriptPolicy: 'none' | 'hash' | 'inline';
  maxEffects: number;
  placements: Partial<Record<string, EffectPlacement>>;
};
export type EffectPlan = { effects: Array<{ placement: string; componentId: string; source: 'hint' | 'jev' | 'repair' }> };
export type EffectRenderReport = {
  applied: Array<{ placement: string; componentId: string; kind: 'css-only' | 'js'; source: 'hint' | 'jev' | 'repair' }>;
  skipped: Array<{ placement: string; componentId?: string; reason: string }>;
  bytesAdded: number;
};

export type ArtifactManifest = JsonObject & {
  entry: string;
  supportingFiles: string[];
  metadata: { agencySite: { recipeDigest: string; revision: string; family: string; outputScope?: 'site' | 'static-prototype' } };
};

/**
 * `effects` is the plan the compiler applies after rendering the family; `compose` is markup the
 * compiler splices in BEFORE the plan, so the plan's byte budget covers the composed page.
 */
export type RenderOptions = { effects?: EffectPlan; compose?: (html: string) => string };
export type RenderResult = {
  recipe: Json;
  html: string;
  manifest: ArtifactManifest;
  approvedAssets: ResolvedAsset[];
  effects?: EffectRenderReport;
  composed?: boolean;
};

/** What the publisher calls in one compiler copy. Everything but `renderAgencySite` is optional, for older copies. */
export type CompilerModules = {
  /** `render.ts`: renders a recipe against an approved asset roster. Synchronous and pure given its resources. */
  renderAgencySite: (input: unknown, entry: string, approvedManifest?: unknown, options?: RenderOptions) => RenderResult;
  /** `resources.ts`: runs a render with every resource read served from a table. Absent = the copy reads its own files. */
  withCompilerResources?: <T>(resources: CompilerResources, fn: () => T) => T;
  /** `effects.ts`: the family's effect placements, read from its `families/<family>/catalog.json` resource. */
  readFamilyEffectDeclaration?: (family: string) => FamilyEffectDeclaration | null;
  /** `assets.ts`: size, file-signature and digest checks on an approved asset's bytes. */
  verifyApprovedAssetBytes?: (asset: ApprovedAsset, bytes: Uint8Array) => void;
  /** `sections.ts`: the shared link-honesty checks. */
  dishonestLinks?: (html: string) => string[];
  selfSectionAnchors?: (html: string) => string[];
};

/**
 * One family's compiler as explicit data: its code, the static resources that code reads, the
 * approved asset roster, and its reference recipe and schema. Built by `@mish/publisher/node`
 * (from a package directory) or shipped prebuilt in `@mish/publisher/families/<family>`.
 */
export type FamilyCompiler = {
  family: string;
  modules: CompilerModules;
  resources: CompilerResources;
  /** The approved asset roster (`families/<family>/approved-assets.json`): `{ version: 1, assets: [...] }`. */
  approvedAssets: JsonObject;
  /** The family's reference recipe, which a new build starts from. */
  reference: JsonObject;
  /** The family's recipe JSON schema. */
  schema: JsonObject;
};
