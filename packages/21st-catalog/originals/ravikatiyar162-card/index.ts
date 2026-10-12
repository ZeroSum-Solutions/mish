/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<article class=\"collection panel stack\"><div class=\"art\"></div><div class=\"row between\"><span class=\"eyebrow\">Collection / 007</span><button data-action=\"save\" aria-pressed=\"false\">Save</button></div><h2>Coastal forms</h2><p class=\"muted\">A study in tides and silhouettes.</p><button data-action=\"details\" aria-expanded=\"false\">View collection notes</button><p class=\"notes\" hidden>Three code-native compositions, drawn with geometry and a sea-glass palette. No remote imagery.</p><p role=\"status\">Original collection card</p></article>", opts);
    s.on('click', e => { const a = action(e), b = (e.target as Element).closest('button')!; if (a === 'save') {
        const p = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(p));
        b.textContent = p ? 'Saved' : 'Save';
        s.status(p ? 'Collection saved locally' : 'Save removed');
    } if (a === 'details') {
        const n = s.query('.notes');
        n.hidden = !n.hidden;
        b.setAttribute('aria-expanded', String(!n.hidden));
    } });
    return { destroy: s.destroy };
}
