import { APP_KEYS, type DesktopStatusSnapshot } from "@open-design/sidecar-proto";
import type { ToolDevConfig, ToolDevOptions } from "./config.js";

export type DesktopStartOptions = ToolDevOptions & { parentPid?: number };

export type DesktopStartDeps = {
  inspect: () => Promise<DesktopStatusSnapshot | null>;
  assertNoStale: () => Promise<void>;
  spawn: (config: ToolDevConfig, options: DesktopStartOptions) => Promise<{ pid: number }>;
  wait: (pid: number) => Promise<DesktopStatusSnapshot>;
  stop: () => Promise<void>;
};

function assertProfileNotReused(config: ToolDevConfig, existing: DesktopStatusSnapshot | null) {
  if (existing != null && config.apps.desktop.userDataDir != null) {
    throw new Error(
      `${APP_KEYS.DESKTOP} is already running in namespace ${config.namespace}; ` +
      `--desktop-user-data-dir cannot be applied or verified on an existing process. ` +
      `Stop that namespace's desktop before starting it with the requested profile.`,
    );
  }
}

// Reject before daemon/web gate preparation can alter running processes.
export async function assertDesktopProfileStartAllowed(
  config: ToolDevConfig,
  inspect: DesktopStartDeps["inspect"],
) {
  if (config.apps.desktop.userDataDir != null) assertProfileNotReused(config, await inspect());
}

// Keep CLI parsing out of the orchestration tests; runtime operations stay in index.ts.
export async function startDesktopRuntime(
  config: ToolDevConfig,
  options: DesktopStartOptions,
  deps: DesktopStartDeps,
) {
  const existing = await deps.inspect();
  assertProfileNotReused(config, existing);
  if (existing != null) {
    if (options.parentPid != null) {
      throw new Error(
        `${APP_KEYS.DESKTOP} is already running in namespace ${config.namespace}; ` +
        `owner-bound starts require a clean namespace, so stop it or choose another namespace`,
      );
    }
    return { app: APP_KEYS.DESKTOP, created: false, logPath: config.apps.desktop.latestLogPath, status: existing };
  }
  await deps.assertNoStale();

  const spawned = await deps.spawn(config, options);
  try {
    const status = await deps.wait(spawned.pid);
    return {
      app: APP_KEYS.DESKTOP,
      created: true,
      logPath: config.apps.desktop.latestLogPath,
      pid: spawned.pid,
      status,
    };
  } catch (error) {
    await deps.stop().catch(() => undefined);
    throw error;
  }
}
