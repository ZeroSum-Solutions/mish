import type { Express, Response } from 'express';
import { parseFontCheckRequest, parseFontCheckResponse } from '@open-design/contracts';
import { checkFont } from '../fonts/check.js';
import { FONT_SPECIMEN_TEXT_LIMIT, renderFontSpecimen } from '../fonts/specimen.js';
import { ResourceError, inspectResource } from '../workbench/resources.js';
import type { FontsResourceSource } from '../workbench/resources-fonts.js';
import { createWorkbenchResourceRequestScope, type RegisterWorkbenchRoutesDeps } from './workbench.js';

export interface RegisterWorkbenchFontRoutesDeps extends Pick<RegisterWorkbenchRoutesDeps, 'http' | 'authorizeProjectRequest' | 'sourcesForRequest'> {
  fonts: FontsResourceSource;
}
const SHA = /^[a-f0-9]{64}$/u;
/** Untrusted bytes are served inert: no sniffing, no document context, same-origin only. */
function lockDown(res: Response, csp = "default-src 'none'; sandbox"): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/** AC-R11.2 font check, admitted bytes, notices and the script-free specimen. Behind server.ts's global API auth. */
export function registerWorkbenchFontRoutes(app: Express, deps: RegisterWorkbenchFontRoutesDeps): void {
  const { fail, resolveContext } = createWorkbenchResourceRequestScope(deps);
  const fontResource = async (refKey: string, context: Parameters<typeof inspectResource>[1], req: Parameters<RegisterWorkbenchFontRoutesDeps['sourcesForRequest']>[0]) => {
    const detail = await inspectResource(refKey, context, deps.sourcesForRequest(req, context));
    const family = detail.resource.ref.sourceId === 'fonts' && detail.resource.fontProfile ? deps.fonts.family(detail.resource.ref.itemId) : undefined;
    if (!family) throw new ResourceError(404, 'resource-ref-unknown', 'Resource is not a font from the fonts source', ['Search with --category font for a current font reference']);
    return { resource: detail.resource, family };
  };
  app.post('/api/workbench/fonts/check', async (req, res) => {
    let request;
    try { request = parseFontCheckRequest(req.body); }
    catch { return deps.http.sendApiError(res, 400, 'BAD_REQUEST', 'Invalid font check request'); }
    try {
      const resolved = await resolveContext(req, res, request.projectId); if (!resolved) return;
      const { context } = resolved;
      const { resource, family } = await fontResource(request.refKey, context, req);
      res.json(parseFontCheckResponse(checkFont(resource, family, request)));
    } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/fonts/specimen', async (req, res) => {
    const { ref, text, weight, style } = req.query;
    if (typeof ref !== 'string' || !ref || (text !== undefined && (typeof text !== 'string' || text.length > FONT_SPECIMEN_TEXT_LIMIT))
      || (weight !== undefined && (typeof weight !== 'string' || !/^\d{1,4}$/.test(weight))) || (style !== undefined && style !== 'normal' && style !== 'italic')) {
      return deps.http.sendApiError(res, 400, 'BAD_REQUEST', 'Invalid font specimen request');
    }
    try {
      const resolved = await resolveContext(req, res); if (!resolved) return;
      const { context } = resolved;
      const { resource } = await fontResource(ref, context, req);
      const specimen = renderFontSpecimen(resource, { ...(typeof text === 'string' ? { text } : {}), ...(typeof weight === 'string' ? { weight: Number(weight) } : {}), ...(style === 'italic' || style === 'normal' ? { style } : {}) });
      lockDown(res, specimen.contentSecurityPolicy);
      res.setHeader('Cache-Control', 'no-store');
      res.type('text/html; charset=utf-8').send(specimen.html);
    } catch (error) { fail(res, error); }
  });
  app.get('/api/workbench/fonts/files/:sha256', async (req, res) => {
    const digest = String(req.params.sha256);
    const read = SHA.test(digest) ? await deps.fonts.readFile(digest) : { state: 'unavailable' as const, reason: 'font-file-unknown' };
    if (read.state !== 'available') return deps.http.sendApiError(res, 404, 'font-file-unavailable', `Font file is unavailable (${read.reason})`);
    lockDown(res);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type(read.contentType).send(read.bytes);
  });
  app.get('/api/workbench/fonts/notices/:sha256', async (req, res) => {
    const digest = String(req.params.sha256);
    const read = SHA.test(digest) ? await deps.fonts.readNotice(digest) : { state: 'unavailable' as const, reason: 'font-notice-unknown' };
    if (read.state !== 'available') return deps.http.sendApiError(res, 404, 'font-notice-unavailable', `Font notice is unavailable (${read.reason})`);
    lockDown(res);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('text/plain; charset=utf-8').send(read.text);
  });
}
