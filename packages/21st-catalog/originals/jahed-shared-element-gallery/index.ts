/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<h3>Expanded moments</h3><div class=\"shared-gallery\"><button class=\"art\" data-action=\"open-0\" style=\"filter:hue-rotate(0deg)\" aria-label=\"Open artwork 1\"></button><button class=\"art\" data-action=\"open-1\" style=\"filter:hue-rotate(70deg)\" aria-label=\"Open artwork 2\"></button><button class=\"art\" data-action=\"open-2\" style=\"filter:hue-rotate(140deg)\" aria-label=\"Open artwork 3\"></button></div><dialog><div class=\"art enlarged\"></div><h3>Field study <span class=\"number\">1</span></h3><p class=\"muted\">An original code-native composition.</p><button data-action=\"close\">Close artwork</button></dialog>", opts);
    s.on('click', e => { const a = action(e), d = s.query<HTMLDialogElement>('dialog'); if (a?.startsWith('open-')) {
        const i = Number(a.slice(5));
        s.query('.number').textContent = String(i + 1);
        s.query('.enlarged').style.filter = `hue-rotate(${i * 70}deg)`;
        d.showModal();
    } if (a === 'close')
        d.close(); });
    return { destroy: s.destroy };
}
