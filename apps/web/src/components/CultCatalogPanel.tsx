// Blocks and Components views of the Catalog tab (cult-port ruling task 9).
//
// Both read GET /api/cult/catalog — one DTO for the whole licensed inventory, so the expanded state
// badge ("Insertable", "Needs adaptation", "Not converted yet", "App only", "Pending") comes from
// the same projection for sections, pages, primitives and apps, and `od cult list|get` prints the
// same rows. Each label names exactly one inventory conversion status (see `CultCatalogState`). Blocks
// shows the section and page rows grouped by taxonomy section kind; Components shows the primitive
// and app rows grouped by the provider's source category. Titles, summaries and tags arrive
// brand-free from the daemon. A card whose row has a preview image (`preview.kind === 'image'`)
// shows it from the daemon's same-origin preview route, lazily, in a fixed 16:10 frame; a row
// without one, or an image that fails to load, shows a neutral placeholder instead.
//
// Filter counts are faceted: each chip counts the rows the view would show if it were picked, with
// the other chip row and the search still applied, so "All" is always the sum of its row's chips.
//
// Cards open the expanded preview. Details and Remix into project actions live in that dialog.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CULT_CATALOG_STATES,
  cultCatalogPreviewUrl,
  parseCultCatalogListResponse,
  type CultCatalogItem,
  type CultCatalogRelatedItem,
  type CultCatalogState,
} from '@mish/contracts';

import { Button, Chip, EmptyState } from '@mish/components';

import { useT } from '../i18n';
import { CultLivePreviewModal, prefetchCultPreview } from './CultLivePreview';
import type { Dict } from '../i18n/types';
import styles from './CatalogView.module.css';
import { Icon } from './Icon';

export type CultCatalogLoad =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; items: CultCatalogItem[] };

export type CultView = 'blocks' | 'components';

const VIEW_KINDS: Record<CultView, ReadonlySet<CultCatalogItem['assetKind']>> = {
  blocks: new Set(['section', 'page']),
  components: new Set(['primitive', 'app']),
};

export function itemsForView(items: readonly CultCatalogItem[], view: CultView): CultCatalogItem[] {
  return items.filter((item) => VIEW_KINDS[view].has(item.assetKind));
}

/**
 * Loads the inventory once, the first time the Catalog tab is active. Only the latest request may
 * settle the state: a slower, earlier response (two quick retries) is ignored.
 */
export function useCultCatalog(isActive: boolean): { load: CultCatalogLoad; reload: () => void } {
  const [load, setLoad] = useState<CultCatalogLoad>({ kind: 'idle' });
  const latest = useRef(0);
  const fetchCatalog = useCallback(async () => {
    const request = ++latest.current;
    setLoad({ kind: 'loading' });
    let next: CultCatalogLoad;
    try {
      const resp = await fetch('/api/cult/catalog');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = parseCultCatalogListResponse(await resp.json());
      next = { kind: 'ready', items: body.catalog.items };
    } catch {
      next = { kind: 'error' };
    }
    if (request === latest.current) setLoad(next);
  }, []);
  useEffect(() => {
    if (isActive && load.kind === 'idle') void fetchCatalog();
  }, [isActive, load.kind, fetchCatalog]);
  return { load, reload: () => void fetchCatalog() };
}

function groupKey(item: CultCatalogItem, view: CultView): string {
  return view === 'blocks' ? item.sectionKind : item.sourceCategory || 'unclassified';
}

function matchesSearch(item: CultCatalogItem, query: string): boolean {
  if (query.length === 0) return true;
  return matchesOwnText(item, query) || matchingRelated(item, query) !== null;
}

function matchesOwnText(item: CultCatalogItem, query: string): boolean {
  const haystack = [item.displayTitle, item.summary, item.sourceCategory, item.sectionKind, ...item.tags]
    .join(' ')
    .toLowerCase();
  return query.toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * A declared child (example or page section) whose title matches, when the row's own text does
 * not. Browse hides declared children, so the match surfaces the parent family and opens the child.
 */
function matchingRelated(item: CultCatalogItem, query: string): CultCatalogRelatedItem | null {
  if (!query || matchesOwnText(item, query)) return null;
  const words = query.toLowerCase().split(/\s+/);
  return item.relatedItems?.find((related) => words.every((word) => related.title.toLowerCase().includes(word))) ?? null;
}

export interface CultCatalogPanelProps {
  view: CultView;
  load: CultCatalogLoad;
  onRetry: () => void;
}

export function CultCatalogPanel({ view, load, onRetry }: CultCatalogPanelProps) {
  const t = useT();
  const [group, setGroup] = useState<string>('all');
  const [state, setState] = useState<CultCatalogState | 'all'>('all');
  const [query, setQuery] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewPartId, setPreviewPartId] = useState<string | null>(null);
  const closePreview = useCallback(() => setPreviewId(null), []);

  const items = useMemo(() => (load.kind === 'ready' ? itemsForView(load.items, view) : []), [load, view]);
  const groupLabel = useCallback(
    (key: string) => (view === 'blocks' ? t(`catalog.cult.kind.${key}` as keyof Dict) : key),
    [t, view],
  );
  // The chip options come from every row in the view, so a chip never disappears while filtering.
  const groups = useMemo(
    () => [...new Set(items.map((item) => groupKey(item, view)))].sort((a, b) => groupLabel(a).localeCompare(groupLabel(b))),
    [items, view, groupLabel],
  );
  const states = useMemo(
    () => CULT_CATALOG_STATES.filter((value) => items.some((item) => item.state === value)),
    [items],
  );
  const searched = useMemo(() => items.filter((item) => matchesSearch(item, query.trim())), [items, query]);
  const inGroup = useCallback((item: CultCatalogItem) => group === 'all' || groupKey(item, view) === group, [group, view]);
  const inState = useCallback((item: CultCatalogItem) => state === 'all' || item.state === state, [state]);
  // Faceted counts: a group chip counts the rows matching the state chip and search, and the
  // reverse; each row's "All" is the sum of its chips.
  const groupCounts = useMemo(() => countBy(searched.filter(inState), (item) => groupKey(item, view)), [searched, inState, view]);
  const stateCounts = useMemo(() => countBy(searched.filter(inGroup), (item) => item.state), [searched, inGroup]);
  const shown = useMemo(() => searched.filter((item) => inGroup(item) && inState(item)), [searched, inGroup, inState]);
  const shownGroups = useMemo(() => {
    const byGroup = new Map<string, CultCatalogItem[]>();
    for (const item of shown) {
      const key = groupKey(item, view);
      byGroup.set(key, [...(byGroup.get(key) ?? []), item]);
    }
    return groups.map((key) => [key, byGroup.get(key) ?? []] as const).filter(([, list]) => list.length > 0);
  }, [shown, groups, view]);

  const testId = `catalog-${view}`;
  return (
    <div className={styles.cultPanel} data-testid={`${testId}-view`}>
      <p className={styles.lede}>{t(`catalog.cult.${view}.lede` as keyof Dict)}</p>

      {load.kind === 'loading' || load.kind === 'idle' ? (
        <p className={styles.note} role="status">{t('catalog.cult.loading')}</p>
      ) : null}
      {load.kind === 'error' ? (
        <div className={styles.note} role="alert">
          <span>{t('catalog.cult.error')}</span>{' '}
          <Button variant="secondary" size="sm" className={styles.button} onClick={onRetry}>{t('catalog.retry')}</Button>
        </div>
      ) : null}

      {load.kind === 'ready' && items.length === 0 ? (
        <EmptyState icon={<Icon name="blocks" size={20} />} title={t('catalog.cult.none')} />
      ) : null}

      {load.kind === 'ready' && items.length > 0 ? (
        <>
          {/* One toolbar row: search, the group filter (chips while they fit, a select past
              that — ui-system § 10), the state chips, and the live count. */}
          <div className={styles.toolbar}>
            <label className={styles.searchField} data-ui-field-shell>
              <Icon name="search" size={14} className={styles.searchIcon} />
              <input
                type="search"
                className={styles.search}
                data-testid={`${testId}-search`}
                value={query}
                aria-label={t('catalog.cult.search')}
                placeholder={t('catalog.cult.searchPlaceholder')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <FacetFilter
              label={t(view === 'blocks' ? 'catalog.cult.filter.kind' : 'catalog.cult.filter.category')}
              testId={`${testId}-group`}
              value={group}
              options={groups.map((key) => ({ value: key, label: groupLabel(key), count: groupCounts.get(key) ?? 0 }))}
              onChange={setGroup}
            />
            <FacetFilter
              label={t('catalog.cult.filter.state')}
              testId={`${testId}-state`}
              value={state}
              options={states.map((value) => ({
                value,
                label: t(`catalog.cult.state.${value}` as keyof Dict),
                count: stateCounts.get(value) ?? 0,
              }))}
              onChange={(value) => setState(value as CultCatalogState | 'all')}
            />
            <p className={styles.count} data-testid={`${testId}-count`}>
              {t('catalog.cult.count', { shown: shown.length, total: items.length })}
            </p>
          </div>
          {shown.length === 0 ? (
            <EmptyState
              icon={<Icon name="search" size={20} />}
              title={t('catalog.cult.empty')}
              action={
                <Button
                  variant="secondary"
                  onClick={() => { setQuery(''); setGroup('all'); setState('all'); }}
                  data-testid={`${testId}-empty-clear`}
                >
                  {t('catalog.clearFilters')}
                </Button>
              }
            />
          ) : null}
          {shownGroups.map(([key, list]) => (
            <section key={key} className={styles.group} aria-label={groupLabel(key)} data-testid={`${testId}-group-section-${key}`}>
              <h2 className={styles.groupTitle}>
                {groupLabel(key)} <span className={styles.groupCount}>{list.length}</span>
              </h2>
              <ul className={styles.grid}>
                {list.map((item) => {
                  const matchedPart = matchingRelated(item, query.trim());
                  return <CultCard key={item.id} item={item} matchedPart={matchedPart} onPreview={() => {
                    setPreviewPartId(matchedPart?.id ?? null);
                    setPreviewId(item.id);
                  }} />;
                })}
              </ul>
            </section>
          ))}
          {previewId !== null ? (
            <CultLivePreviewModal items={shown} activeId={previewId} initialRelatedId={previewPartId} onNavigate={(id) => { setPreviewPartId(null); setPreviewId(id); }} onClose={closePreview} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return counts;
}

interface ChipOption { value: string; label: string; count: number }

/** Past this many options a chip row turns into a pill wall; the filter becomes a select. */
const MAX_FILTER_CHIPS = 6;

/**
 * One facet filter whose "All" option counts the sum of its options. A short facet renders calm
 * chips; a long one (Blocks has twenty section kinds) renders one select with the same values,
 * so the toolbar stays a single quiet row (docs/design/ui-system.md § 10).
 */
export function FacetFilter({ label, testId, value, options, allCount, onChange }: {
  label: string;
  testId: string;
  value: string;
  options: ChipOption[];
  allCount?: number;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const all: ChipOption = { value: 'all', label: t('catalog.cult.filter.all'), count: allCount ?? options.reduce((sum, option) => sum + option.count, 0) };
  if (options.length > MAX_FILTER_CHIPS) {
    return (
      <label className={styles.selectField}>
        <span className={styles.selectLabel}>{label}</span>
        <select
          className={styles.select}
          value={value}
          data-testid={`${testId}-select`}
          onChange={(event) => onChange(event.target.value)}
        >
          {[all, ...options].map((option) => (
            <option key={option.value} value={option.value}>{option.label} · {option.count}</option>
          ))}
        </select>
        <Icon name="chevron-down" size={14} className={styles.selectChevron} />
      </label>
    );
  }
  return (
    <div className={styles.chips} role="group" aria-label={label}>
      {[all, ...options].map((option) => (
        <Chip
          key={option.value}
          className={styles.chip}
          selected={value === option.value}
          data-testid={`${testId}-${option.value}`}
          trailing={<span className={styles.chipCount}>{option.count}</span>}
          onClick={() => onChange(option.value)}
        >
          {option.label}{' '}
        </Chip>
      ))}
    </div>
  );
}

function CultCard({ item, matchedPart, onPreview }: { item: CultCatalogItem; matchedPart: CultCatalogRelatedItem | null; onPreview: () => void }) {
  const t = useT();
  const category = item.assetKind === 'section' || item.assetKind === 'page'
    ? t(`catalog.cult.kind.${item.sectionKind}` as keyof Dict)
    : item.sourceCategory || t(`catalog.cult.assetKind.${item.assetKind}` as keyof Dict);
  return (
    <li className={styles.card} data-testid={`catalog-cult-card-${item.id}`} data-state={item.state}>
      <button
        type="button"
        className={styles.cardButton}
        aria-label={t('catalog.cult.live.openLabel', { title: item.displayTitle })}
        aria-haspopup="dialog"
        onClick={onPreview}
        onMouseEnter={() => prefetchCultPreview(item.id)}
        onFocus={() => prefetchCultPreview(item.id)}
        data-testid={`catalog-cult-live-preview-${item.id}`}
      >
        <CultPreview item={item} />
        <span className={styles.meta}>
          <span role="heading" aria-level={3} className={styles.name}>{item.displayTitle}</span>
          <span className={`${styles.detail} ${styles.cardDescription}`}>{category}</span>
          {matchedPart ? <span className={`${styles.detail} ${styles.cardDescription}`} data-testid={`catalog-cult-matched-part-${matchedPart.id}`}>
            {t(`catalog.cult.live.related.${matchedPart.relationship}` as keyof Dict)} · {matchedPart.title}
          </span> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * The card thumbnail. The alt text is the brand-free display title. An image that fails to load
 * falls back to the same placeholder a row without an image shows.
 */
function CultPreview({ item }: { item: CultCatalogItem }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const testId = `catalog-cult-preview-${item.id}`;
  if (item.preview.kind === 'image' && !failed) {
    return (
      <span className={styles.cultPreview} data-testid={testId} data-preview="image">
        <img
          className={styles.cultPreviewImage}
          src={cultCatalogPreviewUrl(item.id, item.preview.revision)}
          alt={t('catalog.cult.previewAlt', { title: item.displayTitle })}
          width={480}
          height={300}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className={`${styles.placeholder} ${styles.cultPreview}`} data-testid={testId} data-preview="none">
      <span className={styles.noDemo}>{t('catalog.cult.preview')}</span>
    </span>
  );
}
