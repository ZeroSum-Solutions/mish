/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"portfolio panel\"><div class=\"row\"><div class=\"avatar\">EK</div><div><span class=\"eyebrow\">Independent designer</span><h2>Ellis Kim</h2></div></div><p>Interfaces with rhythm, clarity, and a little surprise.</p><div class=\"row\"><button data-action=\"all\" aria-pressed=\"true\">All</button><button data-action=\"product\">Product</button><button data-action=\"brand\">Brand</button></div><div class=\"projects\"><div class=\"art\" data-kind=\"product\"><span>Orbit / Product</span></div><div class=\"art\" data-kind=\"brand\"><span>Archive / Brand</span></div></div><p role=\"status\">2 projects</p></div>", opts);
    s.on('click', e => { const a = action(e); if (!['all', 'product', 'brand'].includes(a ?? ''))
        return; el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.action === a))); el.querySelectorAll<HTMLElement>('[data-kind]').forEach(p => p.hidden = a !== 'all' && p.dataset.kind !== a); s.status(a === 'all' ? '2 projects' : `1 ${a} project`); });
    return { destroy: s.destroy };
}
