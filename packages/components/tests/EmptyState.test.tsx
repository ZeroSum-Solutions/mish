// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmptyState } from '../src';

afterEach(() => {
  cleanup();
});

describe('EmptyState', () => {
  it('shows the title, the sentence and the one action', () => {
    const onClear = vi.fn();
    render(
      <EmptyState
        data-testid="empty"
        role="status"
        icon={<svg data-testid="glyph" />}
        title="Nothing matches"
        description="Try a different filter."
        action={<button type="button" onClick={onClear}>Clear filters</button>}
      />,
    );
    const root = screen.getByTestId('empty');
    expect(root.getAttribute('role')).toBe('status');
    expect(screen.getByText('Nothing matches')).toBeTruthy();
    expect(screen.getByText('Try a different filter.')).toBeTruthy();
    expect(screen.getByTestId('glyph').parentElement?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('omits the optional parts and switches chrome by variant', () => {
    const { container, rerender } = render(<EmptyState title="Empty" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.querySelectorAll('p')).toHaveLength(1);
    expect(root.querySelector('button')).toBeNull();
    const panelClass = root.className;
    rerender(<EmptyState title="Empty" variant="plain" />);
    expect((container.firstElementChild as HTMLElement).className).not.toBe(panelClass);
  });
});
