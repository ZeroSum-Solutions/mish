import { useEffect, useId, useState } from 'react';
import { Button } from '@mish/components';
import { validateVercelProjectName, type VercelNameCheckResponse } from '@mish/contracts';
import { useT } from '../i18n';
import styles from './VercelSiteNameField.module.css';

export function VercelSiteNameField({ value, onChange, projectId, enabled, locked = false, workspaceHeaders }: {
  value: string; onChange: (name: string) => void; projectId?: string; enabled: boolean; locked?: boolean; workspaceHeaders?: HeadersInit;
}) {
  const t = useT();
  const id = useId();
  const [check, setCheck] = useState<VercelNameCheckResponse | 'checking' | 'unknown' | null>(null);
  const validation = validateVercelProjectName(value);
  // Include the serialized scope so a team/member switch invalidates a pending hint.
  const scope = JSON.stringify(Object.fromEntries(new Headers(workspaceHeaders).entries()));
  useEffect(() => {
    setCheck(null);
    if (!enabled || locked || !validateVercelProjectName(value).valid) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setCheck('checking');
      try {
        const query = new URLSearchParams({ name: value, ...(projectId ? { projectId } : {}) });
        const response = await fetch(`/api/deploy/vercel/name-check?${query}`, { signal: controller.signal, headers: JSON.parse(scope) });
        const result = await response.json() as VercelNameCheckResponse;
        if (!controller.signal.aborted) setCheck(response.ok && result.name === value && result.advisory === true ? result : 'unknown');
      } catch { if (!controller.signal.aborted) setCheck('unknown'); }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [value, projectId, enabled, locked, scope]);
  const message = locked ? t('fileViewer.vercelNameLocked') : !validation.valid
    ? t(validation.reason === 'reserved' ? 'fileViewer.vercelNameReserved' : 'fileViewer.vercelNameInvalid')
    : check === 'checking' ? t('fileViewer.vercelNameChecking')
    : check === 'unknown' ? t('fileViewer.vercelNameUnknown')
    : check && check.available === false ? t('fileViewer.vercelNameTaken')
    : check && check.available === true ? t('fileViewer.vercelNameAvailable') : t('fileViewer.vercelNameAdvisory');
  return <div className={styles.field}>
    <label htmlFor={id}>{t('fileViewer.vercelSiteAddress')}</label>
    <div className={styles.address}>
      <input id={id} value={value} disabled={locked} spellCheck={false} autoCapitalize="none" autoComplete="off"
        aria-invalid={!locked && !validation.valid} aria-describedby={`${id}-hint`} onChange={event => onChange(event.target.value)} />
      <span>.vercel.app</span>
    </div>
    <p id={`${id}-hint`} role="status" className={styles.hint}>{message}</p>
    <p className={styles.hint}>{t('fileViewer.vercelNameReplacement')}</p>
    {check && typeof check === 'object' && check.suggestion ? <Button variant="secondary" size="sm" onClick={() => onChange(check.suggestion!)}>
      {t('fileViewer.vercelNameSuggestion', { name: check.suggestion })}
    </Button> : null}
  </div>;
}
