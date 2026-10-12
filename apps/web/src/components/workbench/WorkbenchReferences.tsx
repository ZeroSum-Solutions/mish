import { useEffect, useId, useRef, useState } from 'react';
import { Badge, Button } from '@open-design/components';
import { parseReferenceFanoutRequest, type ReferenceFanoutResponse, type ReferenceSection } from '@open-design/contracts';
import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { fanoutReferences, type ReferenceFanoutInput } from '../../providers/workbench-references';
import { WorkbenchRequestError } from '../../providers/workbench';
import styles from './WorkbenchReferences.module.css';

interface Props {
  brief: string;
  spineCode?: ReferenceFanoutInput['spineCode'];
  sections?: ReferenceSection[];
  sectionAdditions?: ReferenceSection[];
  excludedSections?: string[];
  /** Invalidates captured results when any unsaved brief field changes. */
  contextKey?: string;
}
type SearchState = { key: string; status: 'loading' | 'error' | 'ready'; result?: ReferenceFanoutResponse; code?: string };
const FAILURE_KEYS: Record<string, keyof Dict> = {
  'connector-principal-forbidden': 'workbench.references.failure.principal',
  'connector-binding-missing': 'workbench.references.failure.connection',
  'connector-needs-sign-in': 'workbench.references.failure.signIn',
  'connector-access-revoked': 'workbench.references.failure.signIn',
  'connector-schema-not-frozen': 'workbench.references.failure.connection',
  'connector-tool-denied': 'workbench.references.failure.connection',
  'connector-timeout': 'workbench.references.failure.timeout',
  'connector-rate-limited': 'workbench.references.failure.rateLimit',
  'connector-response-invalid': 'workbench.references.failure.unavailable',
  'connector-unavailable': 'workbench.references.failure.unavailable',
};
const RIGHTS_KEYS: Record<'reference-only' | 'restricted' | 'unknown', keyof Dict> = {
  'reference-only': 'workbench.references.rights.referenceOnly',
  restricted: 'workbench.references.rights.restricted', unknown: 'workbench.references.rights.unknown',
};
const sourceName = (source: string) => source === 'refero' ? 'Refero' : 'Mobbin';

/** A manual inspection panel; provider content stays plain text and source links. */
export function WorkbenchReferences({ brief, spineCode, sections, sectionAdditions, excludedSections, contextKey }: Props) {
  const t = useT();
  const headingId = useId();
  const key = JSON.stringify({ brief, spineCode, sections, sectionAdditions, excludedSections, contextKey });
  const [state, setState] = useState<SearchState | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const liveKey = useRef(key);
  liveKey.current = key;
  useEffect(() => {
    generation.current += 1;
    controller.current?.abort();
    return () => { generation.current += 1; controller.current?.abort(); };
  }, [key]);
  const current = state?.key === key ? state : null;
  const result = current?.status === 'ready' ? current.result : undefined;
  const input: ReferenceFanoutInput = { brief, ...(spineCode ? { spineCode } : {}), ...(sections?.length ? { sections } : {}), ...(sectionAdditions?.length ? { sectionAdditions } : {}), ...(excludedSections?.length ? { excludedSections } : {}) };
  let valid = true;
  try { parseReferenceFanoutRequest(input); } catch { valid = false; }

  async function search() {
    if (!valid || current?.status === 'loading') return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const requestGeneration = ++generation.current;
    const isCurrent = () => !abort.signal.aborted && generation.current === requestGeneration && liveKey.current === key;
    setState({ key, status: 'loading' });
    try {
      const answer = await fanoutReferences(input, { signal: abort.signal });
      if (isCurrent()) setState({ key, status: 'ready', result: answer });
    } catch (error) {
      if (isCurrent()) setState({ key, status: 'error', ...(error instanceof WorkbenchRequestError ? { code: error.code } : {}) });
    }
  }
  const sectionName = (id: string) => result?.sections.find(section => section.id === id)?.name ?? id;
  return (
    <section className={styles.panel} aria-labelledby={headingId} data-testid="workbench-references">
      <div className={styles.header}>
        <h3 id={headingId}>{t('workbench.references.title')}</h3>
        <Button size="sm" variant="secondary" loading={current?.status === 'loading'} disabled={!valid || current?.status === 'loading'} onClick={() => void search()}>{t('workbench.references.find')}</Button>
      </div>
      <p className={styles.caption}>{t('workbench.references.description')}</p>
      {!valid && brief.trim() ? <p className={styles.caption}>{t('workbench.references.invalid')}</p> : null}
      {current?.status === 'loading' ? <p role="status">{t('workbench.references.loading')}</p> : null}
      {current?.status === 'error' ? <p role="alert">{t(FAILURE_KEYS[current.code ?? ''] ?? 'workbench.references.error')}</p> : null}
      {result ? <>
        <p role="status" className={styles.caption}>{t(result.partial ? 'workbench.references.partial' : result.degraded ? 'workbench.references.degraded' : 'workbench.references.complete', { count: result.references.length })}</p>
        {result.ranking.status === 'unavailable' ? <p className={styles.caption}>{t('workbench.references.rankingUnavailable')}</p> : null}
        {result.sources.some(source => source.status !== 'ok') ? <ul className={styles.notices}>
          {result.sources.filter(source => source.status !== 'ok').map(source => <li key={`${source.source}:${source.sectionId}`}>
            {sourceName(source.source)} · {sectionName(source.sectionId)}: {t(source.status === 'empty' ? 'workbench.references.sourceEmpty' : FAILURE_KEYS[source.code ?? ''] ?? 'workbench.references.failure.unavailable')}
          </li>)}
        </ul> : null}
        {[...new Set(result.sources.map(source => source.providerNotice).filter((notice): notice is string => Boolean(notice)))].map(notice => <p key={notice} className={styles.notice} data-testid="reference-provider-notice">{notice}</p>)}
        {result.references.length === 0 ? <p>{t('workbench.references.empty')}</p> : <ol className={styles.results}>
          {result.references.map(reference => <li key={reference.id}>
            <article className={styles.reference} aria-label={reference.resource.title}>
              <div className={styles.referenceHeader}>
                <a href={reference.resource.canonicalUrl} target="_blank" rel="noopener noreferrer">{reference.resource.title}</a>
                <Badge tone="neutral">{t(RIGHTS_KEYS[reference.rightsLabel])}</Badge>
              </div>
              <p className={styles.caption}>{reference.resource.attribution.provider} · {reference.sectionIds.map(sectionName).join(', ')}</p>
              <p className={styles.score}>{reference.score === null ? t('workbench.references.unranked') : t('workbench.references.score', { score: reference.score })}</p>
              <ul className={styles.reasons}>{reference.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
              <p className={styles.caption}>{reference.resource.rights.summary}</p>
            </article>
          </li>)}
        </ol>}
      </> : null}
    </section>
  );
}
