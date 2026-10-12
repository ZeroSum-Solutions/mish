import { createHash } from 'node:crypto';
import {
  parseConnectorInventory, parseIntegrationRoster,
  type ConnectorInventory, type IntegrationRoster, type IntegrationRosterEntry, type LicenceRecordSnapshot,
} from '@open-design/contracts';
import { ALL_INTEGRATION_ROWS, ROSTER_EXCLUSIONS, ROSTER_KNOWN_GAPS, USER_NAMED_SITE_IDS, type RosterRow } from './integration-roster-data.js';

export { USER_NAMED_SITE_IDS };
/** The subset of a daemon MCP server entry the roster reads. Never echoed back. */
export interface RosterMcpServer {
  id: string; enabled: boolean; label?: string; templateId?: string; url?: string;
  command?: string; args?: string[]; headers?: Record<string, string>; env?: Record<string, string>;
}

const LICENCE_RECORD_RECEIPT = 'Licence record (holder and held terms version) entered in Settings';
const TERMS_EVIDENCE_RECEIPT = 'Held terms evidence digest with cited clauses';
const UNREADABLE_RECEIPT = 'The stored licence record is unreadable; re-enter it in Settings';

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
/** Digest of the curated rows, gaps and exclusions only, so live binding and licence state do not change it. */
export const integrationRosterDigest = (): string => createHash('sha256').update(canonical([ALL_INTEGRATION_ROWS, ROSTER_KNOWN_GAPS, ROSTER_EXCLUSIONS]), 'utf8').digest('hex');

function host(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}
export function matchingRosterServers(row: RosterRow, servers: readonly RosterMcpServer[]): RosterMcpServer[] {
  const match = row.daemonMatch;
  if (!match) return [];
  return servers.filter(server => {
    const names = [server.id, server.label ?? ""].map(name => name.toLowerCase());
    const serverHost = host(server.url);
    const launch = [...(server.args ?? []), server.url ?? ""].map(value => value.toLowerCase());
    return (server.templateId !== undefined && match.templateIds.includes(server.templateId))
      || match.idPatterns.some(pattern => names.some(name => name.includes(pattern)))
      || match.argPatterns.some(pattern => launch.some(value => value.includes(pattern)))
      || (serverHost !== null && match.hosts.some(candidate => serverHost === candidate || serverHost.endsWith(`.${candidate}`)));
  });
}
function daemonBinding(row: RosterRow, servers: readonly RosterMcpServer[]): IntegrationRosterEntry['daemonBinding'] {
  const match = row.daemonMatch;
  if (!match) return 'not-applicable';
  const matching = matchingRosterServers(row, servers);
  if (matching.some(server => server.enabled)) return 'enabled';
  return matching.length ? 'disabled' : 'not-configured';
}

/** React Bits: the owner's licence record names the principal; until then the receipt is pending. */
function withLicence(entry: IntegrationRosterEntry, licence: LicenceRecordSnapshot | undefined): IntegrationRosterEntry {
  if (entry.id !== 'react-bits') return entry;
  const record = licence?.record ?? null;
  const missing = [
    ...(licence?.recordState === 'unreadable' ? [UNREADABLE_RECEIPT] : record ? [] : [LICENCE_RECORD_RECEIPT]),
    ...(record?.termsEvidence ? [] : [TERMS_EVIDENCE_RECEIPT]),
  ];
  return {
    ...entry,
    account: { ...entry.account, principal: record?.holder ?? null },
    pendingReceipts: [...missing, ...entry.pendingReceipts],
  };
}

export function buildIntegrationRoster(input: { mcpServers: readonly RosterMcpServer[]; licences: readonly LicenceRecordSnapshot[]; now?: Date }): IntegrationRoster {
  const licence = input.licences.find(item => item.sourceId === 'react-bits');
  const entries = ALL_INTEGRATION_ROWS.map(row => {
    const { daemonMatch: _match, ...entry } = row;
    return withLicence({ ...entry, daemonBinding: daemonBinding(row, input.mcpServers), runtime: {
      installed: entry.installState.state === 'bundled' ? 'installed' : 'not-required', connection: 'missing',
      accountLabel: null, version: entry.version.value, reason: 'No live connection check yet.',
      fix: { label: 'Review integration setup', url: entry.urls[0] ?? null, command: null },
      workflow: { lastSuccess: null, lastTest: null },
    } }, licence);
  });
  return parseIntegrationRoster({
    schema: 'integration-roster/1', rosterDigest: integrationRosterDigest(), generatedAt: (input.now ?? new Date()).toISOString(),
    entries, licences: [...input.licences], knownGaps: [...ROSTER_KNOWN_GAPS], exclusions: ROSTER_EXCLUSIONS.map(item => ({ ...item })),
  });
}

/** AC-R12.1 view: one decision record per evaluated site, every user-named site included. */
export function buildConnectorInventory(roster: IntegrationRoster): ConnectorInventory {
  const sites = roster.entries.flatMap(entry => entry.siteEvaluation
    ? [{ entryId: entry.id, name: entry.name, urls: entry.urls, readiness: entry.readiness, operations: entry.operations, ...entry.siteEvaluation }]
    : []);
  const missing = USER_NAMED_SITE_IDS.filter(id => !sites.some(site => site.entryId === id));
  if (missing.length) throw new Error(`Named sites lack a recorded decision: ${missing.join(', ')}`);
  return parseConnectorInventory({ schema: 'connector-inventory/1', rosterDigest: roster.rosterDigest, sites, exclusions: roster.exclusions });
}
