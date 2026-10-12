// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { beginGuestDropMode } from '../../../src/runtime/intake/guest-drop-mode';
afterEach(() => { document.body.replaceChildren(); });
it('preserves the same connected guest, src, partition, display and unrelated styles through restore', async () => {
 const guest = document.createElement('webview'); guest.setAttribute('src', 'https://example.test/input'); guest.setAttribute('partition', 'persist:design-browser'); guest.style.cssText = 'display: flex; width: 600px; visibility: visible !important; pointer-events: auto';
 const reload = vi.fn(); Object.assign(guest, { reload, loadURL: reload, clearData: reload });
 const button = document.createElement('button'); document.body.append(guest, button); button.focus();
 const restore = beginGuestDropMode(document); expect(guest.style.visibility).toBe('hidden'); expect(guest.style.pointerEvents).toBe('none'); expect(guest.isConnected).toBe(true); expect(guest.style.display).toBe('flex');
 guest.style.height = '400px'; const newFrame = document.createElement('iframe'); document.body.append(newFrame); await Promise.resolve(); expect(newFrame.style.visibility).toBe('hidden');
 restore(); restore();
 expect(document.querySelector('webview')).toBe(guest); expect(guest.getAttribute('src')).toBe('https://example.test/input'); expect(guest.getAttribute('partition')).toBe('persist:design-browser'); expect(guest.style.getPropertyPriority('visibility')).toBe('important'); expect(guest.style.visibility).toBe('visible'); expect(guest.style.pointerEvents).toBe('auto'); expect(guest.style.height).toBe('400px'); expect(newFrame.hasAttribute('style')).toBe(false); expect(document.activeElement).toBe(button); expect(reload).not.toHaveBeenCalled();
});

it('keeps existing guests suppressed after pooled style refreshes without replacing their restore snapshot', async () => {
 const frame = document.createElement('iframe'); frame.src = 'about:blank';
 frame.style.cssText = 'visibility: visible !important; pointer-events: auto; width: 600px';
 const guest = document.createElement('webview'); guest.setAttribute('partition', 'persist:design-browser');
 document.body.append(frame, guest); const parent = frame.parentNode; const frameWindow = frame.contentWindow;
 const restore = beginGuestDropMode(document);
 // PooledIframe.syncStyle writes properties again on later layout commits.
 frame.style.removeProperty('visibility'); frame.style.setProperty('pointer-events', 'auto'); frame.style.height = '400px';
 guest.removeAttribute('style');
 await vi.waitFor(() => {
  for (const node of [frame, guest]) {
   expect(node.style.visibility).toBe('hidden'); expect(node.style.pointerEvents).toBe('none');
   expect(node.style.getPropertyPriority('visibility')).toBe('important');
  }
 });
 frame.style.setProperty('visibility', 'visible', 'important');
 await vi.waitFor(() => expect(frame.style.visibility).toBe('hidden'));
 restore();
 expect(frame.parentNode).toBe(parent); expect(frame.contentWindow).toBe(frameWindow);
 expect(frame.style.visibility).toBe('visible'); expect(frame.style.getPropertyPriority('visibility')).toBe('important');
 expect(frame.style.pointerEvents).toBe('auto'); expect(frame.style.width).toBe('600px'); expect(frame.style.height).toBe('400px');
 expect(guest.hasAttribute('style')).toBe(false); expect(guest.getAttribute('partition')).toBe('persist:design-browser');
});

// AC-R01.1 scopes Option-drop arbitration to guest websites. App-owned previews
// (FileViewer, pooled iframes) are not guests and must not open the overlay.
it('counts only Design Browser guests as guest surfaces, never app-owned preview iframes', async () => {
 const { hasGuestSurfaces } = await import('../../../src/runtime/intake/guest-drop-mode');
 const preview = document.createElement('iframe'); preview.title = 'Preview'; document.body.append(preview);
 expect(hasGuestSurfaces(document)).toBe(false);
 const fallback = document.createElement('div'); fallback.className = 'db-fallback'; fallback.append(document.createElement('iframe')); document.body.append(fallback);
 expect(hasGuestSurfaces(document)).toBe(true);
 fallback.remove(); document.body.append(document.createElement('webview'));
 expect(hasGuestSurfaces(document)).toBe(true);
});
