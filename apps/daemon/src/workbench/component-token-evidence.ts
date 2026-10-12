import { createHash } from 'node:crypto';
import postcss from 'postcss';
import type { ComponentTokenEvidence, ResourceRef } from '@open-design/contracts';
import type { CatalogueMaterialFile } from './adoption/catalogue-material.js';

/** Only literal CSS declarations in the exact admitted source bytes are observations.
 * TSX classes, theme props and runtime expressions remain unknown until their adapter supplies evidence. */
export function observeComponentTokens(ref: ResourceRef, files: readonly CatalogueMaterialFile[]): ComponentTokenEvidence {
  const values: Record<'color' | 'radius' | 'type', string[]> = { color: [], radius: [], type: [] };
  const localVariables = new Set<string>();
  let unreadable = false;
  for (const file of files) {
    if (file.role === 'asset') continue;
    const text = file.bytes.toString('utf8');
    const html = /\.html?$/u.test(file.path);
    // Runtime code can set classes, theme properties or inline styles. A companion
    // stylesheet cannot prove those expressions adaptable.
    if (!file.path.endsWith('.css') && !html && file.role === 'source') unreadable = true;
    if (html && /<script\b/iu.test(text)) unreadable = true;
    if (html && /<(?:link|svg|font|iframe|object|embed)\b|\b(?:on[a-z]+|bgcolor|color|fill|stroke)\s*=/iu.test(text)) unreadable = true;
    const inlineStyles = html ? [...text.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/giu)] : [];
    if (html && [...text.matchAll(/\bstyle\s*=/giu)].length !== inlineStyles.length) unreadable = true;
    const styles = file.path.endsWith('.css') ? [text] : html ? [
      ...[...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)].map(match => match[1]!),
      ...inlineStyles.map(match => `.inline{${match[2]!}}`),
    ] : [];
    for (const css of styles) {
      try {
        const parsed = postcss.parse(css);
        parsed.walkAtRules(rule => { if (rule.name.toLowerCase() === 'import') unreadable = true; });
        parsed.walkDecls(declaration => {
          const property = declaration.prop.toLowerCase();
          if (property.startsWith('--')) localVariables.add(declaration.prop);
          if (/^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left)|-(?:block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|(?:box|text)-shadow|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?)$/u.test(property)) values.color.push(declaration.value);
          if (/^border(?:-(?:(?:top|bottom)-(?:left|right)|(?:start|end)-(?:start|end)))?-radius$/u.test(property)) values.radius.push(declaration.value);
          if (/^(?:font(?:-[a-z-]+)?|line-height|letter-spacing|text-transform)$/u.test(property)) values.type.push(declaration.value);
        });
      } catch { unreadable = true; }
    }
  }
  const axis = (entries: string[]): ComponentTokenEvidence['color'] => {
    if (unreadable || !entries.length) return 'unknown';
    const matches = entries.map(value => /^var\(\s*(--[\w-]+)(?:\s*,[\s\S]*)?\)$/u.exec(value.trim()));
    if (matches.every(match => !!match && !localVariables.has(match[1]!))) return 'adaptable';
    if (entries.some((value, index) => /var\(/u.test(value) && !matches[index] || /^(?:inherit|transparent|none|currentcolor|initial|unset|revert)$/iu.test(value.trim()))) return 'unknown';
    return 'fixed';
  };
  const digest = createHash('sha256').update(JSON.stringify(files.map(file => [file.path, createHash('sha256').update(file.bytes).digest('hex')]))).digest('hex');
  const bindings = (entries: string[]) => [...new Set(entries.flatMap(value => [...value.matchAll(/var\(\s*(--[\w-]+)/gu)].map(match => match[1]!)))].sort();
  return { sourceRevisionOrDigest: ref.revisionOrDigest, evidenceRef: `source-css-bindings:${digest}`, color: axis(values.color), radius: axis(values.radius), type: axis(values.type), bindings: { color: bindings(values.color), radius: bindings(values.radius), type: bindings(values.type) } };
}
