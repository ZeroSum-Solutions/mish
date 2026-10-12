import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  DESIGN_BRIEF_RENDERER_VERSION, DESIGN_BRIEF_SCHEMA, DESIGN_BRIEF_TEXT_PATHS,
  designBriefPreviewSchema, canonicalDesignBriefJson, designBriefModelOutputSchema, parseDesignBrief, parseDesignBriefRecordView, renderDesignBriefPrompt,
  type AttachDesignBriefRequest, type PreviewDesignBriefRequest, type DesignBriefPreview, type CreateDesignBriefRequest, type DesignBrief, type DesignBriefEditablePath, type DesignBriefField, type DesignBriefModelOutput,
  type DesignBriefRecordView, type DesignBriefTextPath, type PatchDesignBriefRequest, type ResourceRef, type RunDesignBriefBinding,
} from '@mish/contracts';
import type { BriefGenerator } from './generator.js';
import { detectStyleDirections, detectTargetRuntime, modernDrift } from './intent.js';
import { groundBriefOutput, type BriefGroundingChecker } from './grounding.js';
import { buildRepairPrompt, buildTransformPrompt, type TransformPromptInput } from './prompt.js';
import { buildReferenceChanges, NO_REVIEWED_REFERENCES, ReferenceSelectionError, referenceRecords, selectReferences, type DesignReferenceSource, type SelectedReference } from './references.js';
import { createBriefStore, type StoredBriefRecord } from './store.js';

export class BriefError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422 | 503, readonly code: string, message: string) { super(message); this.name = 'BriefError'; }
}

export interface DesignBriefServiceDeps {
  /** The resolved daemon data root (RUNTIME_DATA_DIR). */
  dataDir: string;
  generator: BriefGenerator | null;
  /** Typed claim-vs-original judgment; unavailable checks demote stated facts to unverified. */
  groundingChecker?: BriefGroundingChecker | null;
  /** Current saved project context, read under the caller's authority. */
  projectContext?(projectId: string): { contextRevision: number | null; rubricRevision: number | null; context: unknown | null };
  references?: DesignReferenceSource;
  /** Resolves a font family to an admitted font resource, or null (an explicit gap). */
  resolveFont?(family: string): Promise<ResourceRef | null>;
  now?(): Date;
}

type Draft = Omit<DesignBrief, 'renderedPrompt' | 'hash'>;

function fieldAt(brief: Pick<DesignBrief, 'audience' | 'purpose' | 'conversion' | 'design' | 'responsive' | 'accessibility'>, pathName: DesignBriefTextPath): DesignBriefField {
  if (pathName.startsWith('design.')) return brief.design[pathName.slice(7) as keyof DesignBrief['design']];
  return brief[pathName as 'audience'];
}
function withField<T extends Pick<DesignBrief, 'design'>>(brief: T, pathName: DesignBriefTextPath, value: DesignBriefField): T {
  if (pathName.startsWith('design.')) return { ...brief, design: { ...brief.design, [pathName.slice(7)]: value } };
  return { ...brief, [pathName]: value };
}

function finalize(draft: Draft): DesignBrief {
  const renderedPrompt = renderDesignBriefPrompt(draft);
  const withPrompt = { ...draft, renderedPrompt };
  const hash = createHash('sha256').update(canonicalDesignBriefJson(withPrompt as DesignBrief)).digest('hex');
  return parseDesignBrief({ ...withPrompt, hash });
}

/** Problems that send the model's answer through the single repair. */
function validateOutput(raw: string, originalText: string, styles: string[]): { output: DesignBriefModelOutput | null; problems: string[] } {
  let json: unknown;
  try { json = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gu, '')); } catch { return { output: null, problems: ['The answer was not valid JSON.'] }; }
  const parsed = designBriefModelOutputSchema.safeParse(json);
  if (!parsed.success) return { output: null, problems: parsed.error.issues.slice(0, 20).map(issue => `${issue.path.join('.') || 'answer'}: ${issue.message}`) };
  if (styles.length) {
    const output = parsed.data;
    const texts = Object.values(output.design).map(field => field.value ?? '').filter(Boolean);
    const drift = modernDrift(originalText, texts);
    if (drift.length) return { output: null, problems: [`The description asks for the style ${styles.join(', ')}, but the design fields drift to generic modern styling (${drift.join(', ')}). Keep the requested style.`] };
  }
  return { output: parsed.data, problems: [] };
}

/**
 * R15 transformer service: create (async, 202) → read/poll → patch (edits,
 * reference decisions, accept) → resolve the exact accepted revision for a run.
 * Failure and cancellation keep the original text so the composer falls back
 * to it unchanged.
 */
export function createDesignBriefService(deps: DesignBriefServiceDeps) {
  const store = createBriefStore(deps.dataDir);
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();
  const jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let previewInFlight = false;
  const references = deps.references ?? NO_REVIEWED_REFERENCES;
  const resolveFont = deps.resolveFont ?? (async () => null);

  async function view(record: StoredBriefRecord): Promise<DesignBriefRecordView> {
    const latest = record.status === 'ready' ? await store.readRevision(record.id, record.revisions.at(-1)!) : null;
    return parseDesignBriefRecordView({ ...record, brief: latest });
  }
  async function owned(projectId: string, id: string): Promise<StoredBriefRecord> {
    const record = await store.readRecord(id);
    if (!record) throw new BriefError(404, 'brief-not-found', 'No such brief');
    if (record.projectId !== projectId) throw new BriefError(403, 'brief-authority-mismatch', 'This brief belongs to another project');
    return record;
  }

  async function generateDraft(record: StoredBriefRecord, request: CreateDesignBriefRequest, selected: SelectedReference[], signal: AbortSignal, context: { contextRevision: number | null; rubricRevision: number | null; context: unknown | null }, transient = false, onTransformer?: (transformer: StoredBriefRecord['transformer']) => void): Promise<Draft | null> {
    const fail = async (code: string, message: string, recovery: string) => {
      if (signal.aborted) return null;
      throw new BriefError(503, code, `${message}. ${recovery}`);
    };
    const generator = deps.generator;
    const availability = generator ? await generator.available() : { available: false as const, reason: 'No transformer lane is configured', recovery: 'Use your original prompt.' };
    if (!generator || !availability.available) return fail('transformer-unavailable', availability.available ? 'Unavailable' : availability.reason, availability.available ? 'Use your original prompt.' : availability.recovery);
    const styles = detectStyleDirections(request.originalText);
    const runtime = detectTargetRuntime(request.originalText);
    const overrides = Object.fromEntries(Object.entries(request.overrides ?? {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
    const promptInput: TransformPromptInput = {
      originalText: request.originalText, projectContext: context.context, overrides, styleDirections: styles, targetRuntime: runtime,
      references: selected.filter(item => !item.excerptOmitted).map(item => ({ index: item.index, title: item.document.title, excerpt: item.document.excerpt, tokens: item.document.tokens })),
    };
    let output: DesignBriefModelOutput | null = null;
    let problems: string[] = [];
    let transformer: StoredBriefRecord['transformer'] = null;
    try {
      for (let attempt = 0; attempt < 2 && !output; attempt++) {
        const prompt = attempt === 0 ? buildTransformPrompt(promptInput) : buildRepairPrompt(promptInput, problems);
        const generation = await generator.generate(prompt, signal, transient);
        if (signal.aborted) return null;
        transformer = { requestedModel: generation.requestedModel ?? generator.modelId, reportedModel: generation.reportedModel };
        ({ output, problems } = validateOutput(generation.text, request.originalText, styles));
      }
    } catch {
      if (signal.aborted) return null;
      return fail('transformer-failed', 'The transformer could not produce a brief', 'Use your original prompt, or try Improve prompt again.');
    }
    // R15-1: the caller owns the stored record; hand it the requested and reported model.
    onTransformer?.(transformer);
    if (!output) return fail('brief-invalid-output', 'The transformer answer did not pass validation after one repair', 'Use your original prompt, or rephrase and try again.');

    output = await groundBriefOutput(output, request.originalText, deps.groundingChecker ?? null, signal);
    if (signal.aborted) return null;
    let draft: Draft = {
      schema: DESIGN_BRIEF_SCHEMA, id: record.id, revision: 1, projectId: record.projectId, state: 'draft',
      originalText: request.originalText,
      contextRevision: context.contextRevision && context.contextRevision > 0 ? context.contextRevision : null,
      rubricRevision: context.rubricRevision && context.rubricRevision > 0 ? context.rubricRevision : null,
      audience: output.audience, purpose: output.purpose, conversion: output.conversion,
      sections: output.sections, design: output.design,
      responsive: output.responsive, accessibility: output.accessibility,
      implementationConstraints: [...new Set([...(runtime ? [runtime] : []), ...output.implementationConstraints])].slice(0, 24),
      // Intent is the user's explicit words only; a model-suggested style is never rendered as a user request.
      intent: { styleDirections: styles.slice(0, 12), targetRuntime: runtime },
      resourceRefs: [], references: referenceRecords(selected), referenceChanges: [],
      assumptions: output.assumptions, questions: output.questions,
      userEditedPaths: [], rendererVersion: DESIGN_BRIEF_RENDERER_VERSION, createdAt: now(),
    };
    // User overrides take precedence over everything inferred.
    for (const [pathName, value] of Object.entries(overrides) as Array<[DesignBriefTextPath, string]>) {
      draft = withField(draft, pathName, { value, basis: 'user' });
      draft.userEditedPaths = [...new Set([...draft.userEditedPaths, pathName])];
    }
    draft.referenceChanges = await buildReferenceChanges(output.referenceChanges, selected, pathName => fieldAt(draft, pathName), request.originalText, { resolveFont });
    if (signal.aborted) return null;
    return draft;
  }

  async function transform(record: StoredBriefRecord, request: CreateDesignBriefRequest, selected: SelectedReference[], signal: AbortSignal): Promise<void> {
    try {
      const context = deps.projectContext?.(record.projectId) ?? { contextRevision: null, rubricRevision: null, context: null };
      let transformer: StoredBriefRecord['transformer'] = null;
      const draft = await generateDraft(record, request, selected, signal, context, false, value => { transformer = value; });
      if (!draft || signal.aborted) return;
      await store.writeRevision(finalize(draft));
      await store.writeRecord({ ...record, transformer, status: 'ready', revisions: [1], updatedAt: now() });
    } catch (error) {
      if (signal.aborted) return;
      await store.writeRecord({ ...record, status: 'failed', failure: {
        code: error instanceof BriefError ? error.code : 'transformer-failed',
        message: error instanceof BriefError ? error.message.slice(0, 500) : 'The transformer could not produce a brief',
        recovery: 'Use your original prompt, or try Improve prompt again.',
      }, updatedAt: now() });
    }
  }

  return {
    /** Synchronous and stateless: no record, revision, project or job is persisted. */
    async preview(request: PreviewDesignBriefRequest, signal: AbortSignal): Promise<DesignBriefPreview> {
      if (previewInFlight) throw new BriefError(503, 'transformer-busy', 'Another preview is being generated. Try again when it finishes.');
      previewInFlight = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) controller.abort();
      const timeout = setTimeout(abort, 120_000);
      try {
        const at = now();
        const record: StoredBriefRecord = { id: 'preview', projectId: 'preview', status: 'pending', originalText: request.originalText, failure: null, revisions: [], createdAt: at, updatedAt: at };
        const draft = await generateDraft(record, { ...request, projectId: 'preview' }, [], controller.signal, { contextRevision: null, rubricRevision: null, context: null }, true);
        if (!draft || controller.signal.aborted) throw new BriefError(503, 'transformer-cancelled', 'The preview was cancelled or timed out. Try Improve prompt again.');
        const { id: _id, revision: _revision, projectId: _projectId, state: _state, contextRevision: _context, rubricRevision: _rubric, createdAt: _at, ...preview } = draft;
        return designBriefPreviewSchema.parse(preview);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        previewInFlight = false;
      }
    },

    /** Called only after Home creates the project for an accepted Run. No model is called. */
    async attach(request: AttachDesignBriefRequest, context: { projectId: string }): Promise<DesignBriefRecordView> {
      if (request.projectId !== context.projectId) throw new BriefError(403, 'brief-authority-mismatch', 'Project scope is not authorized');
      const preview = designBriefPreviewSchema.parse(request.preview);
      const at = now();
      const id = `brief_${randomUUID().replace(/-/gu, '')}`;
      // Attach is caller-supplied intent, not proof of model/reference provenance.
      // Keep inferred gaps visible, and attribute adopted facts to the accepting user.
      let draft: Draft = { ...preview, id, projectId: request.projectId, revision: 1, state: 'draft', contextRevision: null, rubricRevision: null, createdAt: at };
      for (const pathName of DESIGN_BRIEF_TEXT_PATHS) {
        const field = fieldAt(draft, pathName);
        if (field.basis !== 'assumed') draft = withField(draft, pathName, { ...field, basis: 'user' });
      }
      draft.sections = draft.sections.map(section => ({ ...section, basis: section.basis === 'assumed' ? 'assumed' : 'user' }));
      draft.intent = { styleDirections: detectStyleDirections(preview.originalText).slice(0, 12), targetRuntime: detectTargetRuntime(preview.originalText) };
      await store.writeRevision(finalize(draft));
      const accepted = finalize({ ...draft, revision: 2, state: 'accepted' });
      await store.writeRevision(accepted);
      const record: StoredBriefRecord = { id, projectId: request.projectId, status: 'ready', originalText: preview.originalText, failure: null, revisions: [1, 2], createdAt: at, updatedAt: at };
      await store.writeRecord(record);
      return view(record);
    },

    async create(request: CreateDesignBriefRequest, context: { principalId: string; projectId: string }): Promise<DesignBriefRecordView> {
      if (request.projectId !== context.projectId) throw new BriefError(403, 'brief-authority-mismatch', 'Project scope is not authorized');
      let selected: SelectedReference[] = [];
      try { selected = await selectReferences(request.selectedReferenceRefs ?? [], context, references, deps.generator?.maxInputChars ?? 0); }
      catch (error) { if (error instanceof ReferenceSelectionError) throw new BriefError(error.status, error.code, error.message); throw error; }
      const at = now();
      const record: StoredBriefRecord = { id: `brief_${randomUUID().replace(/-/gu, '')}`, projectId: request.projectId, status: 'pending', originalText: request.originalText, failure: null, revisions: [], createdAt: at, updatedAt: at };
      await store.writeRecord(record);
      const controller = new AbortController();
      const done = transform(record, request, selected, controller.signal)
        .catch(async () => { if (!controller.signal.aborted) await store.writeRecord({ ...record, status: 'failed', failure: { code: 'transformer-failed', message: 'The transformer could not produce a brief', recovery: 'Use your original prompt.' }, updatedAt: now() }); })
        .finally(() => jobs.delete(record.id));
      jobs.set(record.id, { controller, done });
      return view(record);
    },

    async read(projectId: string, id: string): Promise<DesignBriefRecordView> { return view(await owned(projectId, id)); },

    /** Waits for a pending transform (tests and the CLI's synchronous path). */
    async settled(id: string): Promise<DesignBriefRecordView> {
      await jobs.get(id)?.done;
      const record = await store.readRecord(id);
      if (!record) throw new BriefError(404, 'brief-not-found', 'No such brief');
      return view(record);
    },

    async cancel(projectId: string, id: string): Promise<DesignBriefRecordView> {
      const record = await owned(projectId, id);
      if (record.status !== 'pending') return view(record);
      jobs.get(id)?.controller.abort();
      const cancelled = { ...record, status: 'cancelled' as const, updatedAt: now() };
      await store.writeRecord(cancelled);
      return view(cancelled);
    },

    async patch(projectId: string, id: string, patch: PatchDesignBriefRequest): Promise<DesignBriefRecordView> {
      const record = await owned(projectId, id);
      if (record.status !== 'ready') throw new BriefError(409, 'brief-not-ready', 'Only a ready brief can be edited or used');
      const latestRevision = record.revisions.at(-1)!;
      if (patch.expectedRevision !== latestRevision) throw new BriefError(409, 'brief-revision-conflict', `The brief is at revision ${latestRevision}`);
      const latest = await store.readRevision(id, latestRevision);
      if (!latest) throw new BriefError(404, 'brief-not-found', 'The brief revision is missing');
      const { renderedPrompt: _p, hash: _h, ...base } = latest;
      let draft: Draft = { ...base, revision: latestRevision + 1, state: 'draft', createdAt: now() };
      for (const decision of patch.referenceDecisions ?? []) {
        const change = draft.referenceChanges.find(item => item.id === decision.id);
        if (!change) throw new BriefError(422, 'reference-change-unknown', `No proposed change ${decision.id}`);
        draft.referenceChanges = draft.referenceChanges.map(item => (item.id === decision.id ? { ...item, status: decision.status } : item));
        if (decision.status === 'accepted') draft = withField(draft, change.path, { value: change.proposedValue, basis: 'reference' });
      }
      const edited = new Set<DesignBriefEditablePath>(draft.userEditedPaths);
      for (const [pathName, value] of Object.entries(patch.edits ?? {}) as Array<[DesignBriefEditablePath, string | string[]]>) {
        edited.add(pathName);
        if ((DESIGN_BRIEF_TEXT_PATHS as readonly string[]).includes(pathName)) draft = withField(draft, pathName as DesignBriefTextPath, { value: value as string, basis: 'user' });
        else if (pathName === 'sections') draft.sections = (value as string[]).map(entry => { const [name, ...rest] = entry.split(':'); const purpose = rest.join(':').trim(); return { name: name!.trim().slice(0, 200) || 'Section', purpose: purpose || null, basis: 'user' as const }; });
        else draft = { ...draft, [pathName]: value as string[] };
      }
      draft.userEditedPaths = [...edited];
      if (patch.accept) draft.state = 'accepted';
      const brief = finalize(draft);
      await store.writeRevision(brief);
      const next = { ...record, revisions: [...record.revisions, brief.revision], updatedAt: now() };
      await store.writeRecord(next);
      return view(next);
    },

    /** The exact accepted revision a run binds to; checked against its hash and a fresh render. */
    async resolveForRun(projectId: string, binding: RunDesignBriefBinding): Promise<DesignBrief> {
      const record = await owned(projectId, binding.id);
      const brief = await store.readRevision(binding.id, binding.revision);
      if (!brief) throw new BriefError(404, 'brief-not-found', 'No such brief revision');
      if (brief.state !== 'accepted') throw new BriefError(409, 'brief-not-accepted', 'Use prompt has not accepted this brief revision');
      const recomputed = createHash('sha256').update(canonicalDesignBriefJson(brief)).digest('hex');
      if (brief.hash !== binding.hash || recomputed !== brief.hash || renderDesignBriefPrompt(brief) !== brief.renderedPrompt || record.projectId !== brief.projectId) {
        throw new BriefError(409, 'brief-stale', 'The brief changed since it was accepted; review it again');
      }
      return parseDesignBrief(brief);
    },
  };
}
export type DesignBriefService = ReturnType<typeof createDesignBriefService>;

/** Scratch directory for the no-tool transformer turn, under the daemon data root. */
export function briefTransformerWorkDir(dataDir: string): string { return path.join(dataDir, 'workbench', 'brief-transformer'); }
