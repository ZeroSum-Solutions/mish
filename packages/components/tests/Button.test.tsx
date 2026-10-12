// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Button } from '../src/button';

afterEach(() => {
  cleanup();
});

describe('Button', () => {
  it('renders a type=button by default so it never submits an enclosing form', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('button');
  });

  it('accepts the chat secondary variant and sm size without leaking legacy global classes', () => {
    render(
      <Button variant="secondary" size="sm">
        Retry
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Retry' });
    // Legacy compat classes (`primary`, `ghost`, `icon-btn`, …) are frozen; new
    // variants/sizes must not add to that surface.
    for (const legacy of ['primary', 'primary-ghost', 'ghost', 'subtle', 'icon-btn']) {
      expect(button.classList.contains(legacy)).toBe(false);
    }
  });

  it('keeps the caller className and disabled state', () => {
    render(
      <Button className="extra" disabled>
        Send
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(button.classList.contains('extra')).toBe(true);
    expect(button.disabled).toBe(true);
  });
});

describe('Button loading', () => {
  it('announces busy, keeps the label in the DOM for width, and swallows clicks', () => {
    let clicks = 0;
    render(
      <Button loading onClick={() => { clicks += 1; }}>
        Publish
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Publish' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    expect(clicks).toBe(0);
  });

  it('fires clicks again once loading clears', () => {
    let clicks = 0;
    const { rerender } = render(<Button loading onClick={() => { clicks += 1; }}>Go</Button>);
    rerender(<Button onClick={() => { clicks += 1; }}>Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button.hasAttribute('aria-busy')).toBe(false);
    button.click();
    expect(clicks).toBe(1);
  });
});

describe('Button loading inside a form', () => {
  it('does not submit the form while busy', () => {
    let submits = 0;
    render(
      <form onSubmit={(event) => { event.preventDefault(); submits += 1; }}>
        <Button type="submit" loading>Save</Button>
      </form>,
    );
    screen.getByRole('button', { name: 'Save' }).click();
    expect(submits).toBe(0);
  });
});
