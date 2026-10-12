/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"eyebrow\">A visual journal</div><h2>Collect moments.<br>Find your next direction.</h2><div class=\"image-stream\"><div class=\"stream-track\"><div class=\"art\" style=\"filter:hue-rotate(0deg)\"><span>FIELD 01</span></div><div class=\"art\" style=\"filter:hue-rotate(45deg)\"><span>FIELD 02</span></div><div class=\"art\" style=\"filter:hue-rotate(90deg)\"><span>FIELD 03</span></div><div class=\"art\" style=\"filter:hue-rotate(135deg)\"><span>FIELD 04</span></div><div class=\"art\" style=\"filter:hue-rotate(180deg)\"><span>FIELD 05</span></div><div class=\"art\" style=\"filter:hue-rotate(225deg)\"><span>FIELD 06</span></div></div></div><div class=\"row\"><button data-action=\"pause\">Pause stream</button><button data-action=\"reverse\">Reverse direction</button></div>", opts);
    s.on('click', e => { const a = action(e), track = s.query('.stream-track'); if (a === 'pause') {
        track.classList.toggle('paused');
        (e.target as HTMLElement).textContent = track.classList.contains('paused') ? 'Resume stream' : 'Pause stream';
    } if (a === 'reverse')
        track.style.animationDirection = track.style.animationDirection === 'alternate-reverse' ? 'alternate' : 'alternate-reverse'; });
    return { destroy: s.destroy };
}
