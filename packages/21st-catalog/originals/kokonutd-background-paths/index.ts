/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"contour-field\"><svg viewBox=\"0 0 500 250\" aria-hidden=\"true\"><path d=\"M-40 30 C140 220 200 -80 540 70\" style=\"--delay:0.0s\"/><path d=\"M-40 44 C140 210 200 -63 540 86\" style=\"--delay:0.15s\"/><path d=\"M-40 58 C140 200 200 -46 540 102\" style=\"--delay:0.3s\"/><path d=\"M-40 72 C140 190 200 -29 540 118\" style=\"--delay:0.44999999999999996s\"/><path d=\"M-40 86 C140 180 200 -12 540 134\" style=\"--delay:0.6s\"/><path d=\"M-40 100 C140 170 200 5 540 150\" style=\"--delay:0.75s\"/><path d=\"M-40 114 C140 160 200 22 540 166\" style=\"--delay:0.8999999999999999s\"/><path d=\"M-40 128 C140 150 200 39 540 182\" style=\"--delay:1.05s\"/><path d=\"M-40 142 C140 140 200 56 540 198\" style=\"--delay:1.2s\"/><path d=\"M-40 156 C140 130 200 73 540 214\" style=\"--delay:1.3499999999999999s\"/><path d=\"M-40 170 C140 120 200 90 540 230\" style=\"--delay:1.5s\"/><path d=\"M-40 184 C140 110 200 107 540 246\" style=\"--delay:1.65s\"/></svg><div class=\"contour-copy\"><span class=\"eyebrow\">Beyond the straight line</span><h2>Follow a different path.</h2><button data-action=\"pause\">Pause paths</button></div></div><label class=\"row\">Density <input aria-label=\"Path density\" type=\"range\" min=\"3\" max=\"12\" value=\"12\"></label>", opts);
    s.on('click', e => { if (action(e) === 'pause') {
        const p = s.query('.contour-field').classList.toggle('paused');
        (e.target as HTMLElement).textContent = p ? 'Resume paths' : 'Pause paths';
    } });
    s.on('input', e => el.querySelectorAll<SVGElement>('path').forEach((p, i) => p.style.display = i < Number((e.target as HTMLInputElement).value) ? '' : 'none'));
    return { destroy: s.destroy };
}
