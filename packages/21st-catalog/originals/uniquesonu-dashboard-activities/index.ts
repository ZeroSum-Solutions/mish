/** Independently authored ZeroSum alternative. Upstream is a visual reference only. */
import { setup, action, escapeText, type OriginalOptions, type OriginalHandle } from '../runtime.ts';
export function mount(el: HTMLElement, opts: OriginalOptions = {}): OriginalHandle {
    const s = setup(el, "<div class=\"row between\"><h3>Activity ledger</h3><button data-action=\"review\">Mark reviewed</button></div><div class=\"row\"><button data-action=\"all\" aria-pressed=\"true\">All</button><button data-action=\"design\">Design</button><button data-action=\"release\">Release</button></div><div class=\"timeline\"><article data-kind=\"design\"><i></i><div><strong>New direction approved</strong><p class=\"muted\">Ellis \u00b7 8 minutes ago</p></div></article><article data-kind=\"release\"><i></i><div><strong>Preview ready for review</strong><p class=\"muted\">Studio \u00b7 24 minutes ago</p></div></article><article data-kind=\"design\"><i></i><div><strong>12 frames added</strong><p class=\"muted\">Morgan \u00b7 1 hour ago</p></div></article></div><p role=\"status\">3 sample activities \u00b7 unreviewed</p>", opts);
    s.on('click', e => { const a = action(e); if (a === 'review') {
        s.status('Sample activities marked reviewed');
        s.query('.timeline').style.opacity = '.65';
        return;
    } if (!['all', 'design', 'release'].includes(a ?? ''))
        return; el.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(b => { if (b.dataset.action !== 'review')
        b.setAttribute('aria-pressed', String(b.dataset.action === a)); }); el.querySelectorAll<HTMLElement>('[data-kind]').forEach(n => n.hidden = a !== 'all' && n.dataset.kind !== a); s.status(`${a === 'all' ? 3 : a === 'design' ? 2 : 1} sample activities`); });
    return { destroy: s.destroy };
}
