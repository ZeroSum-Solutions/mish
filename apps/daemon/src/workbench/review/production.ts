import path from 'node:path';
import type { JevKeyResolver } from '@open-design/agency-fast-lane/jev';
import { createClaudeVisualReviewer } from './reviewers/claude-visual.js';
import { createDeepSeekReviewer } from './reviewers/deepseek.js';
import { createGeminiReviewer } from './reviewers/gemini.js';
import { createJevReviewer } from './reviewers/jev.js';
import type { ReviewerAdapter } from './reviewers/types.js';
import { createReviewRunService, type ReviewRunService, type ReviewRunServiceDeps } from './run-service.js';
import { createEntryVersionResolver } from './snapshot.js';
import type { WorkbenchReviewService } from './service.js';

/** The daemon's key store, narrowed to what review needs: configured checks and the DeepSeek key. Never logs a key. */
export interface ReviewRunKeySource {
  status(): Promise<{ configured: boolean }>;
  modelStatus(provider: 'deepseek' | 'openrouter'): Promise<{ configured: boolean }>;
  resolveModelKey(provider: 'deepseek' | 'openrouter'): Promise<string>;
}

export interface ProductionReviewRunsDeps {
  /** RUNTIME_DATA_DIR. */
  dataDir: string;
  /** PROJECTS_DIR. */
  projectsRoot: string;
  /** U1's mechanical service; the same instance the mechanical route uses, so both share its one browser slot. */
  mechanical: WorkbenchReviewService;
  projectInputs: ReviewRunServiceDeps['projectInputs'];
  /** The project's file root and stored metadata, or null for an unknown project. */
  project(projectId: string): { root: string; metadata: unknown } | null;
  /** The daemon's lazy TypeSafe key resolver (`jevKeyResolver(...)`). */
  jevApiKey: JevKeyResolver;
  keys: ReviewRunKeySource;
  env?: NodeJS.ProcessEnv;
  limits?: ReviewRunServiceDeps['limits'];
  /** Test seam: replace one provider adapter (for example a fake browser-free live receipt). */
  reviewers?: Partial<ReviewRunServiceDeps['reviewers']>;
}

/**
 * The production composition of R03 review runs: required TypeSafe Jev, Claude
 * visual critic on the Max `claude` CLI, and metered DeepSeek Flash, plus the
 * optional Gemini second-family reviewer, with real key checks, the critic's
 * folder set to the run's own screenshot folder under the data root, and the
 * saved-revision resolver over the managed project root. server.ts mounts it
 * with one line: `runs: createProductionReviewRuns({...})`.
 */
export function createProductionReviewRuns(deps: ProductionReviewRunsDeps): ReviewRunService {
  let service: ReviewRunService | null = null;
  const reviewers: Partial<Record<ReviewerAdapter['role'], ReviewerAdapter>> = {
    'jev-text': createJevReviewer({ apiKey: deps.jevApiKey, keyConfigured: async () => (await deps.keys.status()).configured }),
    'deepseek-adversarial': createDeepSeekReviewer({ apiKey: () => deps.keys.resolveModelKey('deepseek'), keyConfigured: async () => (await deps.keys.modelStatus('deepseek')).configured }),
    // Second family: agy subscription; OpenRouter only when explicitly selected up front.
    'gemini-second-family': createGeminiReviewer({
      ...(deps.env ? { env: deps.env } : {}),
      // The key store resolves env, then the key saved in Settings, then the vault.
      openRouterKey: () => deps.keys.resolveModelKey('openrouter').catch(() => ''),
      // Fresh config/cwd per call; agy reuses subscription sign-in without copying auth files.
      isolatedConfigRoot: path.join(deps.dataDir, 'workbench-review', 'agy-config'),
    }),
    'claude-visual': createClaudeVisualReviewer({
      ...(deps.env ? { env: deps.env } : {}),
      workDir: input => {
        if (!service) throw new Error('review runs are not ready');
        return service.screenshotDir(input.projectId, input.runId);
      },
    }),
    ...deps.reviewers,
  };
  service = createReviewRunService({
    dataDir: deps.dataDir,
    projectInputs: deps.projectInputs,
    mechanical: deps.mechanical,
    entryVersion: createEntryVersionResolver({ projectsRoot: deps.projectsRoot, project: deps.project }),
    reviewers,
    ...(deps.limits ? { limits: deps.limits } : {}),
  });
  return service;
}
