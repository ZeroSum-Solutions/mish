// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisclosureRow } from '../src';

afterEach(() => {
  cleanup();
});

describe('DisclosureRow', () => {
  it('shows title, status and action at a glance and keeps details collapsed', () => {
    render(
      <DisclosureRow
        title="HiggsField"
        description="Image generation"
        status={<span>Connected</span>}
        actions={<button type="button">Connect</button>}
        detailsLabel="HiggsField details"
      >
        <p>Long explanatory copy</p>
      </DisclosureRow>,
    );
    expect(screen.getByText('HiggsField')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'HiggsField details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(region?.getAttribute('aria-hidden')).toBe('true');
  });

  it('expands from the toggle and from a click on empty row space, but not from its own actions', () => {
    const onOpenChange = vi.fn();
    render(
      <DisclosureRow
        title="DeepSeek"
        actions={<button type="button">Save</button>}
        detailsLabel="DeepSeek details"
        onOpenChange={onOpenChange}
      >
        <p>Details</p>
      </DisclosureRow>,
    );
    const toggle = screen.getByRole('button', { name: 'DeepSeek details' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'DeepSeek' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByText('DeepSeek'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(onOpenChange.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it('renders no toggle when there are no details', () => {
    render(<DisclosureRow title="Plain row" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
