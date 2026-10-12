/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"row between\"><h3>Chromatic atlas</h3><small>3 studies</small></div><div class=\"hover-gallery\"><button class=\"art\" style=\"filter:hue-rotate(0deg)\" data-action=\"art-0\" aria-label=\"Expand study 1\"><span>01</span></button><button class=\"art\" style=\"filter:hue-rotate(90deg)\" data-action=\"art-1\" aria-label=\"Expand study 2\"><span>02</span></button><button class=\"art\" style=\"filter:hue-rotate(180deg)\" data-action=\"art-2\" aria-label=\"Expand study 3\"><span>03</span></button></div><p role=\"status\">Select a study to hold it open.</p>", opts);
    s.on('click', e => { const a = action(e); if (a?.startsWith('art-')) {
        el.querySelectorAll('[data-action]').forEach(n => n.setAttribute('aria-pressed', String((n as HTMLElement).dataset.action === a)));
        s.status(`Study ${Number(a.slice(4)) + 1} selected`);
    } });
    return { destroy: s.destroy };
}
