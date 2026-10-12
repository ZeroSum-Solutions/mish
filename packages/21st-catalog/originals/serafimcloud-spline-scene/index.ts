/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"scene\"><div class=\"cube\"><i>01</i><i>02</i><i>03</i><i>04</i><i>05</i><i>06</i></div></div><div class=\"row between\"><h3>Object / One</h3><small>Local spatial alternative</small></div><label class=\"row\">Orbit <input type=\"range\" min=\"0\" max=\"360\" value=\"30\" aria-label=\"Object rotation\"></label>", opts);
    s.on('input', e => s.query('.cube').style.setProperty('--orbit', `${(e.target as HTMLInputElement).value}deg`));
    return { destroy: s.destroy };
}
