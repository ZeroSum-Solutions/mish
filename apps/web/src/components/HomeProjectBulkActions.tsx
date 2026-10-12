import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, DialogDescription, DialogFooter, DialogTitle } from '@mish/components';
import type { ProjectBulkAction, ProjectBulkResult } from '@mish/contracts';
import type { Project } from '../types';
import { useT } from '../i18n';
import styles from './HomeProjectBulkActions.module.css';

interface Props {
  active: boolean;
  selected: Project[];
  visible: Project[];
  disabled: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onCancel: () => void;
  onCompleted: (ids: string[]) => void;
  onBusyChange?: (busy: boolean) => void;
  onResultsChange?: (visible: boolean) => void;
  onDelete?: (id: string, options?: { ifIdle?: boolean }) => boolean | void | Promise<boolean | void>;
  onArchive?: (id: string, archived: boolean, options?: { bulk?: boolean }) => boolean | void | Promise<boolean | void>;
  onDeleteRequested?: () => void;
  onDeleteResult?: (counts: { requested: number; succeeded: number; failed: number; duration: number }) => void;
  children?: ReactNode;
}

/** One batch, one confirmation, and an outcome for every requested project. */
export function HomeProjectBulkActions(props: Props) {
  const t = useT();
  const titleId = useId();
  const dialogId = useId();
  const descriptionId = useId();
  const [confirm, setConfirm] = useState<Project[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<(ProjectBulkResult & { name: string })[]>([]);
  useEffect(() => {
    if (!confirm) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = document.getElementById(dialogId);
    const backdrop = dialog?.parentElement;
    const inertSiblings = Array.from(document.body.children).filter(element => element !== backdrop && !element.hasAttribute('inert'));
    for (const element of inertSiblings) element.setAttribute('inert', '');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? []);
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = focusable();
      const first = controls[0];
      const last = controls.at(-1);
      if (!dialog?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      for (const element of inertSiblings) element.removeAttribute('inert');
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [confirm, dialogId]);
  const busyRef = useRef(false);
  const busy = progress !== null;
  const cancelRef = useRef(props.onCancel);
  cancelRef.current = props.onCancel;
  useEffect(() => {
    if (!props.active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || confirm) return;
      if (document.activeElement?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], dialog')) return;
      event.preventDefault();
      setConfirm(null);
      cancelRef.current();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [props.active, confirm]);

  function clearResults() {
    setResults([]);
    props.onResultsChange?.(false);
  }

  async function execute(action: ProjectBulkAction, targets: Project[]) {
    if (busyRef.current || targets.length === 0) return;
    const startedAt = performance.now();
    busyRef.current = true;
    props.onBusyChange?.(true);
    setConfirm(null);
    clearResults();
    setProgress({ done: 0, total: targets.length });
    const outcomes: (ProjectBulkResult & { name: string })[] = [];
    // Sequential requests keep progress honest and avoid saturating the daemon.
    for (const project of targets) {
      try {
        const result = action === 'delete'
          ? await props.onDelete?.(project.id, { ifIdle: true })
          : await props.onArchive?.(project.id, action === 'archive', { bulk: true });
        if (result === false) throw new Error(t('homeBulk.requestFailed'));
        outcomes.push({ id: project.id, name: project.name, ok: true });
      } catch (error) {
        outcomes.push({ id: project.id, name: project.name, ok: false,
          error: error instanceof Error ? error.message : t('homeBulk.requestFailed') });
      }
      setProgress({ done: outcomes.length, total: targets.length });
    }
    if (action === 'delete') props.onDeleteResult?.({ requested: targets.length, succeeded: outcomes.filter(result => result.ok).length, failed: outcomes.filter(result => !result.ok).length, duration: Math.round(performance.now() - startedAt) });
    setResults(outcomes);
    props.onResultsChange?.(true);
    setProgress(null);
    busyRef.current = false;
    props.onBusyChange?.(false);
    props.onCompleted(outcomes.filter(result => result.ok).map(result => result.id));
  }
  const failures = results.filter(result => !result.ok);
  const archiveTargets = props.selected.filter(project => project.metadata?.archived !== true);
  const unarchiveTargets = props.selected.filter(project => project.metadata?.archived === true);
  return (
    <div className={`${styles.root} ${props.active || busy || results.length ? styles.active : ''}`} aria-hidden={!props.active && !busy && !results.length ? true : undefined}>
      <div hidden={!props.active} className={styles.bar} role="group" aria-label={t('homeBulk.actions')} aria-busy={busy}>
        <strong>{t('homeBulk.selected', { n: props.selected.length })}</strong>
        <Button size="sm" disabled={busy || !props.visible.length} onClick={props.onSelectAll}>{t('homeBulk.selectAll')}</Button>
        <Button size="sm" variant="ghost" disabled={busy || !props.selected.length} onClick={props.onClear}>{t('homeBulk.clear')}</Button>
        {props.onDelete ? <Button size="sm" className={styles.danger} disabled={busy || props.disabled} onClick={() => { props.onDeleteRequested?.(); setConfirm([...props.selected]); }}>{t('homeBulk.delete')}</Button> : null}
        {props.onArchive && archiveTargets.length ? <Button size="sm" disabled={busy || props.disabled} onClick={() => void execute('archive', archiveTargets)}>{t('homeBulk.archive')}</Button> : null}
        {props.onArchive && unarchiveTargets.length ? <Button size="sm" disabled={busy || props.disabled} onClick={() => void execute('unarchive', unarchiveTargets)}>{t('homeBulk.unarchive')}</Button> : null}
        {!busy ? props.children : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { clearResults(); props.onCancel(); }}>{t('homeBulk.cancel')}</Button>
      </div>
      <div role="status" aria-live="polite" className={styles.status}>
        {progress ? t('homeBulk.progress', { n: progress.done, total: progress.total }) : results.length ? t('homeBulk.result', { succeeded: results.length - failures.length, failed: failures.length }) : ''}
      </div>
      {!props.active && results.length ? <Button size="sm" variant="ghost" onClick={clearResults}>{t('homeBulk.clear')}</Button> : null}
      {failures.length ? <ul className={styles.failures}>{failures.map(result => <li key={result.id}>{result.name}: {result.error}</li>)}</ul> : null}
      {confirm ? createPortal(<Dialog id={dialogId} role="alertdialog" ariaLabelledBy={titleId} ariaDescribedBy={descriptionId} onClose={() => setConfirm(null)} closeOnEscape>
        <DialogTitle id={titleId}>{t('homeBulk.confirmTitle', { n: confirm.length, suffix: confirm.length === 1 ? '' : 's' })}</DialogTitle>
        <DialogDescription id={descriptionId}>{t('homeBulk.confirmDescription')}</DialogDescription>
        <ul>{confirm.slice(0, 5).map(project => <li key={project.id}>{project.name}</li>)}</ul>
        {confirm.length > 5 ? <p>{t('homeBulk.more', { n: confirm.length - 5 })}</p> : null}
        <DialogFooter>
          <Button onClick={() => setConfirm(null)}>{t('homeBulk.cancel')}</Button>
          <Button className={styles.danger} onClick={() => void execute('delete', confirm)}>{t('homeBulk.delete')}</Button>
        </DialogFooter>
      </Dialog>, document.body) : null}
    </div>
  );
}
