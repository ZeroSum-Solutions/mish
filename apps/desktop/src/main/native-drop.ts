/**
 * Native OS file-drop navigation guard for the desktop shell (AC-R01.1).
 *
 * Invariant: an OS file drop over app DOM is claimed once, by the renderer's
 * drop coordinator. A drop nobody claimed reaches Electron as a `file:`
 * navigation of the main window; the window refuses it, so the user never
 * navigates away and the drop never takes a second route into intake.
 *
 * Guest websites need no counterpart: the embedded-browser allowlist already
 * refuses `file:` for guests, and the host never intercepts a guest's drop.
 *
 * Pure: no Electron imports.
 */
export function isNativeFileDropNavigation(url: string): boolean {
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

/**
 * The main window's `will-navigate` guard. Returns true when it refused the
 * navigation, so the caller stops applying later rules.
 */
export function refuseNativeFileDropNavigation(event: { preventDefault(): void }, url: string): boolean {
  if (!isNativeFileDropNavigation(url)) return false;
  event.preventDefault();
  return true;
}
