import { randomUUID } from 'node:crypto';

import {
  createUserDesignSystemRevision,
  createUserDesignSystem,
  listUserDesignSystemFiles,
  readDesignSystem,
  type DesignSystemRevision,
  type DesignSystemRevisionFileChange,
  type DesignSystemSummary,
  type UserDesignSystemInput,
  type UserDesignSystemRevisionInput,
} from './index.js';
import type { DesignSystemTokenContractRebuildDecision } from '@mish/contracts';
import {
  collectDesignSystemSourceContext,
  mergeSourceContextIntoInput,
  type DesignSystemSourceContext,
} from './source-context.js';

export type DesignSystemGenerationJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

export type DesignSystemGenerationStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed';

export type DesignSystemGenerationStep = {
  id: string;
  title: string;
  status: DesignSystemGenerationStepStatus;
  message?: string;
  startedAt?: string;
  completedAt?: string;
};

export type DesignSystemGenerationJob = {
  id: string;
  kind?: 'generation' | 'revision' | 'token-contract-rebuild';
  status: DesignSystemGenerationJobStatus;
  progress: number;
  steps: DesignSystemGenerationStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  designSystemId?: string;
  revisionId?: string;
  error?: string;
  message?: string;
  /** The full record was evicted; status still describes the terminal outcome. */
  expired?: boolean;
};

type MutableJob = DesignSystemGenerationJob;

type StoreOptions = {
  root: string;
  createDesignSystem?: (
    root: string,
    input: UserDesignSystemInput,
  ) => Promise<DesignSystemSummary>;
  readDesignSystem?: (root: string, id: string, options?: { idPrefix?: string }) => Promise<string | null>;
  createRevision?: (
    root: string,
    id: string,
    input: UserDesignSystemRevisionInput,
  ) => Promise<DesignSystemRevision | null>;
  collectSourceContext?: (input: UserDesignSystemInput) => Promise<DesignSystemSourceContext>;
  listFiles?: (root: string, id: string) => Promise<Array<{ path: string }> | null>;
  delayMs?: number;
  /** Finished job payloads remain pollable for 30 minutes by default. */
  retentionMs?: number;
  /** Compact expiry receipts are bounded; older ids become not-found. */
  expiredJobLimit?: number;
  idFactory?: () => string;
};

const STEP_DEFS = [
  { id: 'explore-resources', title: 'Explore provided resources' },
  { id: 'create-draft', title: 'Create design system draft' },
  { id: 'generate-files', title: 'Generate preview cards and files' },
  { id: 'register-files', title: 'Register files for review' },
  { id: 'prepare-review', title: 'Prepare review workspace' },
] as const;

const REVISION_STEP_DEFS = [
  { id: 'read-draft', title: 'Read current draft' },
  { id: 'apply-feedback', title: 'Apply requested changes' },
  { id: 'create-revision', title: 'Create pending revision' },
  { id: 'prepare-review', title: 'Prepare updated review' },
] as const;

const TOKEN_CONTRACT_REBUILD_STEP_DEFS = [
  { id: 'read-token-report', title: 'Read token quality report' },
  { id: 'assess-evidence', title: 'Assess schema evidence' },
  { id: 'draft-contract-review', title: 'Draft contract rebuild review' },
  { id: 'create-revision', title: 'Create pending revision' },
  { id: 'prepare-review', title: 'Prepare token review' },
] as const;

export type DesignSystemRevisionInput = {
  /** Exact authorized storage root; defaults to the store root for Personal jobs. */
  root?: string;
  designSystemId: string;
  feedback: string;
  sectionTitle?: string;
  body?: string;
};

export type DesignSystemTokenContractRebuildInput = {
  /** Exact authorized storage root; defaults to the store root for Personal jobs. */
  root?: string;
  designSystemId: string;
  decision: DesignSystemTokenContractRebuildDecision;
  feedback: string;
  sectionTitle: string;
  baseBody: string;
  proposedBody: string;
  fileChanges?: DesignSystemRevisionFileChange[];
};

export function createDesignSystemGenerationJobStore(options: StoreOptions) {
  const jobs = new Map<string, MutableJob>();
  const expiredJobs = new Map<string, Pick<MutableJob, 'id' | 'kind' | 'status' | 'progress' | 'createdAt' | 'completedAt' | 'designSystemId' | 'revisionId' | 'error'>>();
  const retentionMs = options.retentionMs ?? 30 * 60_000;
  const expiredJobLimit = options.expiredJobLimit ?? 1000;
  if (!Number.isFinite(retentionMs) || retentionMs < 0 || retentionMs > 2_147_483_647) throw new Error('Invalid generation job retention window');
  if (!Number.isSafeInteger(expiredJobLimit) || expiredJobLimit < 1) throw new Error('Invalid generation job expiry receipt limit');

  function scheduleExpiry(job: MutableJob): void {
    if (job.status !== 'succeeded' && job.status !== 'failed') return;
    setTimeout(() => {
      if (jobs.get(job.id) !== job) return;
      jobs.delete(job.id);
      expiredJobs.set(job.id, { id: job.id, status: job.status, progress: job.progress, createdAt: job.createdAt, ...(job.error ? { error: job.error } : {}), ...(job.revisionId ? { revisionId: job.revisionId } : {}), ...(job.kind ? { kind: job.kind } : {}), ...(job.completedAt ? { completedAt: job.completedAt } : {}), ...(job.designSystemId ? { designSystemId: job.designSystemId } : {}) });
      if (expiredJobs.size > expiredJobLimit) expiredJobs.delete(expiredJobs.keys().next().value!);
    }, retentionMs).unref?.();
  }
  const createDesignSystem = options.createDesignSystem ?? createUserDesignSystem;
  const readExistingDesignSystem = options.readDesignSystem ?? readDesignSystem;
  const createRevision = options.createRevision ?? createUserDesignSystemRevision;
  const collectSourceContext = options.collectSourceContext ?? collectDesignSystemSourceContext;
  const listFiles = options.listFiles ?? listUserDesignSystemFiles;
  const delayMs = options.delayMs ?? 280;
  const idFactory = options.idFactory ?? randomUUID;

  function start(
    input: UserDesignSystemInput,
    createDesignSystemForJob: StoreOptions['createDesignSystem'] = createDesignSystem,
  ): DesignSystemGenerationJob {
    const now = new Date().toISOString();
    const job: MutableJob = {
      id: idFactory(),
      kind: 'generation',
      status: 'queued',
      progress: 0,
      steps: STEP_DEFS.map((step) => ({ ...step, status: 'pending' })),
      createdAt: now,
      updatedAt: now,
      message: 'Queued',
    };
    expiredJobs.delete(job.id);
    jobs.set(job.id, job);
    void run(job, input, createDesignSystemForJob);
    return snapshot(job);
  }

  function revise(input: DesignSystemRevisionInput): DesignSystemGenerationJob {
    const now = new Date().toISOString();
    const job: MutableJob = {
      id: idFactory(),
      kind: 'revision',
      status: 'queued',
      progress: 0,
      steps: REVISION_STEP_DEFS.map((step) => ({ ...step, status: 'pending' })),
      createdAt: now,
      updatedAt: now,
      designSystemId: input.designSystemId,
      message: 'Queued revision',
    };
    expiredJobs.delete(job.id);
    jobs.set(job.id, job);
    void runRevision(job, input);
    return snapshot(job);
  }

  function rebuildTokenContract(input: DesignSystemTokenContractRebuildInput): DesignSystemGenerationJob {
    const now = new Date().toISOString();
    const job: MutableJob = {
      id: idFactory(),
      kind: 'token-contract-rebuild',
      status: 'queued',
      progress: 0,
      steps: TOKEN_CONTRACT_REBUILD_STEP_DEFS.map((step) => ({ ...step, status: 'pending' })),
      createdAt: now,
      updatedAt: now,
      designSystemId: input.designSystemId,
      message: 'Queued token contract rebuild',
    };
    expiredJobs.delete(job.id);
    jobs.set(job.id, job);
    void runTokenContractRebuild(job, input);
    return snapshot(job);
  }

  function get(id: string): DesignSystemGenerationJob | null {
    const job = jobs.get(id);
    if (job) return snapshot(job);
    const expired = expiredJobs.get(id);
    // Polling still sees the terminal outcome; expiry only removes the full record.
    return expired ? { ...expired, expired: true, steps: [], updatedAt: expired.completedAt ?? expired.createdAt, message: 'This job expired after its retention window. Its design system and revisions are kept.' } : null;
  }

  function lookup(id: string): { status: 'found'; job: DesignSystemGenerationJob } | { status: 'expired' | 'not-found' } {
    if (expiredJobs.has(id)) return { status: 'expired' };
    const job = jobs.get(id);
    return job ? { status: 'found', job: snapshot(job) } : { status: 'not-found' };
  }

  async function run(
    job: MutableJob,
    input: UserDesignSystemInput,
    createDesignSystemForJob: NonNullable<StoreOptions['createDesignSystem']>,
  ): Promise<void> {
    try {
      markJob(job, 'running', 'Starting generation');
      let created: DesignSystemSummary | null = null;
      let enrichedInput = input;
      await runStep(job, 'explore-resources', async () => {
        await sleep(delayMs);
        const sourceContext = await safeCollectSourceContext(collectSourceContext, input);
        enrichedInput = mergeSourceContextIntoInput(input, sourceContext);
        setStepMessage(job, 'explore-resources', sourceSummary(input, sourceContext));
      });
      await runStep(job, 'create-draft', async () => {
        created = await createDesignSystemForJob(options.root, enrichedInput);
        job.designSystemId = created.id;
        setStepMessage(job, 'create-draft', `Created ${created.title}`);
      });
      await runStep(job, 'generate-files', async () => {
        await sleep(delayMs);
        setStepMessage(job, 'generate-files', 'Generated DESIGN.md, README.md, SKILL.md, tokens, previews, and context files');
      });
      await runStep(job, 'register-files', async () => {
        const designSystemId = created?.id;
        const files = designSystemId ? await listFiles(options.root, designSystemId) : [];
        setStepMessage(job, 'register-files', `Registered ${files?.length ?? 0} files`);
      });
      await runStep(job, 'prepare-review', async () => {
        await sleep(delayMs);
        setStepMessage(job, 'prepare-review', 'Review workspace is ready');
      });
      completeJob(job, 'succeeded', 'Design system ready for review');
    } catch (err) {
      failJob(job, err instanceof Error ? err.message : String(err));
    } finally {
      scheduleExpiry(job);
    }
  }

  async function runRevision(job: MutableJob, input: DesignSystemRevisionInput): Promise<void> {
    try {
      const jobRoot = input.root ?? options.root;
      markJob(job, 'running', 'Starting revision');
      const feedback = cleanFeedback(input.feedback);
      if (!feedback) throw new Error('Revision feedback is required');
      let body = input.body;
      let proposedBody = '';
      await runStep(job, 'read-draft', async () => {
        if (!body) {
          body = await readExistingDesignSystem(jobRoot, input.designSystemId, {
            idPrefix: 'user:',
          }) ?? undefined;
        }
        if (!body) throw new Error('Editable design system not found');
        setStepMessage(job, 'read-draft', `Loaded ${input.designSystemId}`);
      });
      await runStep(job, 'apply-feedback', async () => {
        await sleep(delayMs);
        proposedBody = applyRevisionToBody(body ?? '', {
          feedback,
          ...(input.sectionTitle ? { sectionTitle: input.sectionTitle } : {}),
        });
        setStepMessage(job, 'apply-feedback', input.sectionTitle ? `Updated ${input.sectionTitle}` : 'Updated DESIGN.md');
      });
      await runStep(job, 'create-revision', async () => {
        if (!body) throw new Error('Editable design system not found');
        const revision = await createRevision(jobRoot, input.designSystemId, {
          feedback,
          baseBody: body,
          proposedBody,
          ...(input.sectionTitle ? { sectionTitle: input.sectionTitle } : {}),
          jobId: job.id,
        });
        if (!revision) throw new Error('Could not create revision');
        job.revisionId = revision.id;
        setStepMessage(job, 'create-revision', `Created pending revision ${revision.id}`);
      });
      await runStep(job, 'prepare-review', async () => {
        await sleep(delayMs);
        setStepMessage(job, 'prepare-review', 'Updated review is ready');
      });
      completeJob(job, 'succeeded', 'Revision ready for review');
    } catch (err) {
      failJob(job, err instanceof Error ? err.message : String(err));
    } finally {
      scheduleExpiry(job);
    }
  }

  async function runTokenContractRebuild(
    job: MutableJob,
    input: DesignSystemTokenContractRebuildInput,
  ): Promise<void> {
    try {
      const jobRoot = input.root ?? options.root;
      markJob(job, 'running', 'Starting token contract rebuild');
      await runStep(job, 'read-token-report', async () => {
        await sleep(delayMs);
        setStepMessage(
          job,
          'read-token-report',
          `${input.decision.reportPath ?? 'source/token-contract.report.json'} (${input.decision.grade ?? 'unknown'} grade)`,
        );
      });
      await runStep(job, 'assess-evidence', async () => {
        await sleep(delayMs);
        const triggers = input.decision.triggers.length > 0
          ? input.decision.triggers.slice(0, 3).join('; ')
          : input.decision.forced
            ? 'Forced rebuild'
            : 'No quality trigger';
        setStepMessage(job, 'assess-evidence', triggers);
      });
      await runStep(job, 'draft-contract-review', async () => {
        await sleep(delayMs);
        const weakCount = input.decision.weakTokens?.length ?? 0;
        setStepMessage(job, 'draft-contract-review', `Prepared TOKEN_SCHEMA rebuild request (${weakCount} weak token(s))`);
      });
      await runStep(job, 'create-revision', async () => {
        const revision = await createRevision(jobRoot, input.designSystemId, {
          feedback: input.feedback,
          baseBody: input.baseBody,
          proposedBody: input.proposedBody,
          sectionTitle: input.sectionTitle,
          jobId: job.id,
          ...(input.fileChanges?.length ? { fileChanges: input.fileChanges } : {}),
        });
        if (!revision) throw new Error('Could not create token contract revision');
        job.revisionId = revision.id;
        setStepMessage(job, 'create-revision', `Created pending token revision ${revision.id}`);
      });
      await runStep(job, 'prepare-review', async () => {
        await sleep(delayMs);
        setStepMessage(job, 'prepare-review', 'Token contract rebuild is ready for review');
      });
      completeJob(job, 'succeeded', 'Token contract rebuild ready for review');
    } catch (err) {
      failJob(job, err instanceof Error ? err.message : String(err));
    } finally {
      scheduleExpiry(job);
    }
  }

  return { start, revise, rebuildTokenContract, get, lookup };
}

async function runStep(
  job: MutableJob,
  stepId: string,
  task: () => Promise<void>,
): Promise<void> {
  const step = job.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Unknown generation step: ${stepId}`);
  step.status = 'running';
  step.startedAt = new Date().toISOString();
  touch(job);
  try {
    await task();
    step.status = 'succeeded';
    step.completedAt = new Date().toISOString();
    job.progress = Math.round(
      (job.steps.filter((candidate) => candidate.status === 'succeeded').length / job.steps.length) * 100,
    );
    touch(job);
  } catch (err) {
    step.status = 'failed';
    step.completedAt = new Date().toISOString();
    step.message = err instanceof Error ? err.message : String(err);
    touch(job);
    throw err;
  }
}

function markJob(
  job: MutableJob,
  status: DesignSystemGenerationJobStatus,
  message: string,
): void {
  job.status = status;
  job.message = message;
  touch(job);
}

function completeJob(
  job: MutableJob,
  status: Extract<DesignSystemGenerationJobStatus, 'succeeded'>,
  message: string,
): void {
  job.status = status;
  job.progress = 100;
  job.message = message;
  job.completedAt = new Date().toISOString();
  touch(job);
}

function failJob(job: MutableJob, message: string): void {
  job.status = 'failed';
  job.error = message;
  job.message = 'Generation failed';
  job.completedAt = new Date().toISOString();
  touch(job);
}

function setStepMessage(job: MutableJob, stepId: string, message: string): void {
  const step = job.steps.find((candidate) => candidate.id === stepId);
  if (step) step.message = message;
  touch(job);
}

function touch(job: MutableJob): void {
  job.updatedAt = new Date().toISOString();
}

function snapshot(job: MutableJob): DesignSystemGenerationJob {
  return {
    ...job,
    steps: job.steps.map((step) => ({ ...step })),
  };
}

async function safeCollectSourceContext(
  collectSourceContext: (input: UserDesignSystemInput) => Promise<DesignSystemSourceContext>,
  input: UserDesignSystemInput,
): Promise<DesignSystemSourceContext> {
  try {
    return await collectSourceContext(input);
  } catch (err) {
    return {
      github: [],
      notes: `Source context fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function sourceSummary(input: UserDesignSystemInput, context?: DesignSystemSourceContext): string {
  const provenance = input.provenance;
  const counts = [
    provenance?.sourceUrls?.length ? `${provenance.sourceUrls.length} source link(s)` : '',
    provenance?.githubUrls?.length ? `${provenance.githubUrls.length} GitHub repo link(s)` : '',
    provenance?.localCodeFiles?.length ? `${provenance.localCodeFiles.length} local code reference(s)` : '',
    provenance?.figFiles?.length ? `${provenance.figFiles.length} Figma file(s)` : '',
    provenance?.assetFiles?.length ? `${provenance.assetFiles.length} asset(s)` : '',
  ].filter(Boolean);
  const base = counts.length > 0 ? counts.join(', ') : 'Using company context and notes';
  if (!context?.github.length) return base;
  const readable = context.github.filter((repo) => !repo.error).length;
  if (readable === 0) return `${base}; GitHub context unavailable`;
  return `${base}; read ${readable} GitHub repo(s)`;
}

function cleanFeedback(value: string): string {
  return value.trim().replace(/\n{3,}/g, '\n\n');
}

function applyRevisionToBody(
  body: string,
  input: { feedback: string; sectionTitle?: string },
): string {
  const section = input.sectionTitle?.trim();
  const title = section ? `Revision Request: ${section}` : 'Revision Request';
  const stamp = new Date().toISOString();
  return `${body.trim()}\n\n## ${title}\n\n${input.feedback}\n\n_Revision job applied at ${stamp}._\n`;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
