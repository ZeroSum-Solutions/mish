import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ProjectLocation } from '@open-design/contracts';
import type { AppConfig } from '../types';
import {
  fetchProjectLocations,
  openProjectLocationFolderDialog,
  scanProjectLocations,
  updateProjectLocations,
} from '../state/project-locations';
import { useI18n } from '../i18n';
import { Badge, Button, IconButton } from '@open-design/components';
import { Icon } from './Icon';
import styles from './ProjectLocationsSection.module.css';

interface Props {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
  onProjectsRefresh?: () => Promise<void> | void;
}

interface DraftLocation {
  id?: string;
  path: string;
}

function locationLabel(locationPath: string): string {
  return locationPath.split(/[\\/]/).filter(Boolean).pop() || locationPath;
}

function externalLocations(locations: ProjectLocation[]): DraftLocation[] {
  return locations
    .filter((location) => !location.builtIn)
    .map((location) => ({ id: location.id, path: location.path }));
}

function toConfigLocations(locations: ProjectLocation[]): NonNullable<AppConfig['projectLocations']> {
  return locations
    .filter((location) => !location.builtIn)
    .map((location) => ({ id: location.id, name: location.name, path: location.path }));
}

export function ProjectLocationsSection({ cfg, setCfg, onProjectsRefresh }: Props) {
  const { t } = useI18n();
  const [locations, setLocations] = useState<ProjectLocation[]>([]);
  const [drafts, setDrafts] = useState<DraftLocation[]>(cfg.projectLocations ?? []);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draftsRef = useRef<DraftLocation[]>(drafts);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchProjectLocations()
      .then((next) => {
        if (cancelled) return;
        setLocations(next);
        setDrafts(externalLocations(next));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setCfg]);

  const builtIn = useMemo(
    () => locations.find((location) => location.builtIn),
    [locations],
  );
  const effectiveDefaultLocationId = useMemo(() => {
    const configured = cfg.defaultProjectLocationId ?? 'default';
    return locations.some((location) => location.id === configured) ? configured : 'default';
  }, [cfg.defaultProjectLocationId, locations]);

  function defaultControlLabel(locationId: string): string {
    return effectiveDefaultLocationId === locationId
      ? t('settings.projectLocationsDefaultBadge')
      : t('settings.projectLocationsMakeDefault');
  }

  function handleDefaultLocationChange(locationId: string) {
    setError(null);
    setStatus(t('settings.projectLocationsDefaultSaved'));
    setCfg((current) => ({ ...current, defaultProjectLocationId: locationId }));
  }

  async function save(nextDrafts: DraftLocation[]) {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await updateProjectLocations(
        nextDrafts.filter((location) => location.path.trim()),
      );
      if (!saved) {
        setError(t('settings.projectLocationsSaveError'));
        return null;
      }
      setLocations(saved);
      const external = externalLocations(saved);
      setDrafts(external);
      setCfg((current) => {
        const configuredDefault = current.defaultProjectLocationId ?? 'default';
        const nextDefault = saved.some((location) => location.id === configuredDefault)
          ? configuredDefault
          : 'default';
        return {
          ...current,
          projectLocations: toConfigLocations(saved),
          defaultProjectLocationId: nextDefault,
        };
      });
      setStatus(t('settings.projectLocationsSaved'));
      void onProjectsRefresh?.();
      return external;
    } finally {
      setSaving(false);
    }
  }

  async function runScan() {
    const result = await scanProjectLocations();
    if (!result) {
      setError(t('settings.projectLocationsScanError'));
      return null;
    }
    setStatus(t('settings.projectLocationsScanComplete', {
      imported: result.imported.length,
      existing: result.existing.length,
    }));
    void onProjectsRefresh?.();
    return result;
  }

  async function handleAddFolder() {
    setError(null);
    setStatus(null);
    const selected = await openProjectLocationFolderDialog();
    if (!selected) {
      setStatus(t('settings.projectLocationsNoFolderSelected'));
      return;
    }
    if (draftsRef.current.some((draft) => draft.path === selected)) {
      setStatus(t('settings.projectLocationsDuplicate'));
      return;
    }
    const previous = draftsRef.current;
    const next = [...previous, { path: selected }];
    setDrafts(next);
    const saved = await save(next);
    if (!saved) setDrafts(previous);
    else await runScan();
  }

  async function removeDraft(index: number) {
    const previous = draftsRef.current;
    const next = previous.filter((_, i) => i !== index);
    setDrafts(next);
    const saved = await save(next);
    if (!saved) setDrafts(previous);
  }

  const rows: Array<{
    key: string;
    id?: string;
    name: string;
    path: string;
    builtIn: boolean;
    index?: number;
  }> = [
    ...(builtIn
      ? [{ key: builtIn.id, id: builtIn.id, name: t('newproj.locationDefault'), path: builtIn.path, builtIn: true }]
      : []),
    ...drafts.map((draft, index) => ({
      key: `${draft.id ?? 'new'}-${index}`,
      id: draft.id,
      name: locationLabel(draft.path),
      path: draft.path,
      builtIn: false,
      index,
    })),
  ];

  return (
    <section className={`settings-section project-locations-section ${styles.section}`}>
      {rows.length > 0 ? (
        <ul className={styles.list}>
          {rows.map((row) => {
            const isDefault = Boolean(row.id) && effectiveDefaultLocationId === row.id;
            return (
              <li
                key={row.key}
                className={`${row.builtIn ? 'project-location-card is-built-in' : 'project-location-edit'}${isDefault ? ' is-default' : ''} ${styles.row}`}
              >
                <span className={styles.icon} aria-hidden>
                  <Icon name="folder" size={16} />
                </span>
                <span className={styles.text}>
                  <span className={styles.nameLine}>
                    <strong className={styles.name}>{row.name}</strong>
                    {isDefault ? (
                      <Badge tone="success" dot>{t('settings.projectLocationsDefaultBadge')}</Badge>
                    ) : null}
                  </span>
                  <code className={styles.path} title={row.path}>{row.path}</code>
                  {!row.builtIn ? (
                    <span className={styles.meta}>{t('settings.projectLocationsWorkBaseMeta')}</span>
                  ) : null}
                </span>
                <span className={styles.actions}>
                  {row.id && !isDefault ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDefaultLocationChange(row.id!)}
                    >
                      {defaultControlLabel(row.id)}
                    </Button>
                  ) : null}
                  {!row.builtIn && row.index !== undefined ? (
                    <IconButton
                      size="sm"
                      className={styles.remove}
                      label={t('settings.projectLocationsRemove', { name: row.name })}
                      onClick={() => removeDraft(row.index!)}
                      disabled={saving}
                    >
                      <Icon name="trash" size={16} />
                    </IconButton>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className={styles.footer}>
        <Button
          size="sm"
          variant="secondary"
          className="project-location-add"
          onClick={handleAddFolder}
          disabled={loading || saving}
        >
          <Icon name="plus" size={14} />
          {t('settings.projectLocationsAddFolder')}
        </Button>
        {status ? <p className={styles.status} role="status">{status}</p> : null}
        {error ? <p className={styles.status} data-tone="error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
