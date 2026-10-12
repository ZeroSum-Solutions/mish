// Update feeds, artifacts and checksums must travel over TLS. Plain http is
// accepted only for loopback hosts so local dev feeds and tests still work.
export function isSecureUpdateUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function assertSecureUpdateUrl(value: string, label: string): void {
  if (!isSecureUpdateUrl(value)) {
    throw new Error(`${label} must use https (or loopback http): ${value}`);
  }
}
