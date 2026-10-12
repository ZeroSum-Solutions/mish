import { z } from 'zod';
import { parseSessionModelChoice, type SessionModelChoice } from './workbench-model.js';
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(200).refine(value => !/[\x00-\x1f\x7f\\]/u.test(value));
const id = text.refine(value => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value));
const choice = z.unknown().transform((input, ctx): SessionModelChoice => {
  try { return parseSessionModelChoice(input); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid public model choice' }); return z.NEVER; }
});
const legacyChoice = z.object({
  kind: z.literal('legacy-run-only'), agentId: z.literal('byok-opencode'),
  modelId: text, protocol: z.enum(['anthropic','openai','azure','google','ollama','senseaudio','aihubmix']),
  nonce: z.string().uuid(),
}).strict();
const executionChoice = z.union([legacyChoice, choice]);
const identity = z.object({ choice: executionChoice, effectiveModel: text.nullable() }).strict();
const replayNotice = z.object({
  version: z.literal(1), reason: z.enum(['model-switch','fresh-continuation','stateless-replay']),
  from: identity.nullable(), to: identity,
  selectionSource: z.enum(['session','override','default','locked-task']), selectionRevision: integer.nullable(),
  sourceRunId: id.nullable(), includedMessages: integer, omittedMessages: integer,
  omittedRanges: z.array(z.object({ first: integer, last: integer }).strict()).max(2),
  mandatoryTruncation: z.object({ brief: z.boolean(), anchor: z.boolean(), context: z.boolean() }).strict(),
  attachmentCount: integer, digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: integer.max(16000), byteLimit: integer.max(16000), omittedBytes: integer,
  actualReplayTokens: z.null(), estimatedReplayTokens: integer.nullable(), estimatedTokenAllowance: integer.nullable(),
  tokenEstimateMethod: z.literal('utf8_bytes_div_3_ceil_v1'), remainingBudgetConfidence: z.literal('unverified'),
  budgetConfidence: z.enum(['byte-bound-only','byte-and-estimate-bound']), status: z.enum(['empty','unchanged','truncated','omitted']),
}).strict();
const admission = z.object({
  version: z.literal(1), runId: id, sessionId: id, projectId: id,
  cursorSequence: integer, previousRunId: id.nullable(), admittedAt: integer,
  selectionSource: z.enum(['session','override','default','locked-task']), selectionRevision: integer.nullable(),
  requested: executionChoice, effectiveModel: text.nullable(), reasoning: text.nullable(), serviceTier: text.nullable(),
  forceFresh: z.boolean(), sourceRunId: id.nullable(),
  replayNotice: replayNotice.nullable(),
  routeBudget: z.object({ contextWindowTokens: integer.nullable(), outputReserveTokens: integer.nullable(), currentTransportEstimatedTokens: integer, estimatedReplayAllowance: integer.nullable(), hiddenEnvelopeConfidence: z.literal('unverified') }).strict().nullable(),
}).strict();
export type SessionReplayNotice = z.infer<typeof replayNotice>;
export type SessionRunAdmission = z.infer<typeof admission>;
export type SessionExecutionChoice = z.infer<typeof executionChoice>;
export const parseSessionExecutionChoice = (input: unknown): SessionExecutionChoice => executionChoice.parse(input);
export const parseSessionReplayNotice = (input: unknown): SessionReplayNotice => replayNotice.parse(input);
export const parseSessionRunAdmission = (input: unknown): SessionRunAdmission => admission.parse(input);

/** Strict transient launch carrier. This value must never be persisted or hashed. */
const transientProvider = z.object({
  protocol: z.enum(['anthropic','openai','azure','google','ollama','senseaudio','aihubmix']),
  apiKey: z.string().max(12000).default(''), baseUrl: z.string().max(4096).optional(),
  apiVersion: z.string().max(200).optional(), requiresApiKey: z.boolean().optional(), model: z.string().max(200).optional(),
}).strict();
export const parseTransientSessionProviderCarrier = (input: unknown) => transientProvider.parse(input);
