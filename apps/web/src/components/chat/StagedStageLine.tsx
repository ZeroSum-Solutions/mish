import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { StagedRunRecord } from '@mish/contracts';

import { useT } from '../../i18n';
import { stagedLineState } from '../../runtime/chat/staged-line';
import styles from './StagedStageLine.module.css';

/**
 * One line in a staged-drafting turn's record: "Drafting with Haiku 5.5",
 * "Finishing with Opus 5.5", and — after a daemon restart cut the finishing
 * pass short — "Draft only — finishing pass interrupted" with a Finish now
 * button. It reads the run's `staged` record and renders nothing for an
 * ordinary run, so it needs no card of its own.
 */
/**
 * History can hold hundreds of assistant messages; asking the daemon about each
 * run would be a request storm for a Labs feature most people leave off. So
 * the switch is read once (cached briefly) and nothing else is fetched while
 * it is off.
 */
let enabledCache: { at: number; value: Promise<boolean> } | null = null;
const ENABLED_TTL_MS = 30_000;

export function resetStagedEnabledCache(): void {
  enabledCache = null;
}

function stagedEnabled(): Promise<boolean> {
  const now = Date.now();
  if (enabledCache && now - enabledCache.at < ENABLED_TTL_MS) return enabledCache.value;
  const value = fetch('/api/agents/staged')
    .then(async response => {
      if (!response.ok) throw new Error(`Staged switch read failed: ${response.status}`);
      return Boolean(((await response.json()) as { status?: { enabled?: boolean } }).status?.enabled);
    })
    .catch(error => {
      if (enabledCache?.value === value) enabledCache = null;
      throw error;
    });
  enabledCache = { at: now, value };
  return value;
}

export interface StagedStageLineProps {
  runId: string | null | undefined;
  /** Poll interval while a stage is still open. */
  pollMs?: number;
}

export function StagedStageLine({ runId, pollMs = 2000 }: StagedStageLineProps): ReactElement | null {
  const t = useT();
  const [record, setRecord] = useState<StagedRunRecord | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [pollEpoch, setPollEpoch] = useState(0);
  const mountedRef = useRef(true);

  const read = useCallback(async (): Promise<StagedRunRecord | undefined> => {
    if (!runId) return undefined;
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) return undefined;
    if (!response.ok) throw new Error(`Staged status read failed: ${response.status}`);
    return ((await response.json()) as { staged?: StagedRunRecord }).staged;
  }, [runId]);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const tick = async () => {
      try {
        if (!(await stagedEnabled()) || disposed) return;
        const next = await read();
        if (disposed) return;
        failures = 0;
        setRecord(next);
        if (stagedLineState(next)?.active) timer = setTimeout(() => { void tick(); }, pollMs);
      } catch {
        if (disposed) return;
        // Keep the last known line through transient failures; back off to 30s.
        failures = Math.min(failures + 1, 8);
        timer = setTimeout(() => { void tick(); }, Math.min(30_000, pollMs * 2 ** failures));
      }
    };
    void tick();
    return () => {
      mountedRef.current = false;
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [read, pollMs, pollEpoch]);

  const finishNow = useCallback(async () => {
    if (!runId || busy) return;
    setBusy(true);
    try {
      await fetch(`/api/runs/${encodeURIComponent(runId)}/staged/finish`, { method: 'POST' });
      const next = await read();
      if (mountedRef.current) {
        setRecord(next);
        setPollEpoch(epoch => epoch + 1);
      }
    } catch {
      // A POST/read failure should not disable future refreshes or Finish now.
      if (mountedRef.current) setPollEpoch(epoch => epoch + 1);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, read, runId]);

  const state = stagedLineState(record);
  if (!state) return null;
  let text: string;
  switch (state.kind) {
    case 'drafting': text = t('staged.drafting', { model: state.model }); break;
    case 'finishing': text = t('staged.finishing', { model: state.model }); break;
    case 'done': text = t('staged.done', { draft: state.draftModel, finish: state.finishModel }); break;
    case 'interrupted': text = t('staged.interrupted'); break;
    case 'stopped': text = t(`staged.stopped.${state.reason}`); break;
    case 'fallback': text = t(`staged.fallback.${state.reason}`, { model: state.model }); break;
  }
  return (
    <div className={styles.line} data-testid="staged-line" data-state={state.kind} role="status">
      <span>{text}</span>
      {state.kind === 'interrupted' ? (
        <button type="button" className={styles.action} disabled={busy} onClick={() => { void finishNow(); }}>
          {t('staged.finishNow')}
        </button>
      ) : null}
    </div>
  );
}
