import {
  fetchProjectPreviewBaseHref,
  renewProjectPreviewBaseScope,
  type ProjectPreviewBaseScope,
} from '../providers/registry';

// One minted preview scope serves a whole project, so opaque previews of
// several files (thumbnails, version previews, design-system previews, the
// srcDoc viewer) share it instead of minting one per document.
//
// Lifetimes: a cached scope is handed to new previews only while it has more
// than PEEK_MIN_REMAINING left, and mounted previews renew it RENEW_MARGIN
// before expiry. RENEW_MARGIN is larger, so renewal always lands while the
// scope is still being handed out and every preview keeps one shared scope.
const PEEK_MIN_REMAINING_MS = 10 * 60 * 1000;
const RENEW_MARGIN_MS = 15 * 60 * 1000;
const RENEW_RETRY_BASE_MS = 15 * 1000;
const RENEW_RETRY_MAX_MS = 5 * 60 * 1000;

interface ScopeRoot {
  root: string;
  expiresAt: number;
}

const scopeRoots = new Map<string, ScopeRoot>();
const scopeInFlight = new Map<string, Promise<ScopeRoot | null>>();
const subscribers = new Map<string, Map<() => void, string>>();
const renewTimers = new Map<string, ReturnType<typeof setTimeout>>();
const renewAttempts = new Map<string, number>();

function encodeDirForUrl(dir: string): string {
  return dir
    .split('/')
    .map((segment) => (segment ? encodeURIComponent(segment) : segment))
    .join('/');
}

function dirOf(name: string): string {
  const index = name.lastIndexOf('/');
  return index >= 0 ? name.slice(0, index + 1) : '';
}

/**
 * The scope root (`<scheme>://<host>/api/projects/<id>/preview/<scope>/`) of
 * a preview capability href, or null when the href is not one for this
 * project. Built from the href's own scheme and host: the packaged app's
 * `od://app` URLs have an opaque `URL.origin` ("null"), so the origin must
 * never be used to rebuild them.
 */
function scopeRootOf(projectId: string, href: string): string | null {
  try {
    const parsed = new URL(href);
    const prefix = `/api/projects/${encodeURIComponent(projectId)}/preview/`;
    if (!parsed.pathname.startsWith(prefix) || !parsed.host) return null;
    const scopeEnd = parsed.pathname.indexOf('/', prefix.length);
    if (scopeEnd <= prefix.length) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.slice(0, scopeEnd + 1)}`;
  } catch {
    return null;
  }
}

/**
 * The scoped base directory for `name`, given any preview capability href
 * of the same project (any scheme, including the packaged `od://`).
 */
export function projectPreviewScopeDirHref(projectId: string, href: string, name: string): string | null {
  const root = scopeRootOf(projectId, href);
  return root === null ? null : `${root}${encodeDirForUrl(dirOf(name))}`;
}

/**
 * Synchronously return the scoped preview base directory for `name` when a
 * live project scope is already cached; otherwise null.
 */
export function peekProjectPreviewBaseHref(projectId: string, name: string): string | null {
  const cached = scopeRoots.get(projectId);
  if (!cached || cached.expiresAt - Date.now() < PEEK_MIN_REMAINING_MS) return null;
  return `${cached.root}${encodeDirForUrl(dirOf(name))}`;
}

/**
 * Store the project's current scope. Invariant: every change of scope root,
 * whoever caused it (a hook's renewal, FileViewer's renewal, a fresh mint),
 * reaches every mounted subscriber, so all previews of a project converge on
 * one scope and the shared renewal timer renews the scope they actually use.
 */
function setScopeRoot(projectId: string, entry: ScopeRoot): void {
  const previous = scopeRoots.get(projectId);
  scopeRoots.set(projectId, entry);
  if (previous?.root === entry.root) return;
  renewAttempts.delete(projectId);
  for (const listener of [...(subscribers.get(projectId)?.keys() ?? [])]) listener();
  if (subscribers.get(projectId)?.size) scheduleRenewal(projectId);
}

function mintScope(projectId: string, name: string): Promise<ScopeRoot | null> {
  const existing = scopeInFlight.get(projectId);
  if (existing) return existing;
  const minting = (async (): Promise<ScopeRoot | null> => {
    try {
      const scope = await fetchProjectPreviewBaseHref(projectId, name);
      const root = scope ? scopeRootOf(projectId, scope.href) : null;
      if (!scope || !root) return null;
      const entry = { root, expiresAt: scope.expiresAt };
      setScopeRoot(projectId, entry);
      return entry;
    } catch {
      return null;
    }
  })();
  scopeInFlight.set(projectId, minting);
  // A failed mint (file not on disk yet) must not block a later retry.
  void minting.finally(() => {
    if (scopeInFlight.get(projectId) === minting) scopeInFlight.delete(projectId);
  });
  return minting;
}

/**
 * The base directory opaque-origin previews resolve relative assets against.
 *
 * Raw project URLs grant no CORS to opaque documents (any of them can name
 * any project's raw URL), so fonts, module scripts and script reads must go
 * through this project-bound, unguessable preview capability. Resolves null
 * when no scope can be minted (for example the file is not on disk yet);
 * callers then fall back to the raw directory, where only no-CORS assets
 * (images, classic scripts, stylesheets) load.
 */
export async function resolveProjectPreviewBaseHref(
  projectId: string,
  name: string,
): Promise<ProjectPreviewBaseScope | null> {
  const peeked = peekProjectPreviewBaseHref(projectId, name);
  const cached = scopeRoots.get(projectId);
  if (peeked && cached) return { href: peeked, expiresAt: cached.expiresAt };
  const entry = await mintScope(projectId, name);
  if (!entry) return null;
  return { href: `${entry.root}${encodeDirForUrl(dirOf(name))}`, expiresAt: entry.expiresAt };
}

export type ProjectPreviewScopeRefresh =
  | { kind: 'renewed'; expiresAt: number }
  | { kind: 'replaced'; scope: ProjectPreviewBaseScope };

/**
 * Keep a preview capability alive: renew `href`'s scope, or, when the daemon
 * refuses (expired, revoked, or a restarted daemon that forgot it), move to
 * the project's replacement scope. Callers converge: if another caller has
 * already replaced the scope, that replacement is returned instead of minting
 * another, and concurrent replacements share one mint. The current scope is
 * kept until a replacement exists, so a failed attempt (daemon briefly down)
 * returns null and leaves the caller free to retry. Shared by FileViewer and
 * every useProjectPreviewBaseHref preview.
 */
export async function refreshProjectPreviewScope(
  projectId: string,
  href: string,
  name: string,
): Promise<ProjectPreviewScopeRefresh | null> {
  const root = scopeRootOf(projectId, href);
  const renewedExpiresAt = await renewProjectPreviewBaseScope(projectId, href);
  if (renewedExpiresAt !== null) {
    const cached = scopeRoots.get(projectId);
    if (root !== null && cached?.root === root) {
      scopeRoots.set(projectId, { root, expiresAt: renewedExpiresAt });
    }
    return { kind: 'renewed', expiresAt: renewedExpiresAt };
  }
  const current = scopeRoots.get(projectId);
  const dir = encodeDirForUrl(dirOf(name));
  if (current && current.root !== root && current.expiresAt - Date.now() > PEEK_MIN_REMAINING_MS) {
    return { kind: 'replaced', scope: { href: `${current.root}${dir}`, expiresAt: current.expiresAt } };
  }
  const replacement = await mintScope(projectId, name);
  if (!replacement) return null;
  return { kind: 'replaced', scope: { href: `${replacement.root}${dir}`, expiresAt: replacement.expiresAt } };
}

function scheduleRenewal(projectId: string, delayOverride?: number): void {
  const existing = renewTimers.get(projectId);
  if (existing !== undefined) clearTimeout(existing);
  renewTimers.delete(projectId);
  const listeners = subscribers.get(projectId);
  const cached = scopeRoots.get(projectId);
  if (!listeners || listeners.size === 0 || !cached) return;
  const delay = delayOverride ?? Math.max(0, cached.expiresAt - Date.now() - RENEW_MARGIN_MS);
  renewTimers.set(projectId, setTimeout(() => {
    renewTimers.delete(projectId);
    void renewSubscribedScope(projectId);
  }, delay));
}

async function renewSubscribedScope(projectId: string): Promise<void> {
  const listeners = subscribers.get(projectId);
  const cached = scopeRoots.get(projectId);
  if (!listeners || listeners.size === 0 || !cached) return;
  const name = listeners.values().next().value ?? '';
  const result = await refreshProjectPreviewScope(projectId, cached.root, name);
  if (!subscribers.get(projectId)?.size) return;
  if (result === null) {
    // Daemon unreachable: keep the current scope and retry with a capped
    // exponential backoff for as long as a preview is mounted.
    const attempt = (renewAttempts.get(projectId) ?? 0) + 1;
    renewAttempts.set(projectId, attempt);
    scheduleRenewal(projectId, Math.min(RENEW_RETRY_BASE_MS * 2 ** (attempt - 1), RENEW_RETRY_MAX_MS));
    return;
  }
  // A replacement already notified subscribers (setScopeRoot).
  renewAttempts.delete(projectId);
  scheduleRenewal(projectId);
}

/**
 * Keep the project's shared scope alive while a preview of `name` stays
 * mounted. `onReplaced` runs whenever the project's scope root changes,
 * whichever caller replaced it, so the preview can pick up the new base.
 * Returns the unsubscribe.
 */
export function subscribeProjectPreviewScope(
  projectId: string,
  name: string,
  onReplaced: () => void,
): () => void {
  let listeners = subscribers.get(projectId);
  if (!listeners) {
    listeners = new Map();
    subscribers.set(projectId, listeners);
  }
  const listener = () => onReplaced();
  listeners.set(listener, name);
  if (!renewTimers.has(projectId)) scheduleRenewal(projectId);
  return () => {
    const current = subscribers.get(projectId);
    current?.delete(listener);
    if (current && current.size === 0) {
      subscribers.delete(projectId);
      const timer = renewTimers.get(projectId);
      if (timer !== undefined) clearTimeout(timer);
      renewTimers.delete(projectId);
      renewAttempts.delete(projectId);
    }
  };
}

/** Test-only: forget cached project preview scopes and their renewals. */
export function resetProjectPreviewScopeCache(): void {
  for (const timer of renewTimers.values()) clearTimeout(timer);
  renewTimers.clear();
  renewAttempts.clear();
  subscribers.clear();
  scopeRoots.clear();
  scopeInFlight.clear();
}
