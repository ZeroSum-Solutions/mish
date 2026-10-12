/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"listen panel\"><div class=\"album art\"></div><span class=\"eyebrow\">Listening room \u00b7 UI demo</span><h2 class=\"track-title\">Soft horizon</h2><p class=\"muted\">Studio Session / Vol. 02</p><input type=\"range\" min=\"0\" max=\"180\" value=\"42\" aria-label=\"Playback position\"><div class=\"row between\"><small class=\"position\">0:42 / 3:00</small><div class=\"row\"><button data-action=\"previous\" aria-label=\"Previous track\">\u2190</button><button data-action=\"play\" aria-pressed=\"false\">Play</button><button data-action=\"next\" aria-label=\"Next track\">\u2192</button></div></div><p role=\"status\">Player interaction demo \u00b7 no audio source</p></div>", opts);
    let i = 0;
    s.on('click', e => { const a = action(e); if (a === 'play') {
        const b = e.target as HTMLElement, p = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(p));
        b.textContent = p ? 'Pause' : 'Play';
        s.status(p ? 'Playing state · UI demo, no audio source' : 'Paused state · UI demo');
    } if (a === 'next' || a === 'previous') {
        i = (i + (a === 'next' ? 1 : 2)) % 3;
        s.query('.track-title').textContent = ['Soft horizon', 'Night transit', 'Ocean glass'][i]!;
    } });
    s.on('input', e => { const n = Number((e.target as HTMLInputElement).value); s.query('.position').textContent = `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')} / 3:00`; });
    return { destroy: s.destroy };
}
