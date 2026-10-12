// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from '../../src/components/ui/SegmentedControl';

const preferences = vi.hoisted(() => ({ reduced: false }));
vi.mock('motion/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('motion/react')>(),
  useReducedMotion: () => preferences.reduced,
}));
afterEach(() => { cleanup(); preferences.reduced = false; });
const options = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;
describe('segmented selection', () => {
  it('exposes the selected theme with one tab stop and changes on arrow/Home/End keys', () => {
    const onValueChange = vi.fn();
    render(<SegmentedControl label="Theme" options={options} value="light" onValueChange={onValueChange} />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
    const light = screen.getByRole('radio', { name: 'Light' });
    expect(light.getAttribute('aria-checked')).toBe('true');
    expect(light.tabIndex).toBe(0);
    expect(screen.getByRole('radio', { name: 'Dark' }).tabIndex).toBe(-1);
    fireEvent.keyDown(light, { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenLastCalledWith('dark');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(onValueChange).toHaveBeenLastCalledWith('system');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(onValueChange).toHaveBeenLastCalledWith('dark');
  });
  it('uses a static selection surface when reduced motion is requested', () => {
    preferences.reduced = true;
    render(<SegmentedControl label="Theme" options={options} value="light" onValueChange={vi.fn()} />);
    const radio = screen.getByRole('radio', { name: 'Light' });
    expect(radio.querySelector('[data-selection-indicator="static"]')).toBeTruthy();
    expect(radio.querySelector('[data-selection-indicator="shared"]')).toBeNull();
  });
  it('skips disabled choices and supports pointer selection', () => {
    const onValueChange = vi.fn();
    render(<SegmentedControl label="Theme" options={[options[0], { ...options[1], disabled: true }, options[2]]} value="system" onValueChange={onValueChange} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'System' }), { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenLastCalledWith('dark');
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(onValueChange).toHaveBeenLastCalledWith('system');
  });
});
