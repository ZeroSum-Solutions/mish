// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BrandLogo } from '../../src/components/DesignKitView';
import { referenceIconUrl } from '../../src/components/DesignBrowserPanel';

afterEach(cleanup);

function faviconImages(container: HTMLElement): HTMLImageElement[] {
  return Array.from(container.querySelectorAll('img')).filter((img) =>
    (img.getAttribute('src') ?? '').includes('google.com/s2/favicons'),
  );
}

// Audit L8: a project name used as the brand "host" must never be sent to the
// third-party favicon service; the letter fallback renders instead.
describe('BrandLogo favicon privacy', () => {
  it.each(['My dentist site', 'acme', 'atlas-tl-02-kit-warm-wellness-retail-dental-lang'])(
    'renders the letter fallback for project-like host %j',
    (host) => {
      const { container } = render(
        <BrandLogo host={host} name="My dentist site" faviconSize={64} workspaceContext={null} />,
      );
      expect(faviconImages(container)).toHaveLength(0);
      expect(container.textContent).toBe('M');
    },
  );

  it('still requests a favicon for a real public hostname', () => {
    const { container } = render(
      <BrandLogo host="stripe.com" name="Stripe" faviconSize={64} workspaceContext={null} />,
    );
    expect(faviconImages(container)).toHaveLength(1);
  });
});

describe('referenceIconUrl favicon privacy', () => {
  it('skips http URLs whose host is not a public DNS name', () => {
    expect(referenceIconUrl('http://localhost:3000/')).toBeUndefined();
    expect(referenceIconUrl('http://192.168.1.20/')).toBeUndefined();
  });
});
