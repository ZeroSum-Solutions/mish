import path from 'node:path';
import type { ProjectDesignContext, ProjectRubric, ReviewEgressPolicy, RunMechanicalReviewRequest, VerificationBundle, VerificationBundleSummary } from '@open-design/contracts';
import { createCdpReviewPort } from './cdp-worker.js';
import { validatedAllowHosts } from './egress.js';
import { createReviewEvidenceStore } from './evidence-store.js';
import { frozenRubricKeys } from './plan.js';
import { runMechanicalReview, type RunMechanicalReviewInput } from './runner.js';
import type { ReviewBrowserPort } from './types.js';

/** In-process options the R03 collect-review operation passes; the HTTP endpoint never sets them. */
export type MechanicalRunHooks = Pick<RunMechanicalReviewInput, 'screenshots' | 'onCapture' | 'signal'>;

export interface ReviewProjectInputs { root: string; context: ProjectDesignContext | null; rubric: ProjectRubric | null }

export interface WorkbenchReviewServiceDeps {
  /** Absolute daemon data root (RUNTIME_DATA_DIR). */
  dataDir: string;
  /** Resolves the project's file root and its current context/rubric records. */
  projectInputs(projectId: string): ReviewProjectInputs | Promise<ReviewProjectInputs>;
  /** `egress` is the run's allow-list (undefined: default-deny); the port must enforce exactly it. */
  createPort?(projectRoot: string, egress: ReviewEgressPolicy | undefined): ReviewBrowserPort;
  clock?: () => Date;
}

export class ReviewBusyError extends Error {}

/** Runs one mechanical review at a time (each one drives a whole browser) and persists its bundle. */
export function createWorkbenchReviewService(deps: WorkbenchReviewServiceDeps) {
  // A stored bundle's rubric keys verify only against the inputs it was planned from: the current ones, when the revisions still match.
  const store = createReviewEvidenceStore(deps.dataDir, {
    async rubricKeys(projectId, bundle) {
      const inputs = await deps.projectInputs(projectId);
      const same = (inputs.rubric?.revision ?? 0) === bundle.rubricRevision && (inputs.context?.revision ?? 0) === bundle.contextRevision;
      return same ? frozenRubricKeys(inputs.rubric, inputs.context) : null;
    },
  });
  let running = false;
  return {
    async run(projectId: string, request: RunMechanicalReviewRequest, hooks: MechanicalRunHooks = {}): Promise<VerificationBundle> {
      if (running) throw new ReviewBusyError('Another review is running; try again when it finishes');
      running = true;
      try {
        // The allow-list is re-validated here too: in-process callers never skip the contract's host rules.
        if (request.egress) validatedAllowHosts(request.egress.allowHosts);
        const inputs = await deps.projectInputs(projectId);
        const port = deps.createPort ? deps.createPort(inputs.root, request.egress) : createCdpReviewPort(inputs.root, { profileRoot: path.join(deps.dataDir, 'workbench-review', 'browser-profiles'), ...(request.egress ? { egress: request.egress } : {}) });
        const bundle = await runMechanicalReview({ projectId, entry: request.entry, rubric: inputs.rubric, context: inputs.context, port, ...hooks, ...(request.egress ? { egress: request.egress } : {}), ...(deps.clock ? { clock: deps.clock } : {}) });
        await store.save(bundle);
        return bundle;
      } finally { running = false; }
    },
    read(projectId: string, bundleId: string): Promise<VerificationBundle | null> { return store.read(projectId, bundleId); },
    list(projectId: string): Promise<VerificationBundleSummary[]> { return store.list(projectId); },
  };
}
export type WorkbenchReviewService = ReturnType<typeof createWorkbenchReviewService>;
