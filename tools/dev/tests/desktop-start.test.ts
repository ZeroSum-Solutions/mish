import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DesktopStatusSnapshot } from "@mish/sidecar-proto";

import { resolveToolDevConfig } from "../src/config.js";
import { desktopLaunchArgs } from "../src/desktop-profile.js";
import { assertDesktopProfileStartAllowed, startDesktopRuntime, type DesktopStartDeps } from "../src/desktop-start.js";

const running: DesktopStatusSnapshot = { pid: 1234, state: "running" };

function fixture(existing: DesktopStatusSnapshot | null) {
  const calls: string[] = [];
  let launchArgs: string[] | undefined;
  const deps: DesktopStartDeps = {
    inspect: async () => { calls.push("inspect"); return existing; },
    assertNoStale: async () => { calls.push("assertNoStale"); },
    spawn: async (config) => {
      calls.push("spawn");
      launchArgs = desktopLaunchArgs(config.apps.desktop.mainEntryPath, config.apps.desktop.userDataDir);
      return { pid: 1234 };
    },
    wait: async (pid) => { calls.push(`wait:${pid}`); return running; },
    stop: async () => { calls.push("stop"); },
  };
  return { deps, calls, get launchArgs() { return launchArgs; } };
}

describe("development desktop starts", () => {
  it("rejects every explicit profile request when a desktop is already running", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "desktop-start-"));
    try {
      const config = resolveToolDevConfig({ namespace: "profile-test", desktopUserDataDir: path.join(root, "profile") });
      for (const options of [{}, { parentPid: 5678 }]) {
        const recorded = fixture(running);
        await assert.rejects(
          startDesktopRuntime(config, options, recorded.deps),
          /desktop is already running in namespace profile-test;.*--desktop-user-data-dir.*Stop.*desktop/,
        );
        assert.deepEqual(recorded.calls, ["inspect"]);
      }
      await assert.rejects(assertDesktopProfileStartAllowed(config, async () => running), /--desktop-user-data-dir/);
      await assertDesktopProfileStartAllowed(config, async () => null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("skips profile preflight inspection when no profile was requested", async () => {
    await assertDesktopProfileStartAllowed(resolveToolDevConfig(), async () => {
      assert.fail("default starts must keep their existing inspection order");
    });
  });

  it("reuses the running desktop when no profile was requested", async () => {
    const config = resolveToolDevConfig({ namespace: "profile-test" });
    const recorded = fixture(running);
    const result = await startDesktopRuntime(config, {}, recorded.deps);
    assert.equal(result.created, false);
    assert.equal(result.status, running);
    assert.equal(result.logPath, config.apps.desktop.latestLogPath);
    assert.deepEqual(recorded.calls, ["inspect"]);
  });

  it("forwards the requested profile on a fresh start", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "desktop-start-"));
    try {
      const profile = path.join(root, "native résumé profile");
      const config = resolveToolDevConfig({ namespace: "profile-test", desktopUserDataDir: profile });
      const recorded = fixture(null);
      const result = await startDesktopRuntime(config, {}, recorded.deps);
      assert.equal(result.created, true);
      assert.equal(result.pid, running.pid);
      assert.equal(result.status, running);
      assert.deepEqual(recorded.launchArgs, [config.apps.desktop.mainEntryPath, `--user-data-dir=${profile}`]);
      assert.deepEqual(recorded.calls, ["inspect", "assertNoStale", "spawn", "wait:1234"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves owner-bound rejection on a running desktop", async () => {
    const recorded = fixture(running);
    await assert.rejects(
      startDesktopRuntime(resolveToolDevConfig(), { parentPid: 5678 }, recorded.deps),
      /owner-bound starts require a clean namespace/,
    );
    assert.deepEqual(recorded.calls, ["inspect"]);
  });

  it("stops a newly spawned desktop after status wait fails and preserves the error", async () => {
    const recorded = fixture(null);
    const failure = new Error("desktop exited before exposing status");
    recorded.deps.wait = async () => { recorded.calls.push("wait"); throw failure; };
    recorded.deps.stop = async () => { recorded.calls.push("stop"); throw new Error("cleanup failed"); };
    await assert.rejects(startDesktopRuntime(resolveToolDevConfig(), {}, recorded.deps), (error) => error === failure);
    assert.deepEqual(recorded.calls, ["inspect", "assertNoStale", "spawn", "wait", "stop"]);
  });
});
