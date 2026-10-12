import { z } from 'zod';
import { parseConnectorResource, parseConnectorSearchResponse } from './workbench-connectors.js';

export const REFERENCE_SPINES = ['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI'] as const;
export const REFERENCE_SOURCES = ['refero', 'mobbin'] as const;
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid control character');
const sectionSchema = z.object({ id: text(80), name: text(200), purpose: text(500).nullable() }).strict();
const requestSchema = z.object({
  brief: z.string().trim().min(1).max(20_000),
  spineCode: z.enum(REFERENCE_SPINES).optional(),
  sections: z.array(sectionSchema).min(1).max(8).optional(),
  /** Kept optional family sections augment suggestions; they are not a complete page plan. */
  sectionAdditions: z.array(sectionSchema).min(1).max(8).optional(),
  /** Explicitly dropped roles must not reappear in atlas-derived suggestions. */
  excludedSections: z.array(text(200)).max(24).optional(),
  limit: z.number().int().min(1).max(20).default(10),
}).strict().refine(value => !value.sections || new Set(value.sections.map(section => section.id)).size === value.sections.length, 'Section IDs must be unique')
  .refine(value => !value.sectionAdditions || new Set(value.sectionAdditions.map(section => section.id)).size === value.sectionAdditions.length, 'Addition IDs must be unique')
  .refine(value => !(value.sections && value.sectionAdditions), 'Use an explicit page plan or additions, not both');
const resourceSchema = z.unknown().transform((value, ctx) => {
  try { return parseConnectorResource(value); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid connector resource' }); return z.NEVER; }
});
const receiptSchema = z.unknown().transform((value, ctx) => {
  try { return parseConnectorSearchResponse({ schema: 'connector-search/1', connectorId: 'refero', results: [], receipt: value, excluded: 0 }).receipt; }
  catch { ctx.addIssue({ code: 'custom', message: 'Invalid connector receipt' }); return z.NEVER; }
});
const sourceSchema = z.object({
  source: z.enum(REFERENCE_SOURCES), sectionId: text(80), status: z.enum(['ok', 'empty', 'unavailable']),
  count: z.number().int().min(0).max(20), code: text(100).nullable(),
  receipt: receiptSchema.nullable(), providerNotice: z.string().max(4000).nullable(),
}).strict();
const referenceSchema = z.object({
  id: text(80), resource: resourceSchema, sectionIds: z.array(text(80)).min(1).max(8),
  score: z.number().min(0).max(100).nullable(), sourceWeight: z.number().min(0).max(1),
  reasons: z.array(text(500)).min(1).max(8),
  rightsLabel: z.enum(['reference-only', 'restricted', 'unknown']),
}).strict().refine(value => value.rightsLabel === value.resource.rights.status, 'Rights label must match daemon policy');
const responseSchema = z.object({
  schema: z.literal('reference-fanout/1'), spineCode: z.enum(REFERENCE_SPINES),
  sectionBasis: z.enum(['provided', 'suggested']),
  sections: z.array(sectionSchema.extend({ query: text(500) })).min(1).max(8),
  sources: z.array(sourceSchema).max(16), references: z.array(referenceSchema).max(20),
  ranking: z.object({ status: z.enum(['ranked', 'deterministic', 'partial', 'unavailable', 'empty']), model: z.literal('jev-latest'), code: text(100).nullable() }).strict(),
  partial: z.boolean().default(false), degraded: z.boolean(), candidateCount: z.number().int().min(0).max(80),
}).strict().superRefine((value, ctx) => {
  const sections = new Set(value.sections.map(section => section.id));
  if (sections.size !== value.sections.length || value.references.some(ref => ref.sectionIds.some(id => !sections.has(id))) || value.sources.some(source => !sections.has(source.sectionId))) {
    ctx.addIssue({ code: 'custom', message: 'Unknown or duplicated section identity' });
  }
  if (new Set(value.references.map(ref => ref.id)).size !== value.references.length) ctx.addIssue({ code: 'custom', message: 'Duplicate reference identity' });
  if (value.references.some(ref => ref.score !== null && !['ranked', 'partial'].includes(value.ranking.status))) ctx.addIssue({ code: 'custom', message: 'Scores require successful ranking' });
});
export type ReferenceFanoutRequest = z.infer<typeof requestSchema>;
export type ReferenceFanoutResponse = z.infer<typeof responseSchema>;
export type FanoutReference = ReferenceFanoutResponse['references'][number];
export type ReferenceSection = z.infer<typeof sectionSchema>;
export const parseReferenceFanoutRequest = (input: unknown): ReferenceFanoutRequest => requestSchema.parse(input);
export const parseReferenceFanoutResponse = (input: unknown): ReferenceFanoutResponse => responseSchema.parse(input);
