import type { Response } from 'express';

/**
 * CSP for agent-written documents the daemon serves from its own origin
 * (saved artifacts under `/artifacts/`, standalone HTML exports).
 *
 * Invariant: scripts run, but `allow-same-origin` is absent, so the document
 * always gets an opaque origin. It cannot read cookies or storage of the
 * daemon origin, and any request it sends to `/api` carries `Origin: null`,
 * which the API origin guard refuses. This holds however the document is
 * reached: a same-origin navigation, a new tab, or a frame.
 */
export const OPAQUE_DOCUMENT_SANDBOX_POLICY = 'sandbox allow-scripts';

/** Apply the opaque-origin sandbox and disable content sniffing on `res`. */
export function applyOpaqueDocumentSandbox(res: Pick<Response, 'setHeader'>): void {
  res.setHeader('Content-Security-Policy', OPAQUE_DOCUMENT_SANDBOX_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
