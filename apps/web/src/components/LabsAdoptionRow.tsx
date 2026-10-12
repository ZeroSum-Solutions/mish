import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { parseWorkbenchAdoptionStatusResponse, type WorkbenchAdoptionStatus } from '@mish/contracts';

import { useT } from '../i18n';
import { Icon } from './Icon';
import styles from './LabsSection.module.css';

/**
 * Settings → Labs row for the workbench adoption executor (B4-1).
 *
 * The daemon start option (process opt-in) is what opens the executor; the
 * daemon has no trusted way to tell the owner from another local caller, so
 * this switch can only close it. Off closes at once and stays closed until the
 * daemon restarts; turning it back on is stored for the next start. It writes
 * `placementAdoptionExecutor` with a single-field PUT (the web `AppConfig`
 * projection does not carry it) and always shows the daemon's own answer and
 * its named gates, never the switch position alone.
 */
type RowState = { kind: 'loading' } | { kind: 'unreadable' } | { kind: 'ready'; status: WorkbenchAdoptionStatus };

async function readAdoptionStatus(): Promise<WorkbenchAdoptionStatus> {
  const response = await fetch('/api/workbench/adoption/status');
  if (!response.ok) throw new Error(`adoption status failed (${response.status})`);
  return parseWorkbenchAdoptionStatusResponse(await response.json()).status;
}
async function writeAdoptionSwitch(on: boolean): Promise<void> {
  const response = await fetch('/api/app-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ placementAdoptionExecutor: on }),
  });
  if (!response.ok) throw new Error(`app-config write failed (${response.status})`);
}

export function LabsAdoptionRow() {
  const t = useT();
  const [state, setState] = useState<RowState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const noticeId = useId();

  const refresh = useCallback(async (): Promise<WorkbenchAdoptionStatus | null> => {
    try {
      const status = await readAdoptionStatus();
      if (mountedRef.current) setState({ kind: 'ready', status });
      return status;
    } catch {
      if (mountedRef.current) setState({ kind: 'unreadable' });
      return null;
    }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => { mountedRef.current = false; };
  }, [refresh]);

  const toggle = useCallback(() => {
    if (busyRef.current) return;
    if (state.kind === 'unreadable') { setState({ kind: 'loading' }); void refresh(); return; }
    if (state.kind !== 'ready') return;
    const next = !state.status.optIn.labs;
    busyRef.current = true; setBusy(true);
    void (async () => {
      let written = false;
      try { await writeAdoptionSwitch(next); written = true; } catch { /* The re-read below shows what the daemon holds. */ }
      const after = await refresh();
      // Turning it on is stored, but a closed executor reopens only after the daemon restarts.
      if (mountedRef.current) setRestartPending(written && next && after !== null && !after.optIn.labs);
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    })();
  }, [refresh, state]);

  const ready = state.kind === 'ready' ? state.status : null;
  const on = ready?.optIn.labs ?? false;
  const locked = state.kind !== 'ready';
  return (
    <section className="settings-section">
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>
            <span className={styles.rowName}>{t('labs.adoptionName')}</span>
          </span>
          <span className={styles.rowHint}>{t('labs.adoptionHint')}</span>
          {ready && !ready.optIn.env ? (
            <span className={styles.rowNotice} role="status" id={noticeId} data-testid="labs-adoption-env-off">
              <Icon name="info" size={12} aria-hidden />
              {t('labs.adoptionEnvOffNotice')}
            </span>
          ) : null}
          {state.kind === 'unreadable' ? (
            <span className={styles.rowNotice} role="status" id={noticeId}>
              <Icon name="info" size={12} aria-hidden />
              {t('labs.adoptionStatusUnreadable')}
            </span>
          ) : null}
          {restartPending ? (
            <span className={styles.rowNotice} role="status" data-testid="labs-adoption-restart">
              <Icon name="info" size={12} aria-hidden />
              {t('labs.adoptionRestartNotice')}
            </span>
          ) : null}
          {ready ? (
            <span className={styles.rowNotice} data-testid="labs-adoption-status" data-executor={ready.executor}>
              {ready.executor === 'provisioned'
                ? t('labs.adoptionProvisioned')
                : t('labs.adoptionClosed', { gates: ready.gates.join(', ') })}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t('labs.adoptionName')}
          aria-disabled={locked || busy}
          aria-describedby={(ready && !ready.optIn.env) || state.kind === 'unreadable' ? noticeId : undefined}
          className={`${styles.switch}${on ? ` ${styles.switchOn}` : ''}`}
          onClick={toggle}
          data-testid="labs-adoption-switch"
        >
          <span className={styles.switchKnob} aria-hidden />
        </button>
      </div>
    </section>
  );
}
