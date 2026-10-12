import { vi } from 'vitest';

type Listener = (event: { matches: boolean; media: string }) => void;

/**
 * Stubs `window.matchMedia` with a viewport of the given CSS width. Width
 * queries (`(min-width: Npx)` / `(max-width: Npx)`) are evaluated against it;
 * every other query (reduced motion, colour scheme …) does not match.
 * `resize` changes the width and notifies `change` listeners whose result
 * flipped, as a browser does. Undo with `vi.unstubAllGlobals()`.
 */
export function installViewport(initialWidth: number) {
  let width = initialWidth;
  const lists = new Set<{ media: string; listeners: Set<Listener>; last: boolean }>();

  function evaluate(query: string): boolean {
    const min = /\(\s*min-width:\s*(\d+)px\s*\)/.exec(query);
    if (min) return width >= Number(min[1]);
    const max = /\(\s*max-width:\s*(\d+)px\s*\)/.exec(query);
    if (max) return width <= Number(max[1]);
    return false;
  }

  vi.stubGlobal('matchMedia', vi.fn((query: string) => {
    const entry = { media: query, listeners: new Set<Listener>(), last: evaluate(query) };
    lists.add(entry);
    return {
      get matches() {
        return evaluate(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) => entry.listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => entry.listeners.delete(listener),
      addListener: (listener: Listener) => entry.listeners.add(listener),
      removeListener: (listener: Listener) => entry.listeners.delete(listener),
      dispatchEvent: () => false,
    };
  }));

  return {
    resize(next: number) {
      width = next;
      for (const entry of lists) {
        const matches = evaluate(entry.media);
        if (matches === entry.last) continue;
        entry.last = matches;
        for (const listener of [...entry.listeners]) listener({ matches, media: entry.media });
      }
    },
  };
}
