import { z } from 'zod';
import { reusableUnitManifestSchema, workbenchRelativePathSchema, WORKBENCH_UNIT_LIMITS } from './workbench-capture.js';

/** AC-R14.4: standalone editable files, never a reference or implicit inline embedding. */
export const WORKBENCH_UNIT_INSERT_ID_PATTERN = /^insert_[A-Za-z0-9_-]{20}$/u;
export const unitInsertRequestSchema = z.object({
  projectId: z.string().min(1).max(200).refine(value => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value)),
  mode: z.enum(['standalone-artifact', 'inline-primary-content']).default('standalone-artifact'),
}).strict();
export type UnitInsertRequest = z.infer<typeof unitInsertRequestSchema>;
export const UNIT_INSERT_REFUSALS = ['rights-blocked', 'unsupported-target-format', 'same-project', 'unsafe-path', 'insert-conflict', 'insert-not-found', 'insert-incomplete', 'idempotency-conflict', 'project-not-found', 'project-directory-missing', 'unit-file-missing'] as const;
export type UnitInsertRefusal = typeof UNIT_INSERT_REFUSALS[number];

export const unitUndoInsertRequestSchema = z.object({ discardEdits: z.boolean().optional() }).strict();
export type UnitUndoInsertRequest = z.infer<typeof unitUndoInsertRequestSchema>;

export const unitInsertReceiptSchema = z.object({
  schema: z.literal('unit-insert/1'),
  insertId: z.string().regex(WORKBENCH_UNIT_INSERT_ID_PATTERN),
  projectId: unitInsertRequestSchema.shape.projectId,
  mode: z.literal('standalone-artifact'),
  status: z.enum(['inserting', 'inserted', 'undoing', 'undone']),
  directory: z.string().regex(/^unit-insert-[A-Za-z0-9_-]{20}$/u),
  entryPath: workbenchRelativePathSchema,
  files: z.array(z.object({ path: workbenchRelativePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).min(1).max(WORKBENCH_UNIT_LIMITS.maxFiles * 2 + 1),
  /** Immutable source manifest: assets, dependencies, action declarations, rights and lineage. */
  unit: reusableUnitManifestSchema,
  /** An insertion proves file placement; action verification belongs to the actual preview. */
  actionVerification: z.literal('not-run'),
  dependenciesInstalled: z.literal(false),
  createdAt: z.string().datetime(),
  undoneAt: z.string().datetime().nullable(),
  /** Project-relative directory containing recoverable copies of explicitly discarded edits. */
  recoveryPath: workbenchRelativePathSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.recoveryPath !== undefined && value.recoveryPath !== `.od-undo/${value.insertId}`) ctx.addIssue({ code: 'custom', path: ['recoveryPath'], message: 'Recovery copies must belong to this insertion' });
  if (value.files.some(file => !file.path.startsWith(`${value.directory}/`)) || value.entryPath !== `${value.directory}/${value.unit.entry}` || !value.files.some(file => file.path === value.entryPath) || new Set(value.files.map(file => file.path)).size !== value.files.length) ctx.addIssue({ code: 'custom', path: ['files'], message: 'All unique inserted paths must belong to this insertion directory, including its entry' });
});
export type UnitInsertReceipt = z.infer<typeof unitInsertReceiptSchema>;
export function parseUnitInsertRequest(input: unknown): UnitInsertRequest { return unitInsertRequestSchema.parse(input); }
export function parseUnitInsertReceipt(input: unknown): UnitInsertReceipt { return unitInsertReceiptSchema.parse(input); }

export const unitInsertListSchema = z.object({ insertions: z.array(unitInsertReceiptSchema).max(200) }).strict();
export function parseUnitInsertList(input: unknown): { insertions: UnitInsertReceipt[] } { return unitInsertListSchema.parse(input); }
