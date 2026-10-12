// @vitest-environment jsdom
//
// The Prototype row carries All plus nine spines — three more tabs than the
// eight keyword scenes it replaced — so the measured "More" overflow is what
// keeps a narrow window from wrapping the row. jsdom reports every box as zero,
// so the widths are stubbed: the row's own `clientWidth`, its computed
// horizontal padding, and the hidden ghost row's per-chip `offsetWidth` are
// exactly the inputs `measure()` reads.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubTypeRow } from '../../../src/components/HomeHero';
import { prototypeSpineChips } from '../../../src/components/home-hero/spine-chips';
import { I18nProvider, useI18n } from '../../../src/i18n';

const ALL_WIDTH = 40;
const MORE_WIDTH = 60;
const CHIP_WIDTH = 100;
// `.home-hero__subtype-row` carries 12px of padding on each side.
const ROW_PADDING_X = 12;

// The real row's chips are one stable list (HomeHero memoises it), so the
// measurement effect cannot lean on a fresh array arriving every render.
const SPINE_CHIPS = prototypeSpineChips();

let rowWidth = 400;
// When set, a ghost chip's width is derived from its rendered label instead of
// the flat CHIP_WIDTH — the only way a locale change can move the cutoff.
let chipWidthFromLabel = false;
let resizeCallbacks: Array<() => void> = [];

function isRow(node: Element): boolean {
  return node.classList.contains('home-hero__subtype-row');
}

beforeEach(() => {
  rowWidth = 400;
  chipWidthFromLabel = false;
  resizeCallbacks = [];
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      const measure = this.getAttribute('data-measure');
      if (measure === 'all') return ALL_WIDTH;
      if (measure === 'more') return MORE_WIDTH;
      if (measure === 'chip') {
        return chipWidthFromLabel ? (this.textContent ?? '').trim().length * 10 : CHIP_WIDTH;
      }
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return isRow(this) ? rowWidth : 0;
    },
  });
  const realComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((node: Element, pseudo?: string | null) => {
    const style = realComputedStyle(node as Element, pseudo ?? undefined);
    if (node instanceof HTMLElement && isRow(node)) {
      return new Proxy(style, {
        get(target, key) {
          if (key === 'paddingLeft' || key === 'paddingRight') return `${ROW_PADDING_X}px`;
          return Reflect.get(target, key);
        },
      }) as CSSStyleDeclaration;
    }
    return style;
  }) as typeof window.getComputedStyle);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallbacks.push(callback); }
    observe() { /* the width is driven by the test */ }
    disconnect() { resizeCallbacks = resizeCallbacks.filter(() => true); }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

function renderRow(onPickSubChip = vi.fn(), onSelectAll = vi.fn()) {
  render(
    <SubTypeRow
      subChips={SPINE_CHIPS}
      selectedSlug={null}
      pluginsLoading={false}
      onPickSubChip={onPickSubChip}
      onSelectAll={onSelectAll}
    />,
  );
  return { onPickSubChip, onSelectAll };
}

// A locale change rewrites every label without touching the row's size, so it
// run longer than their English originals, so the switch that shortens labels
function LocaleSwitcher() {
  const { setLocale } = useI18n();
  return (
    <button type="button" data-testid="switch-locale" onClick={() => setLocale('en')} />
  );
}

function renderLocalizedRow() {
  render(
    <I18nProvider initial="en">
      <LocaleSwitcher />
      <SubTypeRow
        subChips={SPINE_CHIPS}
        selectedSlug={null}
        pluginsLoading={false}
        onPickSubChip={vi.fn()}
        onSelectAll={vi.fn()}
      />
    </I18nProvider>,
  );
}

function visibleSpineTabs(): string[] {
  return Array.from(document.querySelectorAll('[data-sub-chip-id]'))
    .map((node) => node.getAttribute('data-sub-chip-id') ?? '')
    .filter((id) => id !== 'all');
}

describe('SubTypeRow with the nine atlas spines', () => {
  it('keeps All on the row and collapses the spines that do not fit into More', () => {
    renderRow();
    // 40 + 2 × (5 + 100) = 250 fits inside 400 − 5 − 60; a third would not.
    expect(screen.getByTestId('home-hero-subtype-all')).toBeTruthy();
    expect(visibleSpineTabs()).toEqual(['TL', 'PA']);
    expect(screen.getByTestId('home-hero-subtype-more')).toBeTruthy();
  });

  it('selects a spine that only the More menu can reach', () => {
    const { onPickSubChip } = renderRow();
    expect(screen.queryByTestId('home-hero-subtype-more-MI')).toBeNull();

    fireEvent.click(screen.getByTestId('home-hero-subtype-more'));
    const overflow = screen.getByTestId('home-hero-subtype-more-MI');
    expect(overflow).toBeTruthy();

    fireEvent.click(overflow);
    expect(onPickSubChip).toHaveBeenCalledTimes(1);
    expect(onPickSubChip.mock.calls[0]?.[0]).toMatchObject({ slug: 'MI' });
    // Picking closes the menu.
    expect(screen.queryByTestId('home-hero-subtype-more-MI')).toBeNull();
  });

  it('remeasures when the row gets wider and drops More once every spine fits', () => {
    renderRow();
    expect(visibleSpineTabs()).toHaveLength(2);

    rowWidth = 1200; // 40 + 9 × (5 + 100) = 985 now fits.
    act(() => { for (const callback of resizeCallbacks) callback(); });

    expect(visibleSpineTabs()).toEqual(['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI']);
    expect(screen.queryByTestId('home-hero-subtype-more')).toBeNull();
  });

  it('does not count the row padding as usable width', () => {
    // 40 + 3 × (5 + 100) = 355, and 420 − 5 − 60 = 355: the third spine fits
    // exactly, but only if the row's 24px of padding is usable space. It is
    // not, so it belongs in More.
    rowWidth = 420;
    renderRow();
    expect(visibleSpineTabs()).toEqual(['TL', 'PA']);
    expect(screen.getByTestId('home-hero-subtype-more')).toBeTruthy();
  });

  it('labels each tab with its localized spine name', () => {
    rowWidth = 1200;
    renderRow();
    expect(screen.getByTestId('home-hero-subtype-TL').textContent).toContain('Trust to lead');
    expect(screen.getByTestId('home-hero-subtype-MI').textContent).toContain('Mission impact');
  });
});
