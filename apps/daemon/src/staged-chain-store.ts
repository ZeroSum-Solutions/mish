/**
 * Durable copy of each staged-drafting chain, so a daemon restart cannot
 * silently drop a finishing pass. One JSON file per draft Run under a
 * directory the caller derives from the daemon data root.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { DesignBrief, StagedRunRecord } from '@mish/contracts';

import { INTERRUPTED_MESSAGE } from './staged-routing.js';

export interface StagedChainEntry {
  draftRunId: string;
  /** First terminal transition; active and resumable chains have no expiry. */
  terminalAt?: number;
  /** Includes replaced interrupted passes, so every physical Run keeps its owner. */
  runIds?: string[];
  chain: StagedRunRecord;
  /** The user's request text, before replay composition. */
  originalPrompt: string;
  /** Request body for the main model; secrets are stripped by the caller. */
  mainBody: Record<string, unknown>;
  /** Meta the draft Run was created with, secrets stripped. */
  draftMeta: Record<string, unknown>;
  /** Trusted R15 snapshot resolved by the daemon, never taken from request JSON. */
  acceptedBrief?: DesignBrief;
}

export interface StagedChainStore {
  save(entry: StagedChainEntry): void;
  load(draftRunId: string): StagedChainEntry | null;
  findByRunId(runId: string): StagedChainEntry | null;
  list(): StagedChainEntry[];
  listByConversation(conversationId: string): StagedChainEntry[];
}

const safeName = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '_');

/** Terminal history is retained for seven days; resumable work never expires. */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createStagedChainStore(
  dir: string,
  options: { now?: () => number; retentionMs?: number } = {},
): StagedChainStore {
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? TERMINAL_RETENTION_MS;
  const file = (id: string) => path.join(dir, `${safeName(id)}.json`);
  // Only ownership and expiry metadata live in memory; state reads remain durable.
  const ownerByRun = new Map<string, string>();
  const runsByOwner = new Map<string, Set<string>>();
  const ownersByConversation = new Map<string, Set<string>>();
  const conversationByOwner = new Map<string, string>();
  const expiryByOwner = new Map<string, number>();
  const warnedPruneFailures = new Set<string>();
  const expirations: Array<{ id: string; at: number }> = [];
  const terminal = (entry: StagedChainEntry) => !entry.chain.interrupted
    && entry.chain.stages.every(stage => !['pending', 'running', 'interrupted'].includes(stage.status));
  const unindex = (id: string) => {
    for (const runId of runsByOwner.get(id) ?? []) ownerByRun.delete(runId);
    runsByOwner.delete(id);
    const conversation = conversationByOwner.get(id);
    if (conversation) {
      const owners = ownersByConversation.get(conversation);
      owners?.delete(id);
      if (!owners?.size) ownersByConversation.delete(conversation);
    }
    conversationByOwner.delete(id);
    expiryByOwner.delete(id);
    warnedPruneFailures.delete(id);
  };
  const index = (entry: StagedChainEntry) => {
    unindex(entry.draftRunId);
    const runIds = new Set([entry.draftRunId, ...entry.runIds ?? []]);
    for (const stage of entry.chain.stages) if (stage.runId) runIds.add(stage.runId);
    runsByOwner.set(entry.draftRunId, runIds);
    for (const runId of runIds) ownerByRun.set(runId, entry.draftRunId);
    const conversation = entry.draftMeta.conversationId;
    if (typeof conversation === 'string' && conversation) {
      const owners = ownersByConversation.get(conversation) ?? new Set<string>();
      owners.add(entry.draftRunId);
      ownersByConversation.set(conversation, owners);
      conversationByOwner.set(entry.draftRunId, conversation);
    }
    if (terminal(entry) && typeof entry.terminalAt === 'number') {
      const at = entry.terminalAt + retentionMs;
      expiryByOwner.set(entry.draftRunId, at);
      expirations.push({ id: entry.draftRunId, at });
      expirations.sort((a, b) => a.at - b.at);
    }
  };
  const prune = () => {
    const at = now();
    while (expirations[0] && expirations[0].at <= at) {
      const expired = expirations.shift()!;
      if (expiryByOwner.get(expired.id) !== expired.at) continue;
      // Housekeeping must not block live work. Retry locked files in a minute.
      try { fs.unlinkSync(file(expired.id)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          const retryAt = at + 60_000;
          expiryByOwner.set(expired.id, retryAt);
          expirations.push({ id: expired.id, at: retryAt });
          expirations.sort((a, b) => a.at - b.at);
          if (!warnedPruneFailures.has(expired.id)) {
            console.warn(`[staged-chain-store] Prune deferred for ${expired.id}: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
            warnedPruneFailures.add(expired.id);
          }
          continue;
        }
      }
      unindex(expired.id);
    }
  };
  const read = (target: string): StagedChainEntry | null => {
    try {
      const value = JSON.parse(fs.readFileSync(target, 'utf8')) as StagedChainEntry;
      if (value?.runIds !== undefined && (!Array.isArray(value.runIds) || !value.runIds.every(id => typeof id === 'string'))) return null;
      return value && typeof value.draftRunId === 'string' && Array.isArray(value.chain?.stages) ? value : null;
    } catch {
      return null;
    }
  };
  // Bootstrap once, including records written before terminalAt existed.
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const name of names) {
    const target = path.join(dir, name);
    const entry = read(target);
    if (!entry) continue;
    if (terminal(entry) && !Number.isFinite(entry.terminalAt)) {
      const ended = entry.chain.stages.flatMap(stage => typeof stage.endedAt === 'number' ? [stage.endedAt] : []);
      entry.terminalAt = ended.length ? Math.max(...ended) : fs.statSync(target).mtimeMs;
    }
    index(entry);
  }
  prune();
  const readOwners = (owners: Iterable<string>) => {
    prune();
    return [...owners].map(id => read(file(id))).filter((entry): entry is StagedChainEntry => entry !== null);
  };
  return {
    save(entry) {
      entry.runIds = [...new Set([entry.draftRunId, ...entry.runIds ?? [], ...entry.chain.stages.flatMap(stage => stage.runId ? [stage.runId] : [])])];
      if (terminal(entry)) entry.terminalAt ??= now();
      else delete entry.terminalAt;
      fs.mkdirSync(dir, { recursive: true });
      const target = file(entry.draftRunId);
      const temp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(entry));
      fs.renameSync(temp, target);
      index(entry);
      prune();
    },
    load: (id) => { prune(); return read(file(id)); },
    findByRunId: (runId) => {
      prune();
      const owner = ownerByRun.get(runId);
      return owner ? read(file(owner)) : null;
    },
    list: () => readOwners(runsByOwner.keys()),
    listByConversation: (conversationId) => readOwners(ownersByConversation.get(conversationId) ?? []),
  };
}

const OPEN = new Set(['pending', 'running']);

/**
 * Run once at startup. A chain whose draft finished but whose finishing (or
 * fallback) pass was still open is flagged `interrupted`, which is what offers
 * "Finish now"; a chain whose draft died mid-run just records that. Returns
 * the draft Run ids that can be finished.
 */
export function recoverInterruptedChains(store: StagedChainStore): string[] {
  const resumable: string[] = [];
  for (const entry of store.list()) {
    if (entry.chain.stopped) {
      entry.chain.interrupted = null;
      for (const stage of entry.chain.stages) {
        if (stage.status === 'running') stage.status = 'canceled';
        else if (stage.status === 'pending' || stage.status === 'interrupted') stage.status = 'skipped';
      }
      store.save(entry);
      continue;
    }
    const draft = entry.chain.stages.find((s) => s.stage === 'draft');
    const open = entry.chain.stages.filter((s) => s.stage !== 'draft' && OPEN.has(s.status));
    if (draft && OPEN.has(draft.status)) {
      draft.status = 'failed';
      for (const stage of open) stage.status = 'failed';
      store.save(entry);
    } else if (draft?.status === 'succeeded' && open.length > 0) {
      for (const stage of open) stage.status = 'interrupted';
      entry.chain.interrupted = { message: INTERRUPTED_MESSAGE };
      store.save(entry);
      resumable.push(entry.draftRunId);
    }
  }
  return resumable;
}
