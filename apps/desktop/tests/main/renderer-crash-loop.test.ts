import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  RENDERER_CRASH_LOOP_COOLDOWN_MS,
  RENDERER_CRASH_LOOP_LIMIT,
  RENDERER_CRASH_LOOP_WINDOW_MS,
  RendererCrashLoopBreaker,
} from "../../src/main/renderer-crash-loop.js";
import { isFirstPartyMailtoUrl, isSupportMailtoUrl } from "../../src/main/runtime.js";

describe("RendererCrashLoopBreaker", () => {
  test("stays closed while crashes are below the limit inside the window", () => {
    const breaker = new RendererCrashLoopBreaker({ limit: 5, windowMs: 60_000 });
    let now = 0;
    for (let i = 0; i < 4; i += 1) {
      const outcome = breaker.recordCrash((now += 1000));
      expect(outcome.tripped).toBe(false);
      expect(outcome.suppressTelemetry).toBe(false);
    }
    expect(breaker.isOpen()).toBe(false);
  });

  test("opens exactly on the crash that reaches the limit within the window", () => {
    const breaker = new RendererCrashLoopBreaker({ limit: 5, windowMs: 60_000 });
    let now = 0;
    for (let i = 0; i < 4; i += 1) breaker.recordCrash((now += 1000));
    const trip = breaker.recordCrash((now += 1000));
    expect(trip.tripped).toBe(true);
    expect(trip.justOpened).toBe(true);
    // The tripping crash is still reported so the loop is visible in analytics.
    expect(trip.suppressTelemetry).toBe(false);
    expect(breaker.isOpen()).toBe(true);
  });

  test("suppresses telemetry for every crash after it opens", () => {
    const breaker = new RendererCrashLoopBreaker({ limit: 3, windowMs: 60_000 });
    breaker.recordCrash(1000);
    breaker.recordCrash(2000);
    breaker.recordCrash(3000); // opens here
    const after = breaker.recordCrash(3100);
    expect(after.tripped).toBe(true);
    expect(after.justOpened).toBe(false);
    expect(after.suppressTelemetry).toBe(true);
  });

  test("never opens when crashes are spread wider than the window", () => {
    const breaker = new RendererCrashLoopBreaker({ limit: 3, windowMs: 60_000 });
    // One crash every 61s: the rolling window only ever holds a single crash.
    for (let i = 0; i < 20; i += 1) {
      const outcome = breaker.recordCrash(i * 61_000);
      expect(outcome.tripped).toBe(false);
    }
    expect(breaker.isOpen()).toBe(false);
  });

  test("re-arms only after the cooldown elapses with no further crash", () => {
    const breaker = new RendererCrashLoopBreaker({ limit: 2, windowMs: 60_000, cooldownMs: 300_000 });
    breaker.recordCrash(1000);
    breaker.recordCrash(2000); // opens
    expect(breaker.isOpen()).toBe(true);
    // Before the cooldown: stays open.
    expect(breaker.rearmIfCooledDown(2000 + 299_999)).toBe(false);
    expect(breaker.isOpen()).toBe(true);
    // After the cooldown: closes once and clears the history.
    expect(breaker.rearmIfCooledDown(2000 + 300_000)).toBe(true);
    expect(breaker.isOpen()).toBe(false);
    // A single fresh crash after re-arm does not immediately re-open a limit-2 breaker.
    expect(breaker.recordCrash(2000 + 300_001).tripped).toBe(false);
  });

  test("rearmIfCooledDown is a no-op while the breaker is closed", () => {
    const breaker = new RendererCrashLoopBreaker();
    expect(breaker.rearmIfCooledDown(10_000_000)).toBe(false);
  });

  test("reset forces the breaker closed", () => {
    const breaker = new RendererCrashLoopBreaker({ limit: 2, windowMs: 60_000 });
    breaker.recordCrash(1000);
    breaker.recordCrash(2000);
    expect(breaker.isOpen()).toBe(true);
    breaker.reset();
    expect(breaker.isOpen()).toBe(false);
  });

  test("exposes sane production defaults", () => {
    expect(RENDERER_CRASH_LOOP_LIMIT).toBe(5);
    expect(RENDERER_CRASH_LOOP_WINDOW_MS).toBe(60_000);
    expect(RENDERER_CRASH_LOOP_COOLDOWN_MS).toBe(300_000);
    const breaker = new RendererCrashLoopBreaker();
    let now = 0;
    for (let i = 0; i < RENDERER_CRASH_LOOP_LIMIT - 1; i += 1) {
      expect(breaker.recordCrash((now += 1)).tripped).toBe(false);
    }
    expect(breaker.recordCrash((now += 1)).tripped).toBe(true);
  });
});

// The breaker is wired into `createDesktopRuntime`, which builds real Electron
// BrowserWindows and cannot run under vitest. Mirroring
// `renderer-recovery-poll-loop.test.ts`, pin the wiring invariants against the
// runtime source so a refactor cannot silently drop the loop guard.
const runtimeSource = readFileSync(new URL("../../src/main/runtime.ts", import.meta.url), "utf8");

describe("renderer crash-loop breaker wiring", () => {
  test("runtime constructs the breaker", () => {
    expect(runtimeSource).toContain("new RendererCrashLoopBreaker(");
  });

  test("the crash handler feeds the breaker and can suppress telemetry", () => {
    expect(runtimeSource).toContain(".recordCrash(");
    expect(runtimeSource).toContain("suppressTelemetry");
  });

  test("the poll loop stays parked while the breaker is open", () => {
    // tick() must bail out (or re-arm) instead of reloading a crash-looping
    // renderer; markRendererFailed must no-op while open.
    expect(runtimeSource).toContain("rendererCrashLoop.isOpen()");
    expect(runtimeSource).toContain("rearmIfCooledDown(");
  });

  test("breaker open and recovery attempts are observable via logs + bounded telemetry", () => {
    // A wedged device must be diagnosable: one warn on open, one info per
    // recovery attempt, and a bounded recovery-attempt analytics signal.
    expect(runtimeSource).toContain("crash-loop breaker OPEN");
    expect(runtimeSource).toContain("attempting recovery reload");
    expect(runtimeSource).toContain('reason: "recovery-attempt"');
    expect(runtimeSource).toContain("recovery_attempt:");
  });

  test("the crash screen keeps save-logs and the support mailto on already-exposed IPC", () => {
    // Reuse the preload's existing bridges (no new surface): openExternal for
    // the support mailto, exportDiagnostics for the bundle. The rebrand removed
    // the prefilled GitHub issue / mailto report builders; the support address
    // stays allowlisted so the crash screen can still hand off to mail.
    expect(runtimeSource).toContain("openExternal");
    expect(runtimeSource).toContain("window.mishDesktop");
    expect(runtimeSource).toContain("exportDiagnostics");
    expect(runtimeSource).toContain("devin@zerosumsolutions.com");
  });
});

describe("isSupportMailtoUrl", () => {
  test("allows a mailto to the support address carrying only subject/body", () => {
    expect(isSupportMailtoUrl("mailto:devin@zerosumsolutions.com")).toBe(true);
    expect(isSupportMailtoUrl("mailto:devin@zerosumsolutions.com?subject=Crash&body=hi")).toBe(true);
    // Address comparison is case-insensitive.
    expect(isSupportMailtoUrl("mailto:Devin@ZeroSumSolutions.com")).toBe(true);
  });

  test("rejects any other address or scheme so widening open-external can't be abused", () => {
    expect(isSupportMailtoUrl("mailto:attacker@evil.com")).toBe(false);
    expect(isSupportMailtoUrl("mailto:support@evil.com")).toBe(false);
    expect(isSupportMailtoUrl("https://github.com/ZeroSum-Solutions/mish")).toBe(false);
    expect(isSupportMailtoUrl("javascript:alert(1)")).toBe(false);
    expect(isSupportMailtoUrl("file:///etc/passwd")).toBe(false);
    expect(isSupportMailtoUrl("not a url")).toBe(false);
  });

  test("rejects extra recipients/headers smuggled through the query (to/cc/bcc/unknown)", () => {
    // The address alone passes pathname, so the query must be validated too or a
    // compromised renderer could add recipients through the open-external bridge.
    expect(isSupportMailtoUrl("mailto:devin@zerosumsolutions.com?bcc=attacker@example.com")).toBe(false);
    expect(isSupportMailtoUrl("mailto:devin@zerosumsolutions.com?cc=attacker@example.com")).toBe(false);
    expect(isSupportMailtoUrl("mailto:devin@zerosumsolutions.com?to=attacker@example.com")).toBe(false);
    expect(isSupportMailtoUrl("mailto:devin@zerosumsolutions.com?subject=x&bcc=attacker@example.com")).toBe(false);
    expect(isSupportMailtoUrl("mailto:devin@zerosumsolutions.com?whatever=1")).toBe(false);
  });

  test("rejects a CR/LF-injected subject/body that could smuggle a mail header", () => {
    // %0D%0A decodes to CRLF; a "Bcc:" line after it would add a recipient.
    expect(
      isSupportMailtoUrl("mailto:devin@zerosumsolutions.com?subject=ok%0D%0ABcc:attacker@example.com"),
    ).toBe(false);
    expect(isSupportMailtoUrl("mailto:devin@zerosumsolutions.com?body=line1%0Aline2")).toBe(false);
  });
});

describe("isFirstPartyMailtoUrl", () => {
  test("covers every address the app itself offers to email", () => {
    // The account menu's mail badge (`CONTACT_EMAIL_URL` in EntryNavRail.tsx).
    // Before this predicate existed, `will-navigate` only recognised http(s),
    // so clicking that badge in the packaged shell did nothing at all.
    expect(isFirstPartyMailtoUrl("mailto:devin@zerosumsolutions.com")).toBe(true);
    expect(isFirstPartyMailtoUrl("mailto:devin@zerosumsolutions.com?subject=Hi&body=there")).toBe(true);
    expect(isFirstPartyMailtoUrl("mailto:Devin@ZeroSumSolutions.com")).toBe(true);
    // The retired upstream addresses are no longer first-party.
    expect(isFirstPartyMailtoUrl("mailto:support@mish.invalid")).toBe(false);
  });

  test("keeps the support predicate narrow so the open-external bridge does not widen", () => {
    // `shell:open-external` is renderer-reachable and still gates on the
    // support address only; the retired upstream contact address is rejected.
    expect(isSupportMailtoUrl("mailto:contact@example.test")).toBe(false);
    expect(isFirstPartyMailtoUrl("mailto:contact@example.test")).toBe(false);
  });

  test("applies the same recipient/header hardening as the support predicate", () => {
    expect(isFirstPartyMailtoUrl("mailto:attacker@evil.com")).toBe(false);
    expect(isFirstPartyMailtoUrl("mailto:devin@zerosumsolutions.com?bcc=attacker@example.com")).toBe(false);
    expect(isFirstPartyMailtoUrl("mailto:devin@zerosumsolutions.com?to=attacker@example.com")).toBe(false);
    expect(isFirstPartyMailtoUrl("mailto:devin@zerosumsolutions.com?whatever=1")).toBe(false);
    expect(
      isFirstPartyMailtoUrl("mailto:devin@zerosumsolutions.com?subject=ok%0D%0ABcc:attacker@example.com"),
    ).toBe(false);
    expect(isFirstPartyMailtoUrl("https://github.com/ZeroSum-Solutions/mish")).toBe(false);
    expect(isFirstPartyMailtoUrl("javascript:alert(1)")).toBe(false);
    expect(isFirstPartyMailtoUrl("not a url")).toBe(false);
  });

  test("the main window routes a mailto navigation to the OS instead of dropping it", () => {
    // Guards the wiring, not just the predicate: `will-navigate` must cancel
    // the navigation and hand the URL to `shell.openExternal`.
    const runtimeSource = readFileSync(new URL("../../src/main/runtime.ts", import.meta.url), "utf8");
    const willNavigate = runtimeSource.slice(runtimeSource.indexOf('window.webContents.on("will-navigate"'));
    expect(willNavigate).toContain("isFirstPartyMailtoUrl(url)");
    expect(willNavigate.indexOf("isFirstPartyMailtoUrl(url)")).toBeLessThan(
      willNavigate.indexOf("if (!isHttpUrl(url)"),
    );
  });
});
