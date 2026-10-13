import { appendFileSync, readFileSync } from 'node:fs';

/**
 * The e2e run ledger: one file per `vitest run`, created by the global setup
 * (`lib/vitest/global-setup.ts`) and named by this env var. Every smoke suite
 * appends its tools-dev namespace, so the global teardown can check this run's
 * namespaces, and only this run's, for leftover processes.
 */
export const E2E_RUN_LEDGER_ENV = 'OD_E2E_RUN_LEDGER';

export function recordRunNamespace(namespace: string, env: NodeJS.ProcessEnv = process.env): void {
  const ledger = env[E2E_RUN_LEDGER_ENV];
  if (!ledger) return;
  appendFileSync(ledger, `${namespace}\n`, 'utf8');
}

export function readRunNamespaces(ledger: string): string[] {
  let text: string;
  try {
    text = readFileSync(ledger, 'utf8');
  } catch {
    return [];
  }
  return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))];
}
