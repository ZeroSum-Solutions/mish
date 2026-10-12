// Fetches ONE MotionSites prompt body transiently — the design doc §1's "user-authorized,
// on-demand prompt" step, called only when a build starts with a `designReferenceId` (phase D's
// build route calls `fetchMotionSitesDesignReference` and hands the result to the fast lane as
// untrusted design guidance, in memory, for that one build).
//
// HARD RULE (design doc §1 and §4, and the repo's own MotionSites policy): the value this module
// returns is NEVER written to disk, a log line, a trace, a debug dir, browser storage, or the
// build record — only the `promptId` may be kept (e.g. in fork history) so a fork can fetch it
// again later. Nothing in this file itself persists or logs `MotionSitesDesignReference.text`;
// callers (phase D) must keep that invariant on their side too — see this file's own tests for
// what "transient" is verified against here (no accidental console/error-message leak of the
// fetched text).

import { callMotionSitesTool, McpHttpTransportError } from './mcp-client.js';
import { resolveMotionSitesMcpConnection } from './connection.js';
import { classifyMotionSitesFailure, MotionSitesLoginRequiredError, MotionSitesUpstreamError } from './errors.js';
import { getLocalCorpusText } from './local-corpus-source.js';

/** `SectionCatalogEntry.id` prefix `@open-design/section-catalog`'s `local-corpus.ts` gives every
 * bundled owner-authored entry (`zerosum-kit:<row.id>`) — see that module's `toEntry`. */
const ZEROSUM_KIT_ID_PREFIX = 'zerosum-kit:';
/** Mirrors `@open-design/section-catalog`'s `motionsites.ts` `normalizeMotionSitesPrompt`'s
 * `id: \`motionsites-prompt:${result.id}\`` — the prefix a federated MotionSites entry's id
 * carries. */
const MOTIONSITES_PROMPT_ID_PREFIX = 'motionsites-prompt:';

/**
 * A transiently fetched MotionSites prompt, held only in memory for the one build that requested
 * it. Deliberately NOT a `packages/contracts` DTO — see that package's `motionsites.ts` header for
 * why giving this a wire-contract shape would invite exactly the kind of accidental
 * serialization/logging the design doc forbids.
 */
export interface MotionSitesDesignReference {
  promptId: string;
  /** The prompt's full text. Untrusted design guidance — see the design doc §2 on how the fast
   * lane must treat it (layout/typography/motion cues only, never a source of factual claims). */
  text: string;
}

/**
 * Resolves `id`'s full text on demand, dispatching by which catalog source produced it — the one
 * entry point phase D's build-start route calls for EITHER a `zerosum-kit:*` (bundled, always
 * available, no connection needed) or a `motionsites-prompt:*` (federated, needs the live MCP
 * connection) `designReferenceId` (2026-09-24 phase-C coordination note: "they may appear in the
 * catalog and be chosen explicitly as a designReference, the same as a motionsites-prompt").
 *
 * Throws `MotionSitesLoginRequiredError` when there is no usable connection (`motionsites-prompt:*`
 * only), or `MotionSitesPaidAccessRequiredError` (§1/§4: "the owner must buy access only to use
 * premium prompts... a purchase does not authorize vendoring") when the connected account cannot
 * open this specific prompt — a premium prompt on a free account, or the free-tier 3-prompt
 * allowance is exhausted. Both are meant to surface as structured failures BEFORE the build
 * proceeds, per the design doc's explicit access-error requirement. A `zerosum-kit:*` id that is
 * unknown or would be refused by the local-corpus importer's own rules throws a plain `Error`
 * (there is no login/paid-access concept for bundled, owner-authored content).
 */
export async function fetchMotionSitesDesignReference(
  dataDir: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MotionSitesDesignReference> {
  if (id.startsWith(ZEROSUM_KIT_ID_PREFIX)) return fetchLocalCorpusDesignReference(id);
  if (!id.startsWith(MOTIONSITES_PROMPT_ID_PREFIX)) {
    throw new Error(`"${id}" is not a recognized MotionSites bridge designReferenceId (expected a "${ZEROSUM_KIT_ID_PREFIX}" or "${MOTIONSITES_PROMPT_ID_PREFIX}" prefix)`);
  }
  const promptId = id.slice(MOTIONSITES_PROMPT_ID_PREFIX.length);
  return fetchFederatedDesignReference(dataDir, id, promptId, fetchImpl);
}

async function fetchLocalCorpusDesignReference(id: string): Promise<MotionSitesDesignReference> {
  const corpusId = id.slice(ZEROSUM_KIT_ID_PREFIX.length);
  const text = await getLocalCorpusText(corpusId);
  if (text === null) throw new Error(`No local-corpus row for "${id}" (unknown id, or the row no longer passes the importer's own rules)`);
  return { promptId: id, text };
}

async function fetchFederatedDesignReference(
  dataDir: string,
  entryId: string,
  promptId: string,
  fetchImpl: typeof fetch,
): Promise<MotionSitesDesignReference> {
  let result;
  try {
    const connection = await resolveMotionSitesMcpConnection(dataDir, fetchImpl);
    result = await callMotionSitesTool({ ...connection, fetchImpl }, 'get_prompt', { id: promptId });
  } catch (err) {
    if (err instanceof MotionSitesLoginRequiredError) throw err;
    if (err instanceof McpHttpTransportError) throw new MotionSitesUpstreamError(err.message, { cause: err });
    throw err;
  }
  if (result.isError) {
    throw classifyMotionSitesFailure(promptId, result.text || `MotionSites get_prompt failed for "${promptId}"`);
  }
  const text = extractPromptText(result.data);
  if (text === null) {
    throw new MotionSitesUpstreamError(
      `MotionSites get_prompt returned no recognized prompt-text field (expected a string, or an object with a ` +
      `"text"/"prompt"/"prompt_text" string field) for "${promptId}"`,
    );
  }
  // `promptId` here is the full catalog entry id (the `motionsites-prompt:` prefix included), not
  // the bare MotionSites id `get_prompt` was called with — matching `fetchLocalCorpusDesignReference`,
  // so a caller/fork history round-trips through the same id space regardless of source.
  return { promptId: entryId, text };
}

/**
 * `get_prompt`'s structured payload shape is not fixed by the tool schema beyond "the full prompt
 * text" (see https://motionsites.ai/mcp), so this accepts either a bare string result or a
 * `{ text: string }` / `{ prompt: string }` / `{ prompt_text: string }` object — whichever the
 * live tool actually returns.
 *
 * Deliberately does NOT fall back to the tool result's raw text block when none of those shapes
 * match (delta-audit FIX): the raw text block is meant for a human-readable summary, not
 * guaranteed to be the prompt body, and a success response (`isError: false`) whose
 * `structuredContent` is missing or carries none of the recognized fields — e.g.
 * `{ structuredContent: { error: "..." } }`, a malformed/renamed field, or no structuredContent at
 * all — must surface as an explicit `MotionSitesUpstreamError` (thrown by the caller when this
 * returns `null`), not silently hand back whatever the text block happened to contain.
 */
function extractPromptText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (isPlainObject(data)) {
    if (typeof data.text === 'string') return data.text;
    if (typeof data.prompt === 'string') return data.prompt;
    if (typeof data.prompt_text === 'string') return data.prompt_text;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
