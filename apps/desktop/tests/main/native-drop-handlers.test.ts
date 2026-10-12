// AC-R01.1 / AC-R01.4 (native half): the main-process handlers runtime.ts
// installs, invoked with fake Electron events and a fake ipcMain. These run the
// real handler code; the physical Finder/guest/Option/symlink probe in
// fixtures/native-drop-probe.md stays the open native gate.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { refuseNativeFileDropNavigation } from "../../src/main/native-drop.js";
import { DIRECTORY_INTAKE_IPC_CHANNEL, registerDirectoryIntakeIpc } from "../../src/main/directory-intake.js";

type Listener = (event: { sender: unknown }, raw: unknown) => Promise<unknown>;
function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  return {
    handlers,
    handle: vi.fn((channel: string, listener: Listener) => {
      if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
      handlers.set(channel, listener);
    }),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
  };
}

describe("main-window will-navigate file-drop guard", () => {
  it("prevents exactly one file: navigation per unclaimed OS drop and reports it handled", () => {
    const event = { preventDefault: vi.fn() };
    expect(refuseNativeFileDropNavigation(event, "file:///Users/me/Desktop/brief.pdf")).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("leaves every other navigation to the existing rules untouched", () => {
    for (const url of ["http://127.0.0.1:17573/projects/p1", "mailto:a@b.test", "about:blank", "not a url"]) {
      const event = { preventDefault: vi.fn() };
      expect(refuseNativeFileDropNavigation(event, url)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe("directory intake IPC handler", () => {
  let root: string | null = null;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

  const mainSender = { id: "main" };
  const requireMain = (event: { sender: unknown }) => {
    if (event.sender !== mainSender) throw new Error("host IPC is only available to the main Mishh Mashh window");
  };

  it("registers one handler, replacing a stale one, and unregisters it on dispose", () => {
    const ipc = fakeIpcMain();
    const dispose = registerDirectoryIntakeIpc(ipc, requireMain);
    expect(ipc.removeHandler).toHaveBeenCalledWith(DIRECTORY_INTAKE_IPC_CHANNEL);
    expect(ipc.handle).toHaveBeenCalledTimes(1);
    dispose();
    expect(ipc.handlers.has(DIRECTORY_INTAKE_IPC_CHANNEL)).toBe(false);
  });

  it("refuses a non-main-window sender before touching the filesystem", async () => {
    const ipc = fakeIpcMain(); const list = vi.fn();
    registerDirectoryIntakeIpc(ipc, requireMain, list);
    const handler = ipc.handlers.get(DIRECTORY_INTAKE_IPC_CHANNEL)!;
    await expect(handler({ sender: { id: "guest" } }, "/tmp")).rejects.toThrow(/main Mishh Mashh window/);
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a relative or non-string path from the main window", async () => {
    const ipc = fakeIpcMain(); const list = vi.fn();
    registerDirectoryIntakeIpc(ipc, requireMain, list);
    const handler = ipc.handlers.get(DIRECTORY_INTAKE_IPC_CHANNEL)!;
    await expect(handler({ sender: mainSender }, "relative/dir")).rejects.toThrow(/folder path is required/);
    await expect(handler({ sender: mainSender }, 42)).rejects.toThrow(/folder path is required/);
    expect(list).not.toHaveBeenCalled();
  });

  it("lists a real dropped folder for the main window with tree-relative paths only", async () => {
    root = await mkdtemp(join(tmpdir(), "od-intake-ipc-"));
    await mkdir(join(root, "Kit", "nested"), { recursive: true });
    await writeFile(join(root, "Kit", "a.txt"), "a");
    await writeFile(join(root, "Kit", "nested", "b.txt"), "bb");
    const ipc = fakeIpcMain();
    registerDirectoryIntakeIpc(ipc, requireMain);
    const listing = await ipc.handlers.get(DIRECTORY_INTAKE_IPC_CHANNEL)!({ sender: mainSender }, join(root, "Kit"));
    expect(listing).toEqual({ rootName: "Kit", files: [{ relativePath: "a.txt", size: 1 }, { relativePath: "nested/b.txt", size: 2 }], refused: [], truncated: false });
    expect(JSON.stringify(listing)).not.toContain(root);
  });
});
