/**
 * Option-drag selection of app intake over guest websites (AC-R01.1).
 *
 * A drop over a guest website belongs to the guest unless the visible intake
 * overlay is open. An external file drag that holds Option over app DOM opens
 * that overlay (which hides guests so the drop lands on the app); releasing
 * Option or leaving the window hands the drop back to the guest. An overlay the
 * user opened with the drop-mode button is never closed by this.
 */
export function createOptionDropMode(controls: { isActive(): boolean; hasGuests(): boolean; enter(): void; exit(): void }) {
  let ownedByOption = false;
  const release = () => { if (!ownedByOption) return; ownedByOption = false; controls.exit(); };
  return {
    dragOver(optionHeld: boolean): void {
      if (!optionHeld) { release(); return; }
      if (controls.isActive() || !controls.hasGuests()) return;
      ownedByOption = true; controls.enter();
    },
    leaveWindow: release,
    /** The overlay closed for another reason (drop, Escape, cancel, navigation). */
    closed(): void { ownedByOption = false; },
  };
}
