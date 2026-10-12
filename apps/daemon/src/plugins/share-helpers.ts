import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { upsertMessage } from '../db.js';
import { emittedRenderableQuestionForm } from '../question-form-detect.js';
import { execGhBuffered } from '../services/login-shell.js';
import {
  detectSkillPluginCandidate,
  insertSkillPluginCandidate,
  listSkillPluginCandidates,
} from './index.js';

type JsonRecord = Record<string, unknown>;

export interface ProjectPluginManifest {
  name: string;
  title: string;
  version: string;
  manifest: JsonRecord;
}

export interface RunLike {
  id: string;
  projectId?: string | null;
  conversationId?: string | null;
  assistantMessageId?: string | null;
  agentId?: string | null;
  pluginId?: string | null;
  appliedPluginSnapshotId?: string | null;
}

export interface RunWaiter {
  wait(run: RunLike): Promise<{ status: string; cancelOrigin?: string | null }>;
}

export interface SkillPluginCandidateLike {
  id: string;
  projectId: string;
  conversationId?: string | null;
  status: string;
  assistantMessageId?: string | null;
  title?: string | null;
  description?: string | null;
  confidence?: number | null;
  draftPath?: string | null;
}

export interface SkillPluginCandidateInput {
  message?: string | null;
  currentPrompt?: string | null;
  attachments?: unknown;
}

export interface PluginSnapshotReader {
  (db: Database.Database, snapshotId: string): { pluginId?: string | null } | null | undefined;
}

export function renderPluginBriefTemplate(
  template: string | null | undefined,
  inputs: Record<string, string | number | boolean | null | undefined> = {},
): string {
  if (typeof template !== 'string' || template.length === 0) return '';
  return template.replace(/\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g, (full, key: string) => {
    if (!Object.hasOwn(inputs, key)) return full;
    const value = inputs[key];
    if (value === undefined || value === null || value === '') return full;
    return String(value);
  });
}

export async function readProjectPluginManifest(folder: string): Promise<ProjectPluginManifest> {
  const raw = await fs.promises.readFile(path.join(folder, 'mish.json'), 'utf8');
  const manifest = parseJsonObject(raw);
  const name = typeof manifest.name === 'string' && manifest.name.trim()
    ? manifest.name.trim()
    : path.basename(folder);
  if (/[/\\]/.test(name) || /^\.+$/.test(name)) {
    throw new Error(
      `mish.json in ${folder}: name "${name}" must not contain path separators or consist only of dots`,
    );
  }
  return {
    name,
    title: typeof manifest.title === 'string' ? manifest.title : name,
    version: typeof manifest.version === 'string' ? manifest.version : '0.1.0',
    manifest,
  };
}

export const __forTestReadProjectPluginManifest = readProjectPluginManifest;

export async function ensureGhReady(): Promise<
  | { ok: true; log: string[] }
  | { ok: false; code: string; message: string; url: string; log: string[] }
> {
  const version = await execGhBuffered(['--version'], { timeout: 10_000 });
  if (!version.ok) {
    return {
      ok: false,
      code: 'gh-not-installed',
      message: 'GitHub CLI is not installed. Install it, then click this action again.',
      url: 'https://cli.github.com/',
      log: [version.stderr || version.stdout || 'gh --version failed'],
    };
  }
  const auth = await execGhBuffered(['auth', 'status', '--hostname', 'github.com'], { timeout: 10_000 });
  if (!auth.ok) {
    return {
      ok: false,
      code: 'gh-not-authenticated',
      message: 'GitHub CLI is installed but not authenticated. Run `gh auth login --web`, finish browser authorization, then click this action again.',
      url: 'https://github.com/login/device',
      log: [auth.stderr || auth.stdout || 'gh auth status failed'],
    };
  }
  return { ok: true, log: [version.stdout, auth.stderr || auth.stdout].filter(Boolean) };
}

export function reconcileAssistantMessageOnRunEnd(
  db: Database.Database,
  runs: RunWaiter,
  run: RunLike,
): void {
  if (!run.assistantMessageId) return;
  void runs
    .wait(run)
    .then((finalStatus) => {
      db.prepare(
        `UPDATE messages
            SET run_status = ?, ended_at = COALESCE(ended_at, ?)
          WHERE id = ? AND run_status IN ('queued', 'running')`,
      ).run(finalStatus.status, Date.now(), run.assistantMessageId);
      // Who cancelled, recorded separately from the status latch above.
      // The latch only fires while the row is still queued/running, and the
      // client often writes `canceled` first (it stops its own stream); the
      // origin would then never land. It is written unconditionally for a
      // cancelled run because it is the daemon's own answer to a question the
      // client cannot answer for itself — `runStatus: 'canceled'` alone cannot
      // tell a user's Stop from a shutdown or project cleanup, and the pause
      // line in chat treats `user_stop` as proof.
      if (finalStatus.status === 'canceled' && finalStatus.cancelOrigin) {
        db.prepare(`UPDATE messages SET cancel_origin = ? WHERE id = ?`).run(
          finalStatus.cancelOrigin,
          run.assistantMessageId,
        );
      }
    })
    .catch((err: Error) => {
      console.warn('[runs] message reconciliation failed', err);
    });
}

export function isPluginAuthoringRun(
  db: Database.Database,
  run: RunLike | null | undefined,
  getSnapshot: PluginSnapshotReader,
): boolean {
  if (run?.pluginId === 'od-plugin-authoring') return true;
  if (
    typeof run?.appliedPluginSnapshotId === 'string'
    && run.appliedPluginSnapshotId.length > 0
  ) {
    const snapshot = getSnapshot(db, run.appliedPluginSnapshotId);
    return snapshot?.pluginId === 'od-plugin-authoring';
  }
  return false;
}

export async function hasGeneratedPluginArtifacts(projectRoot: string | null | undefined): Promise<boolean> {
  if (!projectRoot || typeof projectRoot !== 'string') return false;
  const required = [
    path.join(projectRoot, 'generated-plugin', 'mish.json'),
    path.join(projectRoot, 'generated-plugin', 'SKILL.md'),
  ];
  try {
    await Promise.all(required.map((file) => fs.promises.access(file, fs.constants.F_OK)));
    return true;
  } catch {
    return false;
  }
}

function assistantMessageEmittedQuestionForm(
  db: Database.Database,
  assistantMessageId: string | null | undefined,
): boolean {
  if (!assistantMessageId) return false;
  const row = db.prepare(`SELECT content FROM messages WHERE id = ?`).get(assistantMessageId) as { content?: string | null } | undefined;
  return emittedRenderableQuestionForm(row?.content);
}

function deferredSkillPluginCandidateForRun(
  db: Database.Database,
  run: RunLike,
): SkillPluginCandidateLike | null {
  if (!run.projectId || !run.conversationId) return null;
  return (listSkillPluginCandidates(db, run.projectId) as SkillPluginCandidateLike[])
    .find((candidate) =>
      candidate.status !== 'dismissed' &&
      !candidate.assistantMessageId &&
      candidate.conversationId === run.conversationId,
    ) ?? null;
}

export function detectSkillPluginCandidateOnRunSuccess(
  db: Database.Database,
  runs: RunWaiter,
  run: RunLike,
  input: SkillPluginCandidateInput | null | undefined,
  projectRoot: string,
): void {
  if (!run.projectId || !run.conversationId) return;
  const projectId = run.projectId;
  const conversationId = run.conversationId;
  void runs
    .wait(run)
    .then(async (finalStatus) => {
      if (finalStatus.status !== 'succeeded') return;
      const pausedForQuestion = assistantMessageEmittedQuestionForm(db, run.assistantMessageId);
      const message = input?.message ?? input?.currentPrompt;
      const detected = await detectSkillPluginCandidate({
        projectId,
        runId: run.id,
        conversationId,
        assistantMessageId: null,
        ...(message !== undefined ? { message } : {}),
        ...(input?.attachments !== undefined ? { attachments: input.attachments } : {}),
        projectRoot,
      });
      const candidate = detected ? insertSkillPluginCandidate(db, detected) as SkillPluginCandidateLike : null;
      if (pausedForQuestion) return;
      const candidateToShow = candidate ?? deferredSkillPluginCandidateForRun(db, run);
      if (!candidateToShow || candidateToShow.status === 'dismissed') return;
      upsertSkillPluginCandidateAssistantMessage(db, run, candidateToShow);
    })
    .catch((err: Error) => {
      console.warn('[plugins] skill candidate detection failed', err);
    });
}

export function upsertSkillPluginCandidateAssistantMessage(
  db: Database.Database,
  run: RunLike,
  candidate: SkillPluginCandidateLike,
): string | null {
  if (!run.conversationId) return null;
  const currentMessagePosition = run.assistantMessageId
    ? ((db.prepare(`SELECT position FROM messages WHERE id = ?`).get(run.assistantMessageId) as { position?: number | null } | undefined)?.position ?? null)
    : null;
  const existingMessagePosition = candidate.assistantMessageId
    ? ((db.prepare(`SELECT position FROM messages WHERE id = ?`).get(candidate.assistantMessageId) as { position?: number | null } | undefined)?.position ?? null)
    : null;
  if (
    typeof currentMessagePosition === 'number' &&
    typeof existingMessagePosition === 'number' &&
    existingMessagePosition > currentMessagePosition
  ) {
    return null;
  }
  const canReuseExistingMessage = Boolean(
    candidate.assistantMessageId &&
    candidate.assistantMessageId !== run.assistantMessageId &&
    typeof existingMessagePosition === 'number',
  );
  const messageId = canReuseExistingMessage ? candidate.assistantMessageId as string : randomUUID();
  const shouldMoveReusedMessage =
    canReuseExistingMessage &&
    typeof currentMessagePosition === 'number' &&
    typeof existingMessagePosition === 'number' &&
    existingMessagePosition <= currentMessagePosition;
  if (
    candidate.assistantMessageId &&
    candidate.assistantMessageId !== messageId &&
    candidate.assistantMessageId !== run.assistantMessageId
  ) {
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(candidate.assistantMessageId);
  }
  const now = Date.now();
  upsertMessage(db, run.conversationId, {
    id: messageId,
    role: 'assistant',
    content: `Mishh Mashh found reusable skill material that can become a plugin: ${candidate.title}`,
    events: [{
      kind: 'plugin_candidate',
      candidateId: candidate.id,
      title: candidate.title,
      description: candidate.description,
      confidence: candidate.confidence,
      draftPath: candidate.draftPath ?? null,
    }],
    createdAt: now,
    endedAt: now,
    ...(run.agentId ? { agentId: run.agentId } : {}),
  });
  if (shouldMoveReusedMessage) {
    const max = (db
      .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM messages WHERE conversation_id = ?`)
      .get(run.conversationId) as { m?: number | null } | undefined)?.m ?? -1;
    db.prepare(`UPDATE messages SET position = ? WHERE id = ?`).run(Number(max) + 1, messageId);
  }
  db.prepare(
    `UPDATE skill_plugin_candidates
        SET assistant_message_id = ?, updated_at = ?
      WHERE id = ?`,
  ).run(messageId, now, candidate.id);
  return messageId;
}

function parseJsonObject(raw: string): JsonRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as JsonRecord;
  }
  return {};
}
