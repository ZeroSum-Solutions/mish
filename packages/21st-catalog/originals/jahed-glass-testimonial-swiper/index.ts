/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"testimonial panel\"><span class=\"eyebrow\">Studio voices / sample quotes</span><div class=\"quote-mark\">\u201c</div><h2 class=\"quote\">The details make the whole experience feel considered.</h2><div class=\"row\"><div class=\"avatar\">ML</div><div><strong class=\"speaker\">Morgan Lee</strong><p class=\"muted\">Sample persona</p></div></div></div><div class=\"row between\"><button data-action=\"back\" aria-label=\"Previous quote\">\u2190</button><p role=\"status\">Quote 1 of 3</p><button data-action=\"next\" aria-label=\"Next quote\">\u2192</button></div>", opts);
    let i = 0, start = 0;
    const quotes = ['The details make the whole experience feel considered.', 'A small interaction can change the mood of a product.', 'Clear choices. Beautiful rhythm. Nothing gets in the way.'];
    const names = ['Morgan Lee', 'Ellis Kim', 'Avery Chen'];
    function move(d: number) { i = (i + d + 3) % 3; s.query('.quote').textContent = quotes[i]!; s.query('.speaker').textContent = names[i]!; s.query('.avatar').textContent = names[i]!.split(' ').map(x => x[0]).join(''); s.status(`Quote ${i + 1} of 3`); }
    s.on('click', e => { if (action(e) === 'back')
        move(-1); if (action(e) === 'next')
        move(1); });
    s.on('keydown', e => { const k = (e as KeyboardEvent).key; if (k === 'ArrowRight')
        move(1); if (k === 'ArrowLeft')
        move(-1); });
    s.on('pointerdown', e => start = (e as PointerEvent).clientX);
    s.on('pointerup', e => { const d = (e as PointerEvent).clientX - start; if (Math.abs(d) > 50)
        move(d < 0 ? 1 : -1); });
    return { destroy: s.destroy };
}
