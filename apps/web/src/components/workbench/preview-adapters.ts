import type { PreviewAdapterFamily } from '@mish/contracts';
import { findRealTagEnd, HTML_TAG_PATTERNS } from '@mish/contracts/runtime/html-injection-points';

/**
 * AC-R07 preamble: the readiness checks a preview adapter family adds on top of the plain HTML
 * document's (load, observability, 8-second deadline). Each family's guard runs first in the
 * sandboxed document and reports to the Enlarge host with one message shape; the host accepts it
 * only from the pinned frame window.
 *
 * - `webgl`: wraps `HTMLCanvasElement#getContext` for WebGL kinds. A null context is
 *   `unavailable`; `webglcontextlost` is `lost` and a restore is `ready` again. At most one live
 *   WebGL canvas per preview (technical-spec: one live GPU canvas per enlarged preview): another
 *   canvas gets no context, so its own static fallback shows, and the host is told (`limited`).
 *   A document that never asks for a context is probed once after load, so a missing WebGL
 *   still fails closed.
 * - `styled-components`: ready only when the runtime has injected rules into a
 *   `style[data-styled]` element after load; otherwise `failed`. A document whose runtime threw
 *   or whose styles were blocked never reports ready.
 */
export type AdapterReportState = 'ready' | 'unavailable' | 'lost' | 'limited' | 'failed';
export interface AdapterReport { adapter: PreviewAdapterFamily; state: AdapterReportState }
const MESSAGE_TYPE = 'od:workbench-adapter';

const WEBGL_GUARD = `(function(){
  var post = function(state){ try { window.parent.postMessage({ type: '${MESSAGE_TYPE}', adapter: 'webgl', state: state }, '*'); } catch (e) {} };
  var proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  if (!proto || typeof proto.getContext !== 'function') { post('unavailable'); return; }
  var original = proto.getContext;
  var live = null;
  var requested = false;
  var GL = /^(?:webgl2?|experimental-webgl)$/;
  proto.getContext = function(kind){
    if (!GL.test(String(kind))) return original.apply(this, arguments);
    requested = true;
    if (live && live !== this) { post('limited'); return null; }
    var context = original.apply(this, arguments);
    if (!context) { post('unavailable'); return context; }
    if (live !== this) {
      live = this;
      this.addEventListener('webglcontextlost', function(){ post('lost'); });
      this.addEventListener('webglcontextrestored', function(){ post('ready'); });
    }
    post('ready');
    return context;
  };
  window.addEventListener('load', function(){
    if (requested) return;
    var probe = null;
    try { probe = original.call(document.createElement('canvas'), 'webgl'); } catch (e) {}
    if (!probe) { post('unavailable'); return; }
    var lose = probe.getExtension && probe.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  });
})();`;

const STYLED_GUARD = `(function(){
  var post = function(state){ try { window.parent.postMessage({ type: '${MESSAGE_TYPE}', adapter: 'styled-components', state: state }, '*'); } catch (e) {} };
  function injected(){
    var sheets = document.querySelectorAll('style[data-styled]');
    for (var i = 0; i < sheets.length; i++) {
      var rules = 0;
      try { rules = sheets[i].sheet && sheets[i].sheet.cssRules ? sheets[i].sheet.cssRules.length : 0; } catch (e) {}
      if (rules > 0 || (sheets[i].textContent || '').trim()) return true;
    }
    return false;
  }
  window.addEventListener('load', function(){
    var delays = [0, 50, 250, 1000];
    (function check(index){
      if (injected()) { post('ready'); return; }
      if (index >= delays.length - 1) { post('failed'); return; }
      setTimeout(function(){ check(index + 1); }, delays[index + 1] - delays[index]);
    })(0);
  });
})();`;

/** The guard `<script>` for a family that has one, or null. */
export function adapterGuardScript(adapter: PreviewAdapterFamily | undefined): string | null {
  const body = adapter === 'webgl' ? WEBGL_GUARD : adapter === 'styled-components' ? STYLED_GUARD : null;
  return body ? `<script data-od-workbench-adapter="${adapter}">${body}</script>` : null;
}

/** Puts the family's guard at the start of the real head, before any author script. */
export function withAdapterGuard(html: string, adapter: PreviewAdapterFamily | undefined): string {
  const guard = adapterGuardScript(adapter);
  if (!guard) return html;
  const headEnd = findRealTagEnd(html, HTML_TAG_PATTERNS.headOpen);
  if (headEnd >= 0) return html.slice(0, headEnd) + guard + html.slice(headEnd);
  const htmlEnd = findRealTagEnd(html, HTML_TAG_PATTERNS.htmlOpen);
  return htmlEnd >= 0 ? html.slice(0, htmlEnd) + `<head>${guard}</head>` + html.slice(htmlEnd) : `<!doctype html><html><head>${guard}</head><body>${html}</body></html>`;
}

const STATES: ReadonlySet<string> = new Set(['ready', 'unavailable', 'lost', 'limited', 'failed']);
/** A guard report for exactly this adapter, or null. */
export function parseAdapterReport(data: unknown, adapter: PreviewAdapterFamily | undefined): AdapterReport | null {
  if (!adapter || typeof data !== 'object' || data === null) return null;
  const value = data as Record<string, unknown>;
  if (value.type !== MESSAGE_TYPE || value.adapter !== adapter || typeof value.state !== 'string' || !STATES.has(value.state)) return null;
  return { adapter, state: value.state as AdapterReportState };
}
