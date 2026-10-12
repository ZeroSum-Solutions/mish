import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { escapeTranscriptRoleDelimiters, sanitizePriorAssistantTurnForTranscript, type SessionRunAdmission } from '@mish/contracts';
import { getMessage, userRequestBeforeAssistantMessage } from '../db.js';
import { scrubDsmlToolProtocolTail } from '../artifacts/text-suppression.js';
import { normalizeRunContextSelection, renderRunContextPrompt } from '../runtimes/chat-run-context.js';
import { resolveSafeProjectAttachments, normalizeCommentAttachments, renderCommentAttachmentHint } from '../runtimes/chat-prompt-inputs.js';
import { AdmissionError, executionIdentitiesEqual, readRunAdmission, type PreparedAdmission } from './admission.js';
import { budgetSerializedReplay } from './replay-budget.js';

export interface AdmittedPublicInput {
  prompt: string; currentPromptPresent: boolean; attachmentRefs: string[];
  publicContext?: string; replay?: string; freshLockedText?: string;
}
export function readAdmittedPublicInput(db: Database.Database, runId: string): AdmittedPublicInput | null {
  const row = db.prepare('SELECT input_json FROM session_run_admissions WHERE run_id=?').get(runId) as { input_json: string | null } | undefined;
  if (!row?.input_json) return null;
  const value = JSON.parse(row.input_json) as AdmittedPublicInput;
  return typeof value.prompt === 'string' && Array.isArray(value.attachmentRefs) ? value : null;
}
export interface ReplaySourceRun {
  id: string; projectId: string | null; conversationId: string | null;
  assistantMessageId: string | null; status: string;
}
export function authorizeContinuationSource(db: Database.Database, projectId: string, sessionId: string, sourceId: unknown, lockedSourceId: string | null | undefined, getRun?: (id: string) => ReplaySourceRun | null): { runId: string; input: AdmittedPublicInput } | null {
  if (sourceId === undefined && !lockedSourceId) return null;
  if (sourceId !== undefined && (typeof sourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(sourceId))) throw new AdmissionError('VALIDATION_FAILED', 'Pass a valid authorized continuation source run');
  if (sourceId !== undefined && lockedSourceId && sourceId !== lockedSourceId) throw new AdmissionError('VALIDATION_FAILED', 'Continuation source must match the locked task source');
  const runId = (sourceId ?? lockedSourceId) as string;
  const run = getRun?.(runId);
  if (!run || run.projectId !== projectId || run.conversationId !== sessionId || !['failed','canceled','succeeded'].includes(run.status) || !run.assistantMessageId) throw new AdmissionError('VALIDATION_FAILED', 'Continuation source is unavailable in this project conversation');
  const message = getMessage(db, run.assistantMessageId);
  if (!db.prepare("SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND role='assistant' AND run_id=?").get(run.assistantMessageId, sessionId, runId) || !message || message.role !== 'assistant' || message.runId !== runId) throw new AdmissionError('VALIDATION_FAILED', 'Continuation source message linkage is unavailable');
  const admitted = readRunAdmission(db, runId);
  if (admitted && (admitted.projectId !== projectId || admitted.sessionId !== sessionId)) throw new AdmissionError('VALIDATION_FAILED', 'Continuation source scope is unavailable');
  const persisted = readAdmittedPublicInput(db, runId);
  const prompt = persisted?.prompt ?? userRequestBeforeAssistantMessage(db, sessionId, run.assistantMessageId);
  if (prompt === null) throw new AdmissionError('VALIDATION_FAILED', 'Continuation source original input is unavailable');
  return { runId, input: persisted ?? { prompt, currentPromptPresent: false, attachmentRefs: [] } };
}
function publicContext(body: Record<string, unknown>): string {
  const selected = normalizeRunContextSelection(body.context);
  // Replay includes accepted public selections, never private terminal output,
  // connector credentials, provider settings, or arbitrary object extensions.
  return JSON.stringify({ ...selected, workspaceItems: selected.workspaceItems?.map(item => ({ id: item.id, kind: item.kind, label: item.label, ...(item.path ? { path: item.path } : {}) })) });
}
function escapePublicReplay(text: string): string {
  // Neutralize the CDATA terminator before applying the replay budget. The
  // exact locked Turn serializer then preserves this segment byte-for-byte.
  return escapeTranscriptRoleDelimiters(text).replaceAll(']]>', ']]\\>');
}
function boundedSection(label: string, text: string, bytes: number): { text: string; truncated: boolean; omittedBytes: number } {
  if (!text) return { text: '', truncated: false, omittedBytes: 0 };
  const original = `### ${label}\n${escapePublicReplay(text)}\n`;
  const bounded = budgetSerializedReplay(original, { byteLimit: bytes });
  return { text: bounded.replay ?? '', truncated: bounded.status !== 'unchanged', omittedBytes: bounded.omittedBytes };
}
/** Only accepts daemon-authorized source records and public message projections. */
export function prepareAuthorizedReplay(input: {
  db: Database.Database; prepared: PreparedAdmission; body: Record<string, unknown>;
  projectRoot?: string | null; projectMetadata?: unknown; source: ReturnType<typeof authorizeContinuationSource>;
  contextWindowTokens?: number | null; outputReserveTokens?: number | null;
  /** Exact mandatory locked input, excluding the bounded replay slot. */
  mandatoryInputText?: string;
}) {
  const { db, prepared, body } = input;
  const present = Object.prototype.hasOwnProperty.call(body, 'currentPrompt');
  if (present && typeof body.currentPrompt !== 'string') throw new AdmissionError('VALIDATION_FAILED', 'currentPrompt must be a string when present');
  const prompt = present ? body.currentPrompt as string : typeof body.message === 'string' ? body.message : '';
  const attachments = resolveSafeProjectAttachments(input.projectRoot, Array.isArray(body.attachments) ? body.attachments.filter((item): item is string => typeof item === 'string') : []);
  const context = publicContext(body);
  const originalInput: AdmittedPublicInput = { prompt, currentPromptPresent: present, attachmentRefs: attachments, publicContext: context };
  const currentTransportEstimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify({ prompt: input.mandatoryInputText ?? prompt, systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : '', context: renderRunContextPrompt(body.context, input.projectMetadata), attachments, comments: renderCommentAttachmentHint(normalizeCommentAttachments(Array.isArray(body.commentAttachments) ? body.commentAttachments as Parameters<typeof normalizeCommentAttachments>[0] : [])), imageReferences: Array.isArray(body.imagePaths) ? body.imagePaths.filter(item => typeof item === 'string') : [] }), 'utf8') / 3);
  const contextWindowTokens = input.contextWindowTokens ?? null;
  const outputReserveTokens = input.outputReserveTokens ?? null;
  const estimatedReplayAllowance = contextWindowTokens === null ? null : contextWindowTokens - (outputReserveTokens ?? 0) - currentTransportEstimatedTokens;
  if (estimatedReplayAllowance !== null && estimatedReplayAllowance < 0) throw new AdmissionError('VALIDATION_FAILED', 'Mandatory current input exceeds the declared route estimate allowance; shorten it and submit again');
  prepared.facts.routeBudget = { contextWindowTokens, outputReserveTokens, currentTransportEstimatedTokens, estimatedReplayAllowance, hiddenEnvelopeConfidence: 'unverified' };
  prepared.originalInput = originalInput;
  const eligible = "conversation_id=? AND role IN ('user','assistant') AND (role='user' OR run_status IN ('succeeded','failed','canceled') OR ended_at IS NOT NULL) AND id<>?";
  const excluded = typeof body.userMessageId === 'string' ? body.userMessageId : '';
  const hasPriorPublicMessage = db.prepare(`SELECT 1 FROM messages WHERE ${eligible} LIMIT 1`).get(prepared.sessionId, excluded);
  // Legacy conversations predate admission cursors; their persisted public turns
  // are still authorized history. A current draft and in-flight reply are not.
  if (!prepared.cursor.runId && !input.source && !hasPriorPublicMessage) return { message: prompt, priorTranscript: '', currentPrompt: prompt };
  const first = db.prepare('SELECT run_id FROM session_run_admissions WHERE conversation_id=? AND input_json IS NOT NULL ORDER BY rowid LIMIT 1').get(prepared.sessionId) as { run_id: string } | undefined;
  const brief = first ? readAdmittedPublicInput(db, first.run_id)?.prompt ?? '' : '';
  const originalBrief = boundedSection('Original brief', brief, 4000);
  const anchor = boundedSection('Authorized continuation source request', input.source?.input.prompt ?? '', 3000);
  const acceptedContext = boundedSection('Accepted public context', context === '{}' ? '' : context, 1500);
  const allRefs = [...new Set([...attachments, ...resolveSafeProjectAttachments(input.projectRoot, input.source?.input.attachmentRefs ?? [])])];
  const refs = boundedSection('Authorized attachment references', allRefs.join('\n'), 1500);
  const total = Number((db.prepare(`SELECT count(*) n FROM messages WHERE ${eligible}`).get(prepared.sessionId, excluded) as { n: number }).n);
  const rows = db.prepare(`SELECT id,role,position FROM messages WHERE ${eligible} ORDER BY position DESC LIMIT 30`).all(prepared.sessionId, excluded) as { id: string; role: string; position: number }[];
  const blocks = rows.reverse().map((row, index) => {
    const message = getMessage(db, row.id);
    const content = typeof message?.content === 'string' ? message.content : '';
    const visible = row.role === 'assistant' ? sanitizePriorAssistantTurnForTranscript(scrubDsmlToolProtocolTail(content)) : content;
    const toolNames = row.role === 'assistant' && Array.isArray(message?.events) ? [...new Set(message.events.filter(event => event.kind === 'tool_use' && typeof event.name === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/u.test(event.name)).map(event => event.name))].slice(0, 10) : [];
    return { ordinal: total - rows.length + index + 1, text: `[Public message #${total - rows.length + index + 1}]\n## ${row.role}\n${escapePublicReplay(visible)}${toolNames.length ? `\n[Tools used: ${toolNames.join(', ')}]` : ''}\n` };
  });
  const serialized = [originalBrief.text, anchor.text, acceptedContext.text, refs.text, ...blocks.map(block => block.text)].filter(Boolean).join('\n');
  const budget = budgetSerializedReplay(serialized, { estimatedTokenAllowance: estimatedReplayAllowance });
  if (budget.status === 'invalid-budget') throw new AdmissionError('VALIDATION_FAILED', 'Replay allowance is invalid');
  const replay = budget.replay ?? '';
  const included = blocks.filter(block => replay.includes(block.text)).map(block => block.ordinal);
  const omitted = total - included.length;
  const omittedRanges: { first: number; last: number }[] = [];
  if (omitted) {
    // Head/tail replay retains an envelope. At most two ranges are projected;
    // counts remain exact even when partial blocks fall inside that envelope.
    let first = 1; let last = total;
    while (included.includes(first)) first++;
    while (included.includes(last)) last--;
    omittedRanges.push({ first, last });
  }
  const changed = prepared.cursor.admission !== null && !executionIdentitiesEqual(prepared.cursor.admission, prepared.facts);
  prepared.facts.replayNotice = {
    version: 1, reason: changed ? 'model-switch' : input.source ? 'fresh-continuation' : 'stateless-replay',
    from: prepared.cursor.admission ? { choice: prepared.cursor.admission.requested, effectiveModel: prepared.cursor.admission.effectiveModel } : null,
    to: { choice: prepared.facts.requested, effectiveModel: prepared.facts.effectiveModel }, selectionSource: prepared.facts.selectionSource, selectionRevision: prepared.facts.selectionRevision, sourceRunId: input.source?.runId ?? null,
    includedMessages: included.length, omittedMessages: omitted, omittedRanges,
    mandatoryTruncation: { brief: originalBrief.truncated || Boolean(originalBrief.text && !replay.includes(originalBrief.text)), anchor: anchor.truncated || Boolean(anchor.text && !replay.includes(anchor.text)), context: acceptedContext.truncated || Boolean(acceptedContext.text && !replay.includes(acceptedContext.text)) },
    attachmentCount: allRefs.length, digest: createHash('sha256').update(replay).digest('hex'), bytes: budget.bytes, byteLimit: budget.byteLimit!, omittedBytes: budget.omittedBytes + originalBrief.omittedBytes + anchor.omittedBytes + acceptedContext.omittedBytes + refs.omittedBytes,
    actualReplayTokens: null, estimatedReplayTokens: budget.estimatedReplayTokens, estimatedTokenAllowance: budget.estimatedTokenAllowance, tokenEstimateMethod: budget.tokenEstimateMethod, remainingBudgetConfidence: budget.remainingBudgetConfidence, budgetConfidence: budget.budgetConfidence as 'byte-bound-only' | 'byte-and-estimate-bound', status: budget.status,
  };
  originalInput.replay = replay;
  return { currentPrompt: prompt, message: [replay, `## user\n${escapeTranscriptRoleDelimiters(prompt)}`].filter(Boolean).join('\n\n'), priorTranscript: replay };
}
