import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../types';
import { useI18n } from '../i18n';
import { getProjectDetail, listProjects } from '../state/projects';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { dirExists } from '../providers/registry';
import { workspaceIdentityCacheKey } from '../collab/workspace-identity';
import { Button, IconButton } from '@open-design/components';
import { Icon } from './Icon';
import styles from './ProjectReferenceModal.module.css';

export interface ProjectReferenceSelection {
  project: Project;
  resolvedDir: string;
}

interface Props {
  currentProjectId?: string | null;
  workspaceContext?: WorkspaceCollabContext | null;
  onClose: () => void;
  onSelect: (items: ProjectReferenceSelection[]) => void;
}

function projectSearchText(project: Project): string {
  return [
    project.id,
    project.name,
    project.metadata?.kind ?? '',
    project.metadata?.baseDir ?? '',
    project.metadata?.entryFile ?? '',
    ...(project.metadata?.linkedDirs ?? []),
  ].join(' ');
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function projectMeta(project: Project): string {
  return project.metadata?.baseDir || project.metadata?.entryFile || project.metadata?.kind || project.id;
}

export function ProjectReferenceModal({
  currentProjectId,
  workspaceContext = null,
  onClose,
  onSelect,
}: Props) {
  const { t } = useI18n();
  const loadFailedMessage = t('chat.referenceProject.loadFailed');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The exact identity that reaches the wire — the same 8 fields
  // `workspaceProjectHeaders` sends and `listWorkspaceProjectSummaries` caches
  // on. Using it as the effect key means the catalog is re-read whenever the
  // caller's authority actually changes (switch Workspace, role/lifecycle
  // transition) and never merely because the parent re-created an equivalent
  // context object.
  const workspaceIdentity = workspaceIdentityCacheKey(workspaceContext);

  useEffect(() => {
    let cancelled = false;
    setProjects(null);
    setSelectedIds([]);
    setLoadError(null);
    // The catalog read MUST carry the caller's Workspace identity. Without it
    // `listProjects` falls back to the unscoped `GET /api/projects`, which
    // serves `listUnboundProjects` — every project some Workspace has claimed
    // is excluded there by construction, so a signed-in member would see an
    // empty picker while Home still lists those same projects. `'all'` is the
    // view TasksView/RoutinesSection use for their pickers: anything the member
    // can open is something they can reference.
    void listProjects({
      throwOnError: true,
      workspaceContext,
      workspaceView: 'all',
    })
      .then(async (rows) => {
        if (cancelled) return;
        const candidates = rows.filter((project) => project.id !== currentProjectId);
        // Hide imported/external projects whose on-disk folder is gone — they
        // can't be referenced. Managed projects have no external baseDir and
        // are always materializable on demand, so they skip the probe (and a
        // daemon that can't answer leaves everything visible).
        const stillExists = await Promise.all(
          candidates.map(async (project) => {
            const baseDir = project.metadata?.baseDir?.trim();
            return baseDir ? dirExists(baseDir) : true;
          }),
        );
        if (cancelled) return;
        const filtered = candidates.filter((_, index) => stillExists[index] !== false);
        setProjects(filtered);
        setSelectedIds((current) => current.length > 0 ? current : filtered[0] ? [filtered[0].id] : []);
      })
      .catch(() => {
        if (cancelled) return;
        setProjects([]);
        setLoadError(loadFailedMessage);
      });
    return () => {
      cancelled = true;
    };
    // `workspaceContext` is read inside but keyed through `workspaceIdentity`
    // above: an object identity in the dep list would re-fetch on every parent
    // render, and the derived key covers every field the request actually uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, loadFailedMessage, workspaceIdentity]);

  // Captured during the first render, before the search field's `autoFocus`
  // moves focus into the dialog, so closing can hand focus back to whatever
  // opened the picker (the composer or Home hero button).
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Modal contract: the page behind is inert, Tab cycles inside the dialog,
  // and focus returns to the opener when the dialog unmounts.
  useEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;
    const inertSiblings = Array.from(document.body.children).filter(
      (element) => element !== backdrop && !element.hasAttribute('inert'),
    );
    for (const element of inertSiblings) element.setAttribute('inert', '');

    function onTab(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onTab);
    return () => {
      document.removeEventListener('keydown', onTab);
      for (const element of inertSiblings) element.removeAttribute('inert');
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !pending) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const visibleProjects = useMemo(() => {
    if (!projects) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) => projectSearchText(project).toLowerCase().includes(needle));
  }, [projects, query]);

  const selectedProjects = useMemo(() => {
    if (!projects) return [];
    const selected = new Set(selectedIds);
    return projects.filter((project) => selected.has(project.id));
  }, [projects, selectedIds]);

  async function confirm() {
    if (selectedProjects.length === 0 || pending) return;
    setPending(true);
    setError(null);
    try {
      const selections: ProjectReferenceSelection[] = [];
      for (const project of selectedProjects) {
        // `ensureDir` materializes a managed project's folder before we read
        // its resolved dir, so an empty (never-generated) project references
        // to a real directory instead of a path that fails existence checks.
        const persistedProjectWorkspaceId = project.workspaceId?.trim() ?? '';
        const projectWorkspaceContext =
          persistedProjectWorkspaceId
          && workspaceContext?.workspaceId === persistedProjectWorkspaceId
            ? workspaceContext
            : null;
        const detail = await getProjectDetail(
          project.id,
          { ensureDir: true },
          projectWorkspaceContext,
        );
        const resolvedDir =
          detail?.resolvedDir?.trim() || detail?.project.metadata?.baseDir?.trim() || '';
        if (!detail || !resolvedDir) {
          setError(t('homeWorkingDir.applyFailed'));
          return;
        }
        selections.push({ project: detail.project, resolvedDir });
      }
      onSelect(selections);
    } finally {
      setPending(false);
    }
  }

  function toggleSelected(projectId: string) {
    setSelectedIds((current) => (
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId]
    ));
  }

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div ref={backdropRef} className={styles.backdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-reference-title"
        aria-describedby="project-reference-hint"
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            <h2 id="project-reference-title" className={styles.title}>
              {t('chat.referenceProject.title')}
            </h2>
            <p id="project-reference-hint" className={styles.hint}>
              {t('chat.referenceProject.hint')}
            </p>
          </div>
          <IconButton
            label={t('common.close')}
            size="sm"
            onClick={onClose}
            disabled={pending}
          >
            <Icon name="close" size={16} />
          </IconButton>
        </header>
        <div className={styles.body}>
          <label className={styles.search} data-ui-field-shell>
            <Icon name="search" size={14} />
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('chat.referenceProject.search')}
            />
          </label>
          <div
            className={styles.list}
            role="listbox"
            aria-label={t('chat.referenceProject.title')}
            aria-multiselectable="true"
          >
            {projects === null ? (
              <div className={styles.empty}>{t('common.loading')}</div>
            ) : loadError ? (
              <div className={styles.error} role="alert">
                {loadError}
              </div>
            ) : visibleProjects.length === 0 ? (
              <div className={styles.empty}>
                {query.trim()
                  ? t('chat.referenceProject.empty', { query })
                  : t('chat.referenceProject.emptyAll')}
              </div>
            ) : (
              visibleProjects.map((project) => {
                const selected = selectedIds.includes(project.id);
                return (
                  <button
                    key={project.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={styles.item}
                    onClick={() => toggleSelected(project.id)}
                  >
                    <span className={styles.itemIcon} aria-hidden>
                      <Icon name="folder" size={16} />
                    </span>
                    <span className={styles.itemText}>
                      <span className={styles.itemTitle}>{project.name}</span>
                      <span className={styles.itemMeta}>{projectMeta(project)}</span>
                    </span>
                    <span className={styles.check} aria-hidden>
                      {selected ? <Icon name="check" size={12} /> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {error ? (
            <div className={styles.error} role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <footer className={styles.footer}>
          <span className={styles.count} aria-live="polite">
            {selectedProjects.length > 0
              ? t('chat.referenceProject.selectedCount', { count: selectedProjects.length })
              : null}
          </span>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void confirm()}
            disabled={selectedProjects.length === 0 || pending}
            loading={pending}
          >
            {t('chat.referenceProject.confirm')}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
