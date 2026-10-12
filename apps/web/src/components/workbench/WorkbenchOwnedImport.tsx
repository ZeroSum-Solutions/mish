import { useEffect, useId, useState, type InputHTMLAttributes } from 'react';
import { Button, Input, Select } from '@mish/components';
import type { OwnedImportRecord, WorkspaceCollabContext } from '@mish/contracts';
import { useT } from '../../i18n';
import { createOwnedImport, listOwnedImports } from '../../providers/workbench-owned-imports';
import { WorkbenchRequestError } from '../../providers/workbench';
import styles from './WorkbenchSources.module.css';

interface Picked { path: string; file: File }
/** Chromium, WebKit and Firefox directory selection; React has no typed prop for it. */
const DIRECTORY_PICK = { webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>;

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
function readBytes(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('file-read-failed'));
    reader.readAsArrayBuffer(file);
  });
}
/** Folder picks keep paths relative to the chosen folder; single files keep their names. */
function relativePath(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative ? relative.split('/').slice(1).join('/') || file.name : file.name;
}

/**
 * AC-R12.4 canvas surface: import an owner-provided Magic Patterns export from local
 * files. No provider account or MCP is involved; the saved record shows its hashes and
 * the placeholder data/actions to replace. Apply and reuse happen from workbench search.
 * In a workspace every request carries the member identity, so the import is that member's.
 */
export function WorkbenchOwnedImport({ workspaceContext = null }: { workspaceContext?: WorkspaceCollabContext | null } = {}) {
  const t = useT();
  const entryId = useId();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [name, setName] = useState('');
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState<OwnedImportRecord | null>(null);
  const [saved, setSaved] = useState<OwnedImportRecord[]>([]);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => { listOwnedImports(workspaceContext).then(list => setSaved(list.imports)).catch(() => setSaved([])); }, [workspaceContext]);
  function choose(files: FileList | null) {
    // Like `od workbench import create --dir`: hidden entries (.DS_Store, .git) and node_modules are not part of an export.
    const next = [...(files ?? [])].map(file => ({ path: relativePath(file), file }))
      .filter(item => item.path.split('/').every(part => !part.startsWith('.') && part !== 'node_modules'));
    setPicked(next);
    setEntry(next.find(item => /(^|\/)index\.html?$/u.test(item.path))?.path ?? next.find(item => /\.html?$/u.test(item.path))?.path ?? next[0]?.path ?? '');
  }
  async function submit() {
    setBusy(true); setError(null);
    try {
      const files = await Promise.all(picked.map(async item => ({ path: item.path, contentBase64: base64(await readBytes(item.file)) })));
      const created = await createOwnedImport({ provider: 'magic-patterns', name: name.trim(), entryPath: entry, ownership: { declaration: 'owner-provided-export', exportedFrom: null }, files }, workspaceContext);
      setRecord(created); setSaved(prior => [...prior.filter(item => item.id !== created.id), created]);
    } catch (reason) { setError(reason instanceof Error ? reason : new Error('import-failed')); } finally { setBusy(false); }
  }
  const typed = error instanceof WorkbenchRequestError ? error : null;
  return <section className={styles.root} aria-label={t('workbenchImport.title')}>
    <h4 className={styles.title}>{t('workbenchImport.title')}</h4>
    <p className={styles.hint}>{t('workbenchImport.hint')}</p>
    <form className={styles.controls} onSubmit={event => { event.preventDefault(); if (picked.length && name.trim() && entry) void submit(); }}>
      <label>{t('workbenchImport.files')}<Input type="file" multiple onChange={event => choose(event.target.files)} /></label>
      {/* A whole export folder keeps nested paths, so relative references and same-named files survive. */}
      <label>{t('workbenchImport.folder')}<Input type="file" multiple {...DIRECTORY_PICK} onChange={event => choose(event.target.files)} /></label>
      <label>{t('workbenchImport.name')}<Input value={name} maxLength={120} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
      {picked.length ? <div className={styles.field}><label htmlFor={entryId}>{t('workbenchImport.entry')}</label>
        <Select id={entryId} value={entry} onChange={event => setEntry(event.target.value)}>{picked.map(item => <option key={item.path} value={item.path}>{item.path}</option>)}</Select>
      </div> : null}
      <Button size="sm" type="submit" disabled={busy || !picked.length || !name.trim() || !entry}>{t('workbenchImport.submit')}</Button>
    </form>
    {busy ? <p role="status" className={styles.meta}>{t('workbenchImport.importing')}</p> : null}
    {error ? <div role="alert" className={styles.error}><p>{t('workbenchImport.failed')} · {typed ? `${typed.code} · ${typed.message}` : error.message}</p></div> : null}
    {record ? <section className={styles.row} data-testid="workbench-owned-import-record" aria-label={record.name}>
      <p className={styles.rowTitle}>{record.name}</p>
      <p className={styles.meta}>{t('workbenchImport.provenance')}</p>
      <dl className={styles.facts}>
        <dt>{t('workbenchImport.artifact')}</dt><dd><code>{record.artifactSha256}</code></dd>
        <dt>{t('workbenchImport.fileCount')}</dt><dd>{record.files.length} · {record.entryPath}</dd>
        <dt>{t('workbenchImport.placeholders')}</dt>
        <dd>{record.placeholders.length
          ? <ul>{record.placeholders.map(item => <li key={`${item.path}:${item.line}:${item.kind}`}>{item.kind} · {item.path}:{item.line} · {item.excerpt}</li>)}</ul>
          : t('workbenchImport.noPlaceholders')}</dd>
      </dl>
    </section> : null}
    {saved.length ? <>
      <p className={styles.meta}>{t('workbenchImport.saved')}</p>
      <ul className={styles.list}>{saved.map(item => <li key={item.id} className={styles.meta}>{item.name} · {item.files.length} · {item.placeholders.length}</li>)}</ul>
    </> : null}
  </section>;
}
