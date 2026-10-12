/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"offer panel\"><span class=\"eyebrow\">Weekend editions</span><h2 class=\"offer-name\">Make room for better ideas.</h2><p class=\"offer-desc\">Studio tools \u00b7 20% sample offer</p><div class=\"offer-number\">20<span>%</span></div><button class=\"primary\" data-action=\"apply\">Apply sample offer</button></div><div class=\"row between\"><button data-action=\"back\" aria-label=\"Previous offer\">\u2190</button><p role=\"status\">Offer 1 of 3</p><button data-action=\"next\" aria-label=\"Next offer\">\u2192</button></div>", opts);
    let i = 0;
    function render() { s.query('.offer-name').textContent = ['Make room for better ideas.', 'A fresh start for your studio.', 'Gather your next collection.'][i]!; s.query('.offer-desc').textContent = ['Studio tools · 20% sample offer', 'Annual plan · 30% sample offer', 'Asset pack · 15% sample offer'][i]!; s.query('.offer-number').innerHTML = [20, 30, 15][i] + '<span>%</span>'; s.status(`Offer ${i + 1} of 3`); }
    s.on('click', e => { const a = action(e); if (a === 'apply')
        s.status(`Sample offer ${i + 1} applied locally · no purchase`); if (a === 'next' || a === 'back') {
        i = (i + (a === 'next' ? 1 : 2)) % 3;
        render();
    } });
    return { destroy: s.destroy };
}
