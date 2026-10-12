import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog, DialogDescription, DialogTitle, IconButton } from '@mish/components';
import type { ProjectFile, WorkspaceCollabContext } from '@mish/contracts';
import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { mediaApi, type MediaCatalog } from './media-api';
import { MediaCreateForm } from './MediaCreateForm';
import { MediaGallery } from './MediaGallery';
import { useInert } from './use-inert';
import styles from './MediaWorkbench.module.css';

const DEFAULT_POLL_MS = 2_000;

export interface MediaWorkbenchPanelProps {
  projectId: string;
  /** Project files; image files are offered as reference inputs. */
  files: readonly ProjectFile[];
  workspaceContext?: WorkspaceCollabContext | null;
  /** Poll interval for queued/running tasks; 0 turns polling off. */
  pollMs?: number;
}

/**
 * The canvas media workbench body (AC-R10.1, AC-R10.2): a creation form over
 * the existing generate route and a gallery whose entries double as task
 * rows. Every action uses the same daemon endpoint as its `od media`
 * subcommand. No generation happens until the user presses Generate or Retry.
 */
export function MediaWorkbenchPanel({ projectId, files, workspaceContext, pollMs = DEFAULT_POLL_MS }: MediaWorkbenchPanelProps) {
  const t = useT();
  const [catalog, setCatalog] = useState<MediaCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    let live = true;
    mediaApi.catalog()
      .then((next) => { if (live) { setCatalog(next); setCatalogError(null); } })
      .catch((err: unknown) => { if (live) setCatalogError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, []);

  const onCreated = useCallback(() => {
    setAnnouncement(t('mediaWorkbench.create.started'));
    setReloadToken((token) => token + 1);
  }, [t]);

  return (
    <div className={styles.panel}>
      <MediaCreateForm
        projectId={projectId}
        files={files}
        catalog={catalog}
        catalogError={catalogError}
        workspaceContext={workspaceContext}
        onCreated={onCreated}
      />
      <p className={styles.liveRegion} role="status">{announcement}</p>
      <MediaGallery
        projectId={projectId}
        providers={catalog?.providers ?? []}
        reloadToken={reloadToken}
        pollMs={pollMs}
        workspaceContext={workspaceContext}
        announce={setAnnouncement}
      />
    </div>
  );
}

export interface MediaWorkbenchProps extends MediaWorkbenchPanelProps {}

/**
 * Canvas entry point: a "Media" action that opens the workbench in a dialog.
 * The dialog mounts on first open and then stays mounted, toggling its open
 * class so the exit transition plays and the form and gallery keep their
 * state between openings.
 */
export function MediaWorkbench({ projectId, files, workspaceContext, pollMs }: MediaWorkbenchProps) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const dialogId = `${id}-dialog`;

  useInert(backdropRef, !open);

  const show = () => {
    setMounted(true);
    setOpen(true);
  };
  // Focus returns to the trigger from the modal effect's cleanup, once the
  // page behind the dialog is no longer inert.
  const hide = useCallback(() => setOpen(false), []);

  // aria-modal is a promise the page must keep: while open, everything else
  // under <body> is inert, the page does not scroll, Tab and Shift+Tab cycle
  // inside the dialog, and Escape closes it. All of it is undone on close or
  // unmount (same shape as GoPlanSunsetDialog).
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const host = backdropRef.current;
    if (!host) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    const inertSiblings = Array.from(document.body.children).filter(
      (element) => element !== host && !element.hasAttribute('inert'),
    );
    for (const element of inertSiblings) element.setAttribute('inert', '');
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus({ preventScroll: true });

    const focusableInDialog = (): HTMLElement[] => {
      const panel = document.getElementById(dialogId);
      if (!panel) return [];
      return Array.from(panel.querySelectorAll<HTMLElement>(
        'video[controls], audio[controls], a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden') && !element.closest('[inert], [aria-hidden="true"]'));
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hide();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableInDialog();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const focused = document.activeElement;
      const outside = !focusable.includes(focused as HTMLElement);
      if (event.shiftKey && (focused === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (focused === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      for (const element of inertSiblings) element.removeAttribute('inert');
      document.body.style.overflow = previousBodyOverflow;
      const restore = previouslyFocused?.isConnected
        && previouslyFocused !== document.body
        && !host.contains(previouslyFocused)
        ? previouslyFocused
        : triggerRef.current;
      restore?.focus({ preventScroll: true });
    };
  }, [open, dialogId, hide]);

  return (
    <>
      <Button
        ref={triggerRef}
        size="sm"
        variant="ghost"
        aria-label={t('mediaWorkbench.open')}
        title={t('mediaWorkbench.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={mounted ? dialogId : undefined}
        data-testid="media-workbench-trigger"
        onClick={() => (open ? hide() : show())}
      >
        <Icon name="image" size={14} />
        <span>{t('mediaWorkbench.open')}</span>
      </Button>
      {/* Portalled so the host toolbar's button styles never reach the dialog. */}
      {mounted && typeof document !== 'undefined' ? createPortal(
        <div
          ref={backdropRef}
          aria-hidden={!open}
          data-testid="media-workbench-dialog"
          data-open={open ? 'true' : 'false'}
        >
          <Dialog
            id={dialogId}
            onClose={hide}
            ariaLabelledBy={titleId}
            ariaDescribedBy={descriptionId}
            className={styles.dialog}
            backdropClassName={`${styles.backdrop} ${open ? styles.backdropOpen : styles.backdropClosed}`}
          >
            <div className={styles.header}>
              <div className={styles.headerText}>
                <DialogTitle id={titleId}>{t('mediaWorkbench.title')}</DialogTitle>
                <DialogDescription id={descriptionId}>{t('mediaWorkbench.description')}</DialogDescription>
              </div>
              <IconButton ref={closeRef} label={t('mediaWorkbench.close')} onClick={hide}>
                <Icon name="close" size={16} />
              </IconButton>
            </div>
            <MediaWorkbenchPanel projectId={projectId} files={files} workspaceContext={workspaceContext} pollMs={pollMs} />
          </Dialog>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
