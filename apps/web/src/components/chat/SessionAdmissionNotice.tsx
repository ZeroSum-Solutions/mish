import type { SessionRunAdmission, SessionExecutionChoice } from '@open-design/contracts';
import { useT } from '../../i18n';
import { readSessionRunAdmission, sessionExecutionLabel } from '../../runtime/workbench/session-admission';
import { Foldable } from './primitives/Foldable';
import styles from './SessionAdmissionNotice.module.css';
/** The daemon's admitted turn remains fixed while the next-turn picker changes. */
export function SessionAdmissionNotice({ admission: input, runId }: { admission?: SessionRunAdmission; runId?: string }) {
  const t = useT();
  const admission = readSessionRunAdmission(input, { runId });
  if (!admission) return null;
  const notice = admission.replayNotice;
  const identityLabel = (identity: { choice: SessionExecutionChoice; effectiveModel: string | null }) => `${sessionExecutionLabel(identity.choice)}${identity.effectiveModel && identity.effectiveModel !== identity.choice.modelId ? ` (${t('sessionModel.effective', { model: identity.effectiveModel })})` : ''}`;
  const to = notice ? identityLabel(notice.to) : sessionExecutionLabel(admission.requested);
  const reasonKey = notice?.reason === 'model-switch' ? 'sessionModel.replay.switch' : notice?.reason === 'fresh-continuation' ? 'sessionModel.replay.continuation' : 'sessionModel.replay.stateless';
  return <aside className={styles.notice} role="note" data-testid="session-admission-notice" data-run-id={admission.runId}>
    <div>{t('sessionModel.admitted', { model: sessionExecutionLabel(admission.requested) })}</div>
    {admission.effectiveModel && admission.effectiveModel !== admission.requested.modelId ? <div>{t('sessionModel.effective', { model: admission.effectiveModel })}</div> : null}
    {notice ? <Foldable variant="flat" summary={t(reasonKey, { from: notice.from ? identityLabel(notice.from) : '', to })}>
      <div className={styles.details}>
        <div>{t('sessionModel.replay.included', { messages: notice.includedMessages, attachments: notice.attachmentCount })}</div>
        {notice.omittedMessages > 0 || notice.omittedBytes > 0 ? <div>{t('sessionModel.replay.omitted', { messages: notice.omittedMessages, bytes: notice.omittedBytes })}</div> : null}
        {notice.omittedRanges.map((range, index) => <div key={index}>{t('sessionModel.replay.range', { first: range.first, last: range.last })}</div>)}
        {notice.mandatoryTruncation.brief ? <div>{t('sessionModel.replay.brief')}</div> : null}
        {notice.mandatoryTruncation.anchor ? <div>{t('sessionModel.replay.anchor')}</div> : null}
        {notice.mandatoryTruncation.context ? <div>{t('sessionModel.replay.context')}</div> : null}
        <div>{t('sessionModel.replay.bytes', { bytes: notice.bytes, limit: notice.byteLimit })}</div>
        {notice.estimatedReplayTokens !== null ? <div>{t('sessionModel.replay.estimate', { tokens: notice.estimatedReplayTokens })}</div> : null}
        <div>{t('sessionModel.replay.unverified')}</div>
      </div>
    </Foldable> : null}
  </aside>;
}
