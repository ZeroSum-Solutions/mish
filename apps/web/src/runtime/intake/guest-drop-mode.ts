/** DOM-only candidate. Physical Electron/Finder hit-testing is a separate gate. */
export function beginGuestDropMode(root: Document): (restoreFocus?: boolean) => void {
 const focused = root.activeElement instanceof HTMLElement ? root.activeElement : null;
 const originals = new Map<HTMLElement, { visibility: string; visibilityPriority: string; pointerEvents: string; pointerPriority: string; hadStyle: boolean }>();
 const hide = () => {
  for (const element of root.querySelectorAll<HTMLElement>('webview, iframe')) {
   if (!originals.has(element)) originals.set(element, { visibility: element.style.getPropertyValue('visibility'), visibilityPriority: element.style.getPropertyPriority('visibility'), pointerEvents: element.style.getPropertyValue('pointer-events'), pointerPriority: element.style.getPropertyPriority('pointer-events'), hadStyle: element.hasAttribute('style') });
   // Pooled previews reapply styles on later layout commits. Preserve the first
   // restore snapshot, and only write changed properties so observation settles.
   if (element.style.visibility !== 'hidden' || element.style.getPropertyPriority('visibility') !== 'important') element.style.setProperty('visibility', 'hidden', 'important');
   if (element.style.pointerEvents !== 'none' || element.style.getPropertyPriority('pointer-events') !== 'important') element.style.setProperty('pointer-events', 'none', 'important');
  }
 };
 hide(); const observer = new MutationObserver(records => {
  if (records.some(record => record.type === 'childList' || (record.target instanceof HTMLElement && record.target.matches('webview, iframe')))) hide();
 });
 observer.observe(root.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
 let restored = false;
 return (restoreFocus = true) => {
  if (restored) return; restored = true; observer.disconnect();
  for (const [element, previous] of originals) {
   if (previous.visibility) element.style.setProperty('visibility', previous.visibility, previous.visibilityPriority); else element.style.removeProperty('visibility');
   if (previous.pointerEvents) element.style.setProperty('pointer-events', previous.pointerEvents, previous.pointerPriority); else element.style.removeProperty('pointer-events');
   if (!previous.hadStyle && !element.style.cssText) element.removeAttribute('style');
  }
  if (restoreFocus && focused?.isConnected) focused.focus({ preventScroll: true });
 };
}

/**
 * Guest websites are the Design Browser's guests only: its desktop `<webview>`
 * and its web-build fallback frame (`DesignBrowserPanel`'s `.db-fallback`).
 * App-owned previews (FileViewer, pooled iframes) are not guests, so they never
 * trigger Option-drag arbitration (AC-R01.1).
 */
export const GUEST_SURFACE_SELECTOR = 'webview, .db-fallback > iframe';
export function hasGuestSurfaces(root: ParentNode): boolean {
 return root.querySelector(GUEST_SURFACE_SELECTOR) != null;
}
