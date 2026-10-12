/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"phosphor\"><div class=\"eyebrow\">30 Hz / Signal Lab</div><div class=\"signal\">READY_</div><div class=\"scan-lines\"></div><small>LOCAL DISPLAY \u00b7 NO NETWORK</small></div><label class=\"row\">Intensity <input type=\"range\" min=\"20\" max=\"100\" value=\"80\" aria-label=\"Phosphor intensity\"></label><button data-action=\"signal\">Change signal</button>", opts);
    let i = 0;
    s.on('input', e => s.query('.phosphor').style.setProperty('--intensity', String(Number((e.target as HTMLInputElement).value) / 100)));
    s.on('click', e => { if (action(e) === 'signal')
        s.query('.signal').textContent = ['READY_', 'SYNCED_', 'ONLINE_'][++i % 3]!; });
    return { destroy: s.destroy };
}
