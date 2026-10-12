import { Button } from '@mish/components';
import type { ModelPreflightMismatch, ModelPreflightResult } from '@mish/contracts';
import { useT } from '../../i18n';
import type { SessionModelState } from '../../runtime/workbench/session-model-controller';
import styles from './workbench.module.css';
export function SessionModelStatus({ state, onRetry, onOpenSettings }: { state: SessionModelState; onRetry(): void; onOpenSettings(): void }) {
  const t = useT();
  // The model chip's tooltip and accessible name own the ready caption
  // (`sessionModel.nextTurn` prefix in InlineModelSwitcher); errors remain
  // visible. Keeping a persistent "ready" row here would defeat the
  // single-row toolbar geometry this component's container enforces
  // (ResponsiveComposerToolbar's `composer-toolbar` row keeps every visible
  // control vertically centered with the send button — see
  // e2e/ui/composer-responsive.test.ts) every time a session is simply idle,
  // which is the common case.
  if (state.status === 'ready') return null;
  const blocked = state.status === 'error' || state.status === 'conflict';
  return <div className={styles.modelStatus} role={blocked ? 'alert' : 'status'} data-testid="session-model-status">
    <span>{t(state.status === 'conflict' ? 'sessionModel.conflict' : state.status === 'error' ? 'sessionModel.error' : state.status === 'saving' ? 'sessionModel.saving' : 'sessionModel.loading')}</span>
    {state.status === 'conflict' && state.snapshot?.choice ? <span>{t('sessionModel.current', { model: `${state.snapshot.choice.agentId} · ${state.snapshot.choice.modelId}` })}</span> : null}
    {blocked ? <><Button variant="ghost" onClick={onRetry}>{t('sessionModel.retry')}</Button><Button variant="ghost" onClick={onOpenSettings}>{t('sessionModel.settings')}</Button></> : null}
  </div>;
}

// --- Pre-submit capability/attachment preflight (AC-R02.3) ---------------
// Purely presentational, like SessionModelStatus above: the caller owns
// fetching the `ModelPreflightResult` (POST
// `/api/workbench/sessions/:id/model/preflight`, or the `od workbench model
// preflight` CLI) and deciding what the composer does with a failed result —
// nothing here discards the drafted prompt or the previous usable selection.
type PreflightT = ReturnType<typeof useT>;
function preflightMismatchText(t: PreflightT, mismatch: ModelPreflightMismatch, agentLabel: string, modelLabel: string): string {
  const names = (mismatch.attachmentNames ?? []).join(', ');
  switch (mismatch.code) {
    // AC-R02.3: the model/agent pairing is never actually persisted or
    // changed on a rejection any more — the select-time gate in
    // `use-session-model.ts` means a saved choice has always already passed
    // a capability preflight, and a send-time rejection leaves it alone —
    // so "keeping your previous model choice" is always literally true,
    // not a restore decision a caller has to track.
    case 'model-unavailable': return t('workbench.preflight.modelUnavailable', { model: modelLabel, agent: agentLabel });
    case 'image-attachments-unsupported': return t('workbench.preflight.imageAttachmentsUnsupported', { agent: agentLabel, names });
    case 'attachment-too-large': return t('workbench.preflight.attachmentTooLarge', { names });
    // An unrecognized code (e.g. a newer daemon build) still renders the
    // server's own message rather than going blank.
    default: return mismatch.message;
  }
}
/** Attachment names a result's mismatches call out, deduped and in order —
 *  for a caller that wants to badge individual staged attachment chips. */
export function preflightAttachmentNames(result: ModelPreflightResult | null | undefined): string[] {
  if (!result) return [];
  const names = new Set<string>();
  for (const mismatch of result.mismatches) for (const name of mismatch.attachmentNames ?? []) names.add(name);
  return [...names];
}
export interface SessionModelPreflightProps {
  result: ModelPreflightResult | null;
  agentLabel: string;
  modelLabel: string;
  checking?: boolean;
  /** AC-R02.3: the preflight CALL itself failed (network/service error),
   *  distinct from `result` reporting a capability mismatch — no `result`
   *  exists to describe in this case, so it renders its own truthful
   *  "couldn't verify" message instead of going blank. Used by the
   *  select-time picker gate (`useSessionModel`'s `pickerPreflight`); the
   *  existing send-time image-attachment failure keeps its own dedicated
   *  `setError` message rather than this banner. */
  verificationFailed?: boolean;
  onRetry?(): void;
}
export function SessionModelPreflightBanner({ result, agentLabel, modelLabel, checking = false, verificationFailed = false, onRetry }: SessionModelPreflightProps) {
  const t = useT();
  if (checking) return <div className={styles.preflightBanner} role="status" data-testid="session-model-preflight-checking"><span>{t('workbench.preflight.checking')}</span></div>;
  if (verificationFailed) return <div className={styles.preflightBanner} role="alert" data-testid="session-model-preflight-verification-failed"><span>{t('workbench.preflight.selectionVerificationFailed', { model: modelLabel, agent: agentLabel })}</span></div>;
  if (!result || result.ok) return null;
  return <div className={styles.preflightBanner} role="alert" data-testid="session-model-preflight-mismatch">
    <span className={styles.preflightTitle}>{t('workbench.preflight.title')}</span>
    <ul className={styles.preflightList}>
      {result.mismatches.map((mismatch, index) => (
        <li key={`${mismatch.code}-${index}`} data-testid={`session-model-preflight-mismatch-${mismatch.code}`}>
          {preflightMismatchText(t, mismatch, agentLabel, modelLabel)}
        </li>
      ))}
    </ul>
    {onRetry ? <Button variant="ghost" onClick={onRetry}>{t('workbench.preflight.retry')}</Button> : null}
  </div>;
}
