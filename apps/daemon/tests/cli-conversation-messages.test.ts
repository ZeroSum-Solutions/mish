// AC-R02.2 (docs/plans/2026-10-02-design-workbench/prd.md): earlier messages
// must remain accessible in conversation API/CLI output. The CLI reads them
// through the same HTTP message route the web UI uses (dual-track rule in
// AGENTS.md), and `od conversation info` reads an existing project-scoped
// route instead of an unserved `/api/conversations/:id`.
import type http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import url from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI_SRC = path.join(__dirname, '../src/cli.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

type CliResult = { code: number | null; stdout: string; stderr: string };

describe('od conversation messages / info', () => {
  let server: http.Server;
  let baseUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;
  let projectId: string;
  let conversationId: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string; server: http.Server; shutdown?: () => Promise<void> | void;
    };
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
    const created = await api<{ project: { id: string }; conversationId: string }>('/api/projects', 'POST', {
      id: randomUUID(), name: 'CLI messages', skillId: null, designSystemId: null, metadata: { kind: 'prototype' }, pendingPrompt: null,
    });
    projectId = created.project.id;
    conversationId = created.conversationId;
    for (const [index, role] of (['user', 'assistant', 'user', 'assistant'] as const).entries()) {
      await api(`/api/projects/${projectId}/conversations/${conversationId}/messages/msg-${index}`, 'PUT', {
        id: `msg-${index}`, role, content: `MESSAGE_${index} ${role} content`, createdAt: 1_000 + index,
        ...(role === 'assistant' ? { runStatus: 'succeeded', endedAt: 1_000 + index } : {}),
      });
    }
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function api<T>(route: string, method: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${route}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  function runCli(args: string[]): Promise<CliResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, OD_DAEMON_URL: baseUrl };
    delete env.NODE_OPTIONS;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TSX_CLI, CLI_SRC, ...args], { cwd: path.join(__dirname, '..'), env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`CLI timed out: od ${args.join(' ')}`)); }, 20_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      child.stdin.end('');
    });
  }

  it('lists every message with --json exactly as the web message route returns them', async () => {
    const result = await runCli(['conversation', 'messages', projectId, conversationId, '--json']);
    expect(result.code, result.stderr).toBe(0);
    const viaHttp = await api<{ messages: unknown[] }>(`/api/projects/${projectId}/conversations/${conversationId}/messages`, 'GET');
    expect(JSON.parse(result.stdout)).toEqual(viaHttp);
    expect((JSON.parse(result.stdout) as { messages: Array<{ id: string }> }).messages.map(message => message.id))
      .toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3']);
  });

  it('prints one readable line per message without --json', async () => {
    const result = await runCli(['conversation', 'messages', projectId, conversationId]);
    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(4);
    for (const [index, line] of lines.entries()) {
      expect(line).toContain(`msg-${index}`);
      expect(line).toContain(`MESSAGE_${index}`);
    }
  });

  function lastError(result: CliResult): { error: { code: string } } {
    return JSON.parse(result.stderr.trim().split('\n').at(-1)!) as { error: { code: string } };
  }

  it('reports an unknown conversation as conversation-not-found with its own exit code', async () => {
    const result = await runCli(['conversation', 'messages', projectId, 'missing-conversation', '--json']);
    expect(lastError(result)).toMatchObject({ error: { code: 'conversation-not-found' } });
    expect(result.code).toBe(76);
  });

  it('reports an unknown project as project-not-found (exit 68), not as a missing daemon', async () => {
    const result = await runCli(['conversation', 'messages', 'missing-project', conversationId, '--json']);
    expect(lastError(result)).toMatchObject({ error: { code: 'project-not-found' } });
    expect(result.code).toBe(68);
  });

  it('strips control characters from the human-readable lines', async () => {
    const created = await api<{ conversation: { id: string } }>(`/api/projects/${projectId}/conversations`, 'POST', { title: 'Control characters' });
    await api(`/api/projects/${projectId}/conversations/${created.conversation.id}/messages/msg-ctl`, 'PUT', {
      id: 'msg-ctl', role: 'user', content: 'before\u001b[2J\u001b]0;title\u0007after\u0000end\u009b', createdAt: 1,
    });
    const result = await runCli(['conversation', 'messages', projectId, created.conversation.id]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('before');
    expect(result.stdout).toContain('after');
    expect(result.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
  });

  it('prints one conversation through an existing project-scoped route', async () => {
    const result = await runCli(['conversation', 'info', projectId, conversationId, '--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ conversation: { id: conversationId, projectId } });
    const missing = await runCli(['conversation', 'info', projectId, 'missing-conversation', '--json']);
    expect(lastError(missing)).toMatchObject({ error: { code: 'conversation-not-found' } });
    expect(missing.code).toBe(76);
  });

  it('prints a readable summary for info without --json', async () => {
    const result = await runCli(['conversation', 'info', projectId, conversationId]);
    expect(result.code, result.stderr).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout).toContain(conversationId);
  });

  it('asks for the project when info gets only a conversation id', async () => {
    const result = await runCli(['conversation', 'info', conversationId]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('od conversation info <projectId> <conversationId>');
  });
});
