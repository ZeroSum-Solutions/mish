import { createHash } from 'node:crypto';
import { parseRightsAssessment, SOURCE_OPERATIONS, type ConnectorSearchRequest } from '@open-design/contracts';

export const REFERO_EVIDENCE = 'docs/plans/2026-10-02-design-workbench/evidence/refero-b069.md';
export const REFERO_SERVER_ID = 'refero';
export const REFERO_RIGHTS_SUMMARY = 'D8: Refero is a reference-only fallback and does not close Mobbin G29. Private attributed link metadata only; protected content, derivative use and redistribution are blocked.';
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
const policyDigest = digest({ track: 'B069', decision: 'D8', scope: 'attributed-link-metadata-only' });

/** B069 authorizes this narrow private reference adapter, not a grant to retrieved content. */
export const REFERO_RIGHTS_ASSESSMENT = parseRightsAssessment({
  schema: 'rights-assessment/1', id: 'refero-b069-reference-metadata', revision: 1,
  source: { ref: { sourceType: 'reference', sourceId: 'refero', itemId: 'connector:link-metadata', revisionOrDigest: `policy-sha256:${policyDigest}` }, contentSha256: policyDigest, closureDigest: policyDigest, fileScope: 'all', filePaths: [] },
  terms: null, acquisitionMode: 'reference-link',
  evaluator: { id: 'owner-source-curator.refero-b069', role: 'source-curator', basis: 'owner-accepted-private-use' },
  ownerDecision: { decidedAt: '2026-10-09', decidedBy: 'owner', citation: 'B069 track brief ~/refero.md, followed at the owner’s instruction: route Refero results through rights assessment and the daemon connector proxy; reference-only fallback under D8; does not close Mobbin’s gate. Only attributed link metadata is admitted; no content-use licence is asserted.' },
  authorityScope: { kind: 'source-management', principalId: 'local-owner' }, evidenceRefs: ['refero-b069-owner-brief-d8'], evaluatedAt: '2026-10-09T00:00:00.000Z',
  operationRights: SOURCE_OPERATIONS.map(operation => ({
    operation, decision: operation === 'host-preview' ? 'allowed' : 'blocked',
    scope: { projectScope: 'any-authorized', targetScope: 'any', principalId: 'local-owner', projectIds: [], targetProfileIds: [], visibility: operation === 'export-application' ? 'finished-application' : operation === 'redistribute-unit' ? 'reusable-distribution' : 'private' },
    evidenceRefs: ['refero-b069-owner-brief-d8'],
    obligations: operation === 'host-preview' ? [{ id: 'attributed-metadata-only', kind: 'attribution', description: 'Display Refero attribution and the canonical source link; reference-only fallback, never an installable item. Only id, title, category and link metadata may be held in this daemon session; no screenshots or source bodies.' }] : [],
    reason: operation === 'host-preview' ? 'Private attributed link metadata only, authorized by B069; no protected content preview.' : 'D8 reference-only fallback: this content operation is not admitted by B069. Session link metadata is not cached source content.',
  })),
});

export const REFERO_BINDING_STEPS = Object.freeze([
  'Add https://api.refero.design/mcp in Settings → External MCP as a Streamable HTTP server with id "refero", then connect your own Refero account.',
  'An agent runtime login is not shared with the daemon and is never copied. G18 live search/attribution proof remains pending; Refero never closes Mobbin G29.',
]);

export function referoSearchPlan(request: ConnectorSearchRequest): { name: string; args: Record<string, unknown> } {
  const kind = request.kind ?? 'screens';
  if (kind === 'sections' || !request.platform) throw new Error('Refero supports screens or flows with a web or ios platform');
  return { name: kind === 'flows' ? 'refero_search_flows' : 'refero_search_screens', args: { query: request.query, platform: request.platform } };
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Freeze only the selected actual tools/list schema before tools/call, in that same MCP session.
 * Unknown schema constructs/required arguments fail closed; provider names cannot choose a tool.
 * `limit` is local truncation only: Refero's search contract takes page, not limit.
 */
export function freezeReferoSchema(catalog: unknown, name: string, args: Record<string, unknown>): string {
  const entries = record(catalog)?.tools;
  if (!Array.isArray(entries) || entries.length > 100 || record(catalog)?.nextCursor !== undefined) throw new Error('refero-schema-not-frozen');
  const matches = entries.filter(entry => record(entry)?.name === name);
  const schema = matches.length === 1 ? record(record(matches[0])?.inputSchema) : null;
  if (!schema || schema.type !== 'object' || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties', 'description', 'title', '$schema'].includes(key))) throw new Error('refero-schema-not-frozen');
  const properties = record(schema.properties);
  if (!properties || !Array.isArray(schema.required) || !schema.required.includes('query') || !schema.required.includes('platform')) throw new Error('refero-schema-not-frozen');
  const format = record(properties.response_format);
  if (format?.type === 'string' && Array.isArray(format.enum) && format.enum.includes('json')) args.response_format = 'json';
  if (schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(args, key))) throw new Error('refero-schema-not-frozen');
  for (const [key, value] of Object.entries(args)) {
    const property = record(properties[key]);
    if (!property || property.type !== 'string' || typeof value !== 'string'
      || Object.keys(property).some(field => !['type', 'description', 'title', 'enum', 'default', 'minLength', 'maxLength'].includes(field))
      || (property.enum !== undefined && (!Array.isArray(property.enum) || !property.enum.includes(value)))
      || (property.minLength !== undefined && (typeof property.minLength !== 'number' || !Number.isSafeInteger(property.minLength) || property.minLength < 0 || [...value].length < property.minLength))
      || (property.maxLength !== undefined && (typeof property.maxLength !== 'number' || !Number.isSafeInteger(property.maxLength) || property.maxLength < 0 || [...value].length > property.maxLength))) throw new Error('refero-schema-not-frozen');
  }
  return digest(schema);
}
