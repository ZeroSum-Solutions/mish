import { useId } from 'react';
import { Textarea } from '@mish/components';
import type { RightsDeclaration } from '@mish/contracts';
import { useT } from '../../i18n';
import styles from './WorkbenchCapture.module.css';

export type RightsChoice = 'owned' | 'licensed' | 'private' | 'reference' | 'unknown';
export interface RightsDraft { choice: RightsChoice; evidence: string; notices: string; attestation: string }
export const EMPTY_RIGHTS: RightsDraft = { choice: 'unknown', evidence: '', notices: '', attestation: '' };

const lines = (value: string) => [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))];

/**
 * The user's declaration only. It never carries a status: the daemon computes
 * what the declaration permits. Unknown sends no declaration at all.
 */
export function rightsDeclarationFor(draft: RightsDraft): RightsDeclaration | undefined {
  const base = { evidenceRefs: lines(draft.evidence), notices: lines(draft.notices) };
  switch (draft.choice) {
    case 'owned': return { basis: 'user-owned', ...base };
    case 'licensed': return { basis: 'licensed', ...base };
    case 'private': return { basis: 'model-authored', ...base, ...(draft.attestation.trim() ? { privateUseAttestation: draft.attestation.trim() } : {}) };
    case 'reference': return { basis: 'captured-third-party', ...base };
    default: return undefined;
  }
}

export function WorkbenchRightsFields({ value, onChange, disabled }: { value: RightsDraft; onChange: (next: RightsDraft) => void; disabled?: boolean }) {
  const t = useT();
  const id = useId();
  const choices: Array<[RightsChoice, string]> = [
    ['owned', t('workbench.rights.owned')], ['licensed', t('workbench.rights.licensed')], ['private', t('workbench.rights.private')],
    ['reference', t('workbench.rights.reference')], ['unknown', t('workbench.rights.unknown')],
  ];
  return <fieldset className={styles.rights} disabled={disabled}>
    <legend>{t('workbench.rights.legend')}</legend>
    <div className={styles.choices} role="radiogroup" aria-label={t('workbench.rights.legend')}>
      {choices.map(([choice, label]) => <label key={choice} className={styles.choice}>
        <input type="radio" name={`${id}-rights`} value={choice} checked={value.choice === choice} onChange={() => onChange({ ...value, choice })} />
        {label}
      </label>)}
    </div>
    {value.choice !== 'unknown' ? <>
      <label className={styles.field}>{t('workbench.rights.evidence')}<Textarea rows={2} value={value.evidence} onChange={event => onChange({ ...value, evidence: event.target.value })} /></label>
      <label className={styles.field}>{t('workbench.rights.notices')}<Textarea rows={2} value={value.notices} onChange={event => onChange({ ...value, notices: event.target.value })} /></label>
    </> : null}
    {value.choice === 'private' ? <label className={styles.field}>{t('workbench.rights.attestation')}<Textarea rows={2} value={value.attestation} onChange={event => onChange({ ...value, attestation: event.target.value })} /></label> : null}
    <p className={styles.hint}>{t('workbench.rights.note')}</p>
  </fieldset>;
}
