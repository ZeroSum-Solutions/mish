import { createContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@open-design/components';
import { useT } from '../../i18n';
import { navigate } from '../../router';
import styles from './workbench.module.css';

export const WorkbenchExpandedContext = createContext(false);

/** Enlarge the existing wrapper. Never portal, replace or reparent its document. */
export function WorkbenchPreviewShell({ title, children, onExpandedChange, thumbnail = false }: {
  title: string; children: ReactNode; onExpandedChange?: (expanded: boolean) => void; thumbnail?: boolean;
}) {
  const t = useT();
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLButtonElement>(null);
  const hadExpanded = useRef(false);
  const callback = useRef(onExpandedChange);
  callback.current = onExpandedChange;
  function goHome() {
    if (window.location.pathname === '/') setExpanded(false);
    else navigate({ kind: 'home', view: 'home' }, { onCommit: () => setExpanded(false) });
  }
  useLayoutEffect(() => {
    if (!expanded) { if (hadExpanded.current) trigger.current?.focus(); return; }
    if (!root.current) return;
    hadExpanded.current = true;
    const dialog = root.current;
    const undo: (() => void)[] = [];
    // Siblings at every level are background. Ancestors must remain operable.
    let child: HTMLElement = dialog;
    for (let ancestor = dialog.parentElement; ancestor; ancestor = ancestor.parentElement) {
      for (const sibling of Array.from(ancestor.children)) {
        if (sibling === child || !(sibling instanceof HTMLElement)) continue;
        const before = sibling.getAttribute('inert');
        sibling.setAttribute('inert', '');
        undo.push(() => before === null ? sibling.removeAttribute('inert') : sibling.setAttribute('inert', before));
      }
      // Fixed-position descendants otherwise inherit transformed/contained bounds.
      const properties = ['transform', 'translate', 'rotate', 'scale', 'filter', 'backdrop-filter', 'perspective', 'contain', 'container-type', 'will-change', 'content-visibility', 'z-index'];
      const values = properties.map((name) => [name, ancestor!.style.getPropertyValue(name), ancestor!.style.getPropertyPriority(name)]);
      const node = ancestor;
      properties.forEach((name) => node.style.setProperty(name, name === 'z-index' ? '2147483000' : name === 'container-type' ? 'normal' : name === 'content-visibility' ? 'visible' : name === 'will-change' ? 'auto' : 'none', 'important'));
      undo.push(() => values.forEach(([name, value, priority]) => value ? node.style.setProperty(name!, value!, priority) : node.style.removeProperty(name!)));
      child = ancestor;
    }
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    callback.current?.(true);
    restore.current?.focus();
    function close() { setExpanded(false); }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close();
      } else if (event.key === 'Tab') {
        const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, textarea, a[href], iframe, [tabindex="0"]')).filter((node) => !node.hidden && !node.closest('[inert]'));
        const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    function message(event: MessageEvent) {
      const frame = dialog.querySelector('iframe');
      if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
      if (event.data?.type === 'od:workbench-escape') close();
      if (event.data?.type === 'od:workbench-focus-boundary' && typeof event.data.backward === 'boolean') restore.current?.focus();
    }
    function syncFrame() { dialog.querySelector('iframe')?.contentWindow?.postMessage({ type: 'od:workbench-enlarged', expanded: true }, '*'); }
    syncFrame();
    dialog.addEventListener('load', syncFrame, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('message', message);
    return () => {
      dialog.removeEventListener('load', syncFrame, true);
      dialog.querySelector('iframe')?.contentWindow?.postMessage({ type: 'od:workbench-enlarged', expanded: false }, '*');
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('message', message);
      undo.reverse().forEach((fn) => fn());
      document.body.style.overflow = priorOverflow;
      callback.current?.(false);
      if (trigger.current?.isConnected) trigger.current.focus();
    };
  }, [expanded]);
  return <div ref={root} className={`${styles.previewShell}${thumbnail ? ` ${styles.thumbnail}` : ''}${expanded ? ` ${styles.expanded}` : ''}`} data-workbench-expanded={expanded || undefined} data-workbench-retained={expanded || hadExpanded.current || undefined} role={expanded ? 'dialog' : undefined} aria-modal={expanded ? true : undefined} aria-labelledby={expanded ? titleId : undefined}>
    <div className={styles.previewToolbar}>
      <Button ref={restore} size="sm" hidden={!expanded} onClick={() => setExpanded(false)}>{t('workbench.backToPreview')}</Button>
      <span id={titleId}>{title}</span>
      <Button ref={trigger} size="sm" hidden={expanded} onClick={() => setExpanded(true)}>{t('workbench.enlarge')}</Button>
      <Button size="sm" hidden={!expanded} onClick={goHome}>{t('entry.navHome')}</Button>
    </div>
    <WorkbenchExpandedContext.Provider value={expanded}><div className={styles.previewContent}>{children}</div></WorkbenchExpandedContext.Provider>
  </div>;
}
