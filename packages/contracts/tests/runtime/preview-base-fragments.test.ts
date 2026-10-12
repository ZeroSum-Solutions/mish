import { describe, expect, it } from 'vitest';
import { buildPreviewBaseHrefBridge } from '../../src/runtime/preview-observability.js';

const RAW_URL = 'http://preview.test/api/projects/project-1/raw/community-r2.html?odPreviewBridge=scroll&selection&snapshot';
const BASE_URL = 'http://preview.test/api/projects/project-1/preview/scope-1/';

type Listener = (event: Record<string, unknown>) => void;

/** Execute the real serialized bridge; double only browser event, DOM and history boundaries. */
function harness(options: { authoredBase?: boolean; url?: string; namedTarget?: boolean; historyThrows?: boolean } = {}) {
  const listeners = { document: new Map<string, Listener[]>(), window: new Map<string, Listener[]>() };
  let baseHref = BASE_URL;
  const location = new URL(options.url ?? RAW_URL);
  const scrolls: unknown[] = [];
  const topScrolls: unknown[] = [];
  const target = { id: 'community-join', scrollIntoView: (value?: unknown) => scrolls.push(value) };
  const base = { getAttribute: () => baseHref, setAttribute: (_name: string, value: string) => { baseHref = value; } };
  const document = {
    get baseURI() { return baseHref; },
    querySelector: (selector: string) => selector === 'base[data-od-project-preview-base]' && !options.authoredBase ? base : null,
    getElementById: (id: string) => !options.namedTarget && id === target.id ? target : null,
    getElementsByName: (name: string) => options.namedTarget && name === target.id ? [target] : [],
    addEventListener: (name: string, fn: Listener) => listeners.document.set(name, [...(listeners.document.get(name) ?? []), fn]),
  };
  const parent = { postMessage: () => {} };
  const history = {
    pushState: (_state: unknown, _unused: string, url: string) => {
      if (options.historyThrows) throw new Error('opaque origin');
      // Browsers resolve a relative history URL against the document's base, too.
      location.href = new URL(url, document.baseURI).href;
    },
    replaceState: (_state: unknown, _unused: string, url: string) => { location.href = new URL(url, document.baseURI).href; },
  };
  const window = { parent, location, history, scrollTo: (value: unknown) => topScrolls.push(value), addEventListener: (name: string, fn: Listener) => listeners.window.set(name, [...(listeners.window.get(name) ?? []), fn]) };
  const bridge = buildPreviewBaseHrefBridge({ href: BASE_URL, expiresAt: 1000 });
  new Function('window', 'document', 'URL', 'history', bridge.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))(window, document, URL, history);
  const dispatch = (name: string, event: Record<string, unknown>) => {
    for (const fn of [...(listeners.document.get(name) ?? []), ...(listeners.window.get(name) ?? [])]) fn(event);
  };
  const click = (href = '#community-join', extras: Record<string, unknown> = {}, attributes: Record<string, string> = {}) => {
    const attrs = { href, ...attributes };
    const anchor = {
      getAttribute: (name: string) => attrs[name as keyof typeof attrs] ?? null,
      hasAttribute: (name: string) => name in attrs,
      closest: () => anchor,
      get href() { return new URL(href, document.baseURI).href; },
    };
    const event = { target: { closest: () => anchor }, button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() { this.defaultPrevented = true; }, ...extras };
    dispatch('click', event);
    return event;
  };
  return { click, dispatch, target, scrolls, topScrolls, location, get baseHref() { return baseHref; }, parent, addAuthorClick: (fn: Listener) => document.addEventListener('click', fn) };
}

describe('preview base fragment navigation', () => {
  it('scrolls a local target in the current raw document, retaining its path, query and asset base', () => {
    const preview = harness();
    expect(preview.click().defaultPrevented).toBe(true);
    expect(preview.scrolls).toHaveLength(1);
    expect(preview.location.href).toBe(`${RAW_URL}#community-join`);
    expect(preview.baseHref).toBe(BASE_URL);
    expect(new URL('./asset.svg', preview.baseHref).href).toBe(`${BASE_URL}asset.svg`);
  });

  it('still targets the raw document after the parent renews the asset scope', () => {
    const preview = harness();
    preview.dispatch('message', { source: preview.parent, data: { type: 'od:preview-base-update', href: '/api/projects/project-1/preview/scope-2/', requestId: 'renew-1' } });
    expect(preview.baseHref).toBe('http://preview.test/api/projects/project-1/preview/scope-2/');
    expect(preview.click().defaultPrevented).toBe(true);
    expect(preview.location.href).toBe(`${RAW_URL}#community-join`);
    expect(preview.scrolls).toHaveLength(1);
  });

  it('decodes URL fragment IDs and supports authored named anchors', () => {
    for (const namedTarget of [false, true]) {
      const preview = harness({ namedTarget });
      expect(preview.click('#community%2Djoin').defaultPrevented).toBe(true);
      expect(preview.scrolls).toHaveLength(1);
    }
  });

  it('scrolls opaque srcDoc documents even if updating history is forbidden', () => {
    const preview = harness({ url: 'about:srcdoc', historyThrows: true });
    expect(preview.click().defaultPrevented).toBe(true);
    expect(preview.scrolls).toHaveLength(1);
    expect(preview.location.href).toBe('about:srcdoc');
    expect(preview.baseHref).toBe(BASE_URL);
  });

  it('scrolls empty fragments to the top without changing the raw document path or asset base', () => {
    const preview = harness();
    expect(preview.click('#').defaultPrevented).toBe(true);
    expect(preview.topScrolls).toEqual([{ top: 0 }]);
    expect(preview.scrolls).toHaveLength(0);
    expect(preview.location.href).toBe(`${RAW_URL}#`);
    expect(preview.baseHref).toBe(BASE_URL);
  });

  it('keeps an empty href in the current document and scrolls to its top', () => {
    const preview = harness({ url: `${RAW_URL}#community-join` });
    expect(preview.click('').defaultPrevented).toBe(true);
    expect(preview.topScrolls).toEqual([{ top: 0 }]);
    expect(preview.location.href).toBe(RAW_URL);
    expect(preview.baseHref).toBe(BASE_URL);
  });

  it('lets a later authored document handler prevent the bridge fallback', () => {
    const preview = harness();
    let authorCalls = 0;
    preview.addAuthorClick(event => {
      authorCalls += 1;
      (event.preventDefault as () => void).call(event);
    });
    expect(preview.click().defaultPrevented).toBe(true);
    expect(authorCalls).toBe(1);
    expect(preview.scrolls).toHaveLength(0);
    expect(preview.location.href).toBe(RAW_URL);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }])('preserves modified or already handled clicks: %j', extras => {
    const preview = harness();
    expect(preview.click('#community-join', extras).defaultPrevented).toBe(Boolean(extras.defaultPrevented));
    expect(preview.scrolls).toHaveLength(0);
    expect(preview.location.href).toBe(RAW_URL);
  });

  it.each([{ target: '_blank' }, { target: '_parent' }, { download: '' }])('preserves other browsing contexts and downloads: %j', attrs => {
    const preview = harness();
    expect(preview.click('#community-join', {}, attrs).defaultPrevented).toBe(false);
    expect(preview.scrolls).toHaveLength(0);
  });

  it.each(['https://external.test/#community-join', './guide.html#community-join', 'mailto:join@example.com', '#missing', '#%ZZ'])('does not hijack external, relative, absent or invalid destinations: %s', href => {
    const preview = harness();
    expect(preview.click(href).defaultPrevented).toBe(false);
    expect(preview.scrolls).toHaveLength(0);
    expect(preview.location.href).toBe(RAW_URL);
  });

  it('leaves artifact-authored bases alone', () => {
    const preview = harness({ authoredBase: true });
    expect(preview.click().defaultPrevented).toBe(false);
    expect(preview.scrolls).toHaveLength(0);
  });
});
