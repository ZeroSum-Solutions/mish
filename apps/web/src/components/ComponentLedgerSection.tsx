import { useEffect, useId, useState } from 'react';
import { Badge, Button, EmptyState, Select, Spinner, Surface } from '@open-design/components';
import { parseComponentLedgerReport, type ComponentLedgerReport } from '@open-design/contracts';
import { useI18n } from '../i18n';
import styles from './ComponentLedgerSection.module.css';

const statuses = ['built', 'tracked', 'installed', 'verified', 'unverified', 'repair-pending', 'quarantined', 'reference-only', 'repaired', 'error'] as const;

/** Read-only report: flags describe inventory, never certify repair or licence clearance. */
export function ComponentLedgerSection() {
  const { t, locale } = useI18n();
  const id = useId();
  const [report, setReport] = useState<ComponentLedgerReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState('');
  const [licence, setLicence] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setFailed(false); setReport(null);
    void (async () => {
      try {
        const response = await fetch('/api/components/ledger', { signal: controller.signal });
        if (!response.ok) throw new Error('Ledger unavailable');
        const next = parseComponentLedgerReport(await response.json());
        if (!controller.signal.aborted) setReport(next);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [revision]);
  const entries = Object.values(report?.components ?? {});
  const sources = [...new Set(entries.map(row => row.sourceId))].sort();
  const licences = [...new Set(entries.map(row => row.rights.license))].sort();
  const licenceLabel = (value: string) => value === 'licensed (pack-declared)' ? t('componentLedger.packDeclared') : value;
  const rows = entries.filter(row => (!source || row.source === source || row.sourceId === source) && (!licence || row.rights.license === licence) &&
    (!status || (status === 'error' ? row.errors.length > 0 : status === 'unverified' ? !row.verified :
      status === 'built' || status === 'tracked' || status === 'installed' || status === 'verified' ? row[status] === true : row.disposition === status)));
  const yesNo = (value: boolean | null) => value === null ? t('componentLedger.notApplicable') : value ? t('componentLedger.yes') : t('componentLedger.no');
  return <Surface className={styles.section} padding="none">
    <div className={styles.heading}>
      <div><h3>{t('componentLedger.title')}</h3><p>{t('componentLedger.description')}</p></div>
      <Button size="sm" disabled={loading} onClick={() => setRevision(value => value + 1)}>{t('componentLedger.refresh')}</Button>
    </div>
    {loading ? <Spinner label={t('componentLedger.loading')} /> : failed ? <div role="alert">
      <p>{t('componentLedger.loadFailed')}</p><Button size="sm" onClick={() => setRevision(value => value + 1)}>{t('componentLedger.retry')}</Button>
    </div> : <>
      <div className={styles.filters}>
        <label htmlFor={`${id}-source`}>{t('componentLedger.source')}<Select id={`${id}-source`} value={source} onChange={event => setSource(event.target.value)}>
          <option value="">{t('componentLedger.all')}</option><option value="public-core">{t('componentLedger.publicCore')}</option><option value="pack">{t('componentLedger.pack')}</option>
          {sources.map(value => <option key={value} value={value}>{value}</option>)}
        </Select></label>
        <label htmlFor={`${id}-licence`}>{t('componentLedger.licence')}<Select id={`${id}-licence`} value={licence} onChange={event => setLicence(event.target.value)}>
          <option value="">{t('componentLedger.all')}</option>{licences.map(value => <option key={value} value={value}>{licenceLabel(value)}</option>)}
        </Select></label>
        <label htmlFor={`${id}-status`}>{t('componentLedger.status')}<Select id={`${id}-status`} value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">{t('componentLedger.all')}</option>{statuses.map(value => <option key={value} value={value}>{t(`componentLedger.status.${value}`)}</option>)}
        </Select></label>
      </div>
      <p role="status">{t('componentLedger.count', { count: rows.length, total: entries.length })}</p>
      {rows.length === 0 ? <EmptyState title={t('componentLedger.empty')} /> : <div className={styles.scroll} tabIndex={0} role="region" aria-label={t('componentLedger.title')}>
        <table className={styles.table}>
          <caption>{t('componentLedger.title')}</caption>
          <thead><tr>{(['component', 'source', 'licence', 'status', 'built', 'tracked', 'installed', 'evidenceDate'] as const).map(column => <th scope="col" key={column}>{t(`componentLedger.${column}`)}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}>
            <th scope="row"><strong>{row.title}</strong><code>{row.id}</code>{row.packId && <small>{row.packId}</small>}</th>
            <td>{row.sourceId}<small>{t(row.source === 'pack' ? 'componentLedger.pack' : 'componentLedger.publicCore')}</small></td>
            <td>{licenceLabel(row.rights.license)}<small>{row.rights.decision}</small></td>
            <td><Badge>{t(`componentLedger.status.${row.disposition}`)}</Badge><small>{t(row.verified ? 'componentLedger.status.verified' : 'componentLedger.status.unverified')}</small>
              {row.errors.map((error, index) => <p className={styles.error} key={index}>{t('componentLedger.duplicate', { pack: error.packId })}</p>)}</td>
            <td>{yesNo(row.built)}</td><td>{yesNo(row.tracked)}</td><td>{yesNo(row.installed)}</td>
            <td>{row.evidenceDate ? new Date(row.evidenceDate).toLocaleString(locale) : t('componentLedger.noEvidence')}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </>}
  </Surface>;
}
