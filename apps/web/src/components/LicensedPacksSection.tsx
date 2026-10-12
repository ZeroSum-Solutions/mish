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
import type { BadgeTone } from '@mish/components';
import {
  classifyPackSource,
  type InstalledPackStatus,
  type InstalledPackSummary,
  type PackContentKind,
  type PackGithubAccessSource,
  type PackGithubAccessStatus,
  type PackInstallOutcome,
  type PackInstallPhase,
  type PackInstallRequest,
} from '@mish/contracts';

import { useT } from '../i18n';
import {
  clearGithubToken,
  fetchGithubAccessStatus,
  fetchInstalledPacks,
  installPack,
  removeInstalledPack,
  saveGithubToken,
  type PackClientErrorCode,
  type PackInstallSource,
  type PackInstallUpdate,
} from '../state/packs';
import styles from './LicensedPacksSection.module.css';

/**
 * Settings → Licensed packs (Licensed Pack plan, Phase 1 item 2).
 *
 * Self-contained like `LabsSection`: it reads and writes `/api/packs*` itself
 * instead of threading through `cfg` / `setCfg`, because installed packs and
 * the GitHub token are daemon state, not app config. `od pack` drives the same
 * routes.
 *
 * - The list is re-read after every install and removal, so a pack whose files
 *   went missing shows its live status rather than the last success event.
 * - Errors render this file's localized copy for the error code, never the
 *   daemon's text.
 * - The GitHub token lives only in this component's state, leaves only in the
 *   POST body, and the field is cleared as soon as Save is pressed. The status
 *   line names the source in effect, never the token or part of it.
 */

// ---------------------------------------------------------------------------
// DRAFT COPY — waiting on UI Polish wave 2 (PR #190).
//
// #190 rewrites `SettingsDialog.tsx` and the i18n dictionaries, so this unit
// may not edit `apps/web/src/i18n/{types.ts,locales/en.ts}`
// until it is on main. Every string this section (and its nav item and the
// P1-6 first-run hint) needs is listed here under the exact key the i18n
// commit adds. Until then `t(key)` returns the key itself and the English
// draft below is shown. Once the keys are in the Dict, `t()` wins (so English
// works) and nothing in this file changes; the draft can then be deleted.
// The deferred i18n hunk is generated from this object, so the English values
// cannot drift from it.
// ---------------------------------------------------------------------------
export const LICENSED_PACKS_DRAFT_COPY = {
  // Settings nav item and header (used by SettingsDialog after #190).
  'settings.licensedPacks': 'Licensed packs',
  'settings.licensedPacksHint': 'Install licensed content packs',
  // Section
  'licensedPacks.pageDesc':
    'Licensed packs add content your team holds a licence for, such as private component kits. A pack is installed on this computer only.',
  'licensedPacks.installedTitle': 'Installed packs',
  'licensedPacks.loading': 'Loading installed packs…',
  'licensedPacks.loadFailed': 'The installed packs could not be read.',
  'licensedPacks.retry': 'Try again',
  'licensedPacks.empty': 'No licensed packs are installed.',
  'licensedPacks.emptyHint': 'Install the team pack from GitHub, or your own pack folder or .tgz file.',
  'licensedPacks.installTitle': 'Install a pack',
  'licensedPacks.sourceLabel': 'Source',
  'licensedPacks.sourceHint':
    'github:owner/repo, with an optional @version, or the full path of a .tgz file or pack folder on this computer.',
  // Appended to the Dict after the hint keys (2026-10-09): the field starts empty.
  'licensedPacks.sourcePlaceholder': '/path/to/my-pack, my-pack.tgz or github:owner/repo@1.0.0',
  'licensedPacks.sha256Label': 'SHA-256',
  'licensedPacks.sha256Hint': 'Required for a file or a folder. If you made the pack, run od pack digest <folder or file> to get it. A GitHub source does not need it.',
  'licensedPacks.force': 'Replace the same or a newer version',
  'licensedPacks.install': 'Install',
  'licensedPacks.installFromFile': 'Install from file…',
  'licensedPacks.installing': 'Installing…',
  'licensedPacks.phase.resolving': 'Finding the pack…',
  'licensedPacks.phase.downloading': 'Downloading…',
  'licensedPacks.phase.extracting': 'Unpacking…',
  'licensedPacks.phase.verifying': 'Checking every file…',
  'licensedPacks.phase.activating': 'Turning the pack on…',
  'licensedPacks.progressBytes': '{done} of {total}',
  'licensedPacks.outcome.installed': '{title} {version} is installed.',
  'licensedPacks.outcome.upgraded': '{title} is upgraded to {version}.',
  'licensedPacks.outcome.unchanged': '{title} {version} was already installed.',
  'licensedPacks.status.ready': 'Ready',
  'licensedPacks.status.degraded': 'Needs repair',
  'licensedPacks.status.damaged': 'Damaged',
  'licensedPacks.statusHint.degraded': 'Some content did not turn on. Install the pack again to repair it.',
  'licensedPacks.statusHint.damaged': 'Files are missing or changed. Install the pack again, or remove it.',
  'licensedPacks.kind.componentKit': 'Component kit',
  'licensedPacks.kind.cultCatalog': 'Component catalogue',
  'licensedPacks.kind.genuiOverlay': 'GenUI components',
  'licensedPacks.kind.plugins': 'Plugins',
  'licensedPacks.contentItem': '{kind} ({count})',
  'licensedPacks.version': 'Version {version}',
  'licensedPacks.licence': 'Licence: {scope}',
  'licensedPacks.source': 'From {source}',
  'licensedPacks.remove': 'Remove',
  'licensedPacks.removeConfirmTitle': 'Remove {title}?',
  'licensedPacks.removeConfirmBody': 'Its content stops being available on this computer. You can install it again later.',
  'licensedPacks.removeConfirmAction': 'Remove pack',
  'licensedPacks.cancel': 'Cancel',
  'licensedPacks.removed': '{title} is removed.',
  'licensedPacks.refreshFailed': 'The list could not be refreshed, so it may be out of date.',
  'licensedPacks.warnings': 'Warnings',
  // One message per error code (pack routes, token store, and the client).
  'licensedPacks.error.BAD_REQUEST': 'Check the source and try again.',
  'licensedPacks.error.SOURCE_UNSUPPORTED': 'Installing from GitHub is not available in this build.',
  'licensedPacks.error.FETCH_FAILED': 'The pack could not be downloaded from GitHub. Try again later.',
  'licensedPacks.error.AUTH_REQUIRED':
    'The configured GitHub access cannot read the pack. Add a fine-grained token with read access to the pack repository only.',
  'licensedPacks.error.DIGEST_REQUIRED':
    'Enter the SHA-256 that came with the pack. If you made the pack, run od pack digest <folder or file> to get it.',
  'licensedPacks.error.INVALID_ARCHIVE': 'This file is not a valid pack archive.',
  'licensedPacks.error.INVALID_MANIFEST': 'This pack’s pack.json is not valid.',
  'licensedPacks.error.INTEGRITY_MISMATCH': 'The pack does not match its SHA-256, so nothing was installed. Check the value, or run od pack digest <folder or file> to get it again.',
  'licensedPacks.error.TOO_LARGE': 'The pack is larger than the size limit.',
  'licensedPacks.error.VERSION_CONFLICT':
    'A different or newer version of this pack is installed. Select “Replace the same or a newer version” to replace it.',
  'licensedPacks.error.CONTENT_CONFLICT': 'Another installed pack already provides this content.',
  'licensedPacks.error.INSTALL_IN_PROGRESS': 'Another pack install or removal is running. Try again when it finishes.',
  'licensedPacks.error.RETRACT_FAILED': 'The pack content could not be turned off, so the pack is still installed.',
  'licensedPacks.error.CANCELLED': 'The install was cancelled.',
  'licensedPacks.error.INTERNAL_ERROR': 'Something went wrong. Try again.',
  'licensedPacks.error.PACK_NOT_FOUND': 'That pack is not installed.',
  'licensedPacks.error.INVALID_TOKEN_FORMAT':
    'That is not a GitHub token. Paste a fine-grained token (github_pat_…) or a classic token (ghp_…).',
  'licensedPacks.error.CREDENTIAL_STORE_UNSAFE':
    'The token was not saved: the app’s credential folder is not private to your user.',
  'licensedPacks.error.CREDENTIAL_STORE_FAILED': 'The token could not be saved.',
  'licensedPacks.error.FORBIDDEN': 'Pack changes are accepted only from this computer.',
  'licensedPacks.error.NETWORK_ERROR': 'The app could not reach its local service. Try again.',
  // GitHub access
  'licensedPacks.github.title': 'GitHub access',
  'licensedPacks.github.desc':
    'GitHub installs use your GitHub CLI login, GH_TOKEN, or a token you paste here. Use a fine-grained token with read access to the pack repository only.',
  'licensedPacks.github.status.stored': 'Using the token saved here.',
  'licensedPacks.github.status.env': 'Using GH_TOKEN or GITHUB_TOKEN from the app’s environment.',
  'licensedPacks.github.status.ghCli': 'Using your GitHub CLI login.',
  'licensedPacks.github.status.none': 'Not set up. Paste a token, or sign in with gh auth login.',
  'licensedPacks.github.tokenLabel': 'GitHub token',
  'licensedPacks.github.save': 'Save token',
  'licensedPacks.github.clear': 'Remove saved token',
  'licensedPacks.github.saved': 'Token saved.',
  'licensedPacks.github.cleared': 'Saved token removed.',
  // P1-6 first-run hint (consumed by P1-6's LicensedPackHint).
  'licensedPacks.hint.title': 'Licensed components are not installed',
  'licensedPacks.hint.body': 'Install your team’s licensed pack to use its component kits on this computer.',
  'licensedPacks.hint.action': 'Open Licensed packs',
  'licensedPacks.hint.dismiss': 'Not now',
} as const satisfies Record<string, string>;

export type LicensedPacksCopyKey = keyof typeof LICENSED_PACKS_DRAFT_COPY;
/** The i18n keys this section adds, in dictionary order. */
export const LICENSED_PACKS_COPY_KEYS = Object.keys(LICENSED_PACKS_DRAFT_COPY) as LicensedPacksCopyKey[];

type CopyVars = Record<string, string | number>;
type Copy = (key: LicensedPacksCopyKey, vars?: CopyVars) => string;

function interpolate(raw: string, vars?: CopyVars): string {
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => (vars[name] == null ? `{${name}}` : String(vars[name])));
}

/** `t()` for this section's keys, with the draft copy while the Dict lacks them (see DRAFT COPY above). */
export function useLicensedPacksCopy(): Copy {
  // The keys are not in `Dict` until the i18n commit; `t` returns the key for a missing one.
  const t = useT() as unknown as (key: string, vars?: CopyVars) => string;
  return useCallback(
    (key, vars) => {
      const value = t(key, vars);
      return value === key ? interpolate(LICENSED_PACKS_DRAFT_COPY[key], vars) : value;
    },
    [t],
  );
}

export const LICENSED_PACKS_ERROR_KEYS: Record<PackClientErrorCode, LicensedPacksCopyKey> = {
  BAD_REQUEST: 'licensedPacks.error.BAD_REQUEST',
  SOURCE_UNSUPPORTED: 'licensedPacks.error.SOURCE_UNSUPPORTED',
  FETCH_FAILED: 'licensedPacks.error.FETCH_FAILED',
  AUTH_REQUIRED: 'licensedPacks.error.AUTH_REQUIRED',
  DIGEST_REQUIRED: 'licensedPacks.error.DIGEST_REQUIRED',
  INVALID_ARCHIVE: 'licensedPacks.error.INVALID_ARCHIVE',
  INVALID_MANIFEST: 'licensedPacks.error.INVALID_MANIFEST',
  INTEGRITY_MISMATCH: 'licensedPacks.error.INTEGRITY_MISMATCH',
  TOO_LARGE: 'licensedPacks.error.TOO_LARGE',
  VERSION_CONFLICT: 'licensedPacks.error.VERSION_CONFLICT',
  CONTENT_CONFLICT: 'licensedPacks.error.CONTENT_CONFLICT',
  INSTALL_IN_PROGRESS: 'licensedPacks.error.INSTALL_IN_PROGRESS',
  RETRACT_FAILED: 'licensedPacks.error.RETRACT_FAILED',
  CANCELLED: 'licensedPacks.error.CANCELLED',
  INTERNAL_ERROR: 'licensedPacks.error.INTERNAL_ERROR',
  PACK_NOT_FOUND: 'licensedPacks.error.PACK_NOT_FOUND',
  INVALID_TOKEN_FORMAT: 'licensedPacks.error.INVALID_TOKEN_FORMAT',
  CREDENTIAL_STORE_UNSAFE: 'licensedPacks.error.CREDENTIAL_STORE_UNSAFE',
  CREDENTIAL_STORE_FAILED: 'licensedPacks.error.CREDENTIAL_STORE_FAILED',
  FORBIDDEN: 'licensedPacks.error.FORBIDDEN',
  NETWORK_ERROR: 'licensedPacks.error.NETWORK_ERROR',
};

const PHASE_KEYS: Record<PackInstallPhase, LicensedPacksCopyKey> = {
  resolving: 'licensedPacks.phase.resolving',
  downloading: 'licensedPacks.phase.downloading',
  extracting: 'licensedPacks.phase.extracting',
  verifying: 'licensedPacks.phase.verifying',
  activating: 'licensedPacks.phase.activating',
};

const OUTCOME_KEYS: Record<PackInstallOutcome, LicensedPacksCopyKey> = {
  installed: 'licensedPacks.outcome.installed',
  upgraded: 'licensedPacks.outcome.upgraded',
  unchanged: 'licensedPacks.outcome.unchanged',
};

const STATUS_KEYS: Record<InstalledPackStatus, LicensedPacksCopyKey> = {
  ready: 'licensedPacks.status.ready',
  degraded: 'licensedPacks.status.degraded',
  damaged: 'licensedPacks.status.damaged',
};

const STATUS_TONES: Record<InstalledPackStatus, BadgeTone> = {
  ready: 'success',
  degraded: 'warning',
  damaged: 'danger',
};

const KIND_KEYS: Record<PackContentKind, LicensedPacksCopyKey> = {
  'component-kit': 'licensedPacks.kind.componentKit',
  'cult-catalog': 'licensedPacks.kind.cultCatalog',
  'genui-overlay': 'licensedPacks.kind.genuiOverlay',
  plugins: 'licensedPacks.kind.plugins',
};

const ACCESS_KEYS: Record<PackGithubAccessSource, LicensedPacksCopyKey> = {
  stored: 'licensedPacks.github.status.stored',
  env: 'licensedPacks.github.status.env',
  'gh-cli': 'licensedPacks.github.status.ghCli',
  none: 'licensedPacks.github.status.none',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type InstallState =
  | { kind: 'idle' }
  | { kind: 'running'; update: PackInstallUpdate | null }
  | { kind: 'done'; outcome: PackInstallOutcome; title: string; version: string; warnings: string[] }
  | { kind: 'error'; code: PackClientErrorCode; warnings: string[] };

type Notice = { kind: 'ok'; text: string } | { kind: 'error'; code: PackClientErrorCode } | null;

export function LicensedPacksSection() {
  const c = useLicensedPacksCopy();
  const sourceId = useId();
  const shaId = useId();
  const forceId = useId();
  const tokenId = useId();

  const [packs, setPacks] = useState<InstalledPackSummary[] | null>(null);
  const [listError, setListError] = useState<PackClientErrorCode | null>(null);
  const [listNotice, setListNotice] = useState<Notice>(null);
  const [source, setSource] = useState<string>('');
  const [sha256, setSha256] = useState('');
  const [force, setForce] = useState(false);
  const [install, setInstall] = useState<InstallState>({ kind: 'idle' });
  const [confirming, setConfirming] = useState<InstalledPackSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  const [access, setAccess] = useState<PackGithubAccessStatus | null>(null);
  const [token, setToken] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenNotice, setTokenNotice] = useState<Notice>(null);

  const mounted = useRef(true);
  const installAbort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      installAbort.current?.abort();
    };
  }, []);

  const reloadPacks = useCallback(async () => {
    const result = await fetchInstalledPacks();
    if (!mounted.current) return;
    if (result.ok) {
      setPacks(result.value);
      setListError(null);
    } else {
      setListError(result.code);
    }
  }, []);

  const reloadAccess = useCallback(async () => {
    const result = await fetchGithubAccessStatus();
    if (mounted.current && result.ok) setAccess(result.value);
  }, []);

  useEffect(() => {
    void reloadPacks();
    void reloadAccess();
  }, [reloadPacks, reloadAccess]);

  const busy = install.kind === 'running';

  async function runInstall(request: PackInstallSource) {
    installAbort.current?.abort();
    const controller = new AbortController();
    installAbort.current = controller;
    setListNotice(null);
    setInstall({ kind: 'running', update: null });
    const result = await installPack(
      request,
      (update) => {
        if (mounted.current) setInstall({ kind: 'running', update });
      },
      controller.signal,
    );
    if (!mounted.current) return;
    installAbort.current = null;
    setInstall(
      result.ok
        ? { kind: 'done', outcome: result.outcome, title: result.pack.title, version: result.pack.version, warnings: result.warnings }
        : { kind: 'error', code: result.code, warnings: result.warnings ?? [] },
    );
    // Re-read rather than trust the event: the list shows live status.
    await reloadPacks();
  }

  function onInstallSource() {
    const value = source.trim();
    if (!value) {
      setInstall({ kind: 'error', code: 'BAD_REQUEST', warnings: [] });
      return;
    }
    const request: PackInstallRequest = { source: value };
    if (force) request.force = true;
    const digest = sha256.trim();
    if (digest && classifyPackSource(value) !== 'github') request.sha256 = digest;
    void runInstall({ kind: 'source', request });
  }

  function onPickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const digest = sha256.trim();
    // Fail closed here too, before uploading a large file the daemon would refuse.
    if (!digest) {
      setInstall({ kind: 'error', code: 'DIGEST_REQUIRED', warnings: [] });
      return;
    }
    void runInstall({ kind: 'file', file, fileName: file.name, sha256: digest, force });
  }

  async function onConfirmRemove() {
    const pack = confirming;
    if (!pack) return;
    setRemoving(true);
    const result = await removeInstalledPack(pack.id);
    if (!mounted.current) return;
    setRemoving(false);
    setConfirming(null);
    setListNotice(
      result.ok ? { kind: 'ok', text: c('licensedPacks.removed', { title: pack.title || pack.id }) } : { kind: 'error', code: result.code },
    );
    await reloadPacks();
  }

  async function onSaveToken() {
    const value = token;
    // Cleared before the request: the value lives no longer than it must.
    setToken('');
    if (!value.trim()) return;
    setTokenBusy(true);
    setTokenNotice(null);
    const result = await saveGithubToken(value);
    if (!mounted.current) return;
    setTokenBusy(false);
    if (result.ok) {
      setAccess(result.value);
      setTokenNotice({ kind: 'ok', text: c('licensedPacks.github.saved') });
    } else {
      setTokenNotice({ kind: 'error', code: result.code });
    }
  }

  async function onClearToken() {
    setTokenBusy(true);
    setTokenNotice(null);
    const result = await clearGithubToken();
    if (!mounted.current) return;
    setTokenBusy(false);
    if (result.ok) {
      setAccess(result.value);
      setTokenNotice({ kind: 'ok', text: c('licensedPacks.github.cleared') });
    } else {
      setTokenNotice({ kind: 'error', code: result.code });
    }
  }

  function installStatusText(): string | null {
    switch (install.kind) {
      case 'running': {
        if (!install.update) return c('licensedPacks.installing');
        const phase = c(PHASE_KEYS[install.update.phase] ?? 'licensedPacks.installing');
        const { bytes, totalBytes } = install.update;
        if (typeof bytes !== 'number' || bytes <= 0) return phase;
        const amount =
          typeof totalBytes === 'number'
            ? c('licensedPacks.progressBytes', { done: formatBytes(bytes), total: formatBytes(totalBytes) })
            : formatBytes(bytes);
        return `${phase} ${amount}`;
      }
      case 'done':
        return c(OUTCOME_KEYS[install.outcome], { title: install.title, version: install.version });
      case 'error':
        return c(LICENSED_PACKS_ERROR_KEYS[install.code]);
      default:
        return null;
    }
  }

  const statusText = installStatusText();

  return (
    <section className="settings-section" data-testid="licensed-packs-section">
      <p className={styles.pageDesc}>{c('licensedPacks.pageDesc')}</p>

      <div className={styles.card}>
        <h3 className={styles.cardTitle}>{c('licensedPacks.installedTitle')}</h3>
        {packs === null && !listError ? (
          <p className={styles.muted} role="status">
            <Spinner size="sm" /> {c('licensedPacks.loading')}
          </p>
        ) : null}
        {listError && packs === null ? (
          <div className={styles.inlineRow}>
            <p className={styles.error} role="alert">
              {c('licensedPacks.loadFailed')} {c(LICENSED_PACKS_ERROR_KEYS[listError])}
            </p>
            <Button size="sm" onClick={() => void reloadPacks()}>
              {c('licensedPacks.retry')}
            </Button>
          </div>
        ) : null}
        {listError && packs !== null ? (
          <div className={styles.inlineRow}>
            <p className={styles.error} role="alert">
              {c('licensedPacks.refreshFailed')} {c(LICENSED_PACKS_ERROR_KEYS[listError])}
            </p>
            <Button size="sm" onClick={() => void reloadPacks()}>
              {c('licensedPacks.retry')}
            </Button>
          </div>
        ) : null}
        {packs !== null && packs.length === 0 ? (
          <div className={styles.empty} data-testid="licensed-packs-empty">
            <p className={styles.emptyTitle}>{c('licensedPacks.empty')}</p>
            <p className={styles.muted}>{c('licensedPacks.emptyHint')}</p>
          </div>
        ) : null}
        {packs !== null && packs.length > 0 ? (
          <ul className={styles.packList}>
            {packs.map((pack) => (
              <li key={pack.id} className={styles.packRow} data-testid={`licensed-pack-${pack.id}`}>
                <div className={styles.packText}>
                  <div className={styles.packHead}>
                    <span className={styles.packTitle}>{pack.title || pack.id}</span>
                    <Badge tone={STATUS_TONES[pack.status]} dot>
                      {c(STATUS_KEYS[pack.status])}
                    </Badge>
                  </div>
                  <span className={styles.meta}>
                    {pack.version ? c('licensedPacks.version', { version: pack.version }) : null}
                    {pack.licenceScope ? ` · ${c('licensedPacks.licence', { scope: pack.licenceScope })}` : null}
                  </span>
                  {pack.contents.length > 0 ? (
                    <span className={styles.meta}>
                      {pack.contents
                        .map((entry) =>
                          c('licensedPacks.contentItem', {
                            kind: c(KIND_KEYS[entry.kind]),
                            count: entry.count ?? 0,
                          }),
                        )
                        .join(' · ')}
                    </span>
                  ) : null}
                  {pack.source ? <span className={styles.meta}>{c('licensedPacks.source', { source: pack.source })}</span> : null}
                  {pack.status !== 'ready' ? (
                    <span className={styles.warn}>
                      {c(pack.status === 'degraded' ? 'licensedPacks.statusHint.degraded' : 'licensedPacks.statusHint.damaged')}
                    </span>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className={styles.destructive}
                  disabled={busy || removing}
                  onClick={() => setConfirming(pack)}
                >
                  {c('licensedPacks.remove')}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {listNotice ? (
          <p className={listNotice.kind === 'ok' ? styles.ok : styles.error} role={listNotice.kind === 'ok' ? 'status' : 'alert'}>
            {listNotice.kind === 'ok' ? listNotice.text : c(LICENSED_PACKS_ERROR_KEYS[listNotice.code])}
          </p>
        ) : null}
      </div>

      <div className={styles.card}>
        <h3 className={styles.cardTitle}>{c('licensedPacks.installTitle')}</h3>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={sourceId}>
            {c('licensedPacks.sourceLabel')}
          </label>
          <Input
            id={sourceId}
            aria-describedby={`${sourceId}-hint`}
            value={source}
            placeholder={c('licensedPacks.sourcePlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setSource(event.target.value)}
            disabled={busy}
          />
          <span id={`${sourceId}-hint`} className={styles.hint}>
            {c('licensedPacks.sourceHint')}
          </span>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={shaId}>
            {c('licensedPacks.sha256Label')}
          </label>
          <Input
            id={shaId}
            aria-describedby={`${shaId}-hint`}
            value={sha256}
            spellCheck={false}
            autoComplete="off"
            className={styles.mono}
            onChange={(event) => setSha256(event.target.value)}
            disabled={busy}
          />
          <span id={`${shaId}-hint`} className={styles.hint}>
            {c('licensedPacks.sha256Hint')}
          </span>
        </div>
        <label className={styles.check} htmlFor={forceId}>
          <input id={forceId} type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} disabled={busy} />
          <span>{c('licensedPacks.force')}</span>
        </label>
        <div className={styles.actions}>
          <Button variant="primary" onClick={onInstallSource} disabled={busy} aria-busy={busy || undefined}>
            {busy ? c('licensedPacks.installing') : c('licensedPacks.install')}
          </Button>
          <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={busy}>
            {c('licensedPacks.installFromFile')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".tgz,.tar.gz,application/gzip,application/x-gzip"
            className={styles.hiddenFile}
            data-testid="licensed-packs-file"
            tabIndex={-1}
            aria-hidden
            onChange={onPickFile}
          />
        </div>
        <p
          className={install.kind === 'error' ? styles.error : install.kind === 'done' ? styles.ok : styles.muted}
          role="status"
          aria-live="polite"
          data-testid="licensed-packs-install-status"
        >
          {busy ? <Spinner size="sm" /> : null} {statusText}
        </p>
        {(install.kind === 'done' || install.kind === 'error') && install.warnings.length > 0 ? (
          <div className={styles.warnings} data-testid="licensed-packs-warnings">
            <span className={styles.label}>{c('licensedPacks.warnings')}</span>
            {/* The daemon's warning templates, shown as given: they carry no URL, path or token. */}
            <ul className={styles.warningList}>
              {install.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className={styles.card}>
        <h3 className={styles.cardTitle}>{c('licensedPacks.github.title')}</h3>
        <p className={styles.muted}>{c('licensedPacks.github.desc')}</p>
        <p className={styles.accessStatus} data-testid="licensed-packs-access-status">
          {access ? c(ACCESS_KEYS[access.source]) : null}
        </p>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={tokenId}>
            {c('licensedPacks.github.tokenLabel')}
          </label>
          <Input
            id={tokenId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            placeholder="github_pat_…"
            onChange={(event) => setToken(event.target.value)}
            disabled={tokenBusy}
          />
        </div>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => void onSaveToken()} disabled={tokenBusy || token.trim().length === 0}>
            {c('licensedPacks.github.save')}
          </Button>
          {access?.source === 'stored' ? (
            <Button variant="ghost" onClick={() => void onClearToken()} disabled={tokenBusy}>
              {c('licensedPacks.github.clear')}
            </Button>
          ) : null}
        </div>
        {tokenNotice ? (
          <p className={tokenNotice.kind === 'ok' ? styles.ok : styles.error} role={tokenNotice.kind === 'ok' ? 'status' : 'alert'}>
            {tokenNotice.kind === 'ok' ? tokenNotice.text : c(LICENSED_PACKS_ERROR_KEYS[tokenNotice.code])}
          </p>
        ) : null}
      </div>

      {confirming ? (
        <Dialog
          role="alertdialog"
          ariaLabel={c('licensedPacks.removeConfirmTitle', { title: confirming.title || confirming.id })}
          onClose={() => (removing ? undefined : setConfirming(null))}
          closeOnEscape
          data-testid="licensed-packs-remove-dialog"
        >
          <DialogHeader>
            <DialogTitle>{c('licensedPacks.removeConfirmTitle', { title: confirming.title || confirming.id })}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>{c('licensedPacks.removeConfirmBody')}</DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)} disabled={removing}>
              {c('licensedPacks.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void onConfirmRemove()} disabled={removing} aria-busy={removing || undefined}>
              {c('licensedPacks.removeConfirmAction')}
            </Button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </section>
  );
}
