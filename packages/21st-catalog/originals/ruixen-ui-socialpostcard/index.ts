/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<article class=\"social panel stack\"><div class=\"row\"><div class=\"avatar\">AC</div><div><strong>Avery Chen</strong><p class=\"muted\">@avery \u00b7 Sample post</p></div></div><p>Spent the morning exploring light, shape, and the space between. Here is study number seven.</p><div class=\"art\"></div><div class=\"row between\"><button data-action=\"like\" aria-pressed=\"false\">\u2661 <span class=\"likes\">128</span></button><button data-action=\"save\" aria-pressed=\"false\">Save</button></div><p role=\"status\">Sample social post</p></article>", opts);
    s.on('click', e => { const a = action(e); if (a !== 'like' && a !== 'save')
        return; const b = (e.target as Element).closest('button')!, p = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(p)); if (a === 'like') {
        s.query('.likes').textContent = p ? '129' : '128';
        s.status(p ? 'Liked locally' : 'Like removed');
    }
    else {
        b.textContent = p ? 'Saved' : 'Save';
        s.status(p ? 'Saved locally' : 'Save removed');
    } });
    return { destroy: s.destroy };
}
