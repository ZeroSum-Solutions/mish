/**
 * Publishes fast-lane output into a local daemon project through the public file API.
 *
 * A page save carries its own artifact manifest as an AI-sourced version, so the sidecar always
 * matches the page that was just written. The daemon's project watcher turns every save into a
 * canvas reload. No daemon code is involved beyond the existing routes.
 */

import { randomUUID } from 'node:crypto';
import type { Json } from './spine.ts';

export type FileEncoding = 'utf8' | 'base64';

/**
 * A non-2xx answer from the daemon, carrying the status and the route as well as the message.
 *
 * The status is what tells a caller whether the request happened. A 4xx is the daemon deciding
 * about this request — it read it, refused it, and did nothing — so a create that ends this way
 * definitely did not create anything. A 5xx is the daemon failing part-way through and says
 * nothing about how far it got. Without the status a caller can only guess, and a caller rolling
 * back an ambiguous create cannot afford to.
 *
 * `message` is status-only (`daemon 500 on /api/projects`) — this error is what a fast-lane build
 * failure eventually surfaces to a caller that reads only `.message` (a persisted build failure,
 * `buildFailureMessage` in `apps/daemon/src/routes/agency-build.ts`), and the daemon's own answer
 * body is not this module's to repeat that far. It survives on `.detail` instead, when the caller
 * that threw kept one, for the one caller that explicitly wants it back: the CLI, on stderr, after
 * the status-only message.
 */
export class DaemonHttpError extends Error {
  readonly status: number;
  readonly route: string;
  readonly detail?: string;
  constructor(status: number, route: string, detail?: string) {
    super(`daemon ${status} on ${route}`);
    this.name = 'DaemonHttpError';
    this.status = status;
    this.route = route;
    this.detail = detail;
  }
}

export type ProjectPublisher = {
  projectId: string;
  savePage(entry: string, html: string, manifest: Json, label: string): Promise<void>;
  saveFile(name: string, content: string | Uint8Array, encoding?: FileEncoding): Promise<void>;
  /** Removes this project from the daemon, rolling back a project the caller created and is now
   * abandoning — a strict run whose deferred publish failed, or a build that was cancelled. It is
   * idempotent and tolerant of an ambiguous create; see `rollbackProject`. Answers what it found:
   * `deleted` if the project was there, `missing` if the daemon never had it. `retries` overrides
   * how many times a 404 is re-asked, for a caller that already knows the create's fate and needs
   * no confirmation. */
  deleteProject(options?: { retries?: number }): Promise<RollbackOutcome>;
};

type HttpOptions = {
  daemonUrl: string;
  fetchImpl?: typeof fetch;
  /** Cancels a write in flight, so a cancelled build stops saving as soon as it is told to. */
  signal?: AbortSignal;
};

async function postJson(options: HttpOptions, route: string, body: unknown): Promise<Json> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.daemonUrl.replace(/\/+$/u, '')}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) throw new DaemonHttpError(response.status, route, text.slice(0, 400));
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

/** How long the WHOLE rollback may take — every attempt together, not each one. */
const DEFAULT_DELETE_TIMEOUT_MS = 15_000;
/** How many times a rollback re-asks after a 404 before it accepts the project never arrived. */
const DEFAULT_ROLLBACK_RETRIES = 3;
/** The wait between those attempts. */
const DEFAULT_ROLLBACK_POLL_MS = 100;
/** How long a project create may take before the caller stops waiting for an answer. */
const DEFAULT_CREATE_TIMEOUT_MS = 15_000;

export type RollbackOptions = { deleteTimeoutMs?: number; rollbackRetries?: number; rollbackPollMs?: number };

/** What a rollback found: the project was there and is gone, or the daemon never had it. */
export type RollbackOutcome = 'deleted' | 'missing';

/**
 * One rollback DELETE. Deliberately runs without `options.signal`, and with a fresh timeout of its
 * own instead.
 *
 * Every DELETE this module sends is a rollback — of a project the caller just created and is now
 * abandoning — and the usual reason to abandon it is that very signal aborting. Handing the delete
 * the aborted signal would make the clean-up fail exactly when it is needed, leaving the
 * half-written project behind. Running it with no signal at all is not the answer either: a daemon
 * that never answers would then keep a cancelled build alive, holding its provider run lock,
 * without limit. So the rollback gets its own bounded deadline, unrelated to the caller's.
 *
 * A 404 is not a failure. `DELETE /api/projects/:id` answers `PROJECT_NOT_FOUND` for an id it does
 * not hold, which is what a caller rolling back an aborted create wants to hear: there is nothing
 * to remove. It is reported as `missing` rather than `deleted` only so `rollbackProject` can tell
 * "never arrived" from "removed" while it waits the ambiguity out.
 */
async function deleteProjectOnce(options: HttpOptions & RollbackOptions, route: string, timeoutMs: number): Promise<RollbackOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.daemonUrl.replace(/\/+$/u, '')}${route}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) {
    await response.text().catch(() => ''); // drain: releases the socket, the body is not wanted
    return 'missing';
  }
  if (!response.ok) {
    // The status, never the body. This message ends up in a `rollback-failed` result, which a
    // caller shows to a person and 6b turns into a job error, and the body of a daemon answer is
    // arbitrary upstream content that has no business travelling that far.
    await response.text().catch(() => ''); // drain: releases the socket, the body is not wanted
    throw new DaemonHttpError(response.status, `DELETE ${route}`);
  }
  return 'deleted';
}

/**
 * Removes a project a caller created, and is safe to call whatever actually happened to the create
 * that made it.
 *
 * One DELETE answers the ordinary cases: 404 means the daemon never had this id and there is
 * nothing to remove, 2xx means there was. A 404 is nonetheless re-asked a bounded number of times,
 * because a create whose answer the caller never received may still be landing. (`buildSite` waits
 * for its own create to settle before it calls this, which closes that window from the other side;
 * the retries remain for the case where the create's fate is genuinely unknown, and for any other
 * caller.) Asking again with a DELETE rather than a GET keeps it to one round trip per look: the
 * DELETE is its own confirmation.
 *
 * Every attempt shares ONE deadline. A per-attempt timeout would let a stalled daemon hold a
 * cancelled build for the timeout times the retry count; the caller asked for the rollback to be
 * bounded, and it is the whole operation that has to be.
 *
 * Being idempotent also means two owners can safely both roll back the same project, which is why
 * `runFastLane`'s own strict rollback and `buildSite`'s cancellation clean-up do not have to agree
 * in advance about which of them owns a given failure.
 */
export async function rollbackProject(options: HttpOptions & RollbackOptions & { projectId: string }): Promise<RollbackOutcome> {
  const route = `/api/projects/${encodeURIComponent(options.projectId)}`;
  const retries = options.rollbackRetries ?? DEFAULT_ROLLBACK_RETRIES;
  const pollMs = options.rollbackPollMs ?? DEFAULT_ROLLBACK_POLL_MS;
  const deadline = Date.now() + (options.deleteTimeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS);
  for (let attempt = 0; ; attempt += 1) {
    const left = deadline - Date.now();
    const outcome = await deleteProjectOnce(options, route, Math.max(left, 1));
    if (outcome === 'deleted') return 'deleted';
    if (attempt >= retries || deadline - Date.now() <= pollMs) return 'missing';
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * A fresh project id.
 *
 * Exposed so a caller can hold the id it is about to create BEFORE the create request goes out.
 * `POST /api/projects` takes the id from the client, so an aborted or timed-out create is
 * ambiguous — the daemon may well have committed the project before the connection went away —
 * and a caller that only learns the id from a resolved promise has nothing to roll back in
 * exactly the case that needs rolling back.
 */
export function newProjectId(): string {
  return randomUUID();
}

/**
 * Returns the given project id, or creates an agency-site project and returns its id.
 *
 * `id` names the project to create, for a caller that already holds one (see `newProjectId`);
 * left out, a fresh one is generated here. `projectId` is the other thing entirely: an existing
 * project to reuse, which is returned untouched without any request.
 *
 * The create deliberately ignores `options.signal` and runs under its own deadline instead. A
 * create that is cancelled mid-flight is the worst possible state to leave behind: the daemon
 * inserts the project only after a stretch of async validation, so an aborted request can commit
 * moments after the client gave up on it, and nothing the client does next can be ordered against
 * a request it has stopped listening to. Letting the create finish — one way or the other, within
 * `createTimeoutMs` — gives the caller something it can wait on before it rolls back.
 *
 * `archive` marks a newly created project already archived (`metadata.archived`), so an
 * overnight ladder run of dozens of sites doesn't flood Home — see RecentProjectsStrip's
 * Archived filter. It only applies at creation; a caller passing `projectId` reuses that
 * project untouched, archived state included.
 */
export async function ensureProject(
  options: HttpOptions & { projectId?: string; id?: string; name: string; archive?: boolean; createTimeoutMs?: number },
): Promise<string> {
  if (options.projectId) return options.projectId;
  const id = options.id ?? newProjectId();
  const createOptions = { ...options, signal: AbortSignal.timeout(options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS) };
  await postJson(createOptions, '/api/projects', {
    id,
    name: options.name,
    skillId: 'agency-site',
    ...(options.archive ? { metadata: { archived: true } } : {}),
  });
  return id;
}

export function projectPublisher(options: HttpOptions & RollbackOptions & { projectId: string }): ProjectPublisher {
  const route = `/api/projects/${encodeURIComponent(options.projectId)}/files`;
  return {
    projectId: options.projectId,
    async savePage(entry, html, manifest, label) {
      await postJson(options, route, {
        name: entry,
        content: html,
        encoding: 'utf8',
        source: 'ai',
        artifactManifest: manifest,
        versionLabel: label,
      });
    },
    async saveFile(name, content, encoding = 'utf8') {
      const text = typeof content === 'string' ? content : Buffer.from(content).toString('base64');
      await postJson(options, route, { name, content: text, encoding: typeof content === 'string' ? encoding : 'base64', overwrite: true });
    },
    async deleteProject(overrides) {
      return rollbackProject(overrides?.retries === undefined ? options : { ...options, rollbackRetries: overrides.retries });
    },
  };
}
