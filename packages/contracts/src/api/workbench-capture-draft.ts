import { z } from 'zod';
import { WORKBENCH_CAPTURE_ID_PATTERN } from './workbench-capture.js';

/** Shape validation never establishes project authority, rights or provider availability. */
export const WORKBENCH_CAPTURE_DRAFT_ID_PATTERN = /^draft_[A-Za-z0-9_-]{20}$/u;
export const WORKBENCH_CAPTURE_DRAFT_LIMITS = {
  maxPromptChars: 12_000, maxHtmlBytes: 1024 * 1024, maxAssumptions: 32, maxAssumptionChars: 2000, maxListedDrafts: 500,
} as const;

const text = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/\p{Cc}/u.test(value), 'Expected trimmed text without control characters');
const note = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/\p{Cc}/u.test(value.replace(/[\r\n\t]/gu, '')), 'Expected nonempty text without control characters');
const projectId = text(200);
const draftId = z.string().regex(WORKBENCH_CAPTURE_DRAFT_ID_PATTERN);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const prompt = note(WORKBENCH_CAPTURE_DRAFT_LIMITS.maxPromptChars);

/** Pure UTF-8 size check shared by Node and web without runtime-specific APIs. */
function withinUtf8Bytes(value: string, max: number): boolean {
  let size = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (size > max) return false;
  }
  return true;
}

export const captureDraftHtmlSchema = z.string().min(1).max(WORKBENCH_CAPTURE_DRAFT_LIMITS.maxHtmlBytes)
  .refine(value => value.trim().length > 0, 'HTML must be nonempty')
  .refine(value => withinUtf8Bytes(value, WORKBENCH_CAPTURE_DRAFT_LIMITS.maxHtmlBytes), 'HTML exceeds the UTF-8 byte limit');
export const captureDraftAssumptionsSchema = z.array(note(WORKBENCH_CAPTURE_DRAFT_LIMITS.maxAssumptionChars)).max(WORKBENCH_CAPTURE_DRAFT_LIMITS.maxAssumptions);

export const createCaptureDraftRequestSchema = z.object({
  projectId, captureId: z.string().regex(WORKBENCH_CAPTURE_ID_PATTERN), prompt,
  parent: z.object({ draftId, revision }).strict().optional(),
}).strict();
export type CreateCaptureDraftRequest = z.infer<typeof createCaptureDraftRequestSchema>;

const base = {
  schema: z.literal('capture-draft/1'), draftId, projectId, captureId: z.string().regex(WORKBENCH_CAPTURE_ID_PATTERN),
  revision, parentRevision: revision.nullable(), createdAt: z.string().datetime({ offset: false }), prompt,
  assumptions: captureDraftAssumptionsSchema,
  generator: z.object({ provider: z.literal('claude-max'), modelId: text(200), billingLane: z.literal('max-subscription') }).strict(),
};
const failure = z.object({ reason: text(200), message: note(2000), recovery: note(2000) }).strict();

export const captureDraftRevisionSchema = z.discriminatedUnion('status', [
  z.object({ ...base, status: z.literal('pending'), html: z.null(), outputSha256: z.null(), failure: z.null() }).strict(),
  z.object({ ...base, status: z.literal('ready'), html: captureDraftHtmlSchema, outputSha256: z.string().regex(/^[a-f0-9]{64}$/u), failure: z.null() }).strict(),
  z.object({ ...base, status: z.literal('failed'), html: z.null(), outputSha256: z.null(), failure }).strict(),
]);
export type CaptureDraftRevision = z.infer<typeof captureDraftRevisionSchema>;
export const captureDraftListSchema = z.object({ drafts: z.array(captureDraftRevisionSchema).max(WORKBENCH_CAPTURE_DRAFT_LIMITS.maxListedDrafts) }).strict();
export type CaptureDraftList = z.infer<typeof captureDraftListSchema>;

export function parseCreateCaptureDraftRequest(input: unknown): CreateCaptureDraftRequest { return createCaptureDraftRequestSchema.parse(input); }
export function parseCaptureDraftRevision(input: unknown): CaptureDraftRevision { return captureDraftRevisionSchema.parse(input); }
export function parseCaptureDraftList(input: unknown): CaptureDraftList { return captureDraftListSchema.parse(input); }
