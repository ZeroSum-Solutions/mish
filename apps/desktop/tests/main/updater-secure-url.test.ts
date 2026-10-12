import { describe, expect, it } from "vitest";

import { assertSecureUpdateUrl, isSecureUpdateUrl } from "../../src/main/updater/secure-url.js";

describe("update feed url policy", () => {
  it("accepts https and loopback http only", () => {
    expect(isSecureUpdateUrl("https://releases.example.com/latest.json")).toBe(true);
    expect(isSecureUpdateUrl("http://127.0.0.1:8080/latest.json")).toBe(true);
    expect(isSecureUpdateUrl("http://localhost/latest.json")).toBe(true);
    expect(isSecureUpdateUrl("http://releases.example.com/latest.json")).toBe(false);
    expect(isSecureUpdateUrl("file:///tmp/latest.json")).toBe(false);
    expect(isSecureUpdateUrl("not a url")).toBe(false);
  });

  it("throws a labelled error for insecure urls", () => {
    expect(() => assertSecureUpdateUrl("http://evil.example/x", "checksum URL")).toThrow(/checksum URL must use https/);
  });
});
