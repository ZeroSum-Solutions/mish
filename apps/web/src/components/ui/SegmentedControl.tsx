import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@mish/components';
import { SelectionGroup, SelectionIndicator } from './SelectionIndicator';
import styles from './segmented-control.module.css';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}
export interface SegmentedControlProps<T extends string> {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
}

/** Roving radio focus and shared selection motion for compact choices. */
export function SegmentedControl<T extends string>({ label, options, value, onValueChange, className }: SegmentedControlProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const tabIndex = selectedIndex >= 0 ? selectedIndex : enabled[0];
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !enabled.length) return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const backward = event.key === 'ArrowUp' || event.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
    const position = enabled.indexOf(index);
    const target = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled[enabled.length - 1]
      : enabled[(position + (backward ? -1 : 1) + enabled.length) % enabled.length];
    if (target === undefined) return;
    buttons.current[target]?.focus();
    onValueChange(options[target]!.value);
  }
  return (
    <SelectionGroup>
      <div className={[styles.group, className].filter(Boolean).join(' ')} role="radiogroup" aria-label={label}>
        {options.map((option, index) => (
          <Button
            key={option.value}
            variant="ghost"
            className={styles.option}
            ref={(node) => { buttons.current[index] = node; }}
            role="radio"
            aria-checked={value === option.value}
            tabIndex={index === tabIndex ? 0 : -1}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <SelectionIndicator active={value === option.value} />
            {option.label}
          </Button>
        ))}
      </div>
    </SelectionGroup>
  );
}
