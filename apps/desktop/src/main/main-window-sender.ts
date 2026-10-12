import type { WebContents } from "electron";

// The one window allowed to call host IPC. Child windows (artifact popups
// that run generated HTML) never get this status.
let mainContents: WebContents | null = null;

export function registerMainWindowContents(contents: WebContents | null): void {
  mainContents = contents;
}

export function assertMainWindowSender(event: { sender: unknown }): void {
  const main = mainContents;
  if (main == null || main.isDestroyed() || event.sender !== main) {
    throw new Error("host IPC is only available to the main Mishh Mashh window");
  }
}
