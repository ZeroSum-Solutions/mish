import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureComposioConfigStore } from '../src/connectors/composio-config.js';
import { composioConnectorProvider } from '../src/connectors/composio.js';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonCliDist = path.join(daemonRoot, 'dist', 'cli.js');

function pnpmInvocation(): { args: string[]; command: string } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /\.(?:cjs|js)$/iu.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath] };
  }
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [] };
}

function ensureDaemonCliBuilt() {
  if (existsSync(daemonCliDist)) return;
  const pnpm = pnpmInvocation();
  execFileSync(pnpm.command, [...pnpm.args, 'run', 'build'], {
    cwd: daemonRoot,
    stdio: 'inherit',
    env: process.env,
  });
}

const TEST_DATA_DIR_SYMBOL = Symbol.for('open-design.daemon.vitestDataDir');

const globalState = globalThis as typeof globalThis & {
  [TEST_DATA_DIR_SYMBOL]?: string;
};

if (!globalState[TEST_DATA_DIR_SYMBOL]) {
  globalState[TEST_DATA_DIR_SYMBOL] = mkdtempSync(path.join(tmpdir(), 'od-daemon-vitest-'));

  process.once('exit', () => {
    rmSync(globalState[TEST_DATA_DIR_SYMBOL]!, { force: true, recursive: true });
  });
}

// Server paths are resolved at module import time. Force every daemon test
// process to use one isolated data directory before any test imports server.ts,
// so tests can never read or overwrite the developer's real repo `.od` data.
process.env.OD_DATA_DIR = globalState[TEST_DATA_DIR_SYMBOL];
// Composio's config store and catalog cache have no cwd-relative fallback
// (apps/daemon/src/connectors/composio-config.ts, composio.ts) — the Daemon
// data directory contract forbids one, so each store throws until it is
// explicitly configured. server.ts configures both from RUNTIME_DATA_DIR
// immediately after resolving it (right where OD_DATA_DIR is applied above);
// mirror that here so any test that reaches the real `composioConnectorProvider`
// singleton without configuring its own store (e.g. a connector-policy test
// whose fake service only stubs catalog lookups, not hydration/isConfigured)
// gets the same "configured, no API key" baseline production has, instead of
// the unconfigured throw. Tests that specifically exercise the unconfigured
// state (apps/daemon/tests/wavec-data-roots.test.ts) use `vi.resetModules()`
// or a fresh `ComposioConnectorProvider()` instance, so they are unaffected.
configureComposioConfigStore(process.env.OD_DATA_DIR);
composioConnectorProvider.configureCatalogCache(process.env.OD_DATA_DIR);
// Keep unit tests from reading a developer's stored Vela profile and routing
// Langfuse-shaped telemetry through the authenticated Vela sink by accident.
process.env.OPEN_DESIGN_VELA_TELEMETRY ??= 'off';

// Publish/share endpoints shell out through OD_NODE_BIN + OD_BIN (dist/cli.js).
// Build the CLI artifact once per vitest process so package tests do not depend
// on a prior manual `pnpm --filter @open-design/daemon build`.
ensureDaemonCliBuilt();
process.env.OD_DAEMON_CLI_PATH = daemonCliDist;

// The deploy probe's anonymous GET resolves every host it may request and
// refuses loopback/private answers (src/deploy/public-page-probe.ts). Tests
// mock `fetch` with made-up hosts, so name resolution answers with one fixed
// public address here instead of real DNS. A test that needs a
// private answer replaces this slot for its own duration.
(globalThis as Record<symbol, unknown>)[Symbol.for('open-design.daemon.publicProbeResolveHost')] = async () => ['93.184.216.34'];
