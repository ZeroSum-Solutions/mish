import { useEffect, useId, useRef, useState } from 'react';
import { Badge, Button, Input, Select, Spinner } from '@open-design/components';
import { MEDIA_TASK_CANCELLED_CODE, type MediaGalleryEntry, type MediaGalleryEntryDetail, type WorkspaceCollabContext } from '@open-design/contracts';
import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { projectRawUrl } from '../../providers/registry';
import { listProjects } from '../../state/projects';
import type { Project } from '../../types';
import { mediaApi, newIdempotencyKey } from './media-api';
import { mediaEntryView, mediaFileBaseName, type MediaEntryStatusView } from './media-entry-state';
import { useInert } from './use-inert';
import styles from './MediaWorkbench.module.css';

const STATUS_KEY: Record<MediaEntryStatusView, keyof Dict> = {
  queued: 'mediaWorkbench.status.queued',
  running: 'mediaWorkbench.status.running',
  done: 'mediaWorkbench.status.done',
  failed: 'mediaWorkbench.status.failed',
  cancelled: 'mediaWorkbench.status.cancelled',
  'restart-interrupted': 'mediaWorkbench.status.restartInterrupted',
  interrupted: 'mediaWorkbench.status.interrupted',
};

const RELATION_KEY = {
  original: 'mediaWorkbench.chain.relation.original',
  retry: 'mediaWorkbench.chain.relation.retry',
  edit: 'mediaWorkbench.chain.relation.edit',
  reuse: 'mediaWorkbench.chain.relation.reuse',
} as const satisfies Record<MediaGalleryEntry['lineage']['relation'], keyof Dict>;

const SAFETY_KEY = {
  'safety.nsfw': 'chat.record.failedSafetyNsfw',
  'safety.unspecified': 'chat.record.failedSafetyUnspecified',
} as const satisfies Record<NonNullable<MediaGalleryEntry['provenance']['safetyCategory']>, keyof Dict>;

const BADGE_TONE = { neutral: 'neutral', info: 'info', success: 'success', warning: 'warning', danger: 'danger' } as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatTime(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(epochMs).toISOString();
  }
}

/** A disclosure region that stays mounted and toggles its open class (UI system §9). */
function Collapsible({ open, id, children }: { open: boolean; id: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useInert(ref, !open);
  return (
    <div id={id} ref={ref} className={`accordion-collapsible${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="accordion-collapsible-inner">
        <div className={styles.subpanel}>{children}</div>
      </div>
    </div>
  );
}

export interface MediaEntryRowProps {
  /** Source project selected in the gallery. */
  projectId: string;
  canvasProjectId: string;
  canvasProjectName: string;
  entry: MediaGalleryEntry;
  workspaceContext?: WorkspaceCollabContext | null;
  /** The entry changed in place (cancel). */
  onEntryChange: (entry: MediaGalleryEntry) => void;
  /** A new task started from this entry (retry). */
  onTaskStarted: () => void;
  /** The entry was unlinked and should leave the default listing. */
  onUnlinked: (entryId: string) => void;
}

/**
 * One gallery entry and the task behind it (AC-R10.1 task row, AC-R10.2
 * gallery entry). Download reads bytes; Place copies a named asset into the
 * current canvas project; Reuse copies into another project; Unlink hides the entry while
 * retaining bytes. Copies use existing reuse lineage, not generation credit.
 */
export function MediaEntryRow({ projectId, canvasProjectId, canvasProjectName, entry, workspaceContext, onEntryChange, onTaskStarted, onUnlinked }: MediaEntryRowProps) {
  const t = useT();
  const id = useId();
  const view = mediaEntryView(entry);
  const [busy, setBusy] = useState<'cancel' | 'retry' | 'place' | 'reuse' | 'unlink' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [panel, setPanel] = useState<'versions' | 'place' | 'reuse' | 'unlink' | null>(null);
  const [detail, setDetail] = useState<MediaGalleryEntryDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [target, setTarget] = useState('');
  const [output, setOutput] = useState(mediaFileBaseName(entry.file?.name ?? 'media.png'));
  const outputEdited = useRef(false);
  const placeKey = useRef<{ target: string; output: string; key: string } | null>(null);
  // One key per user intent: a repeated click after a network failure resends
  // the same key, so the daemon replays instead of starting a second task.
  const retryKey = useRef<string | null>(null);
  const reuseKey = useRef<{ target: string; key: string } | null>(null);

  const versionsOpen = panel === 'versions';
  const reuseOpen = panel === 'reuse';
  const placeOpen = panel === 'place';
  const unlinkOpen = panel === 'unlink';

  useEffect(() => {
    if (!versionsOpen || detail) return;
    let live = true;
    mediaApi.entry(projectId, entry.id, workspaceContext)
      .then((next) => { if (live) { setDetail(next); setDetailError(null); } })
      .catch((err: unknown) => { if (live) setDetailError(errorMessage(err)); });
    return () => { live = false; };
  }, [versionsOpen, detail, projectId, entry.id, workspaceContext]);

  // A status change (retry finished, cancel landed) makes the chain stale.
  useEffect(() => { setDetail(null); }, [entry.status, entry.output.state]);

  useEffect(() => {
    if (!reuseOpen || projects) return;
    let live = true;
    void listProjects({ workspaceContext }).then((list) => { if (live) setProjects(list); });
    return () => { live = false; };
  }, [reuseOpen, projects, workspaceContext]);

  const toggle = (next: 'versions' | 'place' | 'reuse' | 'unlink') => {
    if (next === 'place' && !outputEdited.current && entry.file) setOutput(mediaFileBaseName(entry.file.name));
    setPanel(current => current === next ? null : next);
  };

  async function run(kind: NonNullable<typeof busy>, action: () => Promise<void>) {
    if (busy) return;
    setBusy(kind);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(t('mediaWorkbench.action.failed', { message: errorMessage(err) }));
    } finally {
      setBusy(null);
    }
  }

  const cancel = () => run('cancel', async () => {
    const result = await mediaApi.cancel(entry.id, workspaceContext);
    onEntryChange({
      ...entry,
      status: 'interrupted',
      interruptReason: result.interruptReason,
      endedAt: result.endedAt,
      error: { message: 'cancelled by the user', code: MEDIA_TASK_CANCELLED_CODE, retryable: true },
    });
  });

  const retry = () => run('retry', async () => {
    retryKey.current ??= newIdempotencyKey();
    await mediaApi.retry(entry.id, retryKey.current, workspaceContext);
    retryKey.current = null;
    onTaskStarted();
  });

  const place = () => run('place', async () => {
    if (!output.trim()) return;
    if (placeKey.current?.target !== canvasProjectId || placeKey.current.output !== output) {
      placeKey.current = { target: canvasProjectId, output, key: newIdempotencyKey() };
    }
    const result = await mediaApi.place(projectId, entry.id, canvasProjectId, output, placeKey.current.key, workspaceContext);
    placeKey.current = null;
    setStatus(t('mediaWorkbench.place.done', { name: result.entry.file?.name ?? output, project: canvasProjectName }));
    onTaskStarted();
  });

  const reuse = () => run('reuse', async () => {
    if (!target) return;
    if (reuseKey.current?.target !== target) reuseKey.current = { target, key: newIdempotencyKey() };
    await mediaApi.reuse(projectId, entry.id, target, reuseKey.current.key, workspaceContext);
    reuseKey.current = null;
    const name = projects?.find((project) => project.id === target)?.name ?? target;
    setStatus(t('mediaWorkbench.reuse.done', { project: name }));
  });

  const unlink = () => run('unlink', async () => {
    await mediaApi.unlink(projectId, entry.id, workspaceContext);
    onUnlinked(entry.id);
  });

  // The preview shows whatever bytes are on record, stub placeholders
  // included (hatched and badged); only real output is downloadable/reusable.
  const previewFile = entry.output.state === 'current' || entry.output.state === 'moved' || entry.output.state === 'unverifiable'
    ? entry.file
    : undefined;
  const file = view.usableFile ? entry.file : undefined;
  const displayName = previewFile?.name ?? entry.output.recordedName ?? t('mediaWorkbench.entry.noFile');
  const src = previewFile ? projectRawUrl(projectId, previewFile.name, workspaceContext) : null;
  const kindLabel = entry.kind === 'video'
    ? t('mediaWorkbench.kind.video')
    : entry.kind === 'audio' ? t('mediaWorkbench.kind.audio') : t('mediaWorkbench.kind.image');
  const provenance = [kindLabel, entry.provenance.providerId, entry.provenance.model, formatTime(entry.createdAt)]
    .filter(Boolean)
    .join(' · ');
  const targets = (projects ?? []).filter((project) => project.id !== projectId);
  const versionsId = `${id}-versions`;
  const reuseId = `${id}-reuse`;
  const placeId = `${id}-place`;
  const unlinkId = `${id}-unlink`;
  const chainLabelId = `${id}-chain`;

  return (
    <li
      className={styles.entry}
      data-testid={`media-entry-${entry.id}`}
      data-stub={view.stub ? 'true' : 'false'}
      data-status={view.status}
      data-kind={entry.kind}
    >
      <div className={`${styles.thumb}${view.stub ? ` ${styles.stubThumb}` : ''}`}>
        {src && entry.kind === 'image' ? <img src={src} alt="" loading="lazy" /> : null}
        {src && entry.kind === 'video' ? <video src={src} preload="metadata" controls aria-label={displayName} /> : null}
        {src && entry.kind === 'audio' ? <audio src={src} preload="metadata" controls aria-label={displayName} /> : null}
        {!src ? <span>{kindLabel}</span> : null}
      </div>
      <div className={styles.entryBody}>
        <div className={styles.entryHead}>
          <span className={styles.entryName}>{mediaFileBaseName(displayName)}</span>
          <Badge tone={BADGE_TONE[view.tone]} dot>{t(STATUS_KEY[view.status])}</Badge>
          {view.stub ? <Badge tone="warning" title={t('mediaWorkbench.stubHint')}>{t('mediaWorkbench.stub')}</Badge> : null}
          {view.safetyCategory ? <Badge tone="danger">{t(SAFETY_KEY[view.safetyCategory])}</Badge> : null}
        </div>
        <p className={styles.meta}>{provenance}</p>
        {view.stub ? <p className={styles.notice}>{t('mediaWorkbench.stubHint')}</p> : null}
        {entry.output.state === 'superseded' ? <p className={styles.notice}>{t('mediaWorkbench.output.superseded')}</p> : null}
        {entry.output.state === 'missing' ? <p className={styles.notice}>{t('mediaWorkbench.output.missing')}</p> : null}
        {entry.output.state === 'moved' && previewFile ? <p className={styles.notice}>{t('mediaWorkbench.output.moved', { name: previewFile.name })}</p> : null}
        {entry.output.state === 'unverifiable' ? <p className={styles.notice}>{t('mediaWorkbench.output.unverifiable')}</p> : null}
        {view.safetyCategory ? (
          <p className={styles.notice}>{t('mediaWorkbench.safetyNoRetry')}</p>
        ) : view.nextStep ? (
          <p className={styles.notice}>{t(`mediaWorkbench.nextStep.${view.nextStep}` as keyof Dict)}</p>
        ) : null}

        <div className={styles.actions}>
          {view.canCancel ? (
            <Button size="sm" variant="secondary" loading={busy === 'cancel'} onClick={() => void cancel()}>
              {t('mediaWorkbench.action.cancel')}
            </Button>
          ) : null}
          {view.canRetry ? (
            <Button size="sm" variant="secondary" loading={busy === 'retry'} onClick={() => void retry()}>
              {t('mediaWorkbench.action.retry')}
            </Button>
          ) : null}
          {file && src ? (
            <a className={styles.linkButton} href={src} download={mediaFileBaseName(file.name)}>
              {t('mediaWorkbench.action.download')}
            </a>
          ) : null}
          {file ? (
            <Button size="sm" variant="ghost" aria-expanded={placeOpen} aria-controls={placeId} onClick={() => toggle('place')}>
              {t('mediaWorkbench.action.place', { project: canvasProjectName })}
            </Button>
          ) : null}
          {file ? (
            <Button size="sm" variant="ghost" aria-expanded={reuseOpen} aria-controls={reuseId} onClick={() => toggle('reuse')}>
              {t('mediaWorkbench.action.reuse')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" aria-expanded={versionsOpen} aria-controls={versionsId} onClick={() => toggle('versions')}>
            {t('mediaWorkbench.action.versions')}
          </Button>
          {!view.canCancel ? (
            <Button size="sm" variant="ghost" aria-expanded={unlinkOpen} aria-controls={unlinkId} onClick={() => toggle('unlink')}>
              {t('mediaWorkbench.action.unlink')}
            </Button>
          ) : null}
        </div>

        {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
        <p className={styles.liveRegion} role="status">{status}</p>

        <Collapsible open={versionsOpen} id={versionsId}>
          <span id={chainLabelId} className={styles.sectionTitle}>{t('mediaWorkbench.chain.heading')}</span>
          {detailError ? <p className={styles.error}>{t('mediaWorkbench.action.failed', { message: detailError })}</p> : null}
          {!detail && !detailError && versionsOpen ? <Spinner size="sm" label={t('mediaWorkbench.chain.loading')} /> : null}
          {detail ? (
            <ol className={styles.chain} aria-labelledby={chainLabelId}>
              {detail.chain.map((link) => {
                const linkView = mediaEntryView(link);
                return (
                  <li key={link.id} className={styles.chainItem} aria-current={link.id === entry.id ? 'true' : undefined}>
                    <span>{t(RELATION_KEY[link.lineage.relation])}</span>
                    {link.lineage.attempt > 1 ? <span>{t('mediaWorkbench.chain.attempt', { n: link.lineage.attempt })}</span> : null}
                    <Badge tone={BADGE_TONE[linkView.tone]}>{t(STATUS_KEY[linkView.status])}</Badge>
                    {linkView.stub ? <Badge tone="warning">{t('mediaWorkbench.stub')}</Badge> : null}
                    {!link.lineage.parentInProject ? <span>{t('mediaWorkbench.chain.fromOtherProject')}</span> : null}
                    <span className={styles.meta}>{formatTime(link.createdAt)}</span>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </Collapsible>

        {file ? (
          <Collapsible open={placeOpen} id={placeId}>
            <p className={styles.hint}>{t('mediaWorkbench.place.hint', { project: canvasProjectName })}</p>
            <label className={styles.field}>
              {t('mediaWorkbench.place.filename')}
              <Input value={output} onChange={event => { outputEdited.current = true; setOutput(event.target.value); }} maxLength={200} />
            </label>
            <div className={styles.actions}>
              <Button size="sm" variant="secondary" disabled={!output.trim()} loading={busy === 'place'} onClick={() => void place()}>
                {t('mediaWorkbench.place.submit')}
              </Button>
            </div>
          </Collapsible>
        ) : null}

        {file ? (
          <Collapsible open={reuseOpen} id={reuseId}>
            <p className={styles.hint}>{t('mediaWorkbench.reuse.hint')}</p>
            {projects && targets.length === 0 ? <p className={styles.hint}>{t('mediaWorkbench.reuse.noTargets')}</p> : null}
            <div className={styles.fieldRow}>
              <label className={styles.field}>
                {t('mediaWorkbench.reuse.target')}
                <Select value={target} onChange={(event) => setTarget(event.target.value)} disabled={!projects || targets.length === 0}>
                  <option value="">{t('mediaWorkbench.reuse.choose')}</option>
                  {targets.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </Select>
              </label>
            </div>
            <div className={styles.actions}>
              <Button size="sm" variant="secondary" disabled={!target} loading={busy === 'reuse'} onClick={() => void reuse()}>
                {t('mediaWorkbench.reuse.submit')}
              </Button>
            </div>
          </Collapsible>
        ) : null}

        {!view.canCancel ? (
          <Collapsible open={unlinkOpen} id={unlinkId}>
            <p className={styles.hint}>{t('mediaWorkbench.unlink.confirm')}</p>
            <div className={styles.actions}>
              <Button size="sm" variant="secondary" className={styles.destructive} loading={busy === 'unlink'} onClick={() => void unlink()}>
                {t('mediaWorkbench.unlink.submit')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>
                {t('mediaWorkbench.unlink.keep')}
              </Button>
            </div>
          </Collapsible>
        ) : null}
      </div>
    </li>
  );
}
