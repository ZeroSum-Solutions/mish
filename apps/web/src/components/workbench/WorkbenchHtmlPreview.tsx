import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type { PreviewAdapterFamily } from '@open-design/contracts';
import { parsePreviewObservabilityMessage } from '@open-design/contracts/runtime/preview-observability';
import { findRealTagEnd, HTML_TAG_PATTERNS } from '@open-design/contracts/runtime/html-injection-points';
import { buildSrcdoc } from '../../runtime/srcdoc';
import { useT } from '../../i18n';
import styles from './workbench.module.css';
import { WorkbenchExpandedContext } from './WorkbenchPreviewShell';
import { WorkbenchViewportContext } from './WorkbenchViewport';
import { useCatalogPreviewStage } from '../CatalogPreviewViewer';
import { previewFloorPolicy, withHeadPolicies } from './preview-policy';
import { parseAdapterReport, withAdapterGuard } from './preview-adapters';

/** Same-origin daemon routes whose responses may become a sandboxed preview document:
 * plugin/genui/section previews, a design-system package's rendered preview or one
 * of its declared package files in path form (`static/<package path>`, which serves
 * without a redirect and gives the document its own base), the workbench's static
 * specimen for an owned token cohort (one opaque resource key, then `/preview`), and a
 * GSAP recipe's preview (AC-R08.5) and a React95 kit template's preview (AC-R17.2), each a
 * self-contained document (pinned runtime inline) served with a no-network policy, and a stored file of an owned
 * import (AC-R12.4, `imports/<id>/files/<path>`, served with a sandbox and no-connect policy). Other design-system routes (archive, file listing,
 * workspace, the redirecting `static?path=` form) and every other workbench route never load. */
function isWorkbenchPreviewDocumentPath(pathname: string): boolean {
  return /^\/api\/(plugins|genui|sections)\//.test(pathname)
    || /^\/api\/design-systems\/[^/]+\/(preview|static\/[^?#]+)$/.test(pathname)
    || /^\/api\/workbench\/resources\/[A-Za-z0-9_-]+\/preview$/.test(pathname)
    || /^\/api\/workbench\/recipes\/gsap\/[^/]+\/preview$/.test(pathname)
    || /^\/api\/workbench\/kits\/react95\/[^/]+\/preview$/.test(pathname)
    || /^\/api\/workbench\/imports\/import-[a-f0-9]{16}\/files\/[^?#]+$/.test(pathname);
}

type PreviewState = 'loading' | 'ready' | 'error' | 'unavailable' | 'outdated';
/** Why an adapter's own check failed closed; drives the labelled fallback text. */
type AdapterFailure = 'webgl-unavailable' | 'webgl-context-lost' | 'styled-components-styles-missing';
const FAILURE_TEXT = {
  'webgl-unavailable': 'workbench.preview.webglUnavailable',
  'webgl-context-lost': 'workbench.preview.webglLost',
  'styled-components-styles-missing': 'workbench.preview.styledMissing',
} as const;

/** Report actual content paint without waiting for every image's load/timeout. The
 * script runs under the same response and floor policies as the author document. */
export function withFirstPaintReport(html: string, url: string, attempt: number, generation: number): string {
  const payload = JSON.stringify({ type: 'od:workbench-preview-painted', url, attempt, generation }).replace(/</g, '\\u003c');
  const script = `<script data-od-workbench-paint-report data-generation="${generation}">(function(){
    try {
      var observer = new PerformanceObserver(function(list){
        if (!list.getEntries().some(function(entry){ return entry.name === 'first-contentful-paint'; })) return;
        window.parent.postMessage(${payload}, '*');
        observer.disconnect();
      });
      observer.observe({ type: 'paint', buffered: true });
    } catch (e) {}
  })();</script>`;
  const headEnd = findRealTagEnd(html, HTML_TAG_PATTERNS.headOpen);
  if (headEnd >= 0) return html.slice(0, headEnd) + script + html.slice(headEnd);
  const htmlEnd = findRealTagEnd(html, HTML_TAG_PATTERNS.htmlOpen);
  return htmlEnd >= 0 ? html.slice(0, htmlEnd) + `<head>${script}</head>` + html.slice(htmlEnd) : `<!doctype html><html><head>${script}</head><body>${html}</body></html>`;
}

/** Materialize permitted HTML through the existing sandbox harness. Enlarge never changes srcDoc.
 * `adapter` names the preview family whose extra readiness check runs (AC-R07 preamble). */
export function WorkbenchHtmlPreview({ title, url, thumbnail = false, adapter }: { title: string; url: string; thumbnail?: boolean; adapter?: PreviewAdapterFamily }) {
  const t = useT();
  const expanded = useContext(WorkbenchExpandedContext);
  // AC-R07.2: an enlarged document lays out at the chosen width, scaled down to fit the dialog.
  // The stage, box and iframe are always the same nodes, so a width change never reloads it.
  const viewport = useContext(WorkbenchViewportContext);
  const fixed = expanded && viewport !== 'fit' ? viewport : null;
  const layout = useCatalogPreviewStage(fixed ?? 'fit');
  const frame = useRef<HTMLIFrameElement>(null);
  const runtimeFailed = useRef(false);
  const adapterFailed = useRef(false);
  // Author documents can forge paint reports. Only a load deadline is recoverable.
  const loadTimedOut = useRef(false);
  // The frame's WindowProxy survives navigations, including A -> B -> A. Pin the
  // paint report to this fetched document, not just its URL or retry number.
  const paintGeneration = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [documentHtml, setDocumentHtml] = useState<string | null>(null);
  // `outdated` (409): the reference names a revision the source no longer has. Retrying the
  // same URL can never succeed, so the user is sent back to search instead.
  const [state, setState] = useState<PreviewState>('loading');
  const [failure, setFailure] = useState<AdapterFailure | null>(null);
  const [limited, setLimited] = useState(false);
  const [base, setBase] = useState('');
  const [warning, setWarning] = useState(false);
  // A styled-components document is ready only on its runtime's report, never on load alone.
  const readyOnLoad = adapter !== 'styled-components';
  useEffect(() => {
    const abort = new AbortController();
    const generation = ++paintGeneration.current;
    let cancelled = false;
    runtimeFailed.current = false;
    loadTimedOut.current = false;
    setDocumentHtml(null); setState('loading'); setWarning(false); setFailure(null); setLimited(false);
    const timeout = window.setTimeout(() => { if (!cancelled) { loadTimedOut.current = true; setState((current) => current === 'loading' ? 'error' : current); } }, 8000);
    async function load() {
      try {
        const target = new URL(url, window.location.href);
        if (target.origin !== window.location.origin || !isWorkbenchPreviewDocumentPath(target.pathname)) throw new Error('unsupported-preview-origin');
        const response = await fetch(target.pathname + target.search, { signal: abort.signal, redirect: 'error' });
        if (!response.ok) { window.clearTimeout(timeout); if (!cancelled) { loadTimedOut.current = false; setState(response.status === 404 ? 'unavailable' : response.status === 409 ? 'outdated' : 'error'); } return; }
        if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) throw new Error('unsupported-preview-content');
        const html = await response.text();
        // srcDoc does not inherit the fetched response's CSP. Retain every directive
        // that a meta policy supports; frame-ancestors is enforced by our host sandbox.
        // The no-network floor always follows it, so no route can admit a CDN.
        const policy = response.headers.get('content-security-policy')?.split(';').filter((part) => !/^\s*(frame-ancestors|report-uri|report-to|sandbox)\b/i.test(part)).join(';');
        const reported = withFirstPaintReport(withAdapterGuard(html, adapter), url, attempt, generation);
        const policed = withHeadPolicies(reported, [...(policy ? [policy] : []), previewFloorPolicy(window.location.origin, target.pathname)]);
        if (!cancelled) { setBase(target.href); setDocumentHtml(policed); }
      } catch { window.clearTimeout(timeout); if (!cancelled && !abort.signal.aborted) { loadTimedOut.current = false; setState('error'); } }
    }
    void load();
    return () => { cancelled = true; abort.abort(); window.clearTimeout(timeout); };
  }, [url, attempt, adapter]);
  const srcDoc = useMemo(() => documentHtml === null ? undefined : buildSrcdoc(documentHtml, { baseHref: base, previewFocusGuard: true, previewObservability: true, workbenchKeyboard: true, reloadKey: attempt }), [documentHtml, base, attempt]);
  useEffect(() => {
    function message(event: MessageEvent) {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
      const paint = event.data;
      if (paint && typeof paint === 'object' && paint.type === 'od:workbench-preview-painted'
        && paint.url === url && paint.attempt === attempt && paint.generation === paintGeneration.current
        && documentHtml !== null && readyOnLoad && !runtimeFailed.current && !adapterFailed.current) {
        setState((current) => current === 'loading' || current === 'error' && loadTimedOut.current ? 'ready' : current);
      }
      const report = parsePreviewObservabilityMessage(event.data);
      if (report?.event === 'white_screen') { runtimeFailed.current = true; setState('error'); }
      else if (report && ['runtime_error', 'unhandled_rejection', 'deck_stage_unscaled'].includes(report.event)) setWarning(true);
      const adapterReport = parseAdapterReport(event.data, adapter);
      if (!adapterReport || runtimeFailed.current) return;
      switch (adapterReport.state) {
        // Fail closed: the fallback replaces the live canvas until a context is restored or a retry.
        case 'unavailable': adapterFailed.current = true; setFailure('webgl-unavailable'); setState('unavailable'); break;
        case 'lost': adapterFailed.current = true; setFailure('webgl-context-lost'); setState('unavailable'); break;
        case 'failed': adapterFailed.current = true; setFailure('styled-components-styles-missing'); setState('error'); break;
        case 'limited': setLimited(true); break;
        case 'ready': adapterFailed.current = false; setFailure(null); setState('ready'); break;
      }
    }
    window.addEventListener('message', message);
    return () => window.removeEventListener('message', message);
  }, [adapter, url, attempt, documentHtml, readyOnLoad]);
  useEffect(() => { adapterFailed.current = false; }, [url, attempt, adapter]);
  return <div className={styles.html} data-preview-state={state} data-preview-adapter={adapter} data-preview-reason={failure ?? undefined}>
    <div ref={layout.stageRef} className={styles.viewportStage} data-preview-viewport={fixed ?? 'fit'}>
      <div className={styles.viewportBox} data-fixed={fixed !== null || undefined} style={fixed === null ? undefined : { width: Math.round(layout.frameWidth * layout.scale), height: Math.round(layout.frameHeight * layout.scale) }}>
        <iframe ref={frame} title={`${title} preview`} sandbox="allow-scripts" className={styles.frame} tabIndex={thumbnail && !expanded ? -1 : undefined} aria-hidden={thumbnail && !expanded || undefined} srcDoc={srcDoc}
          style={fixed === null ? undefined : { width: `${layout.frameWidth}px`, height: `${layout.frameHeight}px`, transform: `scale(${layout.scale})`, transformOrigin: '0 0' }}
          onLoad={() => { if (readyOnLoad && documentHtml !== null && !runtimeFailed.current && !adapterFailed.current) setState((current) => current === 'loading' || current === 'error' && loadTimedOut.current ? 'ready' : current); }} onErrorCapture={() => { runtimeFailed.current = true; loadTimedOut.current = false; setState('error'); }} />
      </div>
    </div>
    {warning && state === 'ready' ? <div className={styles.warning} role="status">{t('workbench.previewWarning')}</div> : null}
    {limited && state === 'ready' && !warning ? <div className={styles.warning} role="status">{t('workbench.preview.webglLimited')}</div> : null}
    {state !== 'ready' ? <div className={styles.status} role={state === 'loading' ? 'status' : 'alert'}>
      <span>{failure ? t(FAILURE_TEXT[failure]) : t(state === 'loading' ? 'workbench.previewLoading' : state === 'unavailable' ? 'workbench.previewUnavailable' : state === 'outdated' ? 'workbench.previewOutdated' : 'workbench.previewError')}</span>
      {state !== 'loading' && state !== 'outdated' ? <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>{t('preview.retry')}</Button> : null}
    </div> : null}
  </div>;
}
