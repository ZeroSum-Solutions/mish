import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { UnitError } from './unit-files.js';

/**
 * Standalone materialization keeps project-root resource references inside the
 * copied unit. This changes only static references to files actually carried
 * by the manifest; external URLs, navigation targets and arbitrary code stay
 * as authored. The receipt retains both source and materialized digests.
 */
export function relocateUnitSource(bytes: Buffer, file: string, carried: ReadonlySet<string>): Buffer {
  function reference(value: string): string {
    if (!value.startsWith('/') || value.startsWith('//')) return value;
    const split = value.search(/[?#]/u);
    const pathname = split === -1 ? value : value.slice(0, split), suffix = split === -1 ? '' : value.slice(split);
    let decoded: string;
    try { decoded = decodeURIComponent(pathname.slice(1)); } catch { return value; }
    if (!carried.has(decoded)) return value;
    const relative = path.posix.relative(path.posix.dirname(file), decoded).split('/').map(segment => encodeURIComponent(segment)).join('/');
    return `${relative.startsWith('.') ? '' : './'}${relative}${suffix}`;
  }
  const css = (text: string) => text
    .replace(/(url\(\s*)(["']?)(\/[^\s"')]+)\2(\s*\))/gu, (_match, before: string, quote: string, value: string, after: string) => `${before}${quote}${reference(value)}${quote}${after}`)
    .replace(/(@import\s+)(["'])(\/[^"']+)\2/gu, (_match, before: string, quote: string, value: string) => `${before}${quote}${reference(value)}${quote}`);
  const js = (text: string) => text.replace(/(\b(?:from|import)\s*\(?\s*)(["'])(\/[^"']+)\2/gu, (_match, before: string, quote: string, value: string) => `${before}${quote}${reference(value)}${quote}`);
  if (!/\.(?:html?|css|m?js)$/iu.test(file)) return bytes;
  if (!isUtf8(bytes)) throw new UnitError(422, 'unsupported-target-format', 'Standalone text source requires UTF-8', [file]);
  const text = bytes.toString('utf8');
  let result: string;
  if (/\.html?$/iu.test(file)) {
    result = text.replace(/(\b(?:src|href|poster|data)\s*=\s*)(["'])(\/[^"']+)\2/giu, (_match, before: string, quote: string, value: string) => `${before}${quote}${reference(value)}${quote}`)
      .replace(/(\bsrcset\s*=\s*)(["'])([^"']+)\2/giu, (_match, before: string, quote: string, value: string) => `${before}${quote}${value.split(',').map(part => part.replace(/^(\s*)(\S+)/u, (_: string, spaces: string, url: string) => `${spaces}${reference(url)}`)).join(',')}${quote}`);
    // CSS URLs also occur in inline style attributes and <style>; module imports in inline scripts.
    result = js(css(result));
  } else if (/\.css$/iu.test(file)) result = css(text);
  else if (/\.(?:m?js)$/iu.test(file)) result = js(text);
  else return bytes;
  return result === text ? bytes : Buffer.from(result);
}
