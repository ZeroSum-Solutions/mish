// Remix into project: the Cult UI Pro source, served from the private source kit to the owner's own
// projects on this machine only.
//
// `GET /api/cult/r/<slug>.json` answers a registry item in the public item format that
// `npx shadcn@latest add <url>` reads (`files[].content` inline). Registry dependencies that are
// other catalogued items point back at the same endpoint; the rest stay bare names for the
// default component registry. `GET /api/cult/copy/:id[?file=<target|path>]` answers `CultCopyResponse`
// for the web Blocks and Components views and `od cult show`: the install URL, the npm packages and
// one file (the main file by default) with its imports on the default aliases.
// `od cult add` reads the registry endpoint. Both routes answer loopback requests only
// (`apps/daemon/src/routes/cult-registry.ts`); the licensed source never leaves this machine.
//
// `parseCultCopyResponse` / `parseCultRegistryItem` validate an untrusted `unknown` (a
// `fetch().json()` result) at the web and CLI boundary.

/** One file of a served registry item. `target` is relative to the project root. */
export interface CultRegistryFile {
  path: string;
  type: string;
  target: string;
  content: string;
}

/** The registry item the endpoint serves (fields this product reads; the rest pass through). */
export interface CultRegistryItem {
  name: string;
  type: string;
  dependencies: string[];
  registryDependencies: string[];
  files: CultRegistryFile[];
  /**
   * A renamed folder's old (internal) name, by its new (public-slug) path, e.g.
   * `{ "sections/cta-hex": "sections/marketing-cta-hex" }`. Detection only: an old copy still at
   * that path is never written to, overwritten or deleted. Only ever a brand-free old name (never
   * a vendor name) — see `apps/daemon/src/cult-registry.ts`. Absent when nothing was renamed.
   */
  folderAliases?: Record<string, string>;
}

export interface CultCopyInfo {
  /** Public catalog id, `cult:<slug>`. */
  id: string;
  name: string;
  /** The loopback URL `npx shadcn@latest add` and `od cult add` read. */
  registryUrl: string;
  /** npm packages the item imports. */
  dependencies: string[];
  /** Registry dependencies as served: catalogued items as URLs, the rest as bare names. */
  registryDependencies: string[];
  /**
   * The file a person most likely wants to read first (or the one `?file=<target|path>` asked
   * for), with `@/…` imports on the default component aliases, as an install would write them.
   */
  mainFile: CultRegistryFile;
  /** Every file of the item, for picking another one with `?file=`. */
  files: Array<{ path: string; target: string }>;
}

export interface CultCopyResponse {
  copy: CultCopyInfo;
}

/** A catalog id (`cult:<name>`) or bare name → the registry name; null when it is not one. */
export function cultRegistryName(idOrName: string): string | null {
  const name = idOrName.startsWith('cult:') ? idOrName.slice('cult:'.length) : idOrName;
  return CULT_REGISTRY_NAME.test(name) ? name : null;
}

/** Item names: lower-case slugs, `--` allowed for derived sections (`<page>--<section>`). */
export const CULT_REGISTRY_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function assertFile(raw: unknown, path: string): void {
  if (!isPlainObject(raw)) throw new Error(`${path} must be an object`);
  for (const field of ['path', 'type', 'content'] as const) {
    if (typeof raw[field] !== 'string') throw new Error(`${path}.${field} must be a string`);
  }
  if (raw.target !== undefined && typeof raw.target !== 'string') throw new Error(`${path}.target must be a string`);
}

/** Validate an `unknown` value as a served registry item. */
export function parseCultRegistryItem(value: unknown): CultRegistryItem {
  if (!isPlainObject(value)) throw new Error('registry item must be an object');
  if (typeof value.name !== 'string' || !CULT_REGISTRY_NAME.test(value.name)) throw new Error('registry item name is invalid');
  if (typeof value.type !== 'string') throw new Error('registry item type must be a string');
  const dependencies = value.dependencies ?? [];
  const registryDependencies = value.registryDependencies ?? [];
  if (!isStringArray(dependencies)) throw new Error('registry item dependencies must be an array of strings');
  if (!isStringArray(registryDependencies)) throw new Error('registry item registryDependencies must be an array of strings');
  if (!Array.isArray(value.files)) throw new Error('registry item files must be an array');
  value.files.forEach((file: unknown, index: number) => assertFile(file, `files[${index}]`));
  let folderAliases: Record<string, string> | undefined;
  if (value.folderAliases !== undefined) {
    if (!isPlainObject(value.folderAliases) || !Object.values(value.folderAliases).every((v) => typeof v === 'string')) {
      throw new Error('registry item folderAliases must be an object of string to string');
    }
    folderAliases = value.folderAliases as Record<string, string>;
  }
  return {
    name: value.name,
    type: value.type,
    dependencies,
    registryDependencies,
    files: (value.files as Array<Record<string, unknown>>).map((file) => ({
      path: file.path as string,
      type: file.type as string,
      target: (file.target as string | undefined) ?? '',
      content: file.content as string,
    })),
    ...(folderAliases !== undefined ? { folderAliases } : {}),
  };
}

/** Validate an `unknown` value as a `CultCopyResponse`. */
export function parseCultCopyResponse(value: unknown): CultCopyResponse {
  if (!isPlainObject(value)) throw new Error('cult copy response must be an object');
  const copy = value.copy;
  if (!isPlainObject(copy)) throw new Error('copy must be an object');
  for (const field of ['id', 'name', 'registryUrl'] as const) {
    if (typeof copy[field] !== 'string') throw new Error(`copy.${field} must be a string`);
  }
  if (!isStringArray(copy.dependencies)) throw new Error('copy.dependencies must be an array of strings');
  if (!isStringArray(copy.registryDependencies)) throw new Error('copy.registryDependencies must be an array of strings');
  assertFile(copy.mainFile, 'copy.mainFile');
  if (!Array.isArray(copy.files) || copy.files.some((file: unknown) => !isPlainObject(file) || typeof file.path !== 'string' || typeof file.target !== 'string')) {
    throw new Error('copy.files must be an array of { path, target }');
  }
  return value as unknown as CultCopyResponse;
}
