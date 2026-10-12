// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DesignSystemSpecimen } from '../../src/components/DesignSystemSpecimen';
import { I18nProvider } from '../../src/i18n';
import { parsedToKit } from '../../src/runtime/design-kit';
import { parseDesignMd } from '../../src/runtime/design-md-parse';

afterEach(cleanup);

describe('source specimen framing', () => {
  it('uses an explicitly recorded CTA color before decorative accent areas', () => {
    const kit = parsedToKit(parseDesignMd('# Glossgenius\n\n## Colors\n| Role | Name | Hex | Usage |\n| --- | --- | --- | --- |\n| source | Sky Violet | #c9c3f4 | Accent areas |\n| source | Genius Yellow | #f7f270 | Calls to Action |'), { designSystemId: 'user:glossgenius', editable: false });
    render(<I18nProvider initial="en"><DesignSystemSpecimen kit={kit} /></I18nProvider>);
    expect(screen.getByTestId('design-kit-specimen').style.getPropertyValue('--specimen-accent')).toBe('#f7f270');
  });

  it('uses the recorded inverse text on a dark canvas without changing source roles', () => {
    const kit = parsedToKit(parseDesignMd('# Assembly\n\n## Colors\n| Role | Name | Hex | Usage |\n| --- | --- | --- | --- |\n| source | Midnight Canvas | #000000 | Primary text and deep backgrounds |\n| source | Canvas White | #ffffff | Primary inverse text |'), { designSystemId: 'user:assembly', editable: false });
    render(<I18nProvider initial="en"><DesignSystemSpecimen kit={kit} /></I18nProvider>);
    expect(screen.getByTestId('design-kit-specimen').style.getPropertyValue('--specimen-ink')).toBe('#ffffff');
    expect(kit.colors[0]?.hex).toBe('#000000');
  });

  it('labels local font fallback rendering and avoids invented dashboard metrics', () => {
    const kit = parsedToKit(parseDesignMd('# Neutral Product\n\n## Typography\n- **Display:** Source Family — fallbacks: system-ui'), { designSystemId: 'neutral-product', editable: false });
    render(<I18nProvider initial="en"><DesignSystemSpecimen kit={kit} /></I18nProvider>);
    expect(screen.getByText('Source families shown; local font fallbacks apply.')).toBeTruthy();
    expect(screen.getByText(/Layout specimen/)).toBeTruthy();
    expect(screen.queryByText('24')).toBeNull();
    expect(screen.queryByText('+12% ↗')).toBeNull();
    expect(screen.queryByText('All changes saved')).toBeNull();
  });
});
