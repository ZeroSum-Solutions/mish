import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertEgressDigest } from './egress.js';
import {
  isCurrentVerificationBundle, parseVerificationBundle, renderReviewEvidenceParam, WORKBENCH_REVIEW_BUNDLE_ID_PATTERN, WORKBENCH_REVIEW_CONFORMANCE_NOTE, WORKBENCH_REVIEW_EGRESS_SCHEMA, WORKBENCH_REVIEW_PREVIEW_HOST,
  type ReviewEvidenceMessage, type ReviewEvidenceParam, type VerificationBundle, type VerificationBundleSummary,
} from '@open-design/contracts';
import { ev, evidenceUrl, PageText, type EvidenceContext } from './evidence.js';

type StoredEgress = NonNullable<VerificationBundle['egress']>;
type StoredConsole = NonNullable<VerificationBundle['console']>;

/**
 * Thrown when a legacy bundle (see legacyProjection) would be used as
 * anything other than the user's local history: reviewer input, a re-review
 * seed, an export or share payload, or new stored evidence.
 */
export class LegacyEvidenceError extends Error {
  constructor(use: string) {
    super(`This evidence was recorded before evidence redaction, so it is never ${use}`);
    this.name = 'LegacyEvidenceError';
  }
}

/**
 * A bundle is current only when the contract's currency rules hold (evidence
 * version /2, every section current, every text field a structured message,
 * every named path, origin and host vouched for by the bundle itself).
 * Anything marked, missing, mixed or carrying free text is legacy, whichever
 * path it arrived by and whatever its labels say.
 */
export function isLegacyBundle(bundle: VerificationBundle, rubricKeys: ReadonlySet<string> | null = null): boolean {
  return !isCurrentVerificationBundle(bundle, { rubricKeys });
}

/**
 * The one gate for any use that sends bundle text off the machine or to a
 * model. `rubricKeys` are the keys of the rubric and context the review was
 * planned from (frozenRubricKeys); a rubric-key parameter outside them fails.
 */
export function assertCurrentEvidence(bundle: VerificationBundle, use: string, rubricKeys: ReadonlySet<string> | null = null): void {
  if (isLegacyBundle(bundle, rubricKeys)) throw new LegacyEvidenceError(use);
}

/** A rubric key the frozen inputs do not name is served only as its token. */
function verifiedRubricKeys(value: ReviewEvidenceMessage, rubricKeys: ReadonlySet<string> | null): ReviewEvidenceMessage {
  const visit = (param: ReviewEvidenceParam): ReviewEvidenceParam => param.kind === 'rubricKey' && !rubricKeys?.has(param.value) ? PageText.of(param.value).token()
    : param.kind === 'list' ? { ...param, items: param.items.map(visit) }
      : param.kind === 'message' ? { ...param, params: param.params.map(visit) } : param;
  return { template: value.template, params: value.params.map(visit) };
}

const tokenText = (value: string): string => renderReviewEvidenceParam(PageText.of(value).token());
/** A legacy free-text field, served only as its token (a message, so readers localize it). */
const tokenMessage = (value: ReviewEvidenceMessage | string, rubricKeys: ReadonlySet<string> | null): ReviewEvidenceMessage => typeof value === 'string' ? ev('legacy.text', PageText.of(value).token()) : verifiedRubricKeys(value, rubricKeys);

/**
 * Bundles that are not current (see isLegacyBundle) may hold page text in
 * finding reasons, recovery, summaries, observations and detail, and URLs that name
 * page-chosen paths or origins. They are verified in their stored form (the
 * digest covers what was written; the stored bytes are never rewritten), then
 * served as a projection marked `legacy: true`: free text becomes the
 * length+sha256 token, record URLs become an origin the bundle's own
 * allow-list vouches for (or a digest) plus a path digest, and console sources
 * the bundle cannot vouch for are dropped. Current bundles are served as written.
 */
export function legacyProjection(bundle: VerificationBundle, rubricKeys: ReadonlySet<string> | null = null): VerificationBundle {
  if (!isLegacyBundle(bundle, rubricKeys)) return bundle;
  const text = (value: ReviewEvidenceMessage | string) => tokenMessage(value, rubricKeys);
  const projected: VerificationBundle = {
    ...bundle, legacy: true,
    results: bundle.results.map(result => ({ ...result, reason: text(result.reason), ...(result.recovery !== undefined ? { recovery: text(result.recovery) } : {}) })),
    evidence: bundle.evidence.map(item => ({ ...item, summary: text(item.summary), observations: item.observations.map(text), ...(item.detail ? { detail: item.detail.map(text) } : {}) })),
    conformanceNote: bundle.conformanceNote === WORKBENCH_REVIEW_CONFORMANCE_NOTE ? bundle.conformanceNote : tokenText(bundle.conformanceNote),
    environment: { ...bundle.environment, browserVersion: bundle.environment.browserVersion !== null && /^[A-Za-z]{1,40}\/[0-9][0-9.]{0,40}$/u.test(bundle.environment.browserVersion) ? bundle.environment.browserVersion : null },
  };
  if (bundle.egress) projected.egress = projectEgress(bundle.egress);
  if (bundle.console) projected.console = projectConsole(bundle.console, bundle);
  return projected;
}

function projectEgress(egress: StoredEgress): StoredEgress {
  const origins = new Set(egress.allowHosts.filter(host => host !== WORKBENCH_REVIEW_PREVIEW_HOST).map(host => { try { return new URL(`https://${host}`).origin; } catch { return ''; } }));
  const context: EvidenceContext = { served: () => false, allowedOrigin: origin => origins.has(origin) };
  const reason = (value: string | null) => (value === null ? null : tokenText(value));
  const urlText = (value: string) => renderReviewEvidenceParam(evidenceUrl(PageText.of(value), context));
  if ('schema' in egress) {
    if (egress.schema === WORKBENCH_REVIEW_EGRESS_SCHEMA) return egress;
    return { ...egress, exhausted: egress.exhausted === null ? null : tokenText(egress.exhausted as string), fetches: egress.fetches.map(fetch => ({ ...fetch, reason: reason(fetch.reason as string | null) })) } as StoredEgress;
  }
  return {
    ...egress,
    exhausted: egress.exhausted === null ? null : tokenText(egress.exhausted),
    fetches: egress.fetches.map(fetch => ({
      ...fetch, url: urlText(fetch.url), reason: reason(fetch.reason),
      redirects: fetch.redirects.map(redirect => ({ ...redirect, url: urlText(redirect.url) })),
    })),
  };
}

function projectConsole(evidence: StoredConsole, bundle: VerificationBundle): StoredConsole {
  const previewOrigin = `http://${WORKBENCH_REVIEW_PREVIEW_HOST}`;
  if (evidence.schema === 'workbench-review-console/1') {
    // v1 kept every preview path and external origin unverified.
    return { ...evidence, entries: evidence.entries.map(entry => ({ ...entry, source: entry.source && /^[a-z][a-z0-9+.-]*:$/u.test(entry.source.origin) ? entry.source : null })) };
  }
  if (evidence.schema === 'workbench-review-console/2') {
    // v2 verified preview paths against the serve log but kept external origins unverified.
    return { ...evidence, entries: evidence.entries.map(entry => ({ ...entry, source: entry.source && (entry.source.origin === previewOrigin || /^[a-z][a-z0-9+.-]*:$/u.test(entry.source.origin)) ? entry.source : null })) };
  }
  // v3: keep a source only when this bundle vouches for what it names.
  const served = new Set(bundle.sourceHashes.map(item => item.path));
  const origins = new Set((bundle.egress?.allowHosts ?? []).map(host => `https://${host}`));
  const vouched = (source: NonNullable<typeof evidence.entries[number]['source']>) => {
    if (source.path !== null) { try { if (!served.has(decodeURIComponent(source.path).replace(/^\/+/u, ''))) return false; } catch { return false; } }
    return source.origin === null || !source.origin.includes('//') || source.origin === previewOrigin || origins.has(source.origin);
  };
  return { ...evidence, entries: evidence.entries.map(entry => ({ ...entry, source: entry.source && vouched(entry.source) ? entry.source : null })) };
}

const MAX_LISTED = 200;

/**
 * Verification bundles live under the daemon data root that the caller
 * passes in (RUNTIME_DATA_DIR in the daemon). Project directories are hashed
 * so a project id never becomes a path segment.
 */
export interface ReviewEvidenceStoreOptions {
  /**
   * The rubric keys a bundle's rubric-key parameters may name: those of the
   * rubric and context the bundle was planned from, or null when they cannot
   * be recovered (the project moved to another revision). Without it no
   * rubric key verifies and such a bundle is served through the projection.
   */
  rubricKeys?(projectId: string, bundle: VerificationBundle): Promise<ReadonlySet<string> | null> | ReadonlySet<string> | null;
}

export function createReviewEvidenceStore(dataDir: string, options: ReviewEvidenceStoreOptions = {}) {
  if (!path.isAbsolute(dataDir)) throw new Error('Review evidence needs an absolute daemon data root');
  const root = path.join(dataDir, 'workbench-review', 'projects');
  const projectDir = (projectId: string) => path.join(root, createHash('sha256').update(projectId, 'utf8').digest('hex').slice(0, 32));

  async function save(bundle: VerificationBundle): Promise<void> {
    const valid = parseVerificationBundle(bundle);
    if (valid.legacy) throw new LegacyEvidenceError('stored again as current evidence');
    assertEgressDigest(valid.egress);
    assertEgressDigest(valid.motionEgress);
    const dir = projectDir(valid.projectId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${valid.id}.json`);
    const temp = path.join(dir, `.${valid.id}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(valid)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  }

  async function read(projectId: string, bundleId: string): Promise<VerificationBundle | null> {
    if (!WORKBENCH_REVIEW_BUNDLE_ID_PATTERN.test(bundleId)) return null;
    let text: string;
    try { text = await readFile(path.join(projectDir(projectId), `${bundleId}.json`), 'utf8'); } catch { return null; }
    const bundle = parseVerificationBundle(JSON.parse(text));
    // The egress records are frozen evidence: an edit after the digest was taken is refused, never served.
    assertEgressDigest(bundle.egress);
    assertEgressDigest(bundle.motionEgress);
    if (bundle.projectId !== projectId) return null;
    return legacyProjection(bundle, (await options.rubricKeys?.(projectId, bundle)) ?? null);
  }

  async function list(projectId: string): Promise<VerificationBundleSummary[]> {
    let names: string[];
    try { names = await readdir(projectDir(projectId)); } catch { return []; }
    const summaries: VerificationBundleSummary[] = [];
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!WORKBENCH_REVIEW_BUNDLE_ID_PATTERN.test(id)) continue;
      try {
        const bundle = await read(projectId, id);
        if (bundle) summaries.push({ id: bundle.id, entry: bundle.entry, outcome: bundle.outcome, startedAt: bundle.startedAt, endedAt: bundle.endedAt, ...(bundle.legacy ? { legacy: true as const } : {}) });
      } catch { /* a damaged record is skipped, never repaired silently */ }
    }
    return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_LISTED);
  }

  return { save, read, list };
}
export type ReviewEvidenceStore = ReturnType<typeof createReviewEvidenceStore>;
