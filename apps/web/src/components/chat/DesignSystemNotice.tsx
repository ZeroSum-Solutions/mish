// A refused selected kit stops generation. Approval binds the revision in the notice.
import { Button } from '@mish/components';
import { useState } from 'react';
import type { DesignSystemRunNotice } from '@mish/contracts';
import { useWorkspaceContext } from '../../collab/useWorkspaceContext';
import { useT } from '../../i18n';
import { setDesignSystemApproval, updateDesignSystemDraft } from '../../providers/registry';
import type { AgentEvent } from '../../types';
import styles from './DesignSystemNotice.module.css';

/** The last design-kit notice among a turn's events, or null. */
export function latestDesignSystemNotice(
  events: readonly AgentEvent[] | undefined,
): DesignSystemRunNotice | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.kind === 'design_system_notice') return event.notice;
  }
  return null;
}

export function DesignSystemNotice({ notice }: { notice: DesignSystemRunNotice | null }) {
  const t = useT();
  const { context: workspaceContext } = useWorkspaceContext();
  const [state, setState] = useState<'idle' | 'publishing' | 'published' | 'failed'>('idle');
  if (!notice) return null;
  const name = notice.title ?? notice.designSystemId;
  const messageKey = notice.reason === 'unreviewed' ? 'designSystemPicker.approvalBlocked' : notice.reason === 'draft'
    ? 'chat.designSystemNotice.draft'
    : notice.reason === 'not_found'
      ? 'chat.designSystemNotice.notFound'
      : 'chat.designSystemNotice.empty';

  async function publish() {
    if (!notice || state === 'publishing') return;
    setState('publishing');
    if (notice.reason === 'unreviewed') {
      const updated = notice.revision ? await setDesignSystemApproval(notice.designSystemId, { approved: true, expectedRevision: notice.revision }, workspaceContext) : null;
      setState(updated ? 'published' : 'failed');
      return;
    }
    const updated = await updateDesignSystemDraft(
      notice.designSystemId,
      { status: 'published' },
      workspaceContext,
    );
    setState(updated ? 'published' : 'failed');
  }

  return (
    <aside
      className={styles.notice}
      role="note"
      data-testid="design-system-notice"
      data-reason={notice.reason}
    >
      <span className={styles.icon} aria-hidden="true">!</span>
      <div className={styles.body}>
        <p className={styles.message}>{t(messageKey, { name })}</p>
        {state === 'published' ? (
          <p className={styles.status} role="status">{t(notice.reason === 'unreviewed' ? 'designSystemPicker.approved' : 'chat.designSystemNotice.published')}</p>
        ) : state === 'failed' ? (
          <p className={styles.status} role="alert">{t(notice.reason === 'unreviewed' ? 'designSystemPicker.approvalFailed' : 'chat.designSystemNotice.publishFailed')}</p>
        ) : null}
      </div>
      {(notice.reason === 'draft' || (notice.reason === 'unreviewed' && notice.revision)) && state !== 'published' ? (
        <Button
          variant="secondary"
          size="sm"
          loading={state === 'publishing'}
          onClick={() => void publish()}
        >
          {t(notice.reason === 'unreviewed' ? 'designSystemPicker.approve' : 'chat.designSystemNotice.publish')}
        </Button>
      ) : null}
    </aside>
  );
}
