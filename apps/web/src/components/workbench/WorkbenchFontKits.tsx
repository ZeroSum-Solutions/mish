import type { FontKitDeclaration, FontKitInventory } from '@mish/contracts';
import { useT } from '../../i18n';
import styles from './workbench.module.css';

const REASON_KEYS = {
  'no-admitted-local-file': 'workbench.fontKits.reason.noAdmittedLocalFile',
  'rights-restricted': 'workbench.fontKits.reason.rightsRestricted',
  'licence-unknown': 'workbench.fontKits.reason.licenceUnknown',
  'kit-bytes-not-admitted': 'workbench.fontKits.reason.kitBytesNotAdmitted',
  'system-font': 'workbench.fontKits.reason.systemFont',
  'not-in-catalogue': 'workbench.fontKits.reason.notInCatalogue',
} as const satisfies Record<NonNullable<FontKitDeclaration['reason']>, string>;

/** The reader-language label for a declaration's state: mapped, or its named undeclared reason. */
export function useFontKitStatus(): (entry: FontKitDeclaration) => string {
  const t = useT();
  return (entry) => entry.state === 'mapped' || !entry.reason ? t('workbench.fontKits.mapped') : t(REASON_KEYS[entry.reason]);
}

/** One row per kit-declared family: where it is declared, its state and the daemon's explanation. */
export function WorkbenchFontKitRows({ declarations, showFamily = true }: { declarations: readonly FontKitDeclaration[]; showFamily?: boolean }) {
  const status = useFontKitStatus();
  return <ul>
    {declarations.map((entry) => <li key={`${entry.root}:${entry.kit}:${entry.family}`} data-state={entry.state} data-reason={entry.reason ?? undefined} title={entry.message}>
      <span>{entry.kit}{showFamily ? ` · ${entry.family}` : ''}</span>{' — '}<span>{status(entry)}</span>
    </li>)}
  </ul>;
}

/** AC-R11 preamble: the kit and example font inventory the daemon returns with a font search
 * (and `od workbench search --category font --json` prints). */
export function WorkbenchFontKitInventory({ inventory }: { inventory: FontKitInventory }) {
  const t = useT();
  return <section className={styles.coverage} aria-label={t('workbench.fontKits.title')} data-testid="workbench-font-kit-inventory">
    <h3>{t('workbench.fontKits.title')}</h3>
    <p>{t('workbench.fontKits.summary', { mapped: String(inventory.counts.mapped), undeclared: String(inventory.counts.undeclared) })}</p>
    {inventory.scanned.truncated ? <p role="status">{t('workbench.fontKits.truncated')}</p> : null}
    <WorkbenchFontKitRows declarations={inventory.declarations} />
  </section>;
}
