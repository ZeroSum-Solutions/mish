// GenUI catalog view (catalog-design.md §E).
//
// Lists the owned effect components from GET /api/genui/catalog with a category and a status
// filter. A ported card runs its demo in `<iframe sandbox="allow-scripts" srcdoc>`, isolated by
// two independent mechanisms: the iframe's `sandbox="allow-scripts"` attribute isolates it from
// the app origin (no `allow-same-origin`, so the demo cannot reach `window.parent` or app
// storage/cookies), and the document itself, served via `demoDocument()` in
// `@open-design/genui-catalog/data`, carries a `<meta http-equiv="Content-Security-Policy"
// content="default-src 'none'; ...">` that blocks the demo from making any network request. The
// data module is loaded on first activation only, so the entry bundle does not carry it. There is
// no copy-source or export control: React Bits-derived effects are embed-only.
//
// A segmented control switches between three views: Effects (the GenUI catalog above, unchanged),
// Blocks and Components (the licensed inventory from GET /api/cult/catalog, `CultCatalogPanel`).
// The segment labels carry each view's count once its data has loaded.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { parseGenuiCatalogResponse, type GenuiCatalogEntry } from '@open-design/contracts';

import { Badge, Button, Chip, EmptyState } from '@open-design/components';

import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import styles from './CatalogView.module.css';
import { Icon } from './Icon';
import { SelectionGroup, SelectionIndicator } from './ui/SelectionIndicator';
import { CultCatalogPanel, itemsForView, useCultCatalog } from './CultCatalogPanel';
import { Twenty1stPanel, useTwenty1stCatalog } from './Twenty1stPanel';
import { EffectPreview, usePreviewScale } from './EffectPreview';

type DemoDocument = (id: string, options?: { reducedMotion?: boolean }) => string | null;
type LoadState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; entries: GenuiCatalogEntry[] };
type StatusFilter = 'all' | 'ported' | 'planned';

export interface CatalogViewProps {
  /** The view fetches nothing until it is first shown. */
  isActive?: boolean;
}

const SEGMENTS = ['effects', 'blocks', 'components', '21st'] as const;
type Segment = (typeof SEGMENTS)[number];

export function CatalogView({ isActive = true }: CatalogViewProps) {
  const t = useT();
  const [segment, setSegment] = useState<Segment>('effects');
  const [effectsCount, setEffectsCount] = useState<number | null>(null);
  const cult = useCultCatalog(isActive);
  const twentyFirst = useTwenty1stCatalog(isActive && segment === '21st');
  const tabRefs = useRef<Record<Segment, HTMLButtonElement | null>>({ effects: null, blocks: null, components: null, '21st': null });

  const counts: Record<Segment, number | null> = {
    effects: effectsCount,
    blocks: cult.load.kind === 'ready' ? itemsForView(cult.load.items, 'blocks').length : null,
    components: cult.load.kind === 'ready' ? itemsForView(cult.load.items, 'components').length : null,
    '21st': twentyFirst.load.kind === 'ready' ? twentyFirst.load.items.length : null,
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = SEGMENTS.indexOf(segment);
    const next = event.key === 'ArrowRight' ? SEGMENTS[(index + 1) % SEGMENTS.length]
      : event.key === 'ArrowLeft' ? SEGMENTS[(index + SEGMENTS.length - 1) % SEGMENTS.length]
      : event.key === 'Home' ? SEGMENTS[0]
      : event.key === 'End' ? SEGMENTS[SEGMENTS.length - 1]
      : undefined;
    if (!next) return;
    event.preventDefault();
    setSegment(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className={styles.root} data-testid="catalog-view">
      <header className={styles.pageHeader}>
        <div className={styles.pageTitleBlock}>
          <h1 className={styles.title}>{t('catalog.title')}</h1>
          <p className={styles.pageDescription}>{t('catalog.description')}</p>
        </div>
      </header>

      {/* The view switch is a segmented track (tab semantics: it swaps the panel below); the
          raised thumb glides between tabs through the shared SelectionIndicator. */}
      <SelectionGroup>
        <div className={styles.segments} role="tablist" aria-label={t('catalog.segment.label')}>
          {SEGMENTS.map((value) => (
            <button
              key={value}
              ref={(node) => { tabRefs.current[value] = node; }}
              type="button"
              role="tab"
              id={`catalog-tab-${value}`}
              aria-controls={`catalog-panel-${value}`}
              aria-selected={segment === value}
              tabIndex={segment === value ? 0 : -1}
              className={styles.segment}
              data-testid={`catalog-segment-${value}`}
              onClick={() => setSegment(value)}
              onKeyDown={onTabKeyDown}
            >
              <SelectionIndicator active={segment === value} />
              {t(`catalog.segment.${value}` as keyof Dict)}
              {counts[value] !== null ? <span className={styles.segmentCount}> {counts[value]}</span> : null}
            </button>
          ))}
        </div>
      </SelectionGroup>

      <div role="tabpanel" id="catalog-panel-effects" aria-labelledby="catalog-tab-effects" hidden={segment !== 'effects'}>
        <EffectsCatalog isActive={isActive} previewsActive={isActive && segment === 'effects'} onCount={setEffectsCount} />
      </div>
      <div role="tabpanel" id="catalog-panel-blocks" aria-labelledby="catalog-tab-blocks" hidden={segment !== 'blocks'}>
        <CultCatalogPanel view="blocks" load={cult.load} onRetry={cult.reload} />
      </div>
      <div role="tabpanel" id="catalog-panel-components" aria-labelledby="catalog-tab-components" hidden={segment !== 'components'}>
        <CultCatalogPanel view="components" load={cult.load} onRetry={cult.reload} />
      </div>
      <div role="tabpanel" id="catalog-panel-21st" aria-labelledby="catalog-tab-21st" hidden={segment !== '21st'}>
        <Twenty1stPanel load={twentyFirst.load} onRetry={twentyFirst.reload} allItems={twentyFirst.allItems}
          filters={twentyFirst.filters} onFiltersChange={twentyFirst.setFilters} />
      </div>
    </section>
  );
}

/** The GenUI effects catalog, as it was before the Blocks and Components views. */
function EffectsCatalog({ isActive, previewsActive, onCount }: { isActive: boolean; previewsActive: boolean; onCount: (count: number) => void }) {
  const t = useT();
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [demoDocument, setDemoDocument] = useState<DemoDocument | null>(null);
  const [category, setCategory] = useState<string>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [reducedMotion, setReducedMotion] = useState(false);
  const [preview, setPreview] = useState<GenuiCatalogEntry | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const [resp, data] = await Promise.all([
        fetch('/api/genui/catalog'),
        import('@open-design/genui-catalog/data'),
      ]);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = parseGenuiCatalogResponse(await resp.json());
      // A `cut` verdict means the rights review rejected the candidate outright (unknown or
      // incompatible licence): there is no clean-room asset and never will be, so the card can
      // only ever render as a blank "no demo" placeholder. That is exactly what Addendum 4 (every
      // Catalog row must show a full preview, none blank) forbids, and there is no lawful way to
      // synthesize a real preview for source we were refused rights to. `keep`/`maybe` verdicts
      // stay visible even when `status` is still `planned`, since those are real future rows with
      // a rights-clear path to a demo, not permanently blank ones — see CatalogView.test.tsx.
      const entries = body.catalog.components.filter((entry) => entry.verdict !== 'cut');
      // Functional form: `data.demoDocument` is stored AS a function, not invoked as a
      // `(prev) => next` state updater — `useState` would otherwise call it immediately.
      setDemoDocument(() => data.demoDocument);
      setState({ kind: 'ready', entries });
    } catch {
      setState({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    if (isActive && state.kind === 'idle') void load();
  }, [isActive, state.kind, load]);

  useEffect(() => {
    if (state.kind === 'ready') onCount(state.entries.length);
  }, [state, onCount]);

  const entries = state.kind === 'ready' ? state.entries : [];
  const categories = useMemo(() => [...new Set(entries.map((entry) => entry.category))].sort(), [entries]);
  const shown = useMemo(
    () => entries.filter((entry) =>
      (category === 'all' || entry.category === category) && (status === 'all' || entry.status === status)),
    [entries, category, status],
  );
  const portedCount = entries.filter((entry) => entry.status === 'ported').length;

  return (
    <div className={styles.cultPanel}>
      <p className={styles.lede}>{t('catalog.lede')}</p>

      <div className={styles.toolbar}>
        <label className={styles.selectField}>
          <span className={styles.selectLabel}>{t('catalog.filter.category')}</span>
          <select
            className={styles.select}
            data-testid="catalog-filter-category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">{t('catalog.filter.all')}</option>
            {categories.map((value) => (
              <option key={value} value={value}>{t(`catalog.category.${value}` as keyof Dict)}</option>
            ))}
          </select>
          <Icon name="chevron-down" size={14} className={styles.selectChevron} />
        </label>
        <label className={styles.selectField}>
          <span className={styles.selectLabel}>{t('catalog.filter.status')}</span>
          <select
            className={styles.select}
            data-testid="catalog-filter-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
          >
            <option value="all">{t('catalog.filter.all')}</option>
            <option value="ported">{t('catalog.status.ported')}</option>
            <option value="planned">{t('catalog.status.planned')}</option>
          </select>
          <Icon name="chevron-down" size={14} className={styles.selectChevron} />
        </label>
        {/* A lone toggle chip: the glyph keeps it reading as a control when off. */}
        <Chip
          selected={reducedMotion}
          icon={<Icon name={reducedMotion ? 'check' : 'pause'} size={14} />}
          data-testid="catalog-reduced-motion"
          onClick={() => setReducedMotion((value) => !value)}
        >
          {t('catalog.reducedMotion')}
        </Chip>
        {state.kind === 'ready' ? (
          <p className={styles.count} data-testid="catalog-count">
            {t('catalog.count', { shown: shown.length, total: entries.length, ported: portedCount })}
          </p>
        ) : null}
      </div>

      {state.kind === 'loading' || state.kind === 'idle' ? (
        <p className={styles.note} role="status">{t('catalog.loading')}</p>
      ) : null}
      {state.kind === 'error' ? (
        <div className={styles.note} role="alert">
          <span>{t('catalog.error')}</span>{' '}
          <Button variant="secondary" size="sm" className={styles.button} onClick={() => void load()}>{t('catalog.retry')}</Button>
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          {shown.length === 0 ? (
            <EmptyState
              icon={<Icon name="sparkles" size={20} />}
              title={t('catalog.empty')}
              action={
                <Button
                  variant="secondary"
                  onClick={() => { setCategory('all'); setStatus('all'); }}
                  data-testid="catalog-empty-clear"
                >
                  {t('catalog.clearFilters')}
                </Button>
              }
            />
          ) : null}
          <ul className={styles.grid}>
            {shown.map((entry) => (
              <CatalogCard
                key={entry.id}
                entry={entry}
                srcDoc={previewsActive && entry.status === 'ported' && demoDocument ? demoDocument(entry.id, { reducedMotion }) : null}
                reducedMotion={reducedMotion}
                onPreview={() => setPreview(entry)}
              />
            ))}
          </ul>
        </>
      ) : null}
      {preview ? <EffectPreview entry={preview} initialReducedMotion={reducedMotion} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

function CatalogCard({ entry, srcDoc, reducedMotion, onPreview }: { entry: GenuiCatalogEntry; srcDoc: string | null; reducedMotion: boolean; onPreview: () => void }) {
  const t = useT();
  const { ref, scale } = usePreviewScale(640, 0.5);
  const cardRef = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(false), [srcDoc, visible]);
  useEffect(() => {
    const card = cardRef.current;
    if (!card || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), { rootMargin: '160px 0px' });
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  return (
    <li ref={cardRef} className={styles.card} data-testid={`catalog-card-${entry.id}`} data-status={entry.status}>
      <button type="button" className={styles.cardHitTarget} onClick={onPreview} disabled={!srcDoc} aria-label={t('catalog.effect.previewName', { name: entry.name })} />
      <div className={styles.demo} ref={ref}>
        {srcDoc && visible ? (
          <div style={{ width: 640 * scale, height: 480 * scale }}>
          <iframe
            // Re-mount on toggle so the demo restarts in the chosen motion mode.
            key={reducedMotion ? 'reduced' : 'full'}
            className={styles.frame}
            width={640}
            height={480}
            style={{ width: 640, height: 480, transform: `scale(${scale})`, transformOrigin: 'top left', opacity: loaded ? 1 : 0 }}
            title={t('catalog.demoTitle', { name: entry.name })}
            sandbox="allow-scripts"
            tabIndex={-1}
            srcDoc={srcDoc}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            data-testid={`catalog-demo-${entry.id}`}
          />
          {!loaded ? <span className={styles.demoLoading} role="status" data-testid={`catalog-demo-loading-${entry.id}`}>{t('catalog.loading')}</span> : null}
          </div>
        ) : !srcDoc ? (
          <p className={styles.noDemo}>{t('catalog.noDemo')}</p>
        ) : null}
      </div>
      <div className={styles.meta}>
        <div className={styles.row}>
          <h2 className={styles.name}>{entry.name}</h2>
          {entry.status === 'planned' ? <Badge>{t('catalog.status.planned')}</Badge> : null}
        </div>
        <p className={styles.detail}>
          {t(`catalog.category.${entry.category}` as keyof Dict)}
        </p>
      </div>
    </li>
  );
}
