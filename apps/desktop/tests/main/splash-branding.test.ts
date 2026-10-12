import { describe, expect, it } from "vitest";
import { createSplashHtml } from "../../src/main/splash-screen.js";

describe("packaged startup branding", () => {
  it("renders the Mishh Mashh mark without the upstream video", () => {
    const html = decodeURIComponent(createSplashHtml({ step: 1, total: 7, label: "Starting" }).split(",").slice(1).join(","));
    expect(html).toContain("Mishh Mashh");
    expect(html).toContain('aria-label="Mishh Mashh"');
    expect(html).not.toMatch(/Mish|claude design alternative|<video|data:video/i);
    expect(html).toContain("window.__odSplashSetStage");
    expect(html).toContain('data-pct="14"');
    expect(html).toContain("1/7");
  });
});
