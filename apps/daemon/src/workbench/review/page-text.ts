// Console, exception and log evidence. Page-originated text is never
// persisted: a message is a PageText whose only traces are its length and
// SHA-256 and a source location reduced by the run's serve log and allow-list
// (see evidence.ts). Findings cite records by id.
import { createHash } from 'node:crypto';
import type { ReviewConsoleEntry } from '@open-design/contracts';
import { consoleRef, digestParam, ev, evidenceLocation, vocab, type EvidenceContext, type EvidenceParam, type EvidenceText, type PageText } from './evidence.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export type ConsoleSource = NonNullable<ReviewConsoleEntry['source']>;
/** One distinct console/exception/log message as seen in one capture. */
export type ConsoleRecord = Omit<ReviewConsoleEntry, 'viewports'>;

/**
 * Where a message came from. The URL is page-chosen (a page can name its own
 * code with `//# sourceURL=`), so a project path is kept only for a file the
 * review served and an origin only when the run can vouch for it; the rest is
 * digests. CDP line and column numbers are 0-based, records are 1-based.
 */
export function consoleSource(url: PageText | null, line: unknown, column: unknown, context: EvidenceContext): ConsoleSource | null {
  if (!url || url.isBlank()) return null;
  const location = evidenceLocation(url, context);
  if (!location) return null;
  const position = { line: Math.max(0, Math.trunc(Number(line) || 0)) + 1, column: Math.max(0, Math.trunc(Number(column) || 0)) + 1 };
  return { origin: location.origin, originSha256: location.originSha256, path: location.path, pathQuerySha256: location.pathQuerySha256, ...position };
}

export function sourceText(source: ConsoleSource | null): EvidenceText {
  if (!source) return ev('console.unknownSource');
  // Built only from a vouched origin or digests, a served project path and numbers.
  const where: EvidenceParam = { kind: 'location', origin: source.origin, originSha256: source.originSha256, path: source.path, pathDepth: 0, pathDepthCapped: false, pathQuerySha256: source.pathQuerySha256, queryLength: 0, querySha256: null };
  return ev('console.source', where, source.line, source.column);
}

/** A record of one message; the id is stable for the same kind, text and source. */
export function consoleRecord(input: { kind: ConsoleRecord['kind']; text: PageText; source: ConsoleSource | null }): ConsoleRecord {
  const digest = input.text.sha256();
  const id = `console-${sha256(JSON.stringify([input.kind, digest, input.source])).slice(0, 12)}`;
  return { id, kind: input.kind, level: 'error', count: 1, length: input.text.length, sha256: digest, source: input.source };
}

export function describeConsoleRecord(record: ConsoleRecord): EvidenceText {
  const head = [vocab('consoleKind', record.kind), consoleRef(record.id), record.length, digestParam(record.sha256.slice(0, 12)), sourceText(record.source)] as const;
  return record.count > 1 ? ev('console.recordRepeated', ...head, record.count) : ev('console.record', ...head);
}

/** Folds repeated records (same id) into one with the summed count. */
export function foldConsoleRecords(records: Iterable<ConsoleRecord>): ConsoleRecord[] {
  const byId = new Map<string, ConsoleRecord>();
  for (const record of records) {
    const seen = byId.get(record.id);
    if (seen) seen.count += record.count; else byId.set(record.id, { ...record });
  }
  return [...byId.values()];
}
