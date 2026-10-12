// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Badge, Chip, IconButton, Spinner, Surface } from '../src';

afterEach(() => {
  cleanup();
});

describe('IconButton', () => {
  it('requires a label and exposes it as the accessible name and tooltip', () => {
    render(<IconButton label="Close panel"><svg /></IconButton>);
    const button = screen.getByRole('button', { name: 'Close panel' });
    expect(button.getAttribute('title')).toBe('Close panel');
    expect(button.getAttribute('type')).toBe('button');
  });

  it('reflects toggle state through aria-pressed', () => {
    render(<IconButton label="Pin" pressed><svg /></IconButton>);
    expect(screen.getByRole('button', { name: 'Pin' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Chip', () => {
  it('is a pressed toggle when selected and a plain button otherwise', () => {
    render(
      <>
        <Chip selected>All</Chip>
        <Chip>Commerce</Chip>
      </>,
    );
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Commerce' }).hasAttribute('aria-pressed')).toBe(false);
  });

  it('hides its decorative icon from assistive tech', () => {
    render(<Chip icon={<svg data-testid="glyph" />}>Prototype</Chip>);
    expect(screen.getByTestId('glyph').parentElement?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Surface', () => {
  it('defaults to a solid, elevation-1 container and forwards attributes', () => {
    render(<Surface data-testid="card">Body</Surface>);
    const card = screen.getByTestId('card');
    expect(card.getAttribute('data-elevation')).toBe('1');
    expect(card.textContent).toBe('Body');
  });

  it('carries the requested elevation tier', () => {
    render(<Surface data-testid="menu" variant="glass" elevation={3} />);
    expect(screen.getByTestId('menu').getAttribute('data-elevation')).toBe('3');
  });
});

describe('Surface interactive', () => {
  it('is a focusable button that activates with Enter and Space', () => {
    let clicks = 0;
    render(<Surface interactive onClick={() => { clicks += 1; }}>Open project</Surface>);
    const card = screen.getByRole('button', { name: 'Open project' });
    expect(card.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyUp(card, { key: ' ' });
    expect(clicks).toBe(2);
  });

  it('keeps a caller-provided role and stays inert when not interactive', () => {
    render(
      <>
        <Surface interactive role="link" data-testid="link">Docs</Surface>
        <Surface data-testid="static">Static</Surface>
      </>,
    );
    expect(screen.getByTestId('link').getAttribute('role')).toBe('link');
    expect(screen.getByTestId('static').hasAttribute('tabindex')).toBe(false);
  });
});

describe('Sol review regressions', () => {
  const srcDir2 = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const rule = (file: string, selector: string) => {
    const source = readFileSync(join(srcDir2, file), 'utf8');
    const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(source);
    return match?.[1] ?? '';
  };

  it('keeps a loading button label in the accessibility tree (no visibility:hidden / display:none)', () => {
    const body = rule('button.module.css', '.loadingLabel');
    expect(body, '.loadingLabel rule missing').not.toBe('');
    expect(body).not.toMatch(/visibility:\s*hidden/);
    expect(body).not.toMatch(/display:\s*none/);
    expect(body).toMatch(/opacity:\s*0/);
  });

  it('activates an interactive Surface once per Space press, not per auto-repeat', () => {
    let clicks = 0;
    render(<Surface interactive onClick={() => { clicks += 1; }}>Card</Surface>);
    const card = screen.getByRole('button', { name: 'Card' });
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyDown(card, { key: ' ', repeat: true });
    fireEvent.keyDown(card, { key: ' ', repeat: true });
    expect(clicks).toBe(0);
    fireEvent.keyUp(card, { key: ' ' });
    expect(clicks).toBe(1);
    fireEvent.keyDown(card, { key: 'Enter', repeat: true });
    expect(clicks).toBe(1);
  });

  it('stops the spinner rotating under reduced motion', () => {
    const source = readFileSync(join(srcDir2, 'spinner.module.css'), 'utf8');
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/.exec(source)?.[1] ?? '';
    expect(reduced).toMatch(/animation:\s*none/);
  });
});

describe('Chip toggle group', () => {
  it('announces aria-pressed=false on unselected toggle chips', () => {
    render(<Chip selected={false}>Commerce</Chip>);
    expect(screen.getByRole('button', { name: 'Commerce' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Badge and Spinner', () => {
  it('renders badge text with an optional dot', () => {
    render(<Badge tone="success" dot>Live</Badge>);
    expect(screen.getByText('Live')).toBeTruthy();
  });

  it('announces a spinner only when it has a label', () => {
    const { container } = render(<Spinner />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    cleanup();
    render(<Spinner label="Loading files" />);
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy();
  });
});

describe('spring-loaded interaction contract', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const css = (name: string) => readFileSync(join(srcDir, name), 'utf8');

  it.each(['button.module.css', 'icon-button.module.css', 'chip.module.css'])(
    '%s presses with a scale and releases on the snappy spring',
    (file) => {
      const source = css(file);
      expect(source).toMatch(/:active:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(var\(--press-scale/);
      expect(source).toMatch(/transform var\(--spring-snappy-duration[^)]*\) var\(--spring-snappy/);
    },
  );

  it.each(['button.module.css', 'icon-button.module.css', 'chip.module.css', 'surface.module.css'])(
    '%s draws focus with the shared focus ring',
    (file) => {
      expect(css(file)).toMatch(/:focus-visible\s*\{[^}]*outline:\s*var\(--focus-outline/);
    },
  );
});
