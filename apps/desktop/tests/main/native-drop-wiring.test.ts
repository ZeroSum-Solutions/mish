// AC-R01.4: "Native guest forwarding is separately verified; web drag tests are
// insufficient." Supplementary shape pin for how the Electron main process and preload wire the
// native drop seams. Behavior lives in the pure helpers covered by
// native-file-drop.test.ts and directory-intake.test.ts, and the handlers are
// executed with fake events in native-drop-handlers.test.ts. The physical probe in
// fixtures/native-drop-probe.md remains the open native gate.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = readFileSync(join(here, "../../src/main/runtime.ts"), "utf8");
const preload = readFileSync(join(here, "../../src/main/preload.cts"), "utf8");

function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `missing end of ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("native drop wiring", () => {
  it("refuses the main window's file-drop navigation before any other navigation rule", () => {
    const handler = block(runtime, 'window.webContents.on("will-navigate"', "\n  });");
    const guard = handler.indexOf("if (refuseNativeFileDropNavigation(event, url)) return;");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(handler.indexOf("isFirstPartyMailtoUrl(url)"));
  });

  it("leaves guest drops to the guest: no guest preload, no host drop or input interception", () => {
    const attach = block(runtime, 'window.webContents.on("will-attach-webview"', "\n  });");
    expect(attach).toContain("delete webPreferences.preload");
    expect(attach).toContain("webPreferences.sandbox = true");
    const attached = block(runtime, 'window.webContents.on("did-attach-webview"', "\n  });");
    expect(attached).toContain('guestWebContents.on("will-navigate", blockDisallowed)');
    // A guest site with no drop handler cannot be navigated to the dropped
    // file: the guest allowlist admits only http(s) and about:blank.
    const allowlist = block(runtime, "export function isAllowedEmbeddedBrowserUrl", "\n}\n");
    expect(allowlist).not.toMatch(/protocol === "file:"/);
    expect(allowlist.match(/parsed\.protocol === "[a-z]+:"/g)).toEqual([
      'parsed.protocol === "http:"',
      'parsed.protocol === "https:"',
      'parsed.protocol === "about:"',
    ]);
    for (const forbidden of ["before-input-event", '"drop"', "executeJavaScript", "preload"]) {
      expect(attached).not.toContain(forbidden);
    }
  });

  it("installs the directory listing handler with the main-window sender guard", () => {
    // Handler behavior is executed in native-drop-handlers.test.ts; this pins the wiring.
    expect(runtime).toContain("registerDirectoryIntakeIpc(ipcMain, requireMainWindowSender);");
    expect(runtime).toContain("ipcMain.removeHandler(DIRECTORY_INTAKE_IPC_CHANNEL)");
  });

  it("resolves dropped folders in the preload from a File only, never from a page-supplied path", () => {
    const intake = block(preload, "const intake = {", "\n};");
    expect(intake).toContain("webUtils.getPathForFile(file)");
    expect(intake).toContain("instanceof File");
    expect(intake).toContain("'intake:list-directory'");
    expect(preload).toMatch(/hostBridge = \{[\s\S]*\bintake,[\s\S]*\} satisfies MishHostBridge/);
  });
});
