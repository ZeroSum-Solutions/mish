// AC-R01.1: "Within guest websites, the guest's drop/upload handler wins by
// default; the visible workbench intake overlay target or Option-drop
// explicitly selects app intake." Host-renderer half of that arbitration.
import { describe, expect, it } from 'vitest';
import { createOptionDropMode } from '../../../src/runtime/intake/option-drop-mode';

function harness(guests = true) {
  let active = false; const events: string[] = [];
  const mode = createOptionDropMode({
    isActive: () => active,
    hasGuests: () => guests,
    enter: () => { active = true; events.push('enter'); },
    exit: () => { active = false; events.push('exit'); },
  });
  return { mode, events, isActive: () => active, setActive: (value: boolean) => { active = value; } };
}

describe('Option drop mode', () => {
  it('leaves a guest drop to the guest while neither the overlay nor Option applies', () => {
    const { mode, events, isActive } = harness();
    mode.dragOver(false); mode.leaveWindow();
    expect(events).toEqual([]); expect(isActive()).toBe(false);
  });

  it('shows the visible intake overlay while an external file drag holds Option, once', () => {
    const { mode, events } = harness();
    mode.dragOver(true); mode.dragOver(true); mode.dragOver(true);
    expect(events).toEqual(['enter']);
  });

  it('returns the drop to the guest when Option is released or the drag leaves the window', () => {
    const first = harness();
    first.mode.dragOver(true); first.mode.dragOver(false);
    expect(first.events).toEqual(['enter', 'exit']);
    const second = harness();
    second.mode.dragOver(true); second.mode.leaveWindow();
    expect(second.events).toEqual(['enter', 'exit']);
  });

  it('never closes an overlay the user opened with the drop-mode button', () => {
    const { mode, events, setActive } = harness();
    setActive(true);
    mode.dragOver(true); mode.dragOver(false); mode.leaveWindow();
    expect(events).toEqual([]);
  });

  it('forgets Option ownership once the overlay closes for any other reason', () => {
    const { mode, events, setActive } = harness();
    mode.dragOver(true); setActive(false); mode.closed();
    mode.dragOver(false); mode.leaveWindow();
    expect(events).toEqual(['enter']);
  });

  it('does nothing without guests: app DOM already receives the drop', () => {
    const { mode, events } = harness(false);
    mode.dragOver(true);
    expect(events).toEqual([]);
  });
});
