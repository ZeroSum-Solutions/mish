// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionModeToggle } from '../../src/components/SessionModeToggle';
import { I18nProvider } from '../../src/i18n';

afterEach(() => cleanup());

describe('SessionModeToggle', () => {
  it('shows only the active mode until the menu is opened', () => {
    render(<SessionModeToggle mode="design" onChange={vi.fn()} />);

    expect(screen.getByTestId('session-mode-trigger').textContent).toContain('Design');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByTestId('session-mode-trigger'));

    expect(screen.getByRole('menuitemradio', { name: /Design mode/i }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: /Plan mode/i }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('menuitemradio', { name: /Ask mode/i }).getAttribute('aria-checked')).toBe('false');
  });

  it('switches into the lightweight Ask mode from the menu', () => {
    const onChange = vi.fn();
    render(<SessionModeToggle mode="design" onChange={onChange} />);

    fireEvent.click(screen.getByTestId('session-mode-trigger'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Ask mode/i }));

    expect(onChange).toHaveBeenCalledWith('chat');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('switches mode from the menu', () => {
    const onChange = vi.fn();
    render(<SessionModeToggle mode="design" onChange={onChange} />);

    fireEvent.click(screen.getByTestId('session-mode-trigger'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Plan mode/i }));

    expect(onChange).toHaveBeenCalledWith('plan');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('tags each mode with its expected usage/cost', () => {
    render(<SessionModeToggle mode="design" onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('session-mode-trigger'));

    // Every option in the menu carries a usage tier so modes can be compared.
    const menu = screen.getByRole('menu');
    expect(menu.textContent).toContain('Light');
    expect(menu.textContent).toContain('Standard');
    expect(menu.textContent).toContain('Heavy');

    // The description card explains the active mode's usage expectation.
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('Typical usage');
    expect(card.textContent).toContain('Generates files and multimodal media');
    expect(screen.getByRole('img', { name: 'Typical usage: Heavy' })).toBeTruthy();
  });

  it('shows localized guidance only after opening the menu', () => {
    render(
      <I18nProvider initial="en">
        <SessionModeToggle mode="plan" onChange={vi.fn()} />
      </I18nProvider>,
    );

    const trigger = screen.getByTestId('session-mode-trigger');
    fireEvent.pointerEnter(trigger);

    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip').textContent).toContain('Plan mode');
    expect(screen.getByRole('tooltip').textContent).toContain('Create a slide-by-slide PPT outline first.');

    const designOption = screen.getByRole('menuitemradio', { name: /Design mode/i });
    fireEvent.pointerEnter(designOption);

    const menu = screen.getByRole('menu');
    const card = screen.getByRole('tooltip');
    expect(menu.textContent).not.toContain(
      "For creating or changing concrete outputs: pages, prototypes, live artifacts, slides, images, videos, HyperFrames, audio, dashboards, and project files.",
    );
    expect(card.textContent).toContain(
      "For creating or changing concrete outputs: pages, prototypes, live artifacts, slides, images, videos, HyperFrames, audio, dashboards, and project files.",
    );
    expect(card.textContent).toContain('images, videos, HyperFrames, audio');
    expect(card.textContent).toContain("Generate image, video, and audio concepts for this campaign.");
  });
});
