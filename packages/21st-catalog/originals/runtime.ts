/** Independently authored by ZeroSum. No upstream component source is used. */
export interface OriginalOptions { theme?: 'light' | 'dark'; reducedMotion?: boolean }
export interface OriginalHandle { destroy(): void }
export function setup(el: HTMLElement, html: string, opts: OriginalOptions = {}) {
  const attributes = [...el.attributes].map(a => [a.name, a.value] as const);
  const children = [...el.childNodes];
  const abort = new AbortController();
  el.classList.add('mm-original');
  el.dataset.theme = opts.theme ?? 'dark';
  el.dataset.reducedMotion = String(opts.reducedMotion ?? false);
  el.innerHTML = html;
  function on(event: string, callback: (event: Event) => void) {
    el.addEventListener(event, callback, { signal: abort.signal });
  }
  function query<T extends Element = HTMLElement>(selector: string): T { return el.querySelector<T>(selector)!; }
  function status(text: string) { const node = el.querySelector('[role=status]'); if (node) node.textContent = text; }
  let destroyed = false;
  return { el, on, query, status, signal: abort.signal, get reducedMotion() { return opts.reducedMotion || el.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false; }, destroy() {
    if (destroyed) return;
    destroyed = true;
    el.querySelectorAll('dialog[open]').forEach(d => (d as HTMLDialogElement).close());
    abort.abort();
    el.replaceChildren(...children);
    for (const a of [...el.attributes]) el.removeAttribute(a.name);
    for (const [name, value] of attributes) el.setAttribute(name, value);
  } };
}
export function action(event: Event): string | undefined {
  return (event.target as Element).closest<HTMLElement>('[data-action]')?.dataset.action;
}
export function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!);
}
