import styles from './DesignSystemApprovalBrowser.module.css';
import { useState } from 'react';
import { Button } from '@open-design/components';
import { isApprovedDesignSystem, type DesignSystemSummary, type WorkspaceCollabContext } from '@open-design/contracts';
import { useWorkspaceContext } from '../collab/useWorkspaceContext';
import { useT } from '../i18n';
import { setDesignSystemApproval } from '../providers/registry';
import { DesignSystemPreviewModal } from './DesignSystemPreviewModal';

/** Inspection never selects a kit. Approval enables a later explicit selection. */
export function DesignSystemApprovalBrowser({ systems, selectedIds = [], workspaceContext, onApprovalChange }: {
  systems: DesignSystemSummary[];
  selectedIds?: string[];
  workspaceContext?: WorkspaceCollabContext | null;
  onApprovalChange: (system: DesignSystemSummary) => void;
}) {
  const t = useT();
  const { context } = useWorkspaceContext();
  const scope = workspaceContext === undefined ? context : workspaceContext;
  const [showAll, setShowAll] = useState(false);
  const [preview, setPreview] = useState<DesignSystemSummary | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  async function approve(system: DesignSystemSummary, approved: boolean) {
    if (!system.approval || pending) return;
    setPending(system.id);
    setFailed(false);
    const updated = await setDesignSystemApproval(system.id, { approved, expectedRevision: system.approval.revision }, scope);
    setPending(null);
    if (!updated || (approved && !isApprovedDesignSystem(updated))) { setFailed(true); return; }
    onApprovalChange(updated);
  }
  const unreviewed = systems.filter((system) => !isApprovedDesignSystem(system));
  return <div className={styles.browser}>
    <label className={styles.toggle}><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />{t('designSystemPicker.showAll')}</label>
    {unreviewed.filter((system) => selectedIds.includes(system.id)).map((system) => <p className={styles.alert} key={system.id} role="alert">{t('designSystemPicker.approvalBlocked', { name: system.title })}</p>)}
    {(showAll ? systems : unreviewed.filter((system) => selectedIds.includes(system.id))).map((system) => <div className={styles.row} key={system.id}>
      <Button variant="ghost" size="sm" onClick={() => setPreview(system)}>{system.title}{!isApprovedDesignSystem(system) ? ` · ${t('designSystemPicker.unreviewed')}` : ''}</Button>
      <Button variant="secondary" size="sm" loading={pending === system.id} disabled={pending !== null} onClick={() => void approve(system, !isApprovedDesignSystem(system))}>{t(isApprovedDesignSystem(system) ? 'designSystemPicker.unapprove' : 'designSystemPicker.approve')}</Button>
    </div>)}
    {failed ? <p className={styles.alert} role="alert">{t('designSystemPicker.approvalFailed')}</p> : null}
    {preview ? <DesignSystemPreviewModal system={preview} workspaceContext={scope} onClose={() => setPreview(null)} /> : null}
  </div>;
}
