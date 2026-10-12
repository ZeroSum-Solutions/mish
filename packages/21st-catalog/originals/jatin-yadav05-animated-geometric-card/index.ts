/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"geometry panel\" tabindex=\"0\" aria-label=\"Interactive orbital card\"><span class=\"eyebrow\">FORM / 03</span><div class=\"geometry-stage\"><i class=\"orbit\"></i><i class=\"prism\"></i><i class=\"sphere\"></i><i class=\"particle p1\"></i><i class=\"particle p2\"></i><i class=\"particle p3\"></i></div><div class=\"row between\"><div><h2>Shape the unexpected.</h2><small>Move, focus, or change the palette.</small></div><button data-action=\"palette\">Change palette</button></div></div>", opts);
    let warm = false;
    s.on('click', e => { if (action(e) === 'palette') {
        warm = !warm;
        s.query('.geometry').style.setProperty('--geo', warm ? '#ffbe82' : '#7edfcc');
    } });
    s.on('pointermove', e => { if (s.reducedMotion)
        return; const p = e as PointerEvent; const b = el.getBoundingClientRect(); s.query('.geometry-stage').style.setProperty('--ry', `${(p.clientX - b.left - b.width / 2) / 25}deg`); s.query('.geometry-stage').style.setProperty('--rx', `${-(p.clientY - b.top - b.height / 2) / 25}deg`); });
    s.on('pointerleave', () => { s.query('.geometry-stage').style.removeProperty('--rx'); s.query('.geometry-stage').style.removeProperty('--ry'); });
    return { destroy: s.destroy };
}
