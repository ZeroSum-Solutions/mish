import { createHash } from 'node:crypto';

/** Private endpoint identity, separate from the public RFC 8707 resource audience. */
export function mcpEndpointFingerprint(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

/** Legacy tokens lack proof of their original endpoint and require reconnect. */
export function mcpTokenMatchesEndpoint(token: { endpointFingerprint?: string | undefined }, endpoint: string | undefined): boolean {
  return Boolean(endpoint && token.endpointFingerprint === mcpEndpointFingerprint(endpoint));
}

/**
 * A resource is shared with the authorization server and browser. Never send credentials.
 *
 * "Public" here means safe to disclose as an RFC 8707 audience: http(s), no
 * userinfo, no query and no hash. It does NOT check the host and is not an
 * SSRF guard; outbound OAuth URLs are checked by `assertOAuthUrl` in
 * `mcp-oauth.ts` through the daemon egress guard.
 */
export function isPublicMcpResource(resource: string): boolean {
  try {
    const url = new URL(resource);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
