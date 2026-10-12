import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseComponentLedgerReport,
  type ComponentLedger, type ComponentLedgerReport, type ComponentLedgerReportEntry,
} from '@open-design/contracts';
import type { PackRegistry, ResolvedPackContent } from '../packs/registry.js';
import { genuiComponentDigest } from './component-ledger-digest.js';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pack component metadata');
  return value as JsonObject;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing pack component identity');
  return value;
}

function implementationPresent(registry: PackRegistry, content: Pick<ResolvedPackContent, 'files' | 'packId' | 'path'>, item: JsonObject): boolean {
  if (item.status !== 'ported' || typeof item.entry !== 'string') return false;
  const paths = [item.entry, item.css].filter((file): file is string => typeof file === 'string');
  const files = registry.get(content.packId)!.manifest!.files;
  return paths.every(file => {
    const root = content.path.endsWith('.json') ? path.posix.dirname(content.path) : content.path;
    const relative = `${root}/${file}`;
    const listed = files.find(candidate => candidate.path === relative);
    const resolved = registry.resolvePath(content.packId, relative);
    if (!listed || !resolved) return false;
    const bytes = readFileSync(resolved);
    return bytes.length === listed.bytes && createHash('sha256').update(bytes).digest('hex') === listed.sha256;
  });
}

/** Only manifest-listed, contained, digest-matching metadata is admitted. */
function readMetadata(registry: PackRegistry, content: Pick<ResolvedPackContent, 'files' | 'packId'>, relative: string): unknown {
  const listed = content.files.find(file => file.path === relative);
  const resolved = registry.resolvePath(content.packId, relative);
  if (!listed || !resolved) throw new Error(`Pack ${content.packId} component metadata is unavailable`);
  const bytes = readFileSync(resolved);
  if (bytes.length > 8 * 1024 * 1024) throw new Error(`Pack ${content.packId} component metadata is too large`);
  if (bytes.length !== listed.bytes || createHash('sha256').update(bytes).digest('hex') !== listed.sha256) {
    throw new Error(`Pack ${content.packId} component metadata has changed`);
  }
  return JSON.parse(bytes.toString('utf8'));
}

function packEntries(registry: PackRegistry): ComponentLedgerReportEntry[] {
  const result: ComponentLedgerReportEntry[] = [];
  for (const pack of registry.list()) {
    if (pack.status === 'damaged') throw new Error(`Pack ${pack.id} is damaged; component inventory is unavailable`);
  }
  for (const kind of ['component-kit', 'cult-catalog', 'genui-overlay'] as const) {
    for (const content of registry.contents(kind)) {
      const pack = registry.get(content.packId)!;
      let items: unknown[];
      if (kind === 'component-kit') {
        items = content.files.filter(file => file.path.startsWith(`${content.path}/registry/`) && file.path.endsWith('.json'))
          .map(file => ({ ...object(readMetadata(registry, content, file.path)), ledgerDigest: file.sha256 }));
      } else {
        const catalogPath = content.path.endsWith('.json') ? content.path : `${content.path}/catalog.json`;
        const catalog = object(readMetadata(registry, content, catalogPath));
        const listing = kind === 'cult-catalog' ? catalog.rows : catalog.components;
        if (!Array.isArray(listing)) throw new Error(`Pack ${pack.id} has no component listing`);
        items = listing;
      }
      if (!items.length) throw new Error(`Pack ${pack.id} has an empty component listing`);
      for (const raw of items) {
        const item = object(raw);
        const sourceId = kind === 'genui-overlay' ? 'genui' : 'cult';
        const itemId = string(item.id ?? item.name).replace(new RegExp(`^${sourceId}:`), '');
        const source = item.source ? object(item.source) : null;
        const root = content.path.endsWith('.json') ? path.posix.dirname(content.path) : content.path;
        const genuiFiles = [item.entry, item.css, item.demo].filter((file): file is string => typeof file === 'string')
          .map(file => [file, pack.manifest!.files.find(listed => listed.path === `${root}/${file}`)?.sha256 ?? null] as const);
        const digest = kind === 'genui-overlay' ? genuiComponentDigest(item, genuiFiles) : typeof item.ledgerDigest === 'string' ? item.ledgerDigest :
          typeof source?.registrySha256 === 'string' && /^[a-f0-9]{64}$/.test(source.registrySha256) ? source.registrySha256 :
            createHash('sha256').update(JSON.stringify(item)).digest('hex');
        result.push({
          id: `${sourceId}:${itemId}`, sourceId, itemId, title: string(item.title ?? item.name ?? itemId), source: 'pack',
          rights: { license: 'licensed (pack-declared)', decision: pack.manifest!.licence.scope, implementationOrigin: 'licensed',
            evidence: pack.manifest!.licence.evidence.join('; ') || `pack:${pack.id}@${pack.version}` },
          licensed: true, built: kind === 'component-kit' ? Array.isArray(item.files) && item.files.length > 0 &&
            item.files.every(file => typeof object(file).content === 'string' && string(object(file).content).length > 0) :
            kind === 'genui-overlay' ? implementationPresent(registry, content, item) : false,
          tracked: true, installed: true, packId: pack.id,
          sourceVersion: { revision: `pack:${pack.id}@${pack.version}`, digest, pinned: true },
          disposition: 'repair-pending', verified: false, evidenceDate: null, evidence: [], errors: [],
        });
      }
    }
  }
  return result;
}

/** One generated, ID-keyed view of the committed ledger and the live installed-pack inventory.
 * Installation and licence flags never create repair evidence. No metadata is written here. */
export function buildComponentLedgerReport(ledger: ComponentLedger, registry?: PackRegistry): ComponentLedgerReport {
  const entries: ComponentLedgerReportEntry[] = ledger.rows.map(row => {
    const verified = row.built === true && row.disposition === 'repaired' && row.evidence.length > 0 &&
      row.evidence.every(item => item.recordedAt && item.sourceDigest === row.sourceVersion.digest);
    return {
      id: row.id, sourceId: row.sourceId, itemId: row.itemId, title: row.title, source: 'public-core', rights: row.rights,
      licensed: row.rights.implementationOrigin === 'licensed', built: row.built === true, tracked: true,
      installed: null, packId: null, sourceVersion: row.sourceVersion, disposition: row.disposition,
      verified, evidenceDate: verified ? row.evidence.map(item => item.recordedAt!).sort().at(-1)! : null,
      evidence: row.evidence, errors: [],
    };
  });
  if (registry) entries.push(...packEntries(registry));
  const components: Record<string, ComponentLedgerReportEntry> = Object.create(null);
  for (const entry of entries.sort((a, b) => a.id.localeCompare(b.id))) {
    // A GenUI overlay can carry exactly the licensed implementation already tracked in core.
    // Identity is never renamed to conceal different bytes or two providers.
    const prior = components[entry.id];
    if (prior) {
      if (prior.source === 'pack' && prior.packId === entry.packId && prior.sourceVersion.digest === entry.sourceVersion.digest) {
        components[entry.id] = { ...prior, built: prior.built || entry.built };
        continue;
      }
      if (prior.source !== 'public-core' || !prior.licensed || entry.sourceId !== 'genui' || prior.sourceVersion.digest !== entry.sourceVersion.digest) {
        // Name every conflicting pack, including the provider retained in this ID-keyed row.
        const packIds = new Set(prior.errors.map(error => error.packId));
        if (prior.packId) packIds.add(prior.packId);
        if (entry.packId) packIds.add(entry.packId);
        components[entry.id] = { ...prior, verified: false, evidenceDate: null,
          errors: [...packIds].map(packId => ({ code: 'duplicate-id', packId })) };
        continue;
      }
    }
    components[entry.id] = prior?.errors.length ? { ...entry, errors: prior.errors, verified: false, evidenceDate: null } : entry;
  }
  return parseComponentLedgerReport({ schema: 'component-ledger-report/1', frozenAt: ledger.frozenAt, components });
}
