import { useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import { useT } from '../../i18n';
import styles from './workbench.module.css';

/** Same-origin daemon API paths only, with no dot segments; the contract already refuses others. */
function isLocalMediaPath(url: string): boolean {
  if (!/^\/api\/[^\s\\]+$/u.test(url) || url.startsWith('//')) return false;
  return !url.split(/[?#]/u)[0]!.split('/').some((segment) => segment === '.' || segment === '..' || /^%2e/iu.test(segment));
}

/**
 * AC-R07.1 native video preview, for a video item without an HTML preview. The bytes play in a
 * native `<video controls>` element, which decodes media and runs no script, so there is no
 * document to sandbox; instead the source is held to a same-origin daemon path, checked first
 * with a HEAD request (a missing source is unavailable, anything not served as `video/*` with
 * `nosniff` is refused before the player sees it), and the player cannot cast to a remote
 * device. Native controls keep it interactive and keyboard operable. Loading, error and retry
 * follow the image and font adapters, including their 8-second stalled-load deadline.
 */
export function WorkbenchVideoPreview({ title, url }: { title: string; url: string }) {
  const t = useT();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading');
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    setState('loading'); setChecked(false);
    const timeout = window.setTimeout(() => { if (!cancelled) setState((current) => current === 'loading' ? 'error' : current); }, 8000);
    async function check() {
      if (!isLocalMediaPath(url)) { window.clearTimeout(timeout); setState('error'); return; }
      try {
        const response = await fetch(url, { method: 'HEAD', signal: abort.signal, redirect: 'error' });
        if (cancelled) return;
        if (!response.ok) { window.clearTimeout(timeout); setState(response.status === 404 ? 'unavailable' : 'error'); return; }
        const type = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (!type.startsWith('video/') || response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') { window.clearTimeout(timeout); setState('error'); return; }
        setChecked(true);
      } catch { window.clearTimeout(timeout); if (!cancelled && !abort.signal.aborted) setState('error'); }
    }
    void check();
    return () => { cancelled = true; abort.abort(); window.clearTimeout(timeout); };
  }, [url, attempt]);
  return <div className={styles.media} data-preview-state={state} data-testid="workbench-video-preview">
    {checked ? <video key={attempt} className={styles.video} src={url} controls preload="metadata" playsInline disableRemotePlayback aria-label={title}
      onLoadedMetadata={() => setState('ready')} onError={() => setState('error')} /> : null}
    {state !== 'ready' ? <div className={styles.status} role={state === 'loading' ? 'status' : 'alert'}>
      <span>{t(state === 'loading' ? 'workbench.previewLoading' : state === 'unavailable' ? 'workbench.previewUnavailable' : 'workbench.enlarge.videoError')}</span>
      {state !== 'loading' ? <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>{t('preview.retry')}</Button> : null}
    </div> : null}
  </div>;
}
