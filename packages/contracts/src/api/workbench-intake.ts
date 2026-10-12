import { z } from 'zod';
import { API_ERROR_CODES, type ApiError } from '../errors.js';
import type { JsonValue } from '../common.js';

const text = z.string().min(1);
const id = z.string().uuid();
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Wire paths are relative and already safe; the daemon still verifies the filesystem. */
const relativePath = text.refine(value => !/[\\\x00-\x1f\x7f]/.test(value) && !/^[A-Za-z]:/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a safe relative path');
const destinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }).strict(),
  z.object({ kind: z.literal('project'), projectId: text, conversationId: text.optional(), dir: relativePath.optional() }).strict(),
]);
const filename = text.refine(value => !/[\/\\\x00-\x1f\x7f]/.test(value) && !/^[A-Za-z]:/.test(value) && value.trim() !== '.' && value.trim() !== '..', 'Expected an ordinary basename without control characters');
const descriptorSchema = z.object({ clientFileId: id, order: size, filename, size, declaredMime: text.optional(), relativePath: relativePath.optional() }).strict();
const createSchema = z.object({ intakeBatchId: id, destination: destinationSchema, files: z.array(descriptorSchema).min(1).max(20) }).strict().superRefine((value, ctx) => {
  if (new Set(value.files.map(file => file.clientFileId)).size !== value.files.length || new Set(value.files.map(file => file.order)).size !== value.files.length) ctx.addIssue({ code: 'custom', message: 'File identities and orders must be unique' });
});
const jsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonSchema), z.record(jsonSchema)]));
const errorSchema = z.object({ code: z.enum(API_ERROR_CODES), message: text, details: jsonSchema.optional(), retryable: z.boolean().optional(), requestId: text.optional(), taskId: text.optional() }).strict().transform((error): ApiError => ({ code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }), ...(error.retryable === undefined ? {} : { retryable: error.retryable }), ...(error.requestId === undefined ? {} : { requestId: error.requestId }), ...(error.taskId === undefined ? {} : { taskId: error.taskId }) }));
const storedSchema = z.object({ assetId: text, contentHash: z.string().regex(/^[a-f0-9]{64}$/), size, filename: text, declaredMime: text.optional(), detectedMime: text, kind: z.enum(['image', 'color', 'design-system', 'font', 'html', 'text', 'url', 'video', 'file']), projectFile: z.object({ projectId: text, relPath: relativePath }).strict().optional(), downloadUrl: z.string().regex(/^\/(?![\/\\])[^\s\\]*$/) }).strict();
const outcomeSchema = z.object({ clientFileId: id, order: size, descriptor: descriptorSchema, state: z.enum(['queued', 'stored', 'failed', 'cancelled', 'needs-reselection', 'cleared']), stored: storedSchema.optional(), error: errorSchema.optional(), retryable: z.boolean(), hasSuccessfulAttachment: z.boolean() }).strict().superRefine((value, ctx) => {
  if (value.descriptor.clientFileId !== value.clientFileId || value.descriptor.order !== value.order) ctx.addIssue({ code: 'custom', message: 'Outcome identity and order must match its frozen descriptor' });
  if (value.state === 'stored' && !value.stored) ctx.addIssue({ code: 'custom', message: 'Stored state requires a byte receipt' });
});
const snapshotSchema = z.object({ intakeBatchId: id, revision: size, destination: destinationSchema, files: z.array(outcomeSchema).max(20), createdAt: size, updatedAt: size }).strict();
const fileIds = z.array(id).min(1).max(20).refine(ids => new Set(ids).size === ids.length, 'Duplicate file identity');
const attachSchema = z.object({ conversationId: text, projectId: text, clientFileIds: fileIds.optional() }).strict();
const clearSchema = z.object({ clientFileIds: fileIds.optional() }).strict();
const attachmentSchema = z.object({ clientFileId: id, assetId: text, contentHash: z.string().regex(/^[a-f0-9]{64}$/), projectId: text, conversationId: text, relPath: relativePath, filename: text, size }).strict();
const attachResponseSchema = z.object({ intakeBatchId: id, revision: size, attachments: z.array(attachmentSchema), files: z.array(outcomeSchema) }).strict();
const putResponseSchema = z.object({ intakeBatchId: id, revision: size, file: outcomeSchema }).strict();
const listSchema = z.object({ batches: z.array(snapshotSchema) }).strict();

export type IntakeDestination = z.infer<typeof destinationSchema>;
export type IntakeFileDescriptor = z.infer<typeof descriptorSchema>;
export type CreateIntakeBatchRequest = z.infer<typeof createSchema>;
export type IntakeFileState = z.infer<typeof outcomeSchema>['state'];
export type IntakeStoredRef = z.infer<typeof storedSchema>;
export type IntakeFileOutcome = z.infer<typeof outcomeSchema>;
export type IntakeBatchSnapshot = z.infer<typeof snapshotSchema>;
export type IntakeFilePutResponse = z.infer<typeof putResponseSchema>;
export type AttachIntakeRequest = z.infer<typeof attachSchema>;
export type AttachIntakeResponse = z.infer<typeof attachResponseSchema>;
export type ClearIntakeRequest = z.infer<typeof clearSchema>;
export type ListIntakeBatchesResponse = z.infer<typeof listSchema>;
export const parseCreateIntakeBatchRequest = (value: unknown): CreateIntakeBatchRequest => createSchema.parse(value);
export const parseIntakeBatchSnapshot = (value: unknown): IntakeBatchSnapshot => snapshotSchema.parse(value);
export const parseIntakeFilePutResponse = (value: unknown): IntakeFilePutResponse => putResponseSchema.parse(value);
export const parseAttachIntakeRequest = (value: unknown): AttachIntakeRequest => attachSchema.parse(value);
export const parseAttachIntakeResponse = (value: unknown): AttachIntakeResponse => attachResponseSchema.parse(value);
export const parseClearIntakeRequest = (value: unknown): ClearIntakeRequest => clearSchema.parse(value);
export const parseListIntakeBatchesResponse = (value: unknown): ListIntakeBatchesResponse => listSchema.parse(value);
