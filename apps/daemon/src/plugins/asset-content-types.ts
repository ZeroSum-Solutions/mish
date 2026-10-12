/**
 * Content types for files served by `/api/plugins/:id/asset/*`, keyed by
 * lower-case extension. A `Map` (not a plain object) so names such as
 * `.constructor` or `.__proto__` never match an inherited property.
 *
 * The font entries are also the only extensions the opaque-origin font
 * allowance accepts: the `/api` origin guard (`isSandboxPluginFontRead`) and
 * the asset route's CORS echo both read them from here.
 */
export const PLUGIN_FONT_ASSET_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.eot', 'application/vnd.ms-fontobject'],
]);

const PLUGIN_ASSET_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ...PLUGIN_FONT_ASSET_CONTENT_TYPES,
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.markdown', 'text/markdown; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

/** `ext` includes the leading dot, e.g. `path.extname(file)`. */
export function isPluginFontAssetExtension(ext: string): boolean {
  return PLUGIN_FONT_ASSET_CONTENT_TYPES.has(ext.toLowerCase());
}

export function pluginAssetContentType(ext: string): string {
  return PLUGIN_ASSET_CONTENT_TYPES.get(ext.toLowerCase()) ?? 'application/octet-stream';
}
