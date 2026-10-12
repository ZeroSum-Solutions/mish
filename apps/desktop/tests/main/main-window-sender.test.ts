import { describe, expect, it } from "vitest";

import {
  assertMainWindowSender,
  registerMainWindowContents,
} from "../../src/main/main-window-sender.js";

const contents = (destroyed = false) =>
  ({ isDestroyed: () => destroyed }) as unknown as Parameters<typeof registerMainWindowContents>[0];

describe("main window sender guard", () => {
  it("accepts only the registered main window", () => {
    const main = contents();
    registerMainWindowContents(main);
    expect(() => assertMainWindowSender({ sender: main })).not.toThrow();
    expect(() => assertMainWindowSender({ sender: contents() })).toThrow(/main Mishh Mashh window/);
  });

  it("rejects everything before registration or after destroy", () => {
    registerMainWindowContents(null);
    expect(() => assertMainWindowSender({ sender: contents() })).toThrow();
    const dead = contents(true);
    registerMainWindowContents(dead);
    expect(() => assertMainWindowSender({ sender: dead })).toThrow();
  });
});
