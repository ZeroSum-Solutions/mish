import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Chip, Input, Select, Spinner } from '@open-design/components';
import {
  MEDIA_TASK_STATUSES,
  type MediaGalleryEntry,
  type MediaSurface,
  type MediaTaskStatus,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { listProjects } from '../../state/projects';
import type { Project } from '../../types';
import type { Dict } from '../../i18n/types';
import { mediaApi, type MediaCatalogProvider, type MediaGalleryFilters } from './media-api';
import { isActiveMediaEntry, localDayEndExclusive, localDayStart } from './media-entry-state';
import { MediaEntryRow } from './MediaEntryRow';
import styles from './MediaWorkbench.module.css';

const STATUS_FILTER_KEY: Record<MediaTaskStatus, keyof Dict> = {
  queued: 'mediaWorkbench.status.queued',
  running: 'mediaWorkbench.status.running',
  done: 'mediaWorkbench.status.done',
  failed: 'mediaWorkbench.status.failed',
  interrupted: 'mediaWorkbench.status.interrupted',
};

const KIND_KEY: Record<MediaSurface, keyof Dict> = {
  image: 'mediaWorkbench.kind.image',
  video: 'mediaWorkbench.kind.video',
  audio: 'mediaWorkbench.kind.audio',
};

interface FilterForm {
  kind: MediaSurface | '';
  status: MediaTaskStatus[];
  provider: string;
  fromDay: string;
  toDay: string;
}

const EMPTY_FILTERS: FilterForm = { kind: '', status: [], provider: '', fromDay: '', toDay: '' };

function toQuery(form: FilterForm): MediaGalleryFilters {
  const from = form.fromDay ? localDayStart(form.fromDay) : undefined;
  const to = form.toDay ? localDayEndExclusive(form.toDay) : undefined;
  return {
    ...(form.kind ? { kind: form.kind } : {}),
    // Keep the contract's order so the query string is stable.
    status: MEDIA_TASK_STATUSES.filter((status) => form.status.includes(status)),
    ...(form.provider ? { provider: form.provider } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

function mergeEntries(current: MediaGalleryEntry[], next: MediaGalleryEntry[]): MediaGalleryEntry[] {
  const seen = new Set(current.map((entry) => entry.id));
  return [...current, ...next.filter((entry) => !seen.has(entry.id))];
}

export interface MediaGalleryProps {
  projectId: string;
  providers: readonly MediaCatalogProvider[];
  /** Bumped by the panel when a new task exists; reloads the first page. */
  reloadToken: number;
  /** Poll interval for queued/running entries; 0 turns polling off. */
  pollMs: number;
  workspaceContext?: WorkspaceCollabContext | null;
  announce: (message: string) => void;
}

/**
 * AC-R10.2 gallery: kind, status, provider and date filters over
 * `GET /api/projects/:id/media/gallery` with cursor paging. Each entry is
 * also the task row for AC-R10.1 (cancel, retry), and opens its version
 * chain from the gallery entry endpoint.
 */
export function MediaGallery({ projectId: canvasProjectId, providers, reloadToken, pollMs, workspaceContext, announce }: MediaGalleryProps) {
  const t = useT();
  const id = useId();
  const [projectId, setProjectId] = useState(canvasProjectId);
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => { setProjectId(canvasProjectId); }, [canvasProjectId]);
  useEffect(() => {
    let live = true;
    setProjects([]);
    void Promise.resolve(listProjects({ workspaceContext })).then(list => {
      if (live) setProjects(Array.isArray(list) ? list : []);
    }).catch(() => { if (live) setProjects([]); });
    return () => { live = false; };
  }, [workspaceContext]);
  const [form, setForm] = useState<FilterForm>(EMPTY_FILTERS);
  const [entries, setEntries] = useState<MediaGalleryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(() => toQuery(form), [form]);
  // Only the newest request may write; an older page arriving late is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setLoading(true);
    setEntries([]);
    setNextCursor(null);
    setError(null);
    mediaApi.gallery(projectId, query, null, workspaceContext)
      .then((page) => {
        if (generation.current !== mine) return;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (generation.current !== mine) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (generation.current === mine) setLoading(false);
      });
  }, [projectId, query, reloadToken, workspaceContext]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const page = await mediaApi.gallery(projectId, query, nextCursor, workspaceContext);
      if (generation.current !== mine) return;
      setEntries((current) => mergeEntries(current, page.entries));
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (generation.current === mine) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, projectId, query, workspaceContext]);

  // Follow queued/running entries until they settle, one entry read each.
  // `pollTick` re-arms the timer after every round, so polling continues
  // while the same tasks stay active, and stops once none are.
  const activeIds = entries.filter(isActiveMediaEntry).map((entry) => entry.id).join(',');
  const [pollTick, setPollTick] = useState(0);
  // Bumped on every local change to an entry (a cancel). A poll answer is
  // applied only when no local change happened since it was requested, so a
  // running snapshot asked for before a cancel can never undo the cancel,
  // even when both answers land in the same tick.
  const localRevisions = useRef(new Map<string, number>());
  const revisionOf = (entryId: string) => localRevisions.current.get(entryId) ?? 0;
  useEffect(() => {
    if (!pollMs || !activeIds) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const ids = activeIds.split(',');
      const askedAt = new Map(ids.map((entryId) => [entryId, revisionOf(entryId)]));
      void Promise.all(ids.map((entryId) => (
        mediaApi.entry(projectId, entryId, workspaceContext).then((detail) => detail.entry).catch(() => null)
      ))).then((updates) => {
        if (!live) return;
        const byId = new Map(updates.filter((entry): entry is MediaGalleryEntry => entry !== null).map((entry) => [entry.id, entry]));
        setEntries((current) => current.map((entry) => {
          const next = byId.get(entry.id);
          if (!next || revisionOf(entry.id) !== askedAt.get(entry.id)) return entry;
          // A settled task never goes back to queued or running.
          if (!isActiveMediaEntry(entry) && isActiveMediaEntry(next)) return entry;
          return next;
        }));
        setPollTick((tick) => tick + 1);
      });
    }, pollMs);
    return () => { live = false; window.clearTimeout(timer); };
  }, [activeIds, pollMs, pollTick, projectId, workspaceContext]);

  const replaceEntry = useCallback((next: MediaGalleryEntry) => {
    localRevisions.current.set(next.id, (localRevisions.current.get(next.id) ?? 0) + 1);
    setEntries((current) => current.map((entry) => (entry.id === next.id ? next : entry)));
  }, []);
  const removeEntry = useCallback((entryId: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== entryId));
    announce(t('mediaWorkbench.unlink.done'));
  }, [announce, t]);
  const reloadFirstPage = useCallback(() => setForm((current) => ({ ...current })), []);

  const toggleStatus = (status: MediaTaskStatus) => setForm((current) => ({
    ...current,
    status: current.status.includes(status)
      ? current.status.filter((value) => value !== status)
      : [...current.status, status],
  }));

  const titleId = `${id}-gallery`;
  const statusLegendId = `${id}-status`;
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.sectionTitle}>{t('mediaWorkbench.gallery.heading')}</h3>
      <div className={styles.filters}>
        <label className={styles.field}>
          {t('mediaWorkbench.filter.project')}
          <Select value={projectId} onChange={event => setProjectId(event.target.value)}>
            <option value={canvasProjectId}>{projects.find(project => project.id === canvasProjectId)?.name ?? t('mediaWorkbench.filter.currentProject')}</option>
            {projects.filter(project => project.id !== canvasProjectId).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </Select>
        </label>
        <label className={styles.field}>
          {t('mediaWorkbench.filter.kind')}
          <Select value={form.kind} onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value as MediaSurface | '' }))}>
            <option value="">{t('mediaWorkbench.filter.any')}</option>
            {(Object.keys(KIND_KEY) as MediaSurface[]).map((kind) => (
              <option key={kind} value={kind}>{t(KIND_KEY[kind])}</option>
            ))}
          </Select>
        </label>
        <label className={styles.field}>
          {t('mediaWorkbench.filter.provider')}
          <Select value={form.provider} onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value }))}>
            <option value="">{t('mediaWorkbench.filter.any')}</option>
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </Select>
        </label>
        <label className={styles.field}>
          {t('mediaWorkbench.filter.from')}
          <Input type="date" value={form.fromDay} max={form.toDay || undefined} onChange={(event) => setForm((current) => ({ ...current, fromDay: event.target.value }))} />
        </label>
        <label className={styles.field}>
          {t('mediaWorkbench.filter.to')}
          <Input type="date" value={form.toDay} min={form.fromDay || undefined} onChange={(event) => setForm((current) => ({ ...current, toDay: event.target.value }))} />
        </label>
        <div className={styles.filterGroup} role="group" aria-labelledby={statusLegendId}>
          <span id={statusLegendId} className={styles.hint}>{t('mediaWorkbench.filter.status')}</span>
          {MEDIA_TASK_STATUSES.map((status) => (
            <Chip key={status} size="sm" selected={form.status.includes(status)} onClick={() => toggleStatus(status)}>
              {t(STATUS_FILTER_KEY[status])}
            </Chip>
          ))}
        </div>
      </div>

      {error ? <p className={styles.error} role="alert">{t('mediaWorkbench.gallery.loadFailed', { message: error })}</p> : null}
      {loading && entries.length === 0 ? <Spinner size="sm" label={t('mediaWorkbench.gallery.loading')} /> : null}
      {!loading && !error && entries.length === 0 ? <p className={styles.hint}>{t('mediaWorkbench.gallery.empty')}</p> : null}

      <ul className={styles.entries} aria-labelledby={titleId} aria-busy={loading || undefined}>
        {entries.map((entry) => (
          <MediaEntryRow
            key={`${projectId}:${entry.id}`}
            projectId={projectId}
            canvasProjectId={canvasProjectId}
            canvasProjectName={projects.find(project => project.id === canvasProjectId)?.name ?? canvasProjectId}
            entry={entry}
            workspaceContext={workspaceContext}
            onEntryChange={replaceEntry}
            onTaskStarted={reloadFirstPage}
            onUnlinked={removeEntry}
          />
        ))}
      </ul>

      {nextCursor ? (
        <div className={styles.footer}>
          <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
            {t('mediaWorkbench.gallery.loadMore')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
