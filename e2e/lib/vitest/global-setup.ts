import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reapNamespaceProcesses } from '../tools-dev/process-reaper.ts';
import { E2E_RUN_LEDGER_ENV, readRunNamespaces } from './run-ledger.ts';

const workspaceRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/**
 * Leak guard for the e2e Vitest run. Setup creates this run's namespace
 * ledger; teardown looks for any process still stamped with one of those
 * namespaces (sidecar supervisors and their daemon/web children), kills it,
 * and fails the run, because a suite's own teardown should already have
 * stopped it.
 */
export default function setup(): () => Promise<void> {
  const runId = `${Date.now()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const runDir = join(workspaceRoot, '.tmp', 'e2e', '.runs', runId);
  const ledger = join(runDir, 'namespaces');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(ledger, '', 'utf8');
  // Forked workers start after global setup and inherit this.
  process.env[E2E_RUN_LEDGER_ENV] = ledger;

  return async () => {
    const leaks: string[] = [];
    for (const namespace of readRunNamespaces(ledger)) {
      const result = await reapNamespaceProcesses(namespace, { killGraceMs: 2_000, termGraceMs: 3_000 });
      if (result.found.length === 0) continue;
      const survivors = result.remainingPids.length > 0 ? ` (still alive after SIGKILL: ${result.remainingPids.join(', ')})` : '';
      leaks.push(
        `${namespace}: ${result.found.length} process(es)${survivors}\n`
          + result.found.map((entry) => `    ${entry.pid} ${entry.command.slice(0, 200)}`).join('\n'),
      );
    }
    rmSync(runDir, { force: true, recursive: true });
    if (leaks.length > 0) {
      throw new Error(
        `e2e run left ${leaks.length} tools-dev namespace(s) with live processes after the suites finished; `
          + `they were killed now, but a suite teardown leaked them:\n  ${leaks.join('\n  ')}`,
      );
    }
  };
}
