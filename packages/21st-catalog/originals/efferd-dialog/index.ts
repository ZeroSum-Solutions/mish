/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"dialog-intro\"><div class=\"dialog-symbol\">\u2197</div><h2>A deliberate next step.</h2><p class=\"muted\">Review a sample publish decision in a focused modal.</p><button class=\"primary\" data-action=\"open\">Review sample publish</button></div><dialog><form method=\"dialog\" class=\"stack\"><span class=\"eyebrow\">Review / Local demo</span><h2>Publish this sample?</h2><p>This only changes the demo state. No project is published.</p><div class=\"row\"><button value=\"cancel\">Cancel</button><button value=\"confirm\" class=\"primary\">Confirm sample</button></div></form></dialog><p role=\"status\">Sample is a draft</p>", opts);
    const d = s.query<HTMLDialogElement>('dialog');
    s.on('click', e => { if (action(e) === 'open')
        d.showModal(); });
    d.addEventListener('close', () => s.status(d.returnValue === 'confirm' ? 'Sample confirmed locally · no project published' : 'Sample remains a draft'), { signal: s.signal });
    return { destroy: s.destroy };
}
