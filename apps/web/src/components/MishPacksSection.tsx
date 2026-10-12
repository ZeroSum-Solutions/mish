import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
} from '@mish/components';
import type { MishPackResourceKey, MishPackSummary } from '@mish/contracts';

import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import {
  applyMishPackRuntime,
  fetchMishPacks,
  installMishPackFromFile,
  installMishPackFromPath,
  removeMishPack,
  type MishPackClientErrorCode,
} from '../state/mish-packs';
import styles from './LicensedPacksSection.module.css';

/**
 * Settings -> Packs.
 *
 * A pack is a private packet (a .zip or folder) a team hands out. It restores content the public
 * app does not carry. Self-contained like `LicensedPacksSection`: it reads and writes
 * `/api/mish-packs*` itself because installed packs are daemon state, not app config; `od packs`
 * drives the same routes. Errors render this file's localized copy for the error code, never the
 * daemon's text. The list is re-read after every install and removal.
 */

const PROVIDES_KEYS: Record<MishPackResourceKey, keyof Dict> = {
  cultKit: 'packs.provides.cultKit',
  cultCatalog: 'packs.provides.cultCatalog',
  cultAdapters: 'packs.provides.cultAdapters',
  genui: 'packs.provides.genui',
  sections: 'packs.provides.sections',
  twentyFirst: 'packs.provides.twentyFirst',
  designSystems: 'packs.provides.designSystems',
  skills: 'packs.provides.skills',
  studies: 'packs.provides.studies',
  pets: 'packs.provides.pets',
  promptTemplates: 'packs.provides.promptTemplates',
  styleCatalog: 'packs.provides.styleCatalog',
  projects: 'packs.provides.projects',
  designIndex: 'packs.provides.designIndex',
};

const ERROR_KEYS: Record<MishPackClientErrorCode, keyof Dict> = {
  INVALID_MANIFEST: 'packs.error.INVALID_MANIFEST',
  INVALID_ARCHIVE: 'packs.error.INVALID_ARCHIVE',
  UNSAFE_PATH: 'packs.error.UNSAFE_PATH',
  MISSING_RESOURCE: 'packs.error.MISSING_RESOURCE',
  TOO_LARGE: 'packs.error.TOO_LARGE',
  NOT_FOUND: 'packs.error.NOT_FOUND',
  SOURCE_NOT_FOUND: 'packs.error.SOURCE_NOT_FOUND',
  BUSY: 'packs.error.BUSY',
  READ_ONLY: 'packs.error.READ_ONLY',
  INTERNAL_ERROR: 'packs.error.INTERNAL_ERROR',
  FORBIDDEN: 'packs.error.FORBIDDEN',
  NETWORK_ERROR: 'packs.error.NETWORK_ERROR',
};

type InstallState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; name: string; version: string; replaced: boolean; warnings: string[] }
  | { kind: 'error'; code: MishPackClientErrorCode };

type Notice = { kind: 'ok'; text: string } | { kind: 'error'; code: MishPackClientErrorCode } | null;

export function MishPacksSection() {
  const t = useT();
  const pathId = useId();
  const [packs, setPacks] = useState<MishPackSummary[] | null>(null);
  const [listError, setListError] = useState<MishPackClientErrorCode | null>(null);
  const [listNotice, setListNotice] = useState<Notice>(null);
  const [path, setPath] = useState('');
  const [install, setInstall] = useState<InstallState>({ kind: 'idle' });
  const [confirming, setConfirming] = useState<MishPackSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const result = await fetchMishPacks();
    if (!mounted.current) return;
    if (result.ok) {
      setPacks(result.value.packs);
      setListError(null);
    } else {
      setListError(result.code);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const busy = install.kind === 'running';

  async function finishInstall(result: Awaited<ReturnType<typeof installMishPackFromPath>>) {
    if (!mounted.current) return;
    setInstall(
      result.ok
        ? { kind: 'done', name: result.value.pack.name, version: result.value.pack.version, replaced: result.value.replaced, warnings: result.value.pack.warnings }
        : { kind: 'error', code: result.code },
    );
    await reload();
    // Previews a pack provides may have changed.
    void applyMishPackRuntime();
  }

  function onInstallPath() {
    const value = path.trim();
    if (!value) {
      setInstall({ kind: 'error', code: 'SOURCE_NOT_FOUND' });
      return;
    }
    setListNotice(null);
    setInstall({ kind: 'running' });
    void installMishPackFromPath(value).then(finishInstall);
  }

  function onPickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setListNotice(null);
    setInstall({ kind: 'running' });
    void installMishPackFromFile(file).then(finishInstall);
  }

  async function onConfirmRemove() {
    const pack = confirming;
    if (!pack) return;
    setRemoving(true);
    const result = await removeMishPack(pack.id);
    if (!mounted.current) return;
    setRemoving(false);
    setConfirming(null);
    if (result.ok) {
      // Saved projects a pack imported are never removed with it; say so, with how many.
      const kept = result.value.keptProjects?.length ?? 0;
      const text = kept > 0 ? t('packs.removedKeptProjects', { name: pack.name, count: kept }) : t('packs.removed', { name: pack.name });
      setListNotice({ kind: 'ok', text });
    } else {
      setListNotice({ kind: 'error', code: result.code });
    }
    await reload();
    void applyMishPackRuntime();
  }

  function providesText(pack: MishPackSummary): string {
    return pack.provides
      .map((entry) => {
        const kind = t(PROVIDES_KEYS[entry.resource]);
        return entry.items === null ? kind : t('packs.provides.item', { kind, count: entry.items });
      })
      .join(' · ');
  }

  const statusText = (() => {
    switch (install.kind) {
      case 'running':
        return t('packs.installing');
      case 'done':
        return t(install.replaced ? 'packs.outcome.replaced' : 'packs.outcome.installed', { name: install.name, version: install.version });
      case 'error':
        return t(ERROR_KEYS[install.code]);
      default:
        return null;
    }
  })();

  return (
    <section className="settings-section" data-testid="mish-packs-section">
      <p className={styles.pageDesc}>{t('packs.pageDesc')}</p>

      <div className={styles.card}>
        <h3 className={styles.cardTitle}>{t('packs.installedTitle')}</h3>
        {packs === null && !listError ? (
          <p className={styles.muted} role="status">
            <Spinner size="sm" /> {t('packs.loading')}
          </p>
        ) : null}
        {listError ? (
          <div className={styles.inlineRow}>
            <p className={styles.error} role="alert">
              {packs === null ? t('packs.loadFailed') : t('packs.refreshFailed')} {t(ERROR_KEYS[listError])}
            </p>
            <Button size="sm" onClick={() => void reload()}>
              {t('packs.retry')}
            </Button>
          </div>
        ) : null}
        {packs !== null && packs.length === 0 ? (
          <div className={styles.empty} data-testid="mish-packs-empty">
            <p className={styles.emptyTitle}>{t('packs.empty')}</p>
            <p className={styles.muted}>{t('packs.emptyHint')}</p>
          </div>
        ) : null}
        {packs !== null && packs.length > 0 ? (
          <ul className={styles.packList}>
            {packs.map((pack) => {
              const unset = pack.requiredEnv.filter((entry) => !entry.set).map((entry) => entry.name);
              return (
                <li key={pack.id} className={styles.packRow} data-testid={`mish-pack-${pack.id}`}>
                  <div className={styles.packText}>
                    <div className={styles.packHead}>
                      <span className={styles.packTitle}>{pack.name}</span>
                      {pack.origin === 'external' ? <Badge tone="neutral">{t('packs.originExternal')}</Badge> : null}
                    </div>
                    <span className={styles.meta}>{t('packs.version', { version: pack.version })}</span>
                    {pack.description ? <span className={styles.meta}>{pack.description}</span> : null}
                    {pack.provides.length > 0 ? <span className={styles.meta}>{t('packs.provides', { list: providesText(pack) })}</span> : null}
                    {pack.mcpServerIds.length > 0 ? <span className={styles.meta}>{t('packs.mcp', { list: pack.mcpServerIds.join(', ') })}</span> : null}
                    {pack.envKeys.length > 0 ? <span className={styles.meta}>{t('packs.settingsList', { list: pack.envKeys.join(', ') })}</span> : null}
                    {unset.length > 0 ? <span className={styles.warn}>{t('packs.requiredVariables', { names: unset.join(', ') })}</span> : null}
                    {pack.warnings.map((warning) => (
                      <span key={warning} className={styles.warn}>{warning}</span>
                    ))}
                  </div>
                  {pack.origin === 'installed' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className={styles.destructive}
                      disabled={busy || removing}
                      onClick={() => setConfirming(pack)}
                    >
                      {t('packs.remove')}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {listNotice ? (
          <p className={listNotice.kind === 'ok' ? styles.ok : styles.error} role={listNotice.kind === 'ok' ? 'status' : 'alert'}>
            {listNotice.kind === 'ok' ? listNotice.text : t(ERROR_KEYS[listNotice.code])}
          </p>
        ) : null}
      </div>

      <div className={styles.card}>
        <h3 className={styles.cardTitle}>{t('packs.importTitle')}</h3>
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => fileInput.current?.click()} disabled={busy} aria-busy={busy || undefined}>
            {busy ? t('packs.installing') : t('packs.chooseFile')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className={styles.hiddenFile}
            data-testid="mish-packs-file"
            tabIndex={-1}
            aria-hidden
            onChange={onPickFile}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={pathId}>
            {t('packs.pathLabel')}
          </label>
          <Input
            id={pathId}
            aria-describedby={`${pathId}-hint`}
            value={path}
            placeholder={t('packs.pathPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setPath(event.target.value)}
            disabled={busy}
          />
          <span id={`${pathId}-hint`} className={styles.hint}>
            {t('packs.pathHint')}
          </span>
        </div>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onInstallPath} disabled={busy}>
            {t('packs.install')}
          </Button>
        </div>
        <p
          className={install.kind === 'error' ? styles.error : install.kind === 'done' ? styles.ok : styles.muted}
          role="status"
          aria-live="polite"
          data-testid="mish-packs-install-status"
        >
          {busy ? <Spinner size="sm" /> : null} {statusText}
        </p>
        {install.kind === 'done' && install.warnings.length > 0 ? (
          <div className={styles.warnings}>
            <span className={styles.label}>{t('packs.warnings')}</span>
            <ul className={styles.warningList}>
              {install.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {confirming ? (
        <Dialog
          role="alertdialog"
          ariaLabel={t('packs.removeConfirmTitle', { name: confirming.name })}
          onClose={() => (removing ? undefined : setConfirming(null))}
          closeOnEscape
          data-testid="mish-packs-remove-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t('packs.removeConfirmTitle', { name: confirming.name })}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>{t('packs.removeConfirmBody')}</DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)} disabled={removing}>
              {t('packs.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void onConfirmRemove()} disabled={removing} aria-busy={removing || undefined}>
              {t('packs.removeConfirmAction')}
            </Button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </section>
  );
}
