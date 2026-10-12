/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"row\"><div class=\"coach-avatar\">EK</div><div><h3>Ellis Kim</h3><p class=\"muted\">Creative coaching \u00b7 sample</p></div></div><div class=\"row between\"><h2>Make space to think.</h2><small>30 min</small></div><div class=\"dates\"><button data-action=\"day-0\" aria-pressed=\"true\"><small>MON</small><strong>14</strong></button><button data-action=\"day-1\" aria-pressed=\"false\"><small>TUE</small><strong>15</strong></button><button data-action=\"day-2\" aria-pressed=\"false\"><small>WED</small><strong>16</strong></button></div><div class=\"row slots\"><button data-action=\"09:00\" aria-pressed=\"true\">09:00</button><button data-action=\"10:30\">10:30</button><button data-action=\"14:00\">14:00</button></div><button data-action=\"confirm\" class=\"primary\">Confirm sample session</button><p role=\"status\">September 14 \u00b7 09:00 selected \u00b7 sample timezone UTC</p>", opts);
    let day = 14, time = '09:00';
    s.on('click', e => { const a = action(e); if (a === 'confirm') {
        s.status(`Sample session confirmed: September ${day}, ${time} UTC · no booking created`);
        return;
    } if (a?.startsWith('day-')) {
        day = 14 + Number(a.slice(4));
        el.querySelectorAll('.dates button').forEach(b => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.action === a)));
    } if (a?.includes(':')) {
        time = a;
        el.querySelectorAll('.slots button').forEach(b => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.action === a)));
    } s.status(`September ${day} · ${time} selected · sample timezone UTC`); });
    return { destroy: s.destroy };
}
