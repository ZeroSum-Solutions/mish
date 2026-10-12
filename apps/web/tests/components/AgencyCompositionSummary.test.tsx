// @vitest-environment jsdom

// The composed-build summary both build surfaces render: block ids in page order, the direction
// and spine, or the fixed fallback code — ids and codes only, labels in this locale's words.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgencyBuildCompositionResult } from '@mish/contracts';

import { AgencyCompositionSummary } from '../../src/components/AgencyCompositionSummary';
import { I18nProvider, useT } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';


function Summary({ composition }: { composition: AgencyBuildCompositionResult }) {
  const t = useT();
  return <AgencyCompositionSummary composition={composition} t={t} />;
}

function renderSummary(composition: AgencyBuildCompositionResult, locale: 'en' = 'en') {
  render(<I18nProvider initial={locale}><Summary composition={composition} /></I18nProvider>);
}

describe('AgencyCompositionSummary', () => {
  afterEach(() => cleanup());

  it('lists the blocks in page order with the direction and spine', () => {
    renderSummary({
      requested: 'blocks',
      used: 'blocks',
      spine: 'TL',
      directionId: 'modern-minimal',
      blocks: ['cult:hero/aurora', 'hyperui:marketing/features/2', 'cult:footer/simple'],
    });
    const list = screen.getByTestId('agency-composition-blocks');
    expect(list.tagName).toBe('OL');
    expect(Array.from(list.querySelectorAll('li')).map((li) => li.getAttribute('data-block-id')))
      .toEqual(['cult:hero/aurora', 'hyperui:marketing/features/2', 'cult:footer/simple']);
    expect(screen.getByTestId('agency-composition-used').textContent)
      .toBe(en['designIndex.build.composition.summary.usedBlocks'].replace('{count}', '3'));
    expect(screen.getByTestId('agency-composition-direction').textContent).toContain('modern-minimal');
    expect(screen.getByTestId('agency-composition-spine').textContent).toContain('TL');
    expect(screen.queryByTestId('agency-composition-fallback')).toBeNull();
  });

  it('names the applied design kit instead of the planner direction it replaced', () => {
    renderSummary({
      requested: 'auto', used: 'blocks', spine: 'TL', directionId: 'modern-minimal', blocks: ['hyperui:marketing/sections/1'],
      designKit: { id: 'user:atlas-beyond-tl03', title: 'Atlas TL.03', applied: true },
    });
    const kit = screen.getByTestId('agency-composition-kit');
    expect(kit.getAttribute('data-kit-applied')).toBe('true');
    expect(kit.textContent).toContain('Atlas TL.03');
    expect(screen.queryByTestId('agency-composition-direction')).toBeNull();
  });

  it('says plainly when the picked kit was not applied because the family route ran', () => {
    renderSummary({ requested: 'auto', used: 'family', fallback: 'no-coverage', designKit: { id: 'user:atlas-beyond-tl03', title: 'Atlas TL.03', applied: false } });
    const kit = screen.getByTestId('agency-composition-kit');
    expect(kit.getAttribute('data-kit-applied')).toBe('false');
    expect(kit.textContent).toBe(en['designIndex.build.composition.summary.kitNotApplied'].replace('{title}', 'Atlas TL.03'));
  });

  it("shows the fallback code and the dropped blocks when the family route ran, in English", () => {
    renderSummary({
      requested: 'blocks',
      used: 'family',
      fallback: 'jev-timeout',
      budgetDropped: ['hyperui:marketing/testimonials/3'],
    }, "en");
    const summary = screen.getByTestId('agency-composition');
    expect(summary.getAttribute('data-used')).toBe('family');
    expect(summary.getAttribute('data-requested')).toBe('blocks');
    const fallback = screen.getByTestId('agency-composition-fallback');
    expect(fallback.textContent).toContain(en['designIndex.build.composition.summary.fallback']);
    expect(fallback.querySelector('code')?.textContent).toBe('jev-timeout');
    expect(screen.getByTestId('agency-composition-budget-dropped').textContent).toContain('hyperui:marketing/testimonials/3');
    expect(screen.queryByTestId('agency-composition-blocks')).toBeNull();
  });
});
