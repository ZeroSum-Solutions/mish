// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivacyConsentModal } from '../../src/components/PrivacyConsentModal';
import { I18nProvider } from '../../src/i18n';

const analyticsTrack = vi.hoisted(() => vi.fn());

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({
    track: analyticsTrack,
  }),
}));

function renderModal(overrides?: { onShare?: () => void; onDecline?: () => void }) {
  const onShare = overrides?.onShare ?? vi.fn();
  const onDecline = overrides?.onDecline ?? vi.fn();
  const result = render(
    <I18nProvider initial="en">
      <PrivacyConsentModal onShare={onShare} onDecline={onDecline} />
    </I18nProvider>,
  );
  return { ...result, onShare, onDecline };
}

describe('PrivacyConsentModal', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders explicit share and decline choices', () => {
    const { container } = renderModal();
    const share = screen.getByRole('button', { name: 'Share' });
    expect(share.className).toContain('privacy-consent-action--primary');
    expect(screen.getByRole('button', { name: "Don't share" }).className)
      .not.toContain('privacy-consent-action--primary');
    expect(screen.queryByRole('button', { name: 'I get it' })).toBeNull();
    expect(container.querySelector('.privacy-consent-banner-head .kicker')).toBeNull();
  });

  it('tells the user choices are changeable in Settings', () => {
    renderModal();
    expect(screen.getByText(/Sharing usage data helps us understand/i)).toBeTruthy();
    const footer = screen.getByText(/You can change these any time/i);
    expect(footer.textContent ?? '').toMatch(/You can change these any time/i);
    expect(footer.textContent ?? '').toMatch(/Settings/);
    expect(footer.textContent ?? '').toMatch(/Privacy/);
  });

  it('does not expose an upstream privacy-policy link', () => {
    renderModal();
    expect(screen.queryByRole('link', { name: /privacy policy/i })).toBeNull();
  });

  it('invokes onShare when the share button is clicked', () => {
    const { onShare, onDecline } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();
  });

  it('invokes onDecline when the decline button is clicked', () => {
    const { onShare, onDecline } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: "Don't share" }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onShare).not.toHaveBeenCalled();
  });

  it('does not track the decline click before opt-out is persisted', () => {
    const { onDecline } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: "Don't share" }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(analyticsTrack).not.toHaveBeenCalled();
  });
});
