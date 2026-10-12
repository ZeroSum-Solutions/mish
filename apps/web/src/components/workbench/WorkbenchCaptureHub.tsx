import { useId, useState } from 'react';
import type { CaptureDraftRevision, WorkspaceCollabContext } from '@mish/contracts';
import { useT } from '../../i18n';
import { WorkbenchCapturePanel } from './WorkbenchCapturePanel';
import { WorkbenchCaptureDraftLibrary, WorkbenchCaptureDraftPanel } from './WorkbenchCaptureDraftPanel';
import { WorkbenchUnitSave } from './WorkbenchUnitSave';
import styles from './WorkbenchCapture.module.css';

type Tab = 'captures' | 'drafts' | 'units';

/** Entry point for R14 capture and reusable-unit save inside a project. */
export function WorkbenchCaptureHub({ projectId, workspaceContext }: { projectId?: string; workspaceContext?: WorkspaceCollabContext | null }) {
  const t = useT();
  const id = useId();
  const [tab, setTab] = useState<Tab>('captures');
  const [draft, setDraft] = useState<{ captureId: string; initialDraft?: Pick<CaptureDraftRevision, 'draftId' | 'revision'> } | null>(null);
  if (!projectId) return <p className={styles.hint}>{t('workbench.unit.chooseProject')}</p>;
  const tabs: Array<[Tab, string]> = [['captures', t('workbench.captureHub.captures')], ['drafts', t('workbench.captureHub.drafts')], ['units', t('workbench.captureHub.units')]];
  return <div className={styles.hub} data-testid="workbench-capture-hub">
    <div role="tablist" aria-label={t('workbench.captureHub.title')} className={styles.tabs}>
      {tabs.map(([value, label]) => <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} className={styles.tab}
        onClick={() => setTab(value)}
        onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = tabs[(tabs.findIndex(([current]) => current === tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]![0]; setTab(next); document.getElementById(`${id}-${next}`)?.focus(); } }}>{label}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}`}>
      {tab === 'captures' ? <WorkbenchCapturePanel projectId={projectId} workspaceContext={workspaceContext} onOpenDraft={capture => setDraft({ captureId: capture.capture.id })} />
        : tab === 'drafts' ? <WorkbenchCaptureDraftLibrary key={draft ? 'open' : 'closed'} projectId={projectId} workspaceContext={workspaceContext} onOpen={selected => setDraft({ captureId: selected.captureId, initialDraft: selected })} />
          : <WorkbenchUnitSave projectId={projectId} workspaceContext={workspaceContext} />}
    </div>
    {draft ? <WorkbenchCaptureDraftPanel key={`${projectId}:${draft.captureId}`} projectId={projectId} workspaceContext={workspaceContext} {...draft} onClose={() => setDraft(null)} /> : null}
  </div>;
}
