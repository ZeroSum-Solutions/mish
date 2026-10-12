// AC-R01.1 / AC-R01.4 (native half): Electron-side guard for OS file drops. These are mocked-Electron unit specs; they do not replace the physical
// Finder/guest/Option/symlink probe in `fixtures/native-drop-probe.md`.
import { describe, expect, it } from "vitest";

import { isNativeFileDropNavigation } from "../../src/main/native-drop.js";

describe("main-window native file drop navigation", () => {
  it("treats an unclaimed OS file drop as a navigation the window must refuse", () => {
    // Chromium turns a file drop nobody claimed into a `file:` navigation of
    // the main window. Refusing it keeps the DOM coordinator's claim as the one
    // and only intake for that drop, and keeps the user on the current surface.
    expect(isNativeFileDropNavigation("file:///Users/me/Desktop/brief.pdf")).toBe(true);
    expect(isNativeFileDropNavigation("file:///Users/me/My%20Folder/")).toBe(true);
    expect(isNativeFileDropNavigation("FILE:///tmp/a.png")).toBe(true);
  });

  it("leaves in-app, web and internal-reorder navigations to the existing handler", () => {
    // An internal reorder or text drag never produces a `file:` URL, so the
    // native layer never treats it as an OS file drop and never uploads it.
    expect(isNativeFileDropNavigation("http://127.0.0.1:17573/projects/p1")).toBe(false);
    expect(isNativeFileDropNavigation("od://app/projects/p1")).toBe(false);
    expect(isNativeFileDropNavigation("https://example.com/")).toBe(false);
    expect(isNativeFileDropNavigation("mailto:devin@zerosumsolutions.com")).toBe(false);
    expect(isNativeFileDropNavigation("about:blank")).toBe(false);
    expect(isNativeFileDropNavigation("not a url")).toBe(false);
  });
});
