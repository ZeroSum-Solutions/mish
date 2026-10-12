/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"row between\"><span class=\"eyebrow\">Inspection lane</span><span class=\"muted\">03 objects</span></div><div class=\"scanner\"><div class=\"scan-beam\"></div><div class=\"scan-ticket\"><small>OBJECT / 01</small><strong>Aurora</strong><span>\u25a5 \u25a5 \u25a5 \u25a5 \u25a5</span></div><div class=\"scan-ticket\"><small>OBJECT / 02</small><strong>Meridian</strong><span>\u25a5 \u25a5 \u25a5 \u25a5 \u25a5</span></div><div class=\"scan-ticket\"><small>OBJECT / 03</small><strong>Orbit</strong><span>\u25a5 \u25a5 \u25a5 \u25a5 \u25a5</span></div></div><button data-action=\"scan\">Pause scanner</button><p role=\"status\">Scanning sample objects</p>", opts);
    s.on('click', e => { if (action(e) === 'scan') {
        const p = s.query('.scanner').classList.toggle('paused');
        (e.target as HTMLElement).textContent = p ? 'Resume scanner' : 'Pause scanner';
        s.status(p ? 'Sample scanner paused' : 'Scanning sample objects');
    } });
    return { destroy: s.destroy };
}
