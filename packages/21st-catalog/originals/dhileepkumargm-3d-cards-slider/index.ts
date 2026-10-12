/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<span class=\"eyebrow\">Depth deck / field collection</span><div class=\"depth-deck\"><div class=\"depth-card art\" style=\"--offset:0;filter:hue-rotate(0deg)\"><span>STUDY 01</span></div><div class=\"depth-card art\" style=\"--offset:1;filter:hue-rotate(55deg)\"><span>STUDY 02</span></div><div class=\"depth-card art\" style=\"--offset:2;filter:hue-rotate(110deg)\"><span>STUDY 03</span></div></div><div class=\"row between\"><button data-action=\"back\" aria-label=\"Previous card\">\u2190</button><p role=\"status\">Card 1 of 3</p><button data-action=\"next\" aria-label=\"Next card\">\u2192</button></div>", opts);
    let i = 0;
    function move(d: number) { i = (i + d + 3) % 3; el.querySelectorAll<HTMLElement>('.depth-card').forEach((n, j) => n.style.setProperty('--offset', String((j - i + 3) % 3))); s.status(`Card ${i + 1} of 3`); }
    s.on('click', e => { if (action(e) === 'next')
        move(1); if (action(e) === 'back')
        move(-1); });
    s.on('keydown', e => { const k = (e as KeyboardEvent).key; if (k === 'ArrowRight')
        move(1); if (k === 'ArrowLeft')
        move(-1); });
    return { destroy: s.destroy };
}
