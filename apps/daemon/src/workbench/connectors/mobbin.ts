import { parseRightsAssessment, type ConnectorSearchKind, type RightsAssessment } from '@open-design/contracts';

/**
 * G29 Mobbin facts the connector proxy uses. Every value comes from committed
 * evidence; nothing here was fetched at runtime.
 *
 * - Tool schemas were frozen from a Claude Code agent-run receipt of 2026-10-08
 *   (tools/list of the official Mobbin MCP: search_screens, search_flows,
 *   search_sections; no detail tool). Digest: SHA-256 of the input schema as
 *   JSON with code-point-sorted keys and no whitespace.
 * - The RightsAssessment cites Mobbin Terms of May 16, 2026 clauses 3.2, 3.4
 *   and 3.5 from a crawl4ai capture. Owner decision 2026-10-09 (relayed by the
 *   captain): the repository is private, licences are ignored for now and nothing
 *   waits on a licence answer. Every private operation, including exporting the
 *   user's own built app, is therefore admitted under the
 *   `owner-accepted-private-use` basis with that dated citation; the clause
 *   readings stay attached as metadata. Public redistribution stays blocked.
 *   Mobbin's terms are account terms, so this choice carries account risk for
 *   the owner's Mobbin account.
 */
const DIR = 'docs/plans/2026-10-02-design-workbench/evidence/mobbin-g29';
export const MOBBIN_EVIDENCE = Object.freeze({
  agentRunReceipt: `${DIR}/agent-run-receipt.json`,
  receiptManifest: `${DIR}/receipt-manifest.json`,
  termsCapture: `${DIR}/terms-capture.json`,
  rightsAssessment: `${DIR}/rights-assessment.json`,
  closure: `${DIR}/g29-closure.md`,
});

export const MOBBIN_MCP_URL = 'https://api.mobbin.com/mcp';
export const MOBBIN_SERVER_ID = 'mobbin';
/** Digest of the receipt's whole tools array (names, descriptions, input schemas). */
export const MOBBIN_TOOL_SET_DIGEST = 'a0e3f7e4dc10ef33f4cb1f13bcce7e5b59709d95466b546ef223f6741bb04d38';
export const MOBBIN_TERMS_SHA256 = 'd9aa3f218585bae560d9f289bb01f0fbd9701cf718dc4c443685f1a3c9668db0';

export interface MobbinFrozenTool {
  name: string; schemaDigest: string; evidenceRef: string;
  /** The tool schema's own maximum for `limit`. */
  maxLimit: number;
  /** Whether the schema requires `platform` (screens, flows) or has none (sections). */
  platform: boolean;
  /** Singular label used as the result category. */
  label: string;
}
export const MOBBIN_FROZEN_TOOLS: Readonly<Record<ConnectorSearchKind, MobbinFrozenTool>> = Object.freeze({
  screens: { name: 'search_screens', schemaDigest: '92a72439d0c3e95ea48e7eade607c165764c8fe6940b945b73f25f7e86f7b6ba', evidenceRef: MOBBIN_EVIDENCE.agentRunReceipt, maxLimit: 30, platform: true, label: 'screen' },
  flows: { name: 'search_flows', schemaDigest: '4c2327b9cde9a267694ff3123745d7742c8cf882af135bd44d7731919c476439', evidenceRef: MOBBIN_EVIDENCE.agentRunReceipt, maxLimit: 10, platform: true, label: 'flow' },
  sections: { name: 'search_sections', schemaDigest: 'bfc06f385dce29c9e854ae969ff4355b319e3a5ee579fc909803b1bd92d1a858', evidenceRef: MOBBIN_EVIDENCE.agentRunReceipt, maxLimit: 30, platform: false, label: 'section' },
});

const PRINCIPAL = 'local-owner';
const scope = (visibility: 'private' | 'finished-application' | 'reusable-distribution') => ({
  projectScope: 'any-authorized' as const, targetScope: 'any' as const, principalId: PRINCIPAL, projectIds: [], targetProfileIds: [], visibility,
});
const TERMS_REF = 'mobbin-terms-2026-05-16';
const RECEIPT_REF = 'mobbin-g29-agent-run-receipt';
/** Evidence ID of the dated owner decision, recorded in g29-closure.md. */
export const MOBBIN_OWNER_DECISION_EVIDENCE = 'owner-decision-2026-10-09:private-use';
export const MOBBIN_OWNER_DECISION = Object.freeze({
  decidedAt: '2026-10-09', decidedBy: 'owner',
  citation: 'Owner decision 2026-10-09, relayed by the captain: the repository is private, licences are ignored for now and nothing may wait on a licence answer; Mobbin operations are admitted for private use. Mobbin\'s terms are account terms, so this carries account risk for the owner.',
});
type Operation = RightsAssessment['operationRights'][number]['operation'];
const OWNER = 'Allowed for private use under owner decision 2026-10-09 (private repository; licences ignored for now).';
const allowed = (operation: Operation, metadata: string, visibility: 'private' | 'finished-application' = 'private') => ({
  operation, decision: 'allowed' as const, scope: scope(visibility), evidenceRefs: [MOBBIN_OWNER_DECISION_EVIDENCE], obligations: [],
  reason: `${OWNER} Terms metadata: ${metadata}`,
});

/** Committed byte-for-byte as `rights-assessment.json`; a test keeps the two equal. */
export const MOBBIN_RIGHTS_ASSESSMENT: RightsAssessment = parseRightsAssessment({
  schema: 'rights-assessment/1', id: 'mobbin-g29-terms-2026-05-16', revision: 3,
  source: {
    ref: { sourceType: 'reference', sourceId: 'mobbin', itemId: 'mcp:search_screens+search_flows+search_sections', revisionOrDigest: `tools-sha256:${MOBBIN_TOOL_SET_DIGEST}` },
    contentSha256: MOBBIN_TOOL_SET_DIGEST, closureDigest: MOBBIN_TOOL_SET_DIGEST, fileScope: 'all', filePaths: [],
  },
  terms: {
    version: '2026-05-16', sha256: MOBBIN_TERMS_SHA256, canonicalUrl: 'https://mobbin.com/terms',
    clauseRefs: ['3.2.1', '3.2.4', '3.2.5', '3.2.11', '3.4.1', '3.4.2', '3.5', '3.5.1', '3.5.3', '4.1.2', '10.1.2', '10.3.1'],
  },
  acquisitionMode: 'reference-link',
  evaluator: { id: 'owner-source-curator.r12-mobbin', role: 'source-curator', basis: 'owner-accepted-private-use' },
  ownerDecision: { ...MOBBIN_OWNER_DECISION },
  authorityScope: { kind: 'source-management', principalId: PRINCIPAL },
  evidenceRefs: [MOBBIN_OWNER_DECISION_EVIDENCE, TERMS_REF, RECEIPT_REF],
  evaluatedAt: '2026-10-09T03:30:00.000Z',
  operationRights: [
    {
      operation: 'host-preview', decision: 'allowed', scope: scope('private'), evidenceRefs: [TERMS_REF, RECEIPT_REF], reason: null,
      obligations: [
        { id: 'credit-mobbin-and-app', kind: 'attribution', description: 'Show the Mobbin link (mobbin_url) and the app name with every reference; never remove proprietary notations (3.2.4, 10.3.1).' },
        { id: 'own-account-only', kind: 'principal', description: 'Only the account holder whose own Mobbin OAuth binding the daemon holds may view; no account sharing and no resale of access (3.5, 3.5.1, 4.1.2).' },
        { id: 'show-usage-notice', kind: 'notice', description: 'Show any ai_usage_notice the tool returns word for word, as plain text.' },
      ],
    },
    allowed('cache-source-content', '3.2.5 forbids caching, archiving, mirroring or re-hosting without Mobbin’s written consent.'),
    allowed('save-private-unit', '3.2.5 treats saving retrieved content as archiving that needs Mobbin’s written consent.'),
    allowed('private-backup', '3.2.5 treats backups of retrieved content as archiving that needs Mobbin’s written consent.'),
    allowed('incorporate-project', '3.5 permits integration into your own proprietary products; 3.2.1 and 3.4.1 forbid derivatives without Mobbin’s written consent.'),
    allowed('reuse-private-project', '3.2.5 treats keeping retrieved content for reuse as archiving that needs Mobbin’s written consent.'),
    allowed('export-application', 'exporting the user’s own built app is not redistributing Mobbin content; 3.2.5 and 3.5.3 still forbid transferring Mobbin material itself.', 'finished-application'),
    allowed('derive-from-reference', '3.2.1 forbids derivative works, 3.4.1 AI-made derivatives and 3.4.2 model training or indexing without Mobbin’s written consent; 10.1.2 assigns derivatives to Mobbin.'),
    {
      operation: 'redistribute-unit', decision: 'blocked', scope: scope('reusable-distribution'), evidenceRefs: [MOBBIN_OWNER_DECISION_EVIDENCE, TERMS_REF], obligations: [],
      reason: 'Public redistribution is outside the private-use owner decision 2026-10-09. Terms metadata: 3.2.5 forbids transferring retrieved content; 3.5.1 and 3.5.3 forbid reselling access or building a substitute content repository.',
    },
  ],
});

/** Proxy-facing summary of the assessment above. */
export const MOBBIN_RIGHTS_SUMMARY = 'Owner decision 2026-10-09: private use allowed while licences are ignored (account risk on the owner\'s Mobbin account); public redistribution blocked. Terms 3.2.1, 3.2.5 and 3.4 kept as metadata.';
export const MOBBIN_ALLOWED_REASON = 'Live attributed view through your own Mobbin binding (3.5): credit Mobbin and the app, store nothing (3.2.5).';
export const MOBBIN_UNASSESSED_REASON = 'Not covered by the G29 RightsAssessment or the owner decision 2026-10-09.';

export const MOBBIN_BINDING_STEPS: readonly string[] = Object.freeze([
  `Add the official Mobbin MCP server (${MOBBIN_MCP_URL}, Streamable HTTP, OAuth) in Settings → External MCP → Add server, with server id "${MOBBIN_SERVER_ID}".`,
  `Connect it with your own Mobbin Pro or Team account through the daemon's OAuth sign-in (Connect on that server, or POST /api/mcp/oauth/start with serverId "${MOBBIN_SERVER_ID}").`,
  'A Mobbin login held by Claude Code, Codex or another agent\'s own MCP configuration is not shared with the daemon and is never copied. An agent run that holds such a login can still search Mobbin for attributed references.',
]);
