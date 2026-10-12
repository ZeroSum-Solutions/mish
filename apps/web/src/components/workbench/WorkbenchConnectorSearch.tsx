import { useId, useState } from 'react';
import { Button, Input, Select } from '@open-design/components';
import {
  CONNECTOR_IDS, CONNECTOR_PLATFORMS, CONNECTOR_SEARCH_KINDS,
  type ConnectorPlatform, type ConnectorReferenceDetailResponse, type ConnectorSearchKind, type ConnectorSearchRequest, type ConnectorSearchResponse,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { getConnectorDetail, searchConnector } from '../../providers/workbench-connectors';
import { WorkbenchRequestError } from '../../providers/workbench';
import styles from './WorkbenchSources.module.css';

const PROVIDER_NAMES: Record<(typeof CONNECTOR_IDS)[number], string> = { motionsites: 'MotionSites', refero: 'Refero', mobbin: 'Mobbin' };
/** G29/B069: Refero offers screens/flows; Mobbin also offers sections. */
const KIND_CONNECTORS: ReadonlySet<(typeof CONNECTOR_IDS)[number]> = new Set(['mobbin', 'refero']);
const KIND_HAS_PLATFORM: Record<ConnectorSearchKind, boolean> = { screens: true, flows: true, sections: false };
const KIND_LABELS = { screens: 'workbenchConnector.kind.screens', flows: 'workbenchConnector.kind.flows', sections: 'workbenchConnector.kind.sections' } as const satisfies Record<ConnectorSearchKind, string>;
const PLATFORM_LABELS = { ios: 'workbenchConnector.platform.ios', web: 'workbenchConnector.platform.web' } as const satisfies Record<ConnectorPlatform, string>;

function Refusal({ error }: { error: Error }) {
  const typed = error instanceof WorkbenchRequestError ? error : null;
  return <div role="alert" className={styles.error}>
    <p>{typed ? `${typed.code} · ${typed.message}` : error.message}</p>
    {typed?.nextSteps.length ? <ul>{typed.nextSteps.map(step => <li key={step}>{step}</li>)}</ul> : null}
  </div>;
}

/**
 * AC-R12.2 canvas surface of the read-only connector proxy: pick a connector, search,
 * open a captured reference's detail. Provider text renders as plain text (data, not
 * instruction); rights come from daemon policy; refusals show the missing receipt.
 */
export function WorkbenchConnectorSearch() {
  const t = useT();
  const selectId = useId();
  const kindId = useId();
  const platformId = useId();
  const [kind, setKind] = useState<ConnectorSearchKind>('screens');
  const [platform, setPlatform] = useState<ConnectorPlatform>('web');
  const [connector, setConnector] = useState<(typeof CONNECTOR_IDS)[number]>('motionsites');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<ConnectorSearchResponse | null>(null);
  const [detail, setDetail] = useState<ConnectorReferenceDetailResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  async function run<T>(work: () => Promise<T>, done: (value: T) => void) {
    setBusy(true); setError(null);
    try { done(await work()); } catch (reason) { setError(reason instanceof Error ? reason : new Error('connector-request-failed')); } finally { setBusy(false); }
  }
  const takesKind = KIND_CONNECTORS.has(connector);
  const takesPlatform = takesKind && KIND_HAS_PLATFORM[kind];
  const searchKinds = connector === 'refero' ? CONNECTOR_SEARCH_KINDS.filter(item => item !== 'sections') : CONNECTOR_SEARCH_KINDS;
  const request = (): ConnectorSearchRequest => ({
    query: query.trim(), limit: 10, ...(takesKind ? { kind } : {}), ...(takesPlatform ? { platform } : {}),
  });
  const search = () => run(() => searchConnector(connector, request()), value => { setResponse(value); setDetail(null); });
  return <section className={styles.root} aria-label={t('workbenchConnector.title')}>
    <h4 className={styles.title}>{t('workbenchConnector.title')}</h4>
    <p className={styles.hint}>{t('workbenchConnector.untrusted')}</p>
    <form className={styles.controls} onSubmit={event => { event.preventDefault(); if (query.trim()) void search(); }}>
      <div className={styles.field}><label htmlFor={selectId}>{t('workbenchConnector.connector')}</label>
        <Select id={selectId} value={connector} onChange={event => { const next = event.target.value as typeof connector; setConnector(next); if (next === 'refero' && kind === 'sections') setKind('screens'); setResponse(null); setDetail(null); setError(null); }}>
          {CONNECTOR_IDS.map(id => <option key={id} value={id}>{PROVIDER_NAMES[id]}</option>)}
        </Select>
      </div>
      {takesKind ? <div className={styles.field}><label htmlFor={kindId}>{t('workbenchConnector.kind')}</label>
        <Select id={kindId} value={kind} onChange={event => setKind(event.target.value as ConnectorSearchKind)}>
          {searchKinds.map(item => <option key={item} value={item}>{t(KIND_LABELS[item])}</option>)}
        </Select>
      </div> : null}
      {takesPlatform ? <div className={styles.field}><label htmlFor={platformId}>{t('workbenchConnector.platform')}</label>
        <Select id={platformId} value={platform} onChange={event => setPlatform(event.target.value as ConnectorPlatform)}>
          {CONNECTOR_PLATFORMS.map(item => <option key={item} value={item}>{t(PLATFORM_LABELS[item])}</option>)}
        </Select>
      </div> : null}
      <label>{t('workbenchConnector.query')}<Input value={query} maxLength={500} onChange={event => setQuery(event.target.value)} autoComplete="off" /></label>
      <Button size="sm" type="submit" disabled={busy || !query.trim()}>{t('workbenchConnector.search')}</Button>
    </form>
    {busy ? <p role="status" className={styles.meta}>{t('workbenchConnector.searching')}</p> : null}
    {error ? <Refusal error={error} /> : null}
    {response && !error ? <>
      {response.results.length === 0 ? <p className={styles.meta}>{t('workbenchConnector.empty')}</p> : null}
      {response.excluded ? <p className={styles.meta}>{t('workbenchConnector.excluded', { count: String(response.excluded) })}</p> : null}
      {response.providerNotice ? <p className={styles.notice} data-testid="workbench-connector-notice" aria-label={t('workbenchConnector.providerNotice')}>{response.providerNotice}</p> : null}
      <ul className={styles.list}>{response.results.map(item => <li key={item.itemId}>
        <article className={styles.row} aria-label={item.title}>
          <p className={styles.rowTitle}>{item.title}</p>
          <p className={styles.meta}>{item.rights.status} · {item.access}{item.category ? ` · ${item.category}` : ''}</p>
          <a className={styles.meta} href={item.canonicalUrl} target="_blank" rel="noreferrer noopener">{item.attribution.provider}</a>
          <Button size="sm" onClick={() => void run(() => getConnectorDetail(response.connectorId, { itemId: item.itemId }), setDetail)}>{t('workbenchConnector.details')}</Button>
        </article>
      </li>)}</ul>
    </> : null}
    {detail ? <section className={styles.row} data-testid="workbench-connector-detail" aria-label={detail.resource.title}>
      <p className={styles.rowTitle}>{detail.resource.title}</p>
      <dl className={styles.facts}>
        <dt>{t('workbenchConnector.captured')}</dt><dd>{detail.resource.capturedAt}</dd>
        <dt>{t('workbenchConnector.receipt')}</dt><dd>{detail.receipt.toolName} · {detail.receipt.binding} · {detail.receipt.attempts}</dd>
        <dt>{t('workbenchConnector.rights')}</dt><dd>{detail.resource.rights.status} · {detail.resource.rights.summary}</dd>
        <dt>{t('workbenchConnector.operations')}</dt>
        <dd><ul>{detail.resource.rights.operations.map(right => <li key={right.operation}>{right.operation} · {right.decision}{right.reason ? ` (${right.reason})` : ''}</li>)}</ul></dd>
      </dl>
    </section> : null}
  </section>;
}
