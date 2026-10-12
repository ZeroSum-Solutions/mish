import type { ResourceResult } from '@mish/contracts';
import { useT } from '../../i18n';
import styles from './workbench.module.css';

function operationGrantGroup(heading: string, grants: ResourceResult['operationGrants']) {
  if (!grants.length) return null;
  return <section className={styles.textDetailSection}>
    <h5>{heading}</h5>
    <ul>{grants.map((grant) => <li key={grant.operation}>{grant.operation}: {grant.state}{grant.reason ? ` · ${grant.reason}` : ''}</li>)}</ul>
  </section>;
}

/** Skill and text/file/reference resources have no executable or visual surface
 * of their own; enlarging them means a larger, fully readable rendering of the
 * same metadata the compact detail panel already carries, plus fields that
 * panel has no room for (the full fit-reason list and operation grants).
 *
 * The decision-relevant fields (readiness, rights, compatibility, need,
 * adoption) are rendered by WorkbenchDecisionDetails, which
 * WorkbenchResourceDetail places inside the enlarged dialog for every preview
 * kind — not duplicated here. */
export function WorkbenchTextDetail({ resource }: { resource: ResourceResult }) {
  const t = useT();
  const permitted = resource.operationGrants.filter((grant) => grant.state === 'permitted');
  const blocked = resource.operationGrants.filter((grant) => grant.state === 'blocked');
  const unknownState = resource.operationGrants.filter((grant) => grant.state === 'unknown');
  return <div className={styles.textDetail} data-testid="workbench-text-detail">
    <h4>{resource.title}</h4>
    <p>{t('workbench.source')}: {resource.sourceAttribution.url ? <a href={resource.sourceAttribution.url} target="_blank" rel="noreferrer noopener">{resource.sourceAttribution.title}</a> : resource.sourceAttribution.title}</p>
    {resource.fitReasons.length ? <section className={styles.textDetailSection}>
      <h5>{t('workbench.enlarge.fitReasons')}</h5>
      <ul>{resource.fitReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    </section> : null}
    {resource.styleTags?.length ? <section className={styles.textDetailSection}>
      <h5>{t('workbench.enlarge.styleTags')}</h5>
      <p>{resource.styleTags.join(' · ')}</p>
    </section> : null}
    {operationGrantGroup(t('workbench.enlarge.operationGrants'), permitted)}
    {operationGrantGroup(t('workbench.enlarge.operationGrantsBlocked'), blocked)}
    {operationGrantGroup(t('workbench.enlarge.operationGrantsUnknown'), unknownState)}
    {!resource.operationGrants.length ? <section className={styles.textDetailSection}>
      <h5>{t('workbench.enlarge.operationGrants')}</h5>
      <p>{t('workbench.adoptionUnavailable')}</p>
    </section> : null}
  </div>;
}
