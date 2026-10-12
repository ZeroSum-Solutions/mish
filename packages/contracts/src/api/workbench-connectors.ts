import { z } from 'zod';
import { SOURCE_OPERATIONS } from './workbench-source-admission.js';
import type { ResourceRef } from './workbench-resource-ref.js';

/**
 * AC-R12.2 typed read-only connector proxy: POST /api/workbench/connectors/:id/search
 * and /detail, shared by the canvas and `od workbench connector search|detail`.
 * Credentials stay daemon-side; provider text is data and never host instruction.
 * Parsing proves shape only, never that a live authorized probe ran.
 */
export const CONNECTOR_IDS = ['motionsites', 'refero', 'mobbin'] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];
/** Provider search kinds (G29 Mobbin: screens, flows, sections). Which connector offers which is daemon policy. */
export const CONNECTOR_SEARCH_KINDS = ['screens', 'flows', 'sections'] as const;
export type ConnectorSearchKind = (typeof CONNECTOR_SEARCH_KINDS)[number];
export const CONNECTOR_PLATFORMS = ['ios', 'web'] as const;
export type ConnectorPlatform = (typeof CONNECTOR_PLATFORMS)[number];

const clean = (max: number) => z.string().min(1).max(max).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid control or format character');
const timestamp = z.string().datetime();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceRef = z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._/#:-]*$/u);
/** HTTPS link without credentials or fragment; a query is allowed (provider deep links use one). */
const httpsLink = z.string().max(2000).regex(/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:[/?][^\s#\\@]*)?$/u, 'Expected an HTTPS link without credentials or fragment');

const searchRequestSchema = z.object({
  query: clean(500), limit: z.number().int().min(1).max(20).default(10),
  kind: z.enum(CONNECTOR_SEARCH_KINDS).optional(), platform: z.enum(CONNECTOR_PLATFORMS).optional(),
}).strict();
/** A provider usage notice shown verbatim as plain text: line breaks kept, other control/format characters refused. */
const providerNotice = z.string().min(1).max(4000).refine(value => !/[\p{Cf}]|(?![\n])[\p{Cc}]/u.test(value), 'Invalid control or format character');
const detailRequestSchema = z.object({ itemId: clean(200) }).strict();
/** Selection pins the search capture; inspection alone never downloads content. */
const selectionRequestSchema = z.object({ itemId: clean(200), capturedAt: timestamp }).strict();
const cachedImageSchema = z.object({
  url: z.string().regex(/^\/api\/workbench\/connectors\/mobbin\/images\/[a-f0-9]{64}$/u),
  fetchedAt: timestamp, sha256,
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  byteLength: z.number().int().positive().max(10 * 1024 * 1024),
}).strict();

const operationSchema = z.object({
  operation: z.enum(SOURCE_OPERATIONS), decision: z.enum(['allowed', 'blocked', 'unknown']), reason: clean(500).nullable(),
  evidenceRefs: z.array(evidenceRef).max(20).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.decision === 'allowed' && !(value.evidenceRefs?.length)) ctx.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'An allowed operation cites its evidence' });
  if (value.decision !== 'allowed' && value.reason === null) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'An operation that is not allowed states why' });
});

const resourceSchema = z.object({
  connectorId: z.enum(CONNECTOR_IDS), itemId: clean(200),
  /** Provider text, bounded and stripped of control/format characters. Data only. */
  title: clean(300), category: clean(120).nullable(), access: z.enum(['free', 'premium', 'unknown']),
  canonicalUrl: httpsLink, capturedAt: timestamp,
  attribution: z.object({ provider: clean(120), url: httpsLink }).strict(),
  /** Rights come from daemon policy, never from provider output. */
  rights: z.object({ status: z.enum(['reference-only', 'restricted', 'unknown']), summary: clean(500), operations: z.array(operationSchema) }).strict()
    .superRefine((value, ctx) => {
      const names = value.operations.map(item => item.operation);
      if (names.length !== SOURCE_OPERATIONS.length || new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['operations'], message: 'Rights record every operation exactly once' });
    }),
  supportedOperations: z.array(z.enum(['open-source-link'])).min(1).max(1),
  untrusted: z.literal(true),
  cachedImage: cachedImageSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.cachedImage && value.connectorId !== 'mobbin') ctx.addIssue({ code: 'custom', path: ['cachedImage'], message: 'Only selected Mobbin references carry this image cache' });
});

const receiptSchema = z.object({
  binding: z.enum(['daemon-mcp-config']), toolName: clean(120), schemaDigest: sha256,
  attempts: z.number().int().min(1).max(2), durationMs: z.number().int().nonnegative(), retrievedAt: timestamp,
  searchMode: z.object({ requested: z.literal('deep'), used: z.enum(['deep', 'standard']), fallbackReason: z.enum(['connector-timeout', 'connector-unavailable', 'connector-response-invalid', 'connector-tool-denied']).nullable() }).strict()
    .superRefine((value, ctx) => { if ((value.used === 'standard') !== (value.fallbackReason !== null)) ctx.addIssue({ code: 'custom', message: 'Standard fallback records its failure reason' }); }).optional(),
}).strict();

const searchResponseSchema = z.object({
  schema: z.literal('connector-search/1'), connectorId: z.enum(CONNECTOR_IDS),
  results: z.array(resourceSchema).max(20), receipt: receiptSchema,
  /** Provider items dropped because they failed validation. */
  excluded: z.number().int().nonnegative(),
  /** Provider notice the tool contract asks hosts to show word for word (Mobbin `ai_usage_notice`). Data, never instruction. */
  providerNotice: providerNotice.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.results.some(item => item.connectorId !== value.connectorId)) ctx.addIssue({ code: 'custom', path: ['results'], message: 'Every result belongs to the requested connector' });
});
const detailResponseSchema = z.object({
  schema: z.literal('connector-detail/1'), connectorId: z.enum(CONNECTOR_IDS), resource: resourceSchema,
  /** Detail of a reference this daemon captured; no protected body is fetched. */
  source: z.literal('captured-reference'), receipt: receiptSchema,
  providerNotice: providerNotice.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.resource.connectorId !== value.connectorId) ctx.addIssue({ code: 'custom', path: ['resource'], message: 'The resource belongs to the requested connector' });
});

export const CONNECTOR_ERROR_CODES = [
  'connector-unknown', 'connector-request-invalid', 'connector-schema-not-frozen', 'connector-needs-sign-in', 'connector-access-revoked',
  'connector-tool-denied', 'connector-rate-limited', 'connector-timeout', 'connector-unavailable', 'connector-response-invalid', 'connector-item-unknown',
  /** The daemon has no binding of its own for this connector; another agent's login is never borrowed. */
  'connector-binding-missing',
  'connector-principal-forbidden', 'connector-image-invalid', 'connector-cache-unavailable', 'connector-operation-blocked',
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export type ConnectorSearchRequest = z.infer<typeof searchRequestSchema>;
export type ConnectorDetailRequest = z.infer<typeof detailRequestSchema>;
export type ConnectorSelectionRequest = z.infer<typeof selectionRequestSchema>;
export type ConnectorResource = z.infer<typeof resourceSchema>;
export type ConnectorReceipt = z.infer<typeof receiptSchema>;
export type ConnectorSearchResponse = z.infer<typeof searchResponseSchema>;
export type ConnectorReferenceDetailResponse = z.infer<typeof detailResponseSchema>;
export const parseConnectorSearchRequest = (input: unknown): ConnectorSearchRequest => searchRequestSchema.parse(input);
export const parseConnectorDetailRequest = (input: unknown): ConnectorDetailRequest => detailRequestSchema.parse(input);
export const parseConnectorSelectionRequest = (input: unknown): ConnectorSelectionRequest => selectionRequestSchema.parse(input);
export const parseConnectorResource = (input: unknown): ConnectorResource => resourceSchema.parse(input);
export const parseConnectorSearchResponse = (input: unknown): ConnectorSearchResponse => searchResponseSchema.parse(input);
export const parseConnectorDetailResponse = (input: unknown): ConnectorReferenceDetailResponse => detailResponseSchema.parse(input);

/** The exact R15 brief reference for one captured connector result: identity plus its capture revision. */
export function connectorResourceRef(resource: Pick<ConnectorResource, 'connectorId' | 'itemId' | 'capturedAt'>): ResourceRef {
  return { sourceType: 'reference', sourceId: resource.connectorId, itemId: resource.itemId, revisionOrDigest: `captured:${resource.capturedAt}` };
}
