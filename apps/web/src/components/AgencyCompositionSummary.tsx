// What a `composition: 'blocks' | 'auto'` agency build decided: the reviewed block ids it composed,
// in page order, with the direction and spine — or, when it ran the family route instead, the
// fixed fallback code that says why (and any blocks the page budget dropped). Ids and fixed codes
// only: the snapshot and the AG-UI state carry nothing else, never a Jev answer.
//
// Rendered by `AgencyBuildProgress`, so the Design index Build panel and Home's "Build with Jev"
// card read a composed build the same way. `data-testid="agency-composition"` and each block's
// `data-block-id` are stable hooks for e2e.

import type { AgencyBuildCompositionResult } from '@open-design/contracts';

import type { useT } from '../i18n';
import styles from './AgencyCompositionSummary.module.css';

type Translate = ReturnType<typeof useT>;

export interface AgencyCompositionSummaryProps {
  composition: AgencyBuildCompositionResult;
  t: Translate;
}

export function AgencyCompositionSummary({ composition, t }: AgencyCompositionSummaryProps) {
  const blocks = composition.used === 'blocks' ? composition.blocks ?? [] : [];
  const budgetDropped = composition.budgetDropped ?? [];
  const kit = composition.designKit;
  return (
    <section
      className={styles.summary}
      aria-label={t('designIndex.build.composition.summary.label')}
      data-testid="agency-composition"
      data-used={composition.used}
      data-requested={composition.requested}
    >
      <h3 className={styles.heading}>{t('designIndex.build.composition.summary.label')}</h3>
      {composition.used === 'blocks' ? (
        <>
          <p className={styles.note} data-testid="agency-composition-used">
            {t('designIndex.build.composition.summary.usedBlocks', { count: blocks.length })}
          </p>
          {/* A picked kit replaces the planner's direction on the page, so the kit is what is named. */}
          {kit?.applied ? (
            <p className={styles.note} data-testid="agency-composition-kit" data-kit-id={kit.id} data-kit-applied="true">
              {t('designIndex.build.composition.summary.kitApplied')} <strong>{kit.title ?? kit.id}</strong>
            </p>
          ) : composition.directionId ? (
            <p className={styles.note} data-testid="agency-composition-direction" data-direction-id={composition.directionId}>
              {t('designIndex.build.composition.summary.direction')} <code>{composition.directionId}</code>
            </p>
          ) : null}
          {composition.spine ? (
            <p className={styles.note} data-testid="agency-composition-spine" data-spine={composition.spine}>
              {t('designIndex.build.composition.summary.spine')} <code>{composition.spine}</code>
            </p>
          ) : null}
          {blocks.length > 0 ? (
            <ol
              className={styles.blocks}
              aria-label={t('designIndex.build.composition.summary.blocks')}
              data-testid="agency-composition-blocks"
            >
              {blocks.map((id, index) => (
                <li key={`${index}-${id}`} data-block-id={id}><code>{id}</code></li>
              ))}
            </ol>
          ) : null}
        </>
      ) : (
        <p className={styles.note} data-testid="agency-composition-fallback" data-fallback={composition.fallback ?? ''}>
          {t('designIndex.build.composition.summary.fallback')}
          {composition.fallback ? <> <code>{composition.fallback}</code></> : null}
        </p>
      )}
      {kit && !kit.applied ? (
        <p className={styles.note} data-testid="agency-composition-kit" data-kit-id={kit.id} data-kit-applied="false">
          {t('designIndex.build.composition.summary.kitNotApplied', { title: kit.title ?? kit.id })}
        </p>
      ) : null}
      {budgetDropped.length > 0 ? (
        <p className={styles.note} data-testid="agency-composition-budget-dropped">
          {t('designIndex.build.composition.summary.budgetDropped')} <code>{budgetDropped.join(', ')}</code>
        </p>
      ) : null}
    </section>
  );
}
