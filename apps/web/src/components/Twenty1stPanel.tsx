import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Twenty1stItem, Twenty1stListFilters, Twenty1stSourceResponse } from '@mish/contracts';
import { TWENTY1ST_RIGHTS, twenty1stBrowseTags, twenty1stCardPreviewUrl, twenty1stListQuery, twenty1stPreviewUrl, filterTwenty1stItems, parseTwenty1stListResponse, parseTwenty1stSourceResponse, selectTwenty1stPrimarySourceFile } from '@mish/contracts';
import { Button, EmptyState } from '@mish/components';

import { useT } from '../i18n';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import styles from './CatalogView.module.css';
import originalStyles from './Twenty1stPanel.module.css';
import { FacetFilter } from './CultCatalogPanel';
import { Icon } from './Icon';
import {
  CatalogPreviewStage,
  CatalogPreviewWorkspace,
  PreviewViewportControls,
  catalogPreviewFrameProps,
  readPreviewContentSize,
  useCatalogPreviewStage,
  usePreviewContentHeight,
  type CatalogPreviewWidth,
} from './CatalogPreviewViewer';

/** Size messages from the private preview bridge (apps/daemon/src/routes/twenty1st.ts). */
const PRIVATE_PREVIEW_SIZE_SOURCE = 'twentyfirst-preview-size';

export type Twenty1stLoad =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; items: Twenty1stItem[] };

/** Loads on first activation and when the shared API filters change. */
export function useTwenty1stCatalog(isActive: boolean) {
  const [load, setLoad] = useState<Twenty1stLoad>({ kind: 'idle' });
  const [allItems, setAllItems] = useState<Twenty1stItem[]>([]);
  const [filters, setFilters] = useState<Twenty1stListFilters>({});
  const latest = useRef(0);
  const fetchedKey = useRef<string | null>(null);
  const fetchList = useCallback(async () => {
    const request = ++latest.current;
    setLoad({ kind: 'loading' });
    let next: Twenty1stLoad;
    try {
      const query = twenty1stListQuery(filters);
      const resp = await fetch(`/api/21st${query}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = parseTwenty1stListResponse(await resp.json());
      next = { kind: 'ready', items: body.catalog.items };
      // Keep the unfiltered facet inventory even if typing superseded its visible result.
      if (!query) setAllItems(body.catalog.items);
    } catch {
      next = { kind: 'error' };
    }
    if (request === latest.current) setLoad(next);
  }, [filters]);
  useEffect(() => {
    const key = twenty1stListQuery(filters);
    if (isActive && fetchedKey.current !== key) {
      fetchedKey.current = key;
      void fetchList();
    }
  }, [isActive, filters, fetchList]);
  return { load, allItems, filters, setFilters, reload: () => void fetchList() };
}

export interface Twenty1stPanelProps {
  load: Twenty1stLoad;
  onRetry: () => void;
  allItems?: Twenty1stItem[];
  filters?: Twenty1stListFilters;
  onFiltersChange?: (filters: Twenty1stListFilters) => void;
}

export function Twenty1stPanel({ load, onRetry, allItems, filters = {}, onFiltersChange }: Twenty1stPanelProps) {
  const t = useT();
  const [localFilters, setLocalFilters] = useState<Twenty1stListFilters>({});
  const selected = onFiltersChange ? filters : localFilters;
  const setSelected = onFiltersChange ?? setLocalFilters;
  const inventory = allItems?.length ? allItems : load.kind === 'ready' ? load.items : [];
  const tags = useMemo(() => [...new Set(inventory.flatMap(item => twenty1stBrowseTags(item)))].sort(), [inventory]);
  const tagCounts = useMemo(() => filterTwenty1stItems(inventory, { query: selected.query, rights: selected.rights })
    .reduce((counts, item) => { for (const tag of twenty1stBrowseTags(item)) counts.set(tag, (counts.get(tag) ?? 0) + 1); return counts; }, new Map<string, number>()), [inventory, selected.query, selected.rights]);
  const rightsCounts = useMemo(() => filterTwenty1stItems(inventory, { query: selected.query, tag: selected.tag })
    .reduce((counts, item) => { counts.set(item.rights, (counts.get(item.rights) ?? 0) + 1); return counts; }, new Map<string, number>()), [inventory, selected.query, selected.tag]);
  return (
    <div className={styles.cultPanel} data-testid="catalog-21st-view">
      <p className={styles.lede}>{t('catalog.21st.lede')}</p>
      <div className={styles.toolbar}>
        <label className={styles.searchField} data-ui-field-shell>
          <Icon name="search" size={14} className={styles.searchIcon} />
          <input type="search" className={styles.search} data-testid="catalog-21st-search"
            aria-label={t('catalog.21st.search')} placeholder={t('catalog.21st.searchPlaceholder')}
            value={selected.query ?? ''} onChange={event => setSelected({ ...selected, query: event.target.value })} />
        </label>
        <FacetFilter label={t('catalog.21st.filter.tag')} testId="catalog-21st-tag"
          value={selected.tag ?? 'all'} options={tags.map(tag => ({ value: tag, label: tag, count: tagCounts.get(tag) ?? 0 }))}
          allCount={filterTwenty1stItems(inventory, { query: selected.query, rights: selected.rights }).length}
          onChange={tag => setSelected({ ...selected, tag })} />
        <FacetFilter label={t('catalog.21st.filter.rights')} testId="catalog-21st-rights"
          value={selected.rights ?? 'all'} options={TWENTY1ST_RIGHTS.map(rights => ({ value: rights, label: t(`catalog.21st.rights.${rights}`), count: rightsCounts.get(rights) ?? 0 }))}
          onChange={rights => setSelected({ ...selected, rights })} />
        <p className={styles.count}>{t('catalog.cult.count', { shown: load.kind === 'ready' ? load.items.length : 0, total: inventory.length })}</p>
      </div>

      {load.kind === 'loading' || load.kind === 'idle' ? (
        <p className={styles.note} role="status">{t('catalog.21st.loading')}</p>
      ) : null}
      {load.kind === 'error' ? (
        <div className={styles.note} role="alert">
          <span>{t('catalog.21st.error')}</span>{' '}
          <button type="button" className={styles.button} onClick={onRetry}>{t('catalog.21st.retry')}</button>
        </div>
      ) : null}

      {load.kind === 'ready' ? (
        load.items.length ? <ul className={styles.grid}>
          {load.items.map((item) => <Twenty1stCard key={item.id} item={item} />)}
        </ul> : <EmptyState icon={<Icon name="search" size={20} />} title={t('catalog.cult.empty')}
          action={<Button variant="secondary" onClick={() => setSelected({})}>{t('catalog.clearFilters')}</Button>} />
      ) : null}
    </div>
  );
}

type CopyState = { kind: 'idle' } | { kind: 'copied' } | { kind: 'failed'; text: string };

function useCopyAction(): [CopyState, (text: string) => void, () => void] {
  const [state, setState] = useState<CopyState>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const latest = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);
  const copy = useCallback((text: string) => {
    const request = ++latest.current;
    void (async () => {
      const ok = await copyToClipboard(text);
      if (!mounted.current || request !== latest.current) return;
      if (timer.current) clearTimeout(timer.current);
      setState(ok ? { kind: 'copied' } : { kind: 'failed', text });
      if (ok) timer.current = setTimeout(() => setState({ kind: 'idle' }), 1500);
    })();
  }, []);
  const reset = useCallback(() => { ++latest.current; if (timer.current) clearTimeout(timer.current); setState({ kind: 'idle' }); }, []);
  return [state, copy, reset];
}

type SourceLoad = { kind: 'idle' | 'loading' | 'error' } | { kind: 'ready'; bundle: Twenty1stSourceResponse };

function Twenty1stCard({ item }: { item: Twenty1stItem }) {
  const implementation = item.privateImplementation ?? item.ownedAlternative;
  const isPrivate = implementation?.provenance === 'upstream-private';
  const title = implementation?.title ?? item.name;
  const t = useT();
  const description = implementation?.description ?? `${t('catalog.21st.author')}: ${item.author}`;
  // This opaque preview must delegate encrypted media to its nested Spotify embed.
  const iframeAllow = item.id === '21st:moumensoliman-glassmorphism-listen-app' ? 'encrypted-media *' : undefined;
  const [theme, setTheme] = useState<'dark' | 'light'>(() => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const [motion, setMotion] = useState(() => typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false));
  const [source, setSource] = useState<SourceLoad>({ kind: 'idle' });
  const [sourceOpen, setSourceOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState('');
  const sourceRequest = useRef<AbortController | null>(null);
  const [copyState, copy, resetCopy] = useCopyAction();
  const [noticeState, copyNotice] = useCopyAction();
  const modal = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const expandedFrame = useRef<HTMLIFrameElement>(null);
  const titleId = useId();
  const fileId = useId();
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState<CatalogPreviewWidth>('fit');
  const [demoState, setDemoState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [demoAttempt, setDemoAttempt] = useState(0);
  const demoErrorReported = useRef(false);
  const previewUrl = implementation ? `${implementation.previewUrl}?theme=${theme}&motion=${motion ? 'reduced' : 'full'}` : undefined;
  // Theme, motion, source and retry each load a new document in a new iframe with its own height.
  const frameKey = `${previewUrl}:${implementation?.sourceSha256}:${demoAttempt}`;
  const [contentHeight, reportHeight] = usePreviewContentHeight(frameKey);
  const layout = useCatalogPreviewStage(width, contentHeight);
  const { frameWidth } = layout;
  const selectedFile = source.kind === 'ready' ? source.bundle.files.find(file => file.path === selectedPath) : undefined;
  const provenance = implementation ? t(isPrivate ? 'catalog.21st.privateProvenance' : 'catalog.21st.provenance') : undefined;

  // Keep validated source in this card's cache across dialog closes, but invalidate it when
  // the catalog advertises a different source. Closing unloads the live demo immediately.
  useEffect(() => {
    sourceRequest.current?.abort();
    setSource({ kind: 'idle' });
    setSourceOpen(false);
    setSelectedPath('');
    return () => sourceRequest.current?.abort();
  }, [implementation?.sourceUrl, implementation?.sourceSha256, implementation?.provenance]);
  useEffect(() => {
    if (!expanded) return;
    if (!modal.current?.open) modal.current?.showModal();
    closeButton.current?.focus();
  }, [expanded]);
  useEffect(() => {
    if (!expanded || !implementation) return;
    demoErrorReported.current = false;
    setDemoState('loading');
    const timer = setTimeout(() => setDemoState(current => current === 'loading' ? 'error' : current), 8000);
    return () => clearTimeout(timer);
  }, [expanded, previewUrl, demoAttempt, implementation?.sourceSha256]);
  useEffect(() => {
    if (!expanded || !implementation) return;
    const onMessage = (event: MessageEvent) => {
      // allow-scripts without allow-same-origin gives the demo an opaque origin.
      if (event.source !== expandedFrame.current?.contentWindow || event.origin !== 'null') return;
      if (isPrivate && event.data?.source === PRIVATE_PREVIEW_SIZE_SOURCE) {
        const height = event.data.id === item.id ? readPreviewContentSize(event.data, 'size', frameWidth) : null;
        if (height !== null) reportHeight(height);
        return;
      }
      if (!isPrivate) {
        if (event.data?.type === 'mishh-original-preview-escape') modal.current?.close();
        return;
      }
      if (event.data?.source !== 'twentyfirst-private-preview' || event.data?.id !== item.id) return;
      if (event.data.type === 'escape') modal.current?.close();
      else if (event.data.status === 'ready' && !demoErrorReported.current) setDemoState('ready');
      else if (event.data.status === 'error') reportDemoError();
      // Loading messages cannot extend the opening deadline or resurrect a failed attempt.
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [expanded, implementation, isPrivate, item.id, frameWidth, reportHeight]);

  function reportDemoError() {
    demoErrorReported.current = true;
    setDemoState('error');
  }

  async function loadSource() {
    if (!implementation) return;
    sourceRequest.current?.abort();
    const request = new AbortController();
    sourceRequest.current = request;
    setSourceOpen(true);
    setSource({ kind: 'loading' });
    try {
      const response = await fetch(implementation.sourceUrl, { signal: request.signal });
      if (!response.ok) throw new Error('source unavailable');
      const bundle = parseTwenty1stSourceResponse(await response.json());
      if (bundle.id !== item.id || bundle.provenance !== implementation.provenance || bundle.sourceSha256 !== implementation.sourceSha256) throw new Error('source does not match this item');
      if (implementation.provenance === 'upstream-private' && bundle.provenance === 'upstream-private'
        && implementation.localImportClosure !== undefined
        && JSON.stringify(bundle.localImportClosure) !== JSON.stringify(implementation.localImportClosure)) throw new Error('source closure does not match this item');
      if (implementation.provenance === 'upstream-private' && bundle.provenance === 'upstream-private'
        && (implementation.refinement?.originalSourceSha256 !== bundle.refinement?.originalSourceSha256 || implementation.refinement?.note !== bundle.refinement?.note)) throw new Error('source refinement does not match this item');
      if (request.signal.aborted) return;
      const initialFile = selectTwenty1stPrimarySourceFile(bundle);
      setSelectedPath(initialFile.path);
      setSource({ kind: 'ready', bundle });
    } catch { if (!request.signal.aborted) setSource({ kind: 'error' }); }
  }

  return <li className={`${styles.card} ${originalStyles.card}`} data-testid={`catalog-21st-card-${item.id}`}>
    <button ref={opener} type="button" className={styles.cardButton} aria-label={t('catalog.21st.openDemo', { title })} aria-haspopup="dialog" onClick={() => setExpanded(true)}>
      <Twenty1stPreview item={item} />
      <span className={styles.meta}>
        <span className={styles.name}>{title}</span>
        <span className={`${styles.detail} ${originalStyles.summary}`}>{description}</span>
      </span>
    </button>
    <dialog ref={modal} aria-labelledby={titleId} className={originalStyles.modal} onCancel={event => { event.preventDefault(); modal.current?.close(); }} onClose={() => { setExpanded(false); opener.current?.focus(); }}>
      {expanded ? <>
        <header className={originalStyles.header}>
          <div className={originalStyles.heading}><h3 id={titleId}>{title}</h3><p>{description}</p></div>
          <button ref={closeButton} type="button" onClick={() => modal.current?.close()}>{t('catalog.21st.close')}</button>
        </header>
        <CatalogPreviewWorkspace
          toolbar={implementation ? <>
              <PreviewViewportControls value={width} onChange={setWidth} label={t('catalog.21st.demoWidth')} />
              <div className={originalStyles.controls}>
                <button type="button" aria-label={t('catalog.21st.theme')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? t('catalog.21st.light') : t('catalog.21st.dark')}</button>
                <button type="button" aria-pressed={motion} onClick={() => setMotion(!motion)}>{t('catalog.21st.reduceMotion')}</button>
              </div>
            </> : null}
          preview={<main className={originalStyles.previewMain} aria-label={`${title} preview`} aria-busy={!!implementation && demoState === 'loading'}>
            {implementation ? <CatalogPreviewStage layout={layout} testId="catalog-21st-preview-stage">
              <iframe key={frameKey} ref={expandedFrame} {...catalogPreviewFrameProps(layout)} title={`${title} expanded demo`} src={previewUrl} sandbox="allow-scripts" allow={iframeAllow} referrerPolicy="no-referrer"
                onLoad={() => { if (!isPrivate && !demoErrorReported.current) setDemoState('ready'); }} onError={reportDemoError} />
            </CatalogPreviewStage> : <div className={originalStyles.previewViewport}><Twenty1stPreview item={item} /></div>}
            {implementation && demoState === 'loading' ? <p className={originalStyles.previewStatus} role="status">{t('catalog.21st.demoLoading')}</p> : null}
            {implementation && demoState === 'error' ? <div className={originalStyles.previewStatus} role="alert"><span>{t('catalog.21st.demoError')}</span><button type="button" onClick={() => setDemoAttempt(attempt => attempt + 1)}>{t('catalog.21st.retry')}</button></div> : null}
          </main>}
          detailsLabel={title}
          details={<div className={originalStyles.info} data-provenance={implementation?.provenance}>
            <p>{description}</p>
            {implementation ? <>
              <span className={originalStyles.owned}>{t(isPrivate ? 'catalog.21st.privateSource' : 'catalog.21st.original')}</span>
              <p className={originalStyles.provenance}>{provenance}</p>
              {item.privateImplementation?.refinement ? <p className={originalStyles.provenance} data-testid="catalog-21st-copy-refinement" title={item.privateImplementation.refinement.originalSourceSha256}>{item.privateImplementation.refinement.note}</p> : null}
              {item.privateImplementation && !item.privateImplementation.sourceVerified ? <p role="status">{t('catalog.21st.unverifiedSource')}</p> : null}
              {item.privateImplementation?.localImportClosure?.status === 'missing' ? <p role="status" data-testid="catalog-21st-missing-import">{t('catalog.21st.missingLocalImport', { path: item.privateImplementation.localImportClosure.missing[0]?.resolvedCandidate ?? '' })}</p> : null}
              {item.privateImplementation && (!item.privateImplementation.localImportClosure || item.privateImplementation.localImportClosure.status === 'unverified') ? <p role="status">{t('catalog.21st.localImportsUnverified')}</p> : null}
              <div className={originalStyles.actions}>
                <button type="button" disabled={source.kind === 'loading'} aria-expanded={sourceOpen} onClick={() => {
                  if (source.kind === 'ready') setSourceOpen(!sourceOpen);
                  else void loadSource();
                }}>{source.kind === 'loading' ? t('catalog.21st.sourceLoading') : t('catalog.21st.source')}</button>
                {(!isPrivate || item.privateImplementation?.localImportClosure?.status === 'resolved') ? <a href={`${implementation.sourceUrl}?download=zip`} download>{t(isPrivate ? 'catalog.21st.downloadSource' : 'catalog.21st.download')}</a> : null}
              </div>
              {sourceOpen && source.kind === 'error' ? <div className={originalStyles.sourceError} role="alert">
                <span>{t('catalog.21st.sourceError')}</span>
                <button type="button" onClick={() => void loadSource()}>{t('catalog.21st.retry')}</button>
              </div> : null}
              {sourceOpen && selectedFile ? <div className={originalStyles.source}>
                <label htmlFor={fileId}>{t('catalog.21st.sourceFile')}</label>
                <select id={fileId} value={selectedPath} onChange={event => { setSelectedPath(event.target.value); resetCopy(); }}>
                  {source.kind === 'ready' ? source.bundle.files.map(file => <option key={file.path} value={file.path}>{file.path}</option>) : null}
                </select>
                <button type="button" onClick={() => copy(selectedFile.content)}>{copyState.kind === 'copied' ? t('catalog.21st.copied') : t(isPrivate ? 'catalog.21st.copyFile' : 'catalog.21st.copySource')}</button>
                <pre tabIndex={0} data-testid="catalog-21st-source-code">{selectedFile.content}</pre>
                {copyState.kind === 'failed' ? <p role="alert">{t('catalog.21st.copyFailed')}</p> : null}
              </div> : null}
            </> : null}
            <div className={originalStyles.rights}>
              <span className={styles.badge} data-rights={item.rights} data-testid={`catalog-21st-rights-${item.id}`}>
                {item.rights === 'mit' ? item.licenseLabel : t('catalog.21st.rights.reference-only')}
              </span>
              <p>{t('catalog.21st.author')}: {item.author}</p>
              {item.licenseUrl ? <a href={item.licenseUrl} target="_blank" rel="noreferrer noopener">{t('catalog.21st.licenceLink')}</a> : null}
              <a href={item.itemUrl} target="_blank" rel="noreferrer noopener">{t('catalog.21st.view')}</a>
              {item.licenseNotice ? <>
                <pre className={originalStyles.licenseNotice} data-testid={`catalog-21st-notice-${item.id}`}>{item.licenseNotice}</pre>
                <button type="button" data-testid={`catalog-21st-copy-notice-${item.id}`} onClick={() => copyNotice(item.licenseNotice!)}>
                  {noticeState.kind === 'copied' ? t('catalog.21st.copied') : t('catalog.21st.copyLicenceNotice')}
                </button>
                {noticeState.kind === 'failed' ? <p role="alert" data-testid={`catalog-21st-copy-notice-failed-${item.id}`}>
                  {t('catalog.21st.copyFailed')}<br /><code>{noticeState.text}</code>
                </p> : null}
              </> : null}
            </div>
          </div>}
        />
      </> : null}
    </dialog>
  </li>;
}

/** Local implementation screenshot when its exact source and image revision match; saved
 * upstream CDN reference otherwise. Failed images fall back to the neutral placeholder. */
function Twenty1stPreview({ item }: { item: Twenty1stItem }) {
  const t = useT();
  const [localFailed, setLocalFailed] = useState(false);
  const [referenceFailed, setReferenceFailed] = useState(false);
  const testId = `catalog-21st-preview-${item.id}`;
  const implementation = item.privateImplementation ?? item.ownedAlternative;
  const local = !!implementation?.thumbnail && !localFailed;
  useEffect(() => { setLocalFailed(false); setReferenceFailed(false); }, [implementation?.thumbnail?.revision, item.preview.kind]);
  if (local || (item.preview.kind === 'image' && !referenceFailed)) {
    return (
      <div className={styles.cultPreview} data-testid={testId} data-preview="image">
        <img
          className={styles.cultPreviewImage}
          src={local ? twenty1stCardPreviewUrl(item) : twenty1stPreviewUrl(item.id)}
          alt={t(local ? 'catalog.21st.implementationPreviewAlt' : 'catalog.21st.previewAlt', { title: item.name })}
          width={480}
          height={300}
          loading="lazy"
          decoding="async"
          onError={() => local ? setLocalFailed(true) : setReferenceFailed(true)}
        />
      </div>
    );
  }
  return (
    <div className={`${styles.placeholder} ${styles.cultPreview}`} data-testid={testId} data-preview="none">
      <p className={styles.noDemo}>{t('catalog.21st.preview')}</p>
    </div>
  );
}
