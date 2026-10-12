import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { StagedDraftingResponse, StagedDraftingStatus } from '@mish/contracts';

import { useT } from '../i18n';
import { Icon } from './Icon';
import styles from './LabsSection.module.css';

/**
 * Settings → Labs row for staged drafting: a fast model drafts, the main model
 * finishes. Off by default. Like the other Labs rows it reads the daemon's own
 * answer and writes one field (`stagedDrafting`) with a single-field PUT, since
 * the web `AppConfig` projection does not carry it.
 */
type RowState = { kind: 'loading' } | { kind: 'unreadable' } | { kind: 'ready'; status: StagedDraftingStatus };

async function readStagedStatus(): Promise<StagedDraftingStatus> {
  const response = await fetch('/api/agents/staged');
  if (!response.ok) throw new Error(`staged status failed (${response.status})`);
  return ((await response.json()) as StagedDraftingResponse).status;
}

async function writeStagedSwitch(on: boolean): Promise<void> {
  const response = await fetch('/api/app-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stagedDrafting: on }),
  });
  if (!response.ok) throw new Error(`app-config write failed (${response.status})`);
}

export function LabsStagedRow() {
  const t = useT();
  const [state, setState] = useState<RowState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const noticeId = useId();

  const refresh = useCallback(async () => {
    try {
      const status = await readStagedStatus();
      if (mountedRef.current) setState({ kind: 'ready', status });
    } catch {
      if (mountedRef.current) setState({ kind: 'unreadable' });
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
    const next = !state.status.enabled;
    busyRef.current = true; setBusy(true);
    void (async () => {
      try { await writeStagedSwitch(next); } catch { /* The re-read below shows what the daemon holds. */ }
      await refresh();
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    })();
  }, [refresh, state]);

  const ready = state.kind === 'ready' ? state.status : null;
  const on = ready?.enabled ?? false;
  const locked = state.kind !== 'ready';
  return (
    <section className="settings-section">
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>
            <span className={styles.rowName}>{t('labs.stagedName')}</span>
          </span>
          <span className={styles.rowHint}>{t('labs.stagedHint')}</span>
          {state.kind === 'unreadable' ? (
            <span className={styles.rowNotice} role="status" id={noticeId} data-testid="labs-staged-unreadable">
              <Icon name="info" size={12} aria-hidden />
              {t('labs.stagedStatusUnreadable')}
            </span>
          ) : null}
          {ready?.draft ? (
            <span className={styles.rowNotice} data-testid="labs-staged-draft">
              {t('labs.stagedDraftModel', { model: ready.draft.model })}
            </span>
          ) : null}
          {ready && !ready.draft ? (
            <span className={styles.rowNotice} role="status" id={noticeId} data-testid="labs-staged-unavailable">
              <Icon name="info" size={12} aria-hidden />
              {t('labs.stagedUnavailable')}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t('labs.stagedName')}
          aria-disabled={locked || busy}
          aria-describedby={state.kind === 'unreadable' || (ready && !ready.draft) ? noticeId : undefined}
          className={`${styles.switch}${on ? ` ${styles.switchOn}` : ''}`}
          onClick={toggle}
          data-testid="labs-staged-switch"
        >
          <span className={styles.switchKnob} aria-hidden />
        </button>
      </div>
    </section>
  );
}
