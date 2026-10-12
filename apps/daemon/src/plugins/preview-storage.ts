/**
 * Preview scripts may use Storage even though their iframe has an opaque
 * origin. Give only inaccessible storage a document-local, in-memory fallback;
 * never grant same-origin access or replace storage that the browser allows.
 */
const PREVIEW_STORAGE_SCRIPT = `<script data-od-preview-storage>
(function () {
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { window[name]; return; } catch (_) {}
    var values = new Map();
    var storage = {
      get length() { return values.size; },
      key: function (index) { return Array.from(values.keys())[Number(index) >>> 0] ?? null; },
      getItem: function (key) { return values.get(String(key)) ?? null; },
      setItem: function (key, value) { values.set(String(key), String(value)); },
      removeItem: function (key) { values.delete(String(key)); },
      clear: function () { values.clear(); }
    };
    try { Object.defineProperty(window, name, { configurable: true, value: storage }); } catch (_) {}
  });
})();
</script>`;

/** Preserve the doctype and install before any preview markup or scripts. */
export function withPreviewStorage(html: string): string {
  // A textual <head> may be inside a comment. Skip the HTML prolog instead;
  // the browser creates the head for this first script and retains html attrs.
  const doctype = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i;
  if (doctype.test(html)) return html.replace(doctype, (tag) => tag + PREVIEW_STORAGE_SCRIPT);
  return PREVIEW_STORAGE_SCRIPT + html;
}
