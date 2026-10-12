import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectDesignContext, ProjectRubric, ReviewerRole } from '@mish/contracts';
import { verifyWorkspaceRequestContext } from '../../src/collab/request-workspace-context.js';
import type { WorkspaceDirectoryFetchResult } from '../../src/collab/vela-workspace-context.js';
import { registerWorkbenchReviewRoutes } from '../../src/routes/workbench-review.js';
import { runReviewCli } from '../../src/workbench/review-cli.js';
import { createReviewRunService, type ReviewRunServiceDeps } from '../../src/workbench/review/run-service.js';
import { createWorkbenchReviewService } from '../../src/workbench/review/service.js';
import type { ReviewerAdapter, ReviewerInput, ReviewerResult } from '../../src/workbench/review/reviewers/types.js';
import { ReviewerCallError } from '../../src/workbench/review/reviewers/types.js';
import type { ReviewBrowserPort, ViewportCapture } from '../../src/workbench/review/types.js';
import { knownGoodCapture } from './review-capture-fixture.js';

/** Smallest valid PNG (1×1). */
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function rubric(revision = 2): ProjectRubric {
  return {
    schema: 'workbench-rubric/1', projectId: 'p', revision, updatedAt: '2026-10-07T09:00:00.000Z', contextRevision: 1,
    checks: [{
      checkId: 'win95-style', kind: 'judgment', required: false, severity: 'medium', requiredBasis: null,
      provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner asked for a Windows 95 look' },
      evidenceTypes: ['judgment-rationale'], sourceCriteria: [], parameters: { type: 'criterion', criterion: 'The page reads as an intentional Windows 95 desktop UI' },
    }],
  };
}

export interface FakeReviewerOptions {
  unavailable?: boolean;
  error?: ReviewerCallError;
  /** Resolves when the call may answer; aborting the signal rejects it. */
  gate?: Promise<void>;
  verdict?: 'supports' | 'disputes' | 'uncertain';
  probability?: number | null;
  /** Evidence refs to cite; `screenshots` cites every screenshot id passed in. */
  refs?: string[] | 'screenshots';
  inputMode?: ReviewerResult['inputMode'];
  /** Resolves when the availability check may answer. */
  availabilityGate?: Promise<void>;
  /** Answer only this many of the assigned checks. */
  answerFirst?: number;
}

export interface FakeReviewer extends ReviewerAdapter { calls: ReviewerInput[] }
export const concurrency = { active: 0, max: 0 };

export function fakeReviewer(role: ReviewerRole, options: FakeReviewerOptions = {}): FakeReviewer {
  const calls: ReviewerInput[] = [];
  return {
    role, provider: role === 'jev-text' ? 'typesafe-jev' : role === 'claude-visual' ? 'claude-max' : role === 'gemini-second-family' ? 'gemini' : 'deepseek',
    modelId: `${role}-model`, adapterVersion: 'fake/1', billingLane: role === 'jev-text' ? 'typesafe-system-one' : role === 'claude-visual' ? 'max-subscription' : role === 'gemini-second-family' ? 'gemini-subscription' : 'deepseek-metered',
    calls,
    async availability() { if (options.availabilityGate) await options.availabilityGate; return options.unavailable ? { available: false, reason: `${role} has no key`, recovery: `Add the ${role} key in Settings` } : { available: true }; },
    async review(input, signal) {
      calls.push(input);
      concurrency.active++; concurrency.max = Math.max(concurrency.max, concurrency.active);
      try {
        if (options.gate) await Promise.race([options.gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
        else await new Promise(resolve => setTimeout(resolve, 5));
        if (options.error) throw options.error;
        const refs = options.refs === 'screenshots' ? input.screenshots.map(shot => shot.evidenceId) : options.refs ?? [];
        return {
          verdicts: input.checks.slice(0, options.answerFirst ?? input.checks.length).map(check => ({ checkId: check.checkId, verdict: options.verdict ?? 'supports', probability: options.probability ?? null, rationale: `${role} view of ${check.checkId}`, evidenceRefs: refs })),
          rawOutput: JSON.stringify({ role, checks: input.checks.length }), inputMode: options.inputMode ?? (role === 'claude-visual' ? 'vision' : 'text'),
        };
      } finally { concurrency.active--; }
    },
  };
}

export interface BootOptions {
  fetchWorkspaceDirectory?: () => Promise<WorkspaceDirectoryFetchResult>;
  reviewers?: Partial<Record<ReviewerRole, ReviewerAdapter>>;
  capture?: (width: number, root: string) => ViewportCapture | Promise<ViewportCapture>;
  port?: () => ReviewBrowserPort;
  dataDir?: string;
  limits?: ReviewRunServiceDeps['limits'];
  /** Sees the per-run egress allow-list the mechanical service hands each port. */
  onPortEgress?: (egress: { allowHosts: string[] } | undefined) => void;
  /** Called when the default port's browser session closes (a cancel closes it at once, before the capture returns). */
  onSessionClose?: () => void;
}

/** A daemon slice: real U1 mechanical service (fake browser port), real run service, real routes and the od CLI. */
export async function bootReviewRuns(options: BootOptions = {}) {
  const data = options.dataDir ?? await mkdtemp(path.join(tmpdir(), 'od-review-runs-'));
  const root = path.join(data, 'project-root');
  await mkdir(root, { recursive: true });
  if (!options.dataDir) await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Win95</title><h1>Start</h1>');
  /** `context` (B5-1) is seen by both services; `contextRevision` alone fakes a context only the run service sees. */
  const state = { rubric: rubric() as ProjectRubric | null, contextRevision: 0, context: null as ProjectDesignContext | null };
  const capture = options.capture ?? (async (width: number) => knownGoodCapture(width, item => {
    item.served = [{ path: 'index.html', sha256: 'pending' }];
    item.screenshotPng = PNG_BASE64;
  }));
  const mechanical = createWorkbenchReviewService({
    dataDir: data,
    projectInputs: () => ({ root, context: state.context, rubric: state.rubric }),
    createPort: (_root, egress) => { options.onPortEgress?.(egress); return options.port ? options.port() : {
      origin: 'http://project.od-review.localhost',
      async capability() { return { available: true, browserVersion: 'HeadlessChrome/140.0.0.0' }; },
      async open() {
        return {
          async capture(request) {
            const item = await capture(request.width, root);
            // Like the real worker, report the bytes actually served from the project root.
            item.served = item.served.map(served => ({ path: served.path, sha256: sha256(readFileSyncSafe(path.join(root, served.path))) }));
            if (!request.screenshot) delete item.screenshotPng;
            return item;
          },
          async close() { options.onSessionClose?.(); },
        };
      },
    }; },
  });
  const deps: ReviewRunServiceDeps = {
    dataDir: data,
    projectInputs: () => ({ root, context: state.context ?? (state.contextRevision ? { revision: state.contextRevision } as never : null), rubric: state.rubric }),
    mechanical,
    entryVersion: async (_projectId, entry, versionId) => {
      const digest = sha256(await readFile(path.join(root, entry)));
      if (versionId === null || versionId === 'v2') return { versionId: 'v2', contentDigest: digest, current: true };
      if (versionId === 'v1') return { versionId: 'v1', contentDigest: digest, current: false };
      return null;
    },
    reviewers: options.reviewers ?? {},
    ...(options.limits ? { limits: options.limits } : {}),
  };
  const runs = createReviewRunService(deps);
  const app = express(); app.use(express.json());
  registerWorkbenchReviewRoutes(app, {
    verifyWorkspaceRequestAuthority: (req: unknown) => verifyWorkspaceRequestContext({
      req,
      fetchWorkspaceDirectory: options.fetchWorkspaceDirectory ?? (async () => ({ ok: true, items: [{
        workspaceId: 'w', workspaceName: 'Workspace', workspaceType: 'team', workspaceMemberId: 'member',
        role: 'member', memberStatus: 'active', lifecycleState: 'active',
      }] })),
    }),
    http: { sendApiError: (res, status, code, message, init = {}) => res.status(status).json({ error: { code, message, ...init } }) },
    authorizeProjectRequest: async (_req, res, id) => { if (id === 'foreign') { res.status(403).json({ error: 'private' }); return false; } return true; },
    assertProject: () => undefined,
    review: mechanical, runs,
  });
  const server: Server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const output: unknown[] = [];
  const cli = (args: string[], stdin = '') => runReviewCli(args, { env: { OD_DAEMON_URL: url }, write: value => output.push(value), readStdin: async () => stdin });
  const start = (body: Record<string, unknown>, key = `k-${Math.random()}`) => fetch(`${url}/api/workbench/reviews`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ projectId: 'p', snapshot: { entry: 'index.html' }, rubricRevision: state.rubric?.revision ?? 0, ...body }) });
  const show = async (id: string) => (await fetch(`${url}/api/workbench/reviews/${id}?projectId=p`)).json() as Promise<{ run: import('@mish/contracts').ReviewRun; freshness: { state: string; reasons: string[] } }>;
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  const mechanicalRun = (entry = 'index.html') => fetch(`${url}/api/workbench/projects/p/review/mechanical`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-od-project-id': 'p' }, body: JSON.stringify({ entry }) });
  return { url, data, root, state, runs, cli, output, start, show, close, mechanicalRun };
}

function readFileSyncSafe(file: string): Buffer { try { return readFileSync(file); } catch { return Buffer.from(''); } }
