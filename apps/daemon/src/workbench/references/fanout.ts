import { createHash } from 'node:crypto';
import {
  REFERENCE_SOURCES, parseConnectorSearchResponse, parseReferenceFanoutRequest, parseReferenceFanoutResponse,
  type ConnectorSearchRequest, type ConnectorSearchResponse, type FanoutReference, type ReferenceFanoutResponse, type ReferenceSection,
} from '@mish/contracts';
import { ConnectorError } from '../connectors/connector-error.js';
import { mayUseOwnerSeatConnector } from '../connectors/connector-references.js';
import { untilAborted } from './abort.js';
import { mobbinWeight, referenceSections, sectionQuery } from './sections.js';

export interface ReferenceJudgment { id: string; relevance: number; sectionFit: number; evidence: number }
export interface ReferenceJudgeCandidate { id: string; title: string; source: string; sections: string[] }
export interface ReferenceJudgeInput { brief: string; candidates: ReferenceJudgeCandidate[] }
export interface ReferenceJudgeOptions { signal: AbortSignal; onBatch?: (judgments: ReferenceJudgment[]) => void }
export type ReferenceJudge = (input: ReferenceJudgeInput, options: ReferenceJudgeOptions) => Promise<ReferenceJudgment[]>;
export interface ReferenceFanoutDeps {
  search: (source: (typeof REFERENCE_SOURCES)[number], request: ConnectorSearchRequest, options: { signal: AbortSignal }) => Promise<ConnectorSearchResponse>;
  judge?: ReferenceJudge;
  deadlineMs?: number;
}
function canonical(url: string): string {
  const parsed = new URL(url); parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/iu.test(key)) parsed.searchParams.delete(key);
  parsed.searchParams.sort(); parsed.pathname = parsed.pathname.replace(/\/$/u, '') || '/';
  return parsed.href;
}
const byRank = (a: FanoutReference, b: FanoutReference) => (b.score ?? 0) - (a.score ?? 0) || b.sourceWeight - a.sourceWeight || a.id.localeCompare(b.id);
/** Give each section one slot before filling the remaining slots by rank. No fabricated padding. */
function select(candidates: FanoutReference[], sections: ReferenceSection[], limit: number): FanoutReference[] {
  const sorted = [...candidates].sort(byRank), picked = new Set<string>();
  for (const section of sections) {
    if (picked.size >= limit) break;
    if (sorted.some(item => picked.has(item.id) && item.sectionIds.includes(section.id))) continue;
    const item = sorted.find(item => item.sectionIds.includes(section.id) && !picked.has(item.id));
    if (item) picked.add(item.id);
  }
  for (const item of sorted) { if (picked.size >= limit) break; picked.add(item.id); }
  return sorted.filter(item => picked.has(item.id));
}
function validateJudgments(value: unknown, candidates: FanoutReference[]): ReferenceJudgment[] {
  if (!Array.isArray(value) || value.length !== candidates.length) throw new Error('jev-invalid-response');
  const ids = new Set(candidates.map(item => item.id)), seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ids.has(item.id) || seen.has(item.id)) throw new Error('jev-invalid-response');
    seen.add(item.id);
    for (const key of ['relevance', 'sectionFit', 'evidence']) if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0 || item[key] > 1) throw new Error('jev-invalid-response');
  }
  return value as ReferenceJudgment[];
}

/** V04/B070/B065: bounded read-only discovery, source custody and typed Jev judgments only. */
export function createReferenceFanout(deps: ReferenceFanoutDeps) {
  const deadlineMs = deps.deadlineMs ?? 45_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000) throw new RangeError('Reference deadline must be 1–300000 ms');
  return {
    async fanout(input: unknown, context: { principalId: string; signal?: AbortSignal } = { principalId: 'local-daemon' }): Promise<ReferenceFanoutResponse> {
      let request;
      try { request = parseReferenceFanoutRequest(input); } catch { throw new ConnectorError(400, 'connector-request-invalid', 'Invalid reference fan-out request'); }
      let plan;
      try { plan = referenceSections(request); } catch { throw new ConnectorError(400, 'connector-request-invalid', 'No suggested sections remain; provide the intended page sections'); }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException('Reference deadline exceeded', 'TimeoutError')), deadlineMs);
      const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
      try {
        const sections = plan.sections.map(section => ({ ...section, query: sectionQuery(request.brief, section) }));
        const tasks = sections.flatMap(section => REFERENCE_SOURCES.map(source => ({ section, source })));
        const reports: ReferenceFanoutResponse['sources'] = new Array(tasks.length);
        const responses: Array<ConnectorSearchResponse | null> = new Array(tasks.length).fill(null);
        let next = 0;
        // Four searches at most; each connector retains its own timeout and retry bounds.
        await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
          while (next < tasks.length && !signal.aborted) {
            const index = next++, { section, source } = tasks[index]!;
            try {
              if (!mayUseOwnerSeatConnector(source, context.principalId)) throw new ConnectorError(403, 'connector-principal-forbidden', 'This connector requires the local owner principal');
              const mobile = /\b(ios|mobile app|iphone)\b/iu.test(request.brief);
              const response = parseConnectorSearchResponse(await untilAborted(signal, () => deps.search(source, { query: section.query, limit: 5,
                ...(source === 'refero' || mobile ? { kind: 'screens' as const, platform: mobile ? 'ios' as const : 'web' as const } : { kind: 'sections' as const }),
              }, { signal })));
              if (response.connectorId !== source || response.results.some(item => item.connectorId !== source)) throw new Error('source-mismatch');
              responses[index] = response;
              reports[index] = { source, sectionId: section.id, status: response.results.length ? 'ok' : 'empty', count: response.results.length, code: null, receipt: response.receipt, providerNotice: response.providerNotice ?? null };
            } catch (error) {
              reports[index] = { source, sectionId: section.id, status: 'unavailable', count: 0, code: signal.aborted ? 'connector-timeout' : error instanceof ConnectorError ? error.code : 'connector-unavailable', receipt: null, providerNotice: null };
            }
          }
        }));
        for (let index = 0; index < tasks.length; index++) {
          reports[index] ??= { source: tasks[index]!.source, sectionId: tasks[index]!.section.id, status: 'unavailable', count: 0, code: 'connector-timeout', receipt: null, providerNotice: null };
        }
        const pool = new Map<string, FanoutReference>();
        for (const [index, response] of responses.entries()) {
          const sectionId = tasks[index]!.section.id;
          for (const resource of response?.results.slice(0, 5) ?? []) {
            const key = canonical(resource.canonicalUrl), prior = pool.get(key);
            const sourceWeight = resource.connectorId === 'refero' ? 1 : mobbinWeight(request.brief, plan.spineCode);
            if (prior) {
              prior.sectionIds = [...new Set([...prior.sectionIds, sectionId])];
              if (sourceWeight > prior.sourceWeight) { prior.resource = resource; prior.rightsLabel = resource.rights.status; prior.sourceWeight = sourceWeight; }
            } else pool.set(key, { id: `ref_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`, resource, sectionIds: [sectionId], rightsLabel: resource.rights.status, sourceWeight, score: null,
              reasons: ['Found by a section query; relevance has not been judged.'] });
          }
        }
        let candidates = [...pool.values()];
        // No third-party processing grant means deterministic source/section/id order.
        const eligible = candidates.filter(item => item.resource.rights.operations.some(right => right.operation === 'derive-from-reference' && right.decision === 'allowed'));
        const eligibleIds = new Set(eligible.map(item => item.id));
        const excluded = candidates.length - eligible.length;
        candidates = candidates.map(item => eligibleIds.has(item.id) ? item : { ...item, reasons: ['Connector rights do not permit third-party processing; deterministic source weight, section coverage and reference ID ordering.'] });
        let ranking: ReferenceFanoutResponse['ranking'] = { status: candidates.length ? eligible.length ? 'unavailable' : 'deterministic' : 'empty', model: 'jev-latest', code: candidates.length ? eligible.length ? 'jev-unavailable' : 'jev-rights-excluded' : null };
        if (eligible.length && deps.judge && !signal.aborted) {
          const completed = new Map<string, ReferenceJudgment>();
          const onBatch = (value: ReferenceJudgment[]) => {
            if (signal.aborted) return;
            // A completed batch is atomic; duplicate/foreign/non-finite judgments are refused.
            const batchIds = new Set(value.map(item => item.id));
            const batch = eligible.filter(item => batchIds.has(item.id));
            const checked = validateJudgments(value, batch);
            if (checked.some(item => completed.has(item.id))) throw new Error('jev-invalid-response');
            for (const item of checked) completed.set(item.id, item);
          };
          try {
            const judgments = validateJudgments(await untilAborted(signal, () => deps.judge!({ brief: request.brief,
              candidates: eligible.map(item => ({ id: item.id, title: item.resource.title, source: item.resource.connectorId === 'refero' ? 'Refero' : 'Mobbin',
                sections: item.sectionIds.map(id => plan.sections.find(section => section.id === id)!.name) })),
            }, { signal, onBatch })), eligible);
            for (const item of judgments) completed.set(item.id, item);
            ranking = { status: 'ranked', model: 'jev-latest', code: excluded ? 'jev-rights-excluded' : null };
          } catch {
            // Only an overall timeout/cancellation may retain already validated batches.
            if (!signal.aborted) completed.clear();
            ranking = { status: signal.aborted ? 'partial' : 'unavailable', model: 'jev-latest', code: signal.aborted ? 'reference-deadline-exceeded' : 'jev-unavailable-or-invalid' };
          }
          candidates = candidates.map(item => {
            const judgment = completed.get(item.id);
            if (!judgment) return item;
            const score = Math.round(100 * item.sourceWeight * (0.6 * judgment.relevance + 0.3 * judgment.sectionFit + 0.1 * judgment.evidence));
            return { ...item, score, reasons: [
              `TypeSafe Jev typed judgments: brief relevance ${(judgment.relevance * 100).toFixed(0)}%, section fit ${(judgment.sectionFit * 100).toFixed(0)}%, metadata support ${(judgment.evidence * 100).toFixed(0)}%.`,
              item.resource.connectorId === 'refero' ? 'Refero is the primary source; only public title, source and section text was judged.' : `Mobbin source weight ${item.sourceWeight}: strongest for SaaS, mobile and commerce; sparse metadata is not visual proof.`,
            ] };
          });
        }
        if (signal.aborted) ranking = { status: 'partial', model: 'jev-latest', code: 'reference-deadline-exceeded' };
        return parseReferenceFanoutResponse({ schema: 'reference-fanout/1', spineCode: plan.spineCode, sectionBasis: plan.sectionBasis, sections, sources: reports,
          references: select(candidates, plan.sections, request.limit), ranking, candidateCount: pool.size,
          partial: signal.aborted,
          degraded: signal.aborted || reports.some(item => item.status !== 'ok') || ranking.status === 'unavailable',
        });
      } finally { clearTimeout(timer); }
    },
  };
}
export type ReferenceFanoutService = ReturnType<typeof createReferenceFanout>;
