import { createHash } from 'node:crypto';

/** Private endpoint identity, separate from the public RFC 8707 resource audience. */
export function mcpEndpointFingerprint(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

/** Legacy tokens lack proof of their original endpoint and require reconnect. */
export function mcpTokenMatchesEndpoint(token: { endpointFingerprint?: string | undefined }, endpoint: string | undefined): boolean {
  return Boolean(endpoint && token.endpointFingerprint === mcpEndpointFingerprint(endpoint));
}

/** A resource is shared with the authorization server and browser. Never send credentials. */
export function isPublicMcpResource(resource: string): boolean {
  try {
    const url = new URL(resource);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
