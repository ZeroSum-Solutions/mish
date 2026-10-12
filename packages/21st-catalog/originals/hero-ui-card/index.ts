/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<article class=\"destination panel stack\"><div class=\"art\"><span>THE NORTH SHORE</span></div><div class=\"row between\"><h2>Seabrook house</h2><span>\u2605 4.9</span></div><p class=\"muted\">A sample stay beside the water.</p><div class=\"row\"><label>Guests <select aria-label=\"Guest count\"><option>1 guest</option><option>2 guests</option><option>3 guests</option></select></label><button data-action=\"reserve\" class=\"primary\">Check sample stay</button></div><p role=\"status\">$180 / night \u00b7 fictional listing</p></article>", opts);
    s.on('click', e => { if (action(e) === 'reserve')
        s.status(`Sample availability for ${s.query<HTMLSelectElement>('select').value} · no booking created`); });
    return { destroy: s.destroy };
}
