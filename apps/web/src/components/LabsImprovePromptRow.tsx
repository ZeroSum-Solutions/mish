import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { BriefTransformerStatus, BriefTransformerStatusResponse } from '@open-design/contracts';

import { useT } from '../i18n';
import { Icon } from './Icon';
import styles from './LabsSection.module.css';

/**
 * Settings → Labs row for the Improve prompt writer: on runs GPT Terra on
 * OpenRouter, with the Claude turn as the fallback. Like the other Labs rows
 * it reads the daemon's own answer and writes one field
 * (`improvePromptTransformer`) with a single-field PUT.
 */
type RowState = { kind: 'loading' } | { kind: 'unreadable' } | { kind: 'ready'; status: BriefTransformerStatus };

async function readTransformerStatus(): Promise<BriefTransformerStatus> {
  const response = await fetch('/api/workbench/briefs/transformer');
  if (!response.ok) throw new Error(`transformer status failed (${response.status})`);
  return ((await response.json()) as BriefTransformerStatusResponse).status;
}

async function writeTransformer(terra: boolean): Promise<void> {
  const response = await fetch('/api/app-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ improvePromptTransformer: terra ? 'terra' : 'claude' }),
  });
  if (!response.ok) throw new Error(`app-config write failed (${response.status})`);
}

export function LabsImprovePromptRow() {
  const t = useT();
  const [state, setState] = useState<RowState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const noticeId = useId();

  const refresh = useCallback(async () => {
    try {
      const status = await readTransformerStatus();
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
    const next = state.status.lane !== 'terra';
    busyRef.current = true; setBusy(true);
    void (async () => {
      try { await writeTransformer(next); } catch { /* The re-read below shows what the daemon holds. */ }
      await refresh();
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    })();
  }, [refresh, state]);

  const ready = state.kind === 'ready' ? state.status : null;
  const on = ready?.lane === 'terra';
  const locked = state.kind !== 'ready';
  const noKey = Boolean(ready && on && !ready.terraKeyAvailable);
  return (
    <section className="settings-section">
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>
            <span className={styles.rowName}>{t('labs.improvePromptName')}</span>
          </span>
          <span className={styles.rowHint}>{t('labs.improvePromptHint')}</span>
          {state.kind === 'unreadable' ? (
            <span className={styles.rowNotice} role="status" id={noticeId} data-testid="labs-improve-prompt-unreadable">
              <Icon name="info" size={12} aria-hidden />
              {t('labs.improvePromptUnreadable')}
            </span>
          ) : null}
          {ready && on && ready.terraKeyAvailable ? (
            <span className={styles.rowNotice} data-testid="labs-improve-prompt-model">
              {t('labs.improvePromptModel', { model: ready.terraModel, fallback: ready.fallbackModel })}
            </span>
          ) : null}
          {noKey ? (
            <span className={styles.rowNotice} role="status" id={noticeId} data-testid="labs-improve-prompt-no-key">
              <Icon name="info" size={12} aria-hidden />
              {t('labs.improvePromptNoKey')}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t('labs.improvePromptName')}
          aria-disabled={locked || busy}
          aria-describedby={state.kind === 'unreadable' || noKey ? noticeId : undefined}
          className={`${styles.switch}${on ? ` ${styles.switchOn}` : ''}`}
          onClick={toggle}
          data-testid="labs-improve-prompt-switch"
        >
          <span className={styles.switchKnob} aria-hidden />
        </button>
      </div>
    </section>
  );
}
