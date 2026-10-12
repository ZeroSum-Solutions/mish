import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveToolDevConfig } from "../src/config.js";
import { desktopLaunchArgs, resolveDesktopUserDataDir } from "../src/desktop-profile.js";

describe("opt-in development Electron profile", () => {
  it("preserves the default launch arguments and config", () => {
    assert.deepEqual(desktopLaunchArgs("main.js", null), ["main.js"]);
    assert.equal(resolveToolDevConfig().apps.desktop.userDataDir, null);
  });

  it("rejects empty and relative paths before runtime launch", () => {
    for (const value of ["", " ", "profile", "./profile"]) {
      assert.throws(() => resolveToolDevConfig({ desktopUserDataDir: value }), /absolute directory path/);
    }
  });

  it("rejects malformed option values and the filesystem root", () => {
    for (const value of [true, ["/first", "/second"], path.parse(process.cwd()).root]) {
      assert.throws(() => resolveDesktopUserDataDir(value), /absolute directory path|filesystem root/);
    }
  });

  it("propagates the profile through config and a single native Electron argument", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tools-dev-profile-"));
    try {
      const profile = path.join(root, "native résumé profile");
      const config = resolveToolDevConfig({ namespace: "owned-native", desktopUserDataDir: profile });
      assert.equal(config.apps.desktop.userDataDir, profile);
      assert.equal(config.namespace, "owned-native");
      assert.deepEqual(desktopLaunchArgs("main.js", config.apps.desktop.userDataDir), ["main.js", `--user-data-dir=${profile}`]);
      assert.equal(lstatSync(profile).isDirectory(), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an existing file or final symlink without modifying either", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tools-dev-profile-"));
    try {
      const file = path.join(root, "file"); writeFileSync(file, "owned fixture");
      const alias = path.join(root, "alias"); symlinkSync(root, alias, "dir");
      for (const value of [file, alias, alias + path.sep]) {
        assert.throws(() => desktopLaunchArgs("main.js", value), /not a file or symlink/);
      }
      assert.equal(lstatSync(file).isFile(), true);
      assert.equal(lstatSync(alias).isSymbolicLink(), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
