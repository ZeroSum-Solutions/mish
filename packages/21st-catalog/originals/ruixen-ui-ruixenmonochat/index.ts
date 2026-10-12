/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"row between\"><h3>Conversation sketch</h3><small>Local demo</small></div><div class=\"messages\" role=\"log\" aria-label=\"Demo chat transcript\"><p class=\"bubble\">What are we making today?</p></div><form class=\"chat-form\"><input aria-label=\"Message\" placeholder=\"Describe your idea\u2026\" maxlength=\"500\" required><button type=\"submit\" class=\"primary\">Send</button></form><p role=\"status\">Local transcript \u00b7 canned replies, no AI service</p>", opts);
    s.on('submit', e => { e.preventDefault(); const input = s.query<HTMLInputElement>('input'), text = input.value.trim(); if (!text)
        return; const log = s.query('.messages'); const user = el.ownerDocument.createElement('p'); user.className = 'bubble sent'; user.textContent = text; log.append(user); const reply = el.ownerDocument.createElement('p'); reply.className = 'bubble'; reply.textContent = 'Saved to this demo transcript. Try another idea.'; log.append(reply); input.value = ''; log.scrollTop = log.scrollHeight; s.status('Message added locally · canned reply'); });
    return { destroy: s.destroy };
}
