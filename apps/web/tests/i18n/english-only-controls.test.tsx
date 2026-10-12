// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { LanguageMenu } from '../../src/components/LanguageMenu';
import { EntrySettingsMenu } from '../../src/components/EntrySettingsMenu';
import type { AppConfig } from '../../src/types';

const config = { mode: 'daemon', agentId: 'codex' } as AppConfig;

afterEach(cleanup);

describe('English-only language controls', () => {
  it('hides the standalone language menu', () => {
    const { container } = render(<I18nProvider initial="en"><LanguageMenu /></I18nProvider>);
    expect(container.innerHTML).toBe('');
  });

  it('keeps entry settings available without a language picker', () => {
    render(<I18nProvider initial="en"><EntrySettingsMenu config={config} onOpenSettings={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('entry-settings-menu')).toBeTruthy();
    expect(screen.queryByText('Language')).toBeNull();
    expect(screen.queryByRole('menuitemradio')).toBeNull();
  });
});
