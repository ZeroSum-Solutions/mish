// The daemon's own TypeSafe (Jev) credential.
//
// Jev powers `POST /api/agency/route`, `POST /api/design-index/profile`, the Design index view
// and `od agency route`. Until now the key came from one place only — the owner's local secret
// store, reached by shelling out to `zsvault` — which made the whole surface unusable on any
// other machine. This module gives the daemon a credential of its own, on the same terms the
// media config (`media/config.ts`) already uses for provider keys:
//
//   1. `TYPESAFE_API_KEY` in the daemon's environment. A power user can keep the key out of the
//      data directory entirely, and an operator can set it per deployment.
//   2. The key saved through `PUT /api/agency/config`, in `agency-config.json` under the
//      resolved daemon data root, mode 0600, written temp-file-then-rename.
//   3. The machine's local secret store, read lazily and only when neither of the first two
//      answered. This is the owner's original setup and still works unchanged.
//
// The key never leaves this module. `status()` says which of the three is in effect and nothing
// else — no key, no tail, no suffix — so a Settings screen can render "configured" without the
// secret re-entering the DOM, and a failed vault read stays a silent fallback rather than a log
// line naming the entry it tried.
//
// The same file and the same three-step order also hold the fast lane's fill-model keys
// (DeepSeek, Cerebras): `DEEPSEEK_API_KEY` / `CEREBRAS_API_KEY` in the environment, then the key
// saved through `PUT /api/agency/config` with a `provider`, then the vault. The document is
// `{ jev?: { apiKey }, models?: { deepseek?: { apiKey }, cerebras?: { apiKey } } }`, and every
// write is read-modify-write inside one queue, so saving one key never drops another.
//
// "Absent" and "unreadable" are deliberately different answers. A missing file, or a valid
// document with no key in it, means the next source gets its turn. A file that is there but
// cannot be read — corrupt JSON, EACCES, an I/O error — raises `AgencyJevConfigUnreadableError`
// instead, because falling through would hand the machine back to the vault without telling
// anyone the file needs repairing, on the one screen that exists to show where the key comes
// from. The same rule holds for writes: only a missing file starts from an empty document. A
// file that is there but cannot be read refuses every save and clear with its bytes untouched,
// because it may still hold the other keys; `repair()` (`POST /api/agency/config/repair`,
// `od agency config repair --confirm`) renames it aside and never deletes it.

import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type {
  AgencyJevConfigErrorReason,
  AgencyJevConfigResponse,
  AgencyJevConfigSource,
  AgencyKeyStatus,
  AgencyModelProvider,
} from '@mish/contracts';
import { AGENCY_JEV_KEY_ENV, AGENCY_JEV_KEY_MAX_CHARS, AGENCY_MODEL_PROVIDERS } from '@mish/contracts';
import { providerEnvKey } from '@mish/agency-fast-lane/deepseek';

/** Owner-only, like every other credential file the daemon writes. */
const FILE_MODE = 0o600;
const CONFIG_FILE = 'agency-config.json';

/**
 * The stored-key file exists but could not be turned into a value. Carries a fixed message: the
 * underlying error names the path and, for a JSON failure, a slice of the file — which on this
 * one file is a credential.
 */
export class AgencyJevConfigUnreadableError extends Error {
  constructor() {
    super('the stored Jev key could not be read');
    this.name = 'AgencyJevConfigUnreadableError';
  }
}

/**
 * A save or clear was refused because the stored file exists but cannot be read or parsed, or
 * because, after the change, it would still hold a malformed section the change did not touch
 * (e.g. saving the DeepSeek key while the Jev section is broken). Nothing is written: the file
 * keeps its exact bytes — which may still hold every other key — so a PUT never answers an error
 * after having saved, and never replaces keys it could not read. `repair()` is the one explicit
 * way out. The message names no path and no value.
 */
export class AgencyConfigSectionInvalidError extends Error {
  constructor() {
    super('the stored key file is unreadable or has a malformed section, so nothing was saved');
    this.name = 'AgencyConfigSectionInvalidError';
  }
}

/** What `repair()` did. `movedTo` is the new file name only — never a path. */
export interface AgencyConfigRepairResult {
  repaired: boolean;
  movedTo: string | null;
}

export interface AgencyJevKeyStoreOptions {
  /** The resolved daemon data root (`RUNTIME_DATA_DIR`), never a cwd-relative guess. */
  dataDir: string;
  /** Reads the machine's local secret store. Rejecting is a normal "no key here" answer. */
  readVaultSecret: () => Promise<string>;
  /** The same for a fill model's key. Omitted means no vault for model keys at all. */
  readModelVaultSecret?: (provider: AgencyModelProvider) => Promise<string>;
}

/** No fill-model key resolves from any source. The message names only the provider. */
export class AgencyModelKeyUnavailableError extends Error {
  readonly provider: AgencyModelProvider;
  constructor(provider: AgencyModelProvider) {
    super(`no ${provider} key is configured on this daemon`);
    this.name = 'AgencyModelKeyUnavailableError';
    this.provider = provider;
  }
}

export interface AgencyJevKeyStore {
  /**
   * Which source is in effect right now. Probes the vault only when the first two are absent.
   * Rejects with `AgencyJevConfigUnreadableError` when the stored file cannot be read.
   */
  status: () => Promise<AgencyJevConfigResponse>;
  /** The key itself, for the Jev callers. Rejects when no source answers. */
  resolveKey: () => Promise<string>;
  save: (apiKey: string) => Promise<AgencyJevConfigResponse>;
  clear: () => Promise<AgencyJevConfigResponse>;
  /** One fill model's key status: env, then stored, then vault. Never the key. */
  modelStatus: (provider: AgencyModelProvider) => Promise<AgencyKeyStatus>;
  /** One fill model's key, for the fast lane's model caller. Rejects when no source answers. */
  resolveModelKey: (provider: AgencyModelProvider) => Promise<string>;
  saveModelKey: (provider: AgencyModelProvider, apiKey: string) => Promise<AgencyJevConfigResponse>;
  clearModelKey: (provider: AgencyModelProvider) => Promise<AgencyJevConfigResponse>;
  /**
   * The explicit way out of an unreadable or malformed file: renames it to
   * `agency-config.json.corrupt-<timestamp>` (never deletes it) so the next save starts fresh.
   * A missing or healthy file is left alone and reported as `repaired: false`.
   */
  repair: () => Promise<AgencyJevConfigResponse & AgencyConfigRepairResult>;
  /**
   * Counts saves and clears. `freshPerGeneration` below turns that count into the whole of the
   * cache invalidation the fast lane's own key cache would otherwise make impossible.
   */
  generation: () => number;
}

/** The one shape `PUT /api/agency/config` accepts a key in, or the reason it does not. */
export type AgencyJevKeyCheck =
  | { apiKey: string; provider?: AgencyModelProvider }
  | { clear: true; provider?: AgencyModelProvider }
  | { error: string; reason: AgencyJevConfigErrorReason };

function isModelProvider(value: unknown): value is AgencyModelProvider {
  return typeof value === 'string' && (AGENCY_MODEL_PROVIDERS as string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a `PUT /api/agency/config` body against the exact union, not a superset of it.
 *
 * A credential write is the wrong place to guess what the caller meant, so exactly one of the two
 * shapes is accepted, no companion field rides along, and everything else is refused with a
 * reason a client can translate. An unknown extra field is a refusal rather than something to
 * ignore: `{ apiKey, clear: true }` read as a plain save is the shape most likely to mean the
 * caller believed something else was happening.
 *
 * Whitespace inside a key is refused rather than stripped: a key that arrived with a line break
 * in the middle is a paste accident, and silently repairing it would store a key the user cannot
 * reproduce.
 */
export function checkAgencyJevConfigBody(body: unknown): AgencyJevKeyCheck {
  const shape = (error: string): AgencyJevKeyCheck => ({ error, reason: 'shape' });
  if (!isPlainObject(body)) return shape('body must be an object');

  // `provider` is the one companion field allowed, and only with a known provider: it moves the
  // write from the Jev key to that fill model's key. Everything else about the body is the same.
  let provider: AgencyModelProvider | undefined;
  let keys = Object.keys(body);
  if (keys.includes('provider')) {
    if (!isModelProvider(body.provider)) return shape('provider must be deepseek or cerebras');
    provider = body.provider;
    keys = keys.filter((key) => key !== 'provider');
  }
  const scoped = provider ? { provider } : {};
  if (keys.length !== 1) {
    return shape('body must carry exactly one of apiKey or clear');
  }
  if (keys[0] === 'clear') {
    if (body.clear !== true) return shape('clear must be true');
    return { clear: true, ...scoped };
  }
  if (keys[0] !== 'apiKey') return shape('apiKey or clear is required');
  if (typeof body.apiKey !== 'string') return shape('apiKey must be a string');

  const apiKey = body.apiKey.trim();
  if (apiKey.length === 0) return { error: 'apiKey must not be empty', reason: 'empty' };
  if (apiKey.length > AGENCY_JEV_KEY_MAX_CHARS) {
    return { error: `apiKey must be at most ${AGENCY_JEV_KEY_MAX_CHARS} characters`, reason: 'too-long' };
  }
  if (/\s/.test(apiKey)) return { error: 'apiKey must not contain whitespace', reason: 'whitespace' };
  return { apiKey, ...scoped };
}

/**
 * The rule a key must already satisfy to be read back out of the stored file. Deliberately the
 * same rule `checkAgencyJevConfigBody` applies on the way in, minus the trimming: a value only
 * reaches the file through that check, so anything here that fails it was edited by hand or
 * corrupted, and is a fault rather than something to repair silently.
 */
function isStorableJevKey(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= AGENCY_JEV_KEY_MAX_CHARS
    && !/\s/.test(value)
  );
}

function envKey(name: string = AGENCY_JEV_KEY_ENV): string {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

type ConfigDocument = Record<string, unknown>;

/**
 * Reads one `{ apiKey }` section out of the document. Absence is the missing section or the
 * missing property and nothing else; a key that is there but unusable is a broken file.
 */
function sectionKey(section: unknown): string {
  if (section === undefined) return '';
  if (!isPlainObject(section)) throw new AgencyJevConfigUnreadableError();
  // Absence is the missing property and nothing else. A key that is THERE but unusable —
  // empty, carrying whitespace, past the cap — is a broken file: trimming it into shape would
  // store a key the user cannot reproduce, and calling it absent would hand the machine to the
  // vault with nobody told the file needs repairing. Both hide the same fault, so neither is
  // done, and the value is returned exactly as it was written.
  if (section.apiKey === undefined) return '';
  if (!isStorableJevKey(section.apiKey)) throw new AgencyJevConfigUnreadableError();
  return section.apiKey;
}

function errorCode(error: unknown): string | undefined {
  return isPlainObject(error) && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Every section `status()` reads, checked the same way it reads them. Throws
 * `AgencyJevConfigUnreadableError` on the first malformed one.
 */
function validateDocument(doc: ConfigDocument): void {
  sectionKey(doc.jev);
  const models = doc.models;
  if (models === undefined) return;
  if (!isPlainObject(models)) throw new AgencyJevConfigUnreadableError();
  for (const provider of AGENCY_MODEL_PROVIDERS) sectionKey(models[provider]);
}

export function createAgencyJevKeyStore(options: AgencyJevKeyStoreOptions): AgencyJevKeyStore {
  const file = path.join(options.dataDir, CONFIG_FILE);
  let generation = 0;
  // Every write goes through one chain, so two saves cannot interleave their rename with each
  // other's temp file and leave the loser's bytes at the final path.
  let writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * A missing file is "no stored key". Anything else that goes wrong is a fault, not an absence:
   * see this module's header for why the two must not collapse into one another.
   */
  const readDocument = async (): Promise<ConfigDocument> => {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return {};
      throw new AgencyJevConfigUnreadableError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AgencyJevConfigUnreadableError();
    }
    if (!isPlainObject(parsed)) throw new AgencyJevConfigUnreadableError();
    return parsed;
  };

  const readStoredKey = async (): Promise<string> => sectionKey((await readDocument()).jev);

  const readStoredModelKey = async (provider: AgencyModelProvider): Promise<string> => {
    const models = (await readDocument()).models;
    if (models === undefined) return '';
    if (!isPlainObject(models)) throw new AgencyJevConfigUnreadableError();
    return sectionKey(models[provider]);
  };

  /**
   * Temp file then rename, with the mode carried by the temp file so the key is never briefly
   * readable by anyone else at the final path. The temp name is unique and opened `wx`, so a
   * stale or planted file at a guessable path can neither receive the key nor be followed.
   */
  const writeDocumentNow = async (body: ConfigDocument): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(12).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await open(temp, 'wx', FILE_MODE);
      await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`, 'utf8');
      await handle.close();
      handle = undefined;
      await rename(temp, file);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  };

  /** Runs `task` after every earlier write has landed. */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writeQueue.then(task);
    // The queue must survive a failed write, or one error would wedge every later one.
    writeQueue = next.catch(() => {});
    return next;
  };

  /**
   * Read-modify-write, inside the queue: the current document is read AFTER every earlier write
   * has landed, one section is changed, and the rest is written back as it was. Only a MISSING
   * file starts from `{}`. A file that is there but cannot be read or parsed refuses the write and
   * keeps its bytes: it may hold the other keys, and replacing it would erase them without anyone
   * having asked. `repair()` is the explicit way out.
   */
  const updateDocument = (change: (doc: ConfigDocument) => ConfigDocument): Promise<void> =>
    enqueue(async () => {
      let current: ConfigDocument;
      try {
        current = await readDocument();
      } catch (error) {
        if (error instanceof AgencyJevConfigUnreadableError) throw new AgencyConfigSectionInvalidError();
        throw error;
      }
      const updated = change(current);
      // Validated whole BEFORE anything is written: a readable file whose untouched sections are
      // malformed must not take this write and then fail the status read that answers it.
      try {
        validateDocument(updated);
      } catch {
        throw new AgencyConfigSectionInvalidError();
      }
      await writeDocumentNow(updated);
    });

  /** `<file>.corrupt-<timestamp>`, with a counter if that name is somehow taken already. */
  const freeCorruptName = async (): Promise<string> => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (let n = 0; ; n += 1) {
      const candidate = `${file}.corrupt-${stamp}${n === 0 ? '' : `-${n}`}`;
      try {
        await lstat(candidate);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return candidate;
        throw error;
      }
    }
  };

  /** Inside the queue, so no save can land between the check and the rename. */
  const repairNow = (): Promise<string | null> =>
    enqueue(async () => {
      try {
        // A missing file reads as `{}` and validates: nothing to repair.
        validateDocument(await readDocument());
        return null;
      } catch (error) {
        if (!(error instanceof AgencyJevConfigUnreadableError)) throw error;
      }
      const target = await freeCorruptName();
      await rename(file, target);
      return path.basename(target);
    });

  const writeStoredKey = (apiKey: string): Promise<void> =>
    updateDocument((doc) => {
      const { jev: _jev, ...rest } = doc;
      return apiKey ? { ...rest, jev: { apiKey } } : rest;
    });

  const writeStoredModelKey = (provider: AgencyModelProvider, apiKey: string): Promise<void> =>
    updateDocument((doc) => {
      const { models, ...rest } = doc;
      const current = isPlainObject(models) ? models : {};
      const { [provider]: _old, ...others } = current;
      const nextModels = apiKey ? { ...others, [provider]: { apiKey } } : others;
      return Object.keys(nextModels).length > 0 ? { ...rest, models: nextModels } : rest;
    });

  /** The vault is the last resort, so it is only ever touched when the first two are absent. */
  const readVault = async (): Promise<string> => {
    try {
      const value = await options.readVaultSecret();
      return typeof value === 'string' ? value.trim() : '';
    } catch {
      return '';
    }
  };

  const resolve = async (): Promise<{ key: string; source: AgencyJevConfigSource }> => {
    const fromEnv = envKey();
    if (fromEnv) return { key: fromEnv, source: 'env' };
    const stored = await readStoredKey();
    if (stored) return { key: stored, source: 'stored' };
    const vault = await readVault();
    if (vault) return { key: vault, source: 'vault' };
    return { key: '', source: 'unset' };
  };

  /** A fill model's vault read: last resort, silent on failure, like `readVault`. */
  const readModelVault = async (provider: AgencyModelProvider): Promise<string> => {
    if (!options.readModelVaultSecret) return '';
    try {
      const value = await options.readModelVaultSecret(provider);
      return typeof value === 'string' ? value.trim() : '';
    } catch {
      return '';
    }
  };

  const resolveModel = async (provider: AgencyModelProvider): Promise<{ key: string; source: AgencyJevConfigSource }> => {
    // The fast lane's own env read, so blank/trim semantics match `createProviderKeyResolver`.
    const fromEnv = provider === 'openrouter' ? (process.env.OD_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '').trim() : providerEnvKey(process.env, provider);
    if (fromEnv) return { key: fromEnv, source: 'env' };
    const stored = await readStoredModelKey(provider);
    if (stored) return { key: stored, source: 'stored' };
    const vault = await readModelVault(provider);
    if (vault) return { key: vault, source: 'vault' };
    return { key: '', source: 'unset' };
  };

  const modelStatus = async (provider: AgencyModelProvider): Promise<AgencyKeyStatus> => {
    const { key, source } = await resolveModel(provider);
    return { configured: key.length > 0, source };
  };

  const status = async (): Promise<AgencyJevConfigResponse> => {
    const { key, source } = await resolve();
    const models = {} as Record<AgencyModelProvider, AgencyKeyStatus>;
    for (const provider of AGENCY_MODEL_PROVIDERS) models[provider] = await modelStatus(provider);
    return { configured: key.length > 0, source, models };
  };

  return {
    status,
    resolveKey: async () => {
      let resolved;
      try {
        resolved = await resolve();
      } catch (error) {
        if (error instanceof AgencyJevConfigUnreadableError) {
          // One fixed sentence. No path, no parser detail, nothing read out of the file — the
          // operator needs to know the file is the problem, and nothing more can safely be said.
          console.error('[agency-config] the stored Jev key file could not be read');
        }
        throw error;
      }
      // The message names no entry, no path and no source: `jevKeyResolver` turns every failure
      // here into the same `JevKeyUnavailableError`, which the routes answer as a bare 503.
      if (!resolved.key) throw new Error('no Jev key is configured on this daemon');
      return resolved.key;
    },
    save: async (apiKey: string) => {
      await writeStoredKey(apiKey);
      generation += 1;
      return status();
    },
    clear: async () => {
      // Idempotent on purpose: clearing with nothing stored is a success that reports whichever
      // source the daemon will use next, not a complaint that there was nothing to remove.
      await writeStoredKey('');
      generation += 1;
      return status();
    },
    modelStatus,
    resolveModelKey: async (provider) => {
      let resolved;
      try {
        resolved = await resolveModel(provider);
      } catch (error) {
        if (error instanceof AgencyJevConfigUnreadableError) {
          console.error('[agency-config] the stored model key file could not be read');
        }
        throw error;
      }
      if (!resolved.key) throw new AgencyModelKeyUnavailableError(provider);
      return resolved.key;
    },
    saveModelKey: async (provider, apiKey) => {
      await writeStoredModelKey(provider, apiKey);
      return status();
    },
    clearModelKey: async (provider) => {
      await writeStoredModelKey(provider, '');
      return status();
    },
    repair: async () => {
      const movedTo = await repairNow();
      if (movedTo) {
        generation += 1;
        // A fixed sentence plus the new file name, which is not a secret and says where the old
        // keys went. No path, nothing read out of the file.
        console.error(`[agency-config] the unreadable key file was set aside as ${movedTo}`);
      }
      return { ...(await status()), repaired: movedTo !== null, movedTo };
    },
    generation: () => generation,
  };
}

/**
 * Rebuilds `build()`'s value whenever `generation()` moves.
 *
 * The fast lane's `resolveJevKey` caches a successfully read key for the lifetime of the router
 * or profiler it was handed to (`packages/agency-fast-lane/src/jev.ts`), which is deliberate —
 * a long-lived daemon must not shell out once per request. The cost is that a key saved or
 * cleared through Settings would not be seen until the daemon restarted. Throwing the router
 * away is the cheapest correct answer: building one is a handful of closures, not a connection,
 * so the fast lane keeps its cache and a settings change still lands on the next request.
 */
export function freshPerGeneration<T>(generation: () => number, build: () => T): () => T {
  let cached: { at: number; value: T } | undefined;
  return () => {
    const at = generation();
    if (!cached || cached.at !== at) cached = { at, value: build() };
    return cached.value;
  };
}
