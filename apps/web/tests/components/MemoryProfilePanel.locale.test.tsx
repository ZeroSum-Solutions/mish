// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryProfilePanel } from '../../src/components/MemoryProfilePanel';
import { I18nProvider, useI18n } from '../../src/i18n';
import type { Locale } from '../../src/i18n/types';

// Choice fields store a locale-independent value, so switching the UI language
// never strands a stale translated value or shows the same choice twice.

function stub(body: string) {
  const puts: Array<{ body: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)) as { body: string });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ entry: { body } }) };
  }));
  return puts;
}

let switchLocale: (next: Locale) => void = () => {};
function LocaleSwitch() {
  switchLocale = useI18n().setLocale;
  return null;
}

function show(initial: Locale) {
  return render(
    <I18nProvider initial={initial}>
      <LocaleSwitch />
      <MemoryProfilePanel enabled />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MemoryProfilePanel choice values across locales', () => {
  it('keeps one selected choice per option and saves stable values after reapplying the English locale', async () => {
    const puts = stub('- Organization size: Small team (2-10)\n- Use cases: Landing pages');
    show('en');
    const orgSize = (await screen.findByRole('combobox', { name: 'Organization size' })) as HTMLSelectElement;
    await waitFor(() => expect(orgSize.selectedOptions[0]?.textContent).toBe('Small team (2-10)'));

    act(() => switchLocale("en"));

    const orgSizeEs = screen.getByRole('combobox', { name: "Organization size" }) as HTMLSelectElement;
    expect(orgSizeEs.selectedOptions[0]?.textContent).toBe("Small team (2-10)");
    // No stale English value lingers as an extra "custom" option.
    expect(Array.from(orgSize.options).filter((option) => option.textContent === 'Small team (2-10)')).toHaveLength(1);

    const useCases = screen.getByRole('group', { name: "Use case" });
    expect(within(useCases).getByRole('button', { name: 'Landing pages' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(useCases).getAllByRole('button', { name: 'Landing pages' })).toHaveLength(1);

    fireEvent.click(within(useCases).getByRole('button', { name: "Design system" }));
    fireEvent.click(screen.getByRole('button', { name: "Save profile" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toBe([
      '- Organization size: Small team (2-10)',
      '- Use cases: Landing pages, Design system',
    ].join('\n'));
  });

  it('reads English values back to their options and keeps unknown values as custom', async () => {
    const puts = stub([
      '- Organization size: Small team (2-10)',
      '- Use cases: Landing pages, Brand films',
    ].join('\n'));
    show('en');
    const orgSize = (await screen.findByRole('combobox', { name: 'Organization size' })) as HTMLSelectElement;
    await waitFor(() => expect(orgSize.selectedOptions[0]?.textContent).toBe('Small team (2-10)'));
    expect(Array.from(orgSize.options).filter((option) => option.textContent === 'Small team (2-10)')).toHaveLength(1);

    const useCases = screen.getByRole('group', { name: 'Use case' });
    expect(within(useCases).getByRole('button', { name: 'Landing pages' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(useCases).getByRole('button', { name: 'Brand films' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(useCases).getAllByRole('button', { name: 'Landing pages' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toBe([
      '- Organization size: Small team (2-10)',
      '- Use cases: Landing pages, Brand films',
    ].join('\n'));
  });
});
