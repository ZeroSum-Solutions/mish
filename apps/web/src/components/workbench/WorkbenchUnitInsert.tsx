import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Select, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@mish/components';
import type { Project, ReusableUnitManifest, UnitInsertReceipt, UnitInsertRefusal, WorkspaceCollabContext } from '@mish/contracts';
import type { Dict } from '../../i18n/types';
import { useT } from '../../i18n';
import { listProjects } from '../../state/projects';
import { buildPath } from '../../router';
import { CaptureRequestError, unitApi } from '../../providers/workbench-capture';
import styles from './WorkbenchCapture.module.css';

const refusalMessages = {
  'rights-blocked': 'workbench.unit.refusal.rights-blocked',
  'unsupported-target-format': 'workbench.unit.refusal.unsupported-target-format',
  'same-project': 'workbench.unit.refusal.same-project',
  'unsafe-path': 'workbench.unit.refusal.unsafe-path',
  'insert-conflict': 'workbench.unit.refusal.insert-conflict',
  'insert-not-found': 'workbench.unit.refusal.insert-not-found',
  'insert-incomplete': 'workbench.unit.refusal.insert-incomplete',
  'idempotency-conflict': 'workbench.unit.refusal.idempotency-conflict',
  'project-not-found': 'workbench.unit.refusal.project-not-found',
  'project-directory-missing': 'workbench.unit.refusal.project-directory-missing',
  'unit-file-missing': 'workbench.unit.refusal.unit-file-missing',
} as const satisfies Record<UnitInsertRefusal, keyof Dict>;

/** AC-R14.4: copies editable files, shows the actual receipt and keeps undo beside the open action. */
export function WorkbenchUnitInsert({ unit, workspaceContext }: { unit: ReusableUnitManifest; workspaceContext?: WorkspaceCollabContext | null }) {
  const t = useT();
  const [choosing, setChoosing] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; paths: string[] } | null>(null);
  const [confirmation, setConfirmation] = useState<{ receipt: UnitInsertReceipt; paths: string[] } | null>(null);
  const [receipts, setReceipts] = useState<UnitInsertReceipt[]>([]);
  const remember = (receipt: UnitInsertReceipt) => setReceipts(current => [receipt, ...current.filter(item => item.insertId !== receipt.insertId)]);
  const generation = useRef(0);
  const key = useRef<string | null>(null);
  useEffect(() => {
    const n = ++generation.current; setChoosing(false); setConfirmation(null); setReceipts([]); setProjects([]); setProjectId(''); setBusy(false); setError(null); key.current = null;
    unitApi.listInsertions(unit.unitId, workspaceContext).then(found => { if (n === generation.current) setReceipts(current => [...current, ...found.filter(item => (item.status !== 'undone' || item.recoveryPath) && !current.some(existing => existing.insertId === item.insertId))]); }).catch(value => { if (n === generation.current) setError(failure(value)); });
    return () => { generation.current++; };
  }, [unit.unitId, workspaceContext]);
  function failure(value: unknown): { message: string; paths: string[] } {
    if (value instanceof CaptureRequestError && value.reason && Object.hasOwn(refusalMessages, value.reason)) return { message: t(refusalMessages[value.reason as UnitInsertRefusal]), paths: value.discardEditsAllowed ? [] : value.paths };
    return { message: value instanceof Error ? value.message : String(value), paths: value instanceof CaptureRequestError ? value.paths : [] };
  }
  async function choose() {
    const n = generation.current;
    setChoosing(true); setBusy(true); setError(null);
    try {
      const all = await listProjects({ workspaceContext, throwOnError: true });
      if (n === generation.current) setProjects(all.filter(project => project.id !== unit.provenance.projectId));
    } catch (value) { if (n === generation.current) setError(failure(value)); }
    finally { if (n === generation.current) setBusy(false); }
  }
  async function insert() {
    if (!projectId || busy) return;
    const n = generation.current; setBusy(true); setError(null);
    key.current ??= crypto.randomUUID();
    try {
      const next = await unitApi.insert(unit.unitId, { projectId, mode: 'standalone-artifact' }, workspaceContext, key.current);
      if (n === generation.current) { remember(next); setChoosing(false); }
    } catch (value) { if (n === generation.current) { setError(failure(value)); if (value instanceof CaptureRequestError && value.insertion) { remember(value.insertion); setChoosing(false); } } }
    finally { if (n === generation.current) setBusy(false); }
  }
  async function undo(receipt: UnitInsertReceipt, discardEdits = false) {
    if (busy) return;
    const n = generation.current; setBusy(true); setError(null);
    try {
      const next = discardEdits ? await unitApi.undoInsert(receipt.insertId, workspaceContext, { discardEdits: true }) : await unitApi.undoInsert(receipt.insertId, workspaceContext);
      if (n === generation.current) { remember(next); setConfirmation(null); key.current = null; }
    } catch (value) {
      if (n === generation.current) {
        setError(failure(value));
        setConfirmation(value instanceof CaptureRequestError && value.reason === 'insert-conflict' && value.discardEditsAllowed && value.paths.length ? { receipt, paths: value.paths } : null);
      }
    }
    finally { if (n === generation.current) setBusy(false); }
  }
  const active = receipts.some(receipt => receipt.status !== 'undone');
  return <div className={styles.panel} data-testid="workbench-unit-insert">
    {!active ? <Button size="sm" disabled={busy} onClick={() => void choose()}>{t('workbench.unit.insert')}</Button> : null}
    {choosing ? <div className={styles.planForm}>
      <label className={styles.field}>{t('workbench.unit.destination')}
        <Select value={projectId} disabled={busy} onChange={event => { setProjectId(event.target.value); key.current = null; }}>
          <option value="">{t('workbench.unit.chooseDestination')}</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </Select>
      </label>
      <p className={styles.hint}>{t('workbench.unit.standaloneOnly')}</p>
      <div className={styles.row}>
        <Button size="sm" disabled={busy || !projectId} onClick={() => void insert()}>{busy ? t('workbench.unit.inserting') : t('workbench.unit.addArtifact')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChoosing(false)}>{t('workbench.unit.cancelInsert')}</Button>
      </div>
    </div> : null}
    {receipts.map(receipt => <div key={receipt.insertId} role="status" className={styles.saved}>
      {receipt.status === 'undone' ? <>
        <p>{t('workbench.unit.insertUndone')}</p>
        {receipt.recoveryPath ? <p>{t('workbench.unit.editsBackedUp', { path: receipt.recoveryPath })}</p> : null}
      </> : <>
        <p>{receipt.status === 'inserted' ? t('workbench.unit.inserted', { count: receipt.files.length, path: receipt.entryPath }) : t('workbench.unit.insertIncomplete')}</p>
        <p className={styles.hint}>{t('workbench.unit.insertVerification')}</p>
        {unit.dependencies.length ? <p className={styles.hint}>{t('workbench.unit.notInstalled')} {unit.dependencies.map(dependency => `${dependency.name} ${dependency.version}`).join(', ')}</p> : null}
        <div className={styles.row}>
          {receipt.status === 'inserted' ? <a href={buildPath({ kind: 'project', projectId: receipt.projectId, fileName: receipt.entryPath })} target="_blank" rel="noopener">{t('workbench.unit.openInserted')}</a> : null}
          <Button size="sm" disabled={busy} onClick={() => void undo(receipt)}>{t('workbench.unit.undoInsert')}</Button>
        </div>
        <p className={styles.hint}>{t('workbench.unit.undoInsertHint')}</p>
      </>}
    </div>)}
    {confirmation ? createPortal(<div data-workbench-unit-insert-dialog="true"><Dialog role="alertdialog" ariaLabel={t('workbench.unit.editedFiles')} closeOnEscape={!busy} closeOnBackdrop={!busy} onClose={() => { if (!busy) { setConfirmation(null); setError(null); } }} layout="sectioned">
      <DialogHeader><DialogTitle>{t('workbench.unit.editedFiles')}</DialogTitle></DialogHeader>
      <DialogBody className={styles.dialogBody}>
        <p>{t(confirmation.receipt.status === 'inserted' ? 'workbench.unit.confirmDiscardEdits' : 'workbench.unit.confirmPartialUndo')}</p>
        <ul className={styles.fileList}>{confirmation.paths.map(file => <li key={file}>{file}</li>)}</ul>
      </DialogBody>
      <DialogFooter>
        <Button size="sm" disabled={busy} style={{ color: 'var(--red)' }} onClick={() => void undo(confirmation.receipt, true)}>{t('workbench.unit.backUpAndUndo')}</Button>
        <Button size="sm" variant="ghost" autoFocus disabled={busy} onClick={() => { setConfirmation(null); setError(null); }}>{t('workbench.unit.keepEdits')}</Button>
      </DialogFooter>
    </Dialog></div>, document.body) : null}
    {error ? <div role="alert" className={styles.error}><p>{error.message}</p>{error.paths.length ? <ul className={styles.fileList}>{error.paths.map(file => <li key={file}>{file}</li>)}</ul> : null}</div> : null}
  </div>;
}
