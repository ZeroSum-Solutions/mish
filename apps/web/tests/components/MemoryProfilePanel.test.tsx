// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryProfilePanel, profileOptionValue, splitProfileList } from '../../src/components/MemoryProfilePanel';
import { I18nProvider } from '../../src/i18n';

const STORED = [
  '- Role: Founder',
  '- Organization size: Small team (2-10)',
  '- Use cases: Landing pages, Brand films',
  '- Discovery source: A podcast',
].join('\n');

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

const show = () => render(<I18nProvider initial="en"><MemoryProfilePanel enabled /></I18nProvider>);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('MemoryProfilePanel', () => {
  it('drops the decorative emoji from option words and splits stored lists', () => {
    expect(profileOptionValue('🎨 Product design')).toBe('Product design');
    expect(profileOptionValue('▶️ YouTube')).toBe('YouTube');
    expect(profileOptionValue('Small team (2-10)')).toBe('Small team (2-10)');
    expect(splitProfileList('Landing pages, Design system;  Decks ')).toEqual(['Landing pages', 'Design system', 'Decks']);
  });

  it('renders list-backed fields as real choices and keeps values that are not options', async () => {
    stub(STORED);
    show();
    const orgSize = await screen.findByRole('combobox', { name: 'Organization size' }) as HTMLSelectElement;
    await waitFor(() => expect(orgSize.value).toBe('Small team (2-10)'));
    const source = screen.getByRole('combobox', { name: 'Where did you hear about us?' }) as HTMLSelectElement;
    expect(source.value).toBe('A podcast');

    const useCases = screen.getByRole('group', { name: 'Use case' });
    expect(within(useCases).getByRole('button', { name: 'Landing pages' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(useCases).getByRole('button', { name: 'Brand films' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(useCases).getByRole('button', { name: 'Design system' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('saves toggled use cases into the same `- Label: value` body', async () => {
    const puts = stub(STORED);
    show();
    const useCases = await screen.findByRole('group', { name: 'Use case' });
    await waitFor(() =>
      expect(within(useCases).getByRole('button', { name: 'Landing pages' }).getAttribute('aria-pressed')).toBe('true'),
    );
    fireEvent.click(within(useCases).getByRole('button', { name: 'Design system' }));
    fireEvent.click(within(useCases).getByRole('button', { name: 'Landing pages' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toBe([
      '- Role: Founder',
      '- Organization size: Small team (2-10)',
      '- Use cases: Brand films, Design system',
      '- Discovery source: A podcast',
    ].join('\n'));
  });
});
