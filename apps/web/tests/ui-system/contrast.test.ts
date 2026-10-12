import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { accessibleAccentInk, ACCENT_SWATCHES, workspaceAccentInks } from '../../src/state/appearance';

const sheet = postcss.parse(readFileSync(new URL('../../src/styles/workspace-ui.css', import.meta.url), 'utf8'));
function palette(selector: string, inMedia = false): Record<string, string> {
  const colors: Record<string, string> = {};
  sheet.walkRules((rule) => {
    if (rule.selector !== selector || (rule.parent?.type === 'atrule') !== inMedia) return;
    rule.walkDecls((decl) => { if (/^#[\da-f]{6}$/i.test(decl.value)) colors[decl.prop] = decl.value; });
  });
  return colors;
}
function luminance(hex: string): number {
  if (!hex) throw new Error('Missing palette role');
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}
const light = palette("html[data-ui-system='workspace']");
const dark = palette("html[data-ui-system='workspace'][data-theme='dark']");
for (const [theme, colors] of [['light', light], ['dark', dark]] as const) {
  describe(`${theme} workspace contrast`, () => {
    for (const ink of ['text', 'text-strong', 'text-muted', 'text-soft', 'text-faint']) {
      for (const surface of ['bg', 'bg-app', 'bg-panel', 'bg-subtle', 'bg-muted', 'bg-elevated']) {
        it(`${ink} on ${surface} meets 4.5:1`, () => {
          expect(contrast(colors[`--${ink}`]!, colors[`--${surface}`]!)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    for (const status of ['green', 'red', 'blue', 'amber', 'purple', 'brand']) {
      it(`${status} foreground meets 4.5:1 on its status surface`, () => {
        expect(contrast(colors[`--${status === 'brand' ? 'brand-text' : status}`]!, colors[`--${status === 'brand' ? 'brand-soft' : `${status}-bg`}`]!)).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const surface of ['bg', 'bg-app', 'bg-panel', 'bg-elevated']) {
      it(`field edge and focus ring on ${surface} meet 3:1`, () => {
        for (const role of ['ui-control-border', 'ui-focus']) expect(contrast(colors[`--${role}`]!, colors[`--${surface}`]!)).toBeGreaterThanOrEqual(3);
      });
    }
    it('filled information controls and selected provider chips remain legible', () => {
      expect(contrast(colors['--ui-info-fill-ink'] ?? light['--ui-info-fill-ink']!, colors['--ui-info-fill'] ?? light['--ui-info-fill']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors['--bg']!, colors['--selected']!)).toBeGreaterThanOrEqual(4.5);
    });
    it('semantic filled badges use theme ink independently of custom accents', () => {
      for (const fill of ['red', 'blue', 'green']) expect(contrast(colors['--bg']!, colors[`--${fill}`]!)).toBeGreaterThanOrEqual(4.5);
    });
    it('primary button remains legible at rest and on hover', () => {
      for (const surface of ['text-strong', 'ui-button-primary-hover']) expect(contrast(colors['--bg']!, colors[`--${surface}`]!)).toBeGreaterThanOrEqual(4.5);
    });
  });
}
it('system dark supplies the same color roles as explicit dark', () => {
  expect(palette("html[data-ui-system='workspace']:not([data-theme])", true)).toEqual(dark);
});
it('every global visual rule is scoped to the shared application system', () => {
  sheet.walkRules((rule) => expect(rule.selector).toContain("html[data-ui-system='workspace']"));
});

for (const accent of [...ACCENT_SWATCHES, '#777777', '#757575', '#000000', '#ffffff']) {
  it(`custom accent ${accent} has at least 4.5:1 solid-button ink`, () => {
    expect(contrast(accessibleAccentInk(accent), accent)).toBeGreaterThanOrEqual(4.5);
  });
}

for (const [theme, colors] of [['light', light], ['dark', dark]] as const) {
  for (const accent of [...ACCENT_SWATCHES, '#777777', '#757575', '#000000', '#ffffff']) {
    it(`${theme} custom accent ${accent} remains readable through hover and strong states`, () => {
      const inks = workspaceAccentInks(accent, colors['--text-strong']!);
      for (const [state, weight] of [['hover', 0.86], ['strong', 0.82]] as const) {
        const background = '#' + [1, 3, 5].map((offset) =>
          Math.round(parseInt(accent.slice(offset, offset + 2), 16) * weight
            + parseInt(colors['--text-strong']!.slice(offset, offset + 2), 16) * (1 - weight))
            .toString(16).padStart(2, '0')).join('');
        expect(contrast(inks[`--ui-on-accent-${state}`]!, background)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}
