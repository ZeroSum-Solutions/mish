import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { parse, parseExpression } from '@babel/parser';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';

/** Normalize escaped function/at-rule identifiers while preserving strings and comments. */
function normalizeCssIdentifiers(css: string): string {
  return css.replace(/\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(@?)([-\w\u0080-\uFFFF]*(?:\\(?:[a-f0-9]{1,6}(?:\r\n|[ \t\r\n\f])?|[^\r\n\f])[-\w\u0080-\uFFFF]*)+)(?=\(|\s|["'])/gi, (full, at: string | undefined, identifier: string | undefined) => {
    if (!identifier) return full;
    const decoded = decodeCssUrl(identifier).toLowerCase();
    if (at === '@') return decoded === 'import' ? '@import' : full;
    return ['url', 'image-set', '-webkit-image-set'].includes(decoded) ? decoded : full;
  });
}

/** Decode CSS escapes before the publication path validator sees the URL. */
function decodeCssUrl(value: string): string {
  return value.replace(/\\([a-f0-9]{1,6})(?:\r\n|[ \t\r\n\f])?|\\(\r\n|[\r\n\f])|\\([\s\S])/gi, (_match, hex: string | undefined, newline: string | undefined, literal: string | undefined) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return String.fromCodePoint(code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code);
    }
    return newline ? '' : (literal ?? '');
  });
}

/** Select URL nodes by CSS grammar, never by text in comments, selectors or arbitrary strings. */
function cssUrlNodes(value: string, importRule = false): { parsed: valueParser.ParsedValue; urls: valueParser.Node[] } {
  const parsed = valueParser(normalizeCssIdentifiers(value));
  const urls: valueParser.Node[] = [];
  const significant = (nodes: valueParser.Node[]) => nodes.filter((node) => node.type !== 'space' && node.type !== 'comment');
  const walk = (nodes: valueParser.Node[]): void => {
    for (const node of nodes) {
      if (node.type !== 'function') continue;
      const name = decodeCssUrl(node.value).toLowerCase();
      if (name === 'url') {
        const children = significant(node.nodes);
        const child = children[0];
        const validWord = child?.type === 'word' && !/["'()\s]/.test(child.value.replace(/\\(?:[a-f0-9]{1,6}(?:\r\n|[ \t\r\n\f])?|[\s\S])/gi, ''));
        if (!node.unclosed && children.length === 1 && (validWord || child?.type === 'string')) urls.push(child!);
        continue;
      }
      if (name === 'image-set' || name === '-webkit-image-set') {
        let candidateStart = true;
        for (const child of significant(node.nodes)) {
          if (child.type === 'div' && child.value === ',') { candidateStart = true; continue; }
          if (candidateStart && child.type === 'string') urls.push(child);
          candidateStart = false;
        }
      }
      walk(node.nodes);
    }
  };
  if (importRule) {
    const first = significant(parsed.nodes)[0];
    if (first?.type === 'string' && !('unclosed' in first && first.unclosed)) urls.push(first);
    else if (first?.type === 'function' && decodeCssUrl(first.value).toLowerCase() === 'url') walk([first]);
  } else walk(parsed.nodes);
  return { parsed, urls };
}

export function cssPublicationReferences(css: string): string[] {
  const urls: string[] = [];
  const imports: string[] = [];
  const stylesheet = postcss.parse(normalizeCssIdentifiers(css));
  stylesheet.walkDecls((declaration) => {
    urls.push(...cssUrlNodes(declaration.value).urls.map((node) => decodeCssUrl(node.value)));
  });
  stylesheet.walkAtRules((rule) => {
    if (decodeCssUrl(rule.name).toLowerCase() === 'import') imports.push(...cssUrlNodes(rule.params, true).urls.map((node) => decodeCssUrl(node.value)));
  });
  return [...urls, ...imports];
}

/** Best-effort legacy url()/@import scan, excluding comments and ordinary strings. */
export function fallbackCssPublicationReferences(css: string): string[] {
  const refs: string[] = [];
  const collect = (statement: string): void => {
    // Rule preludes and capability queries do not fetch URLs. Scan only
    // declaration values and @import, even if a closing brace is missing.
    const declaration = /^\s*(?:--[-\w]+|[-\w]+)\s*:/u.exec(statement);
    const importRule = /^\s*@import(?=\s|["'(])/i.exec(statement);
    if (!declaration && !importRule) return;
    const value = statement.slice(declaration?.[0].length ?? importRule?.[0].length ?? 0);
    refs.push(...cssUrlNodes(value, !!importRule).urls.map((node) => decodeCssUrl(node.value)));
  };
  let statement = '';
  let parentheses = 0;
  const tokens = /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^{};()"'/]+|[\s\S]/g;
  for (const match of normalizeCssIdentifiers(css).matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith('/*')) { statement += ' '; continue; }
    if (token === '(') parentheses += 1;
    if (token === ')') parentheses = Math.max(0, parentheses - 1);
    if (token === '{' || token === '}' || (parentheses === 0 && token === ';')) {
      if (token !== '{') collect(statement);
      statement = '';
      parentheses = 0;
    } else statement += token;
  }
  collect(statement);
  return refs;
}

/** Relocate only selected URL nodes; keep ordinary strings and selectors intact. */
export function rewriteCssPublicationReferences(css: string, rewrite: (ref: string) => string): string {
  let stylesheet: ReturnType<typeof postcss.parse>;
  try { stylesheet = postcss.parse(normalizeCssIdentifiers(css)); }
  catch (error) {
    // Broken stylesheets remain publishable with a collection warning; any other error is a bug.
    if (error instanceof Error && error.name === 'CssSyntaxError') return css;
    throw error;
  }
  const rewriteValue = (value: string, importRule = false): string => {
    const { parsed, urls } = cssUrlNodes(value, importRule);
    for (const node of urls) {
      const decoded = decodeCssUrl(node.value);
      const relocated = rewrite(decoded);
      if (relocated !== decoded) node.value = relocated;
    }
    return valueParser.stringify(parsed.nodes);
  };
  stylesheet.walkDecls((declaration) => { declaration.value = rewriteValue(declaration.value); });
  stylesheet.walkAtRules((rule) => {
    if (decodeCssUrl(rule.name).toLowerCase() === 'import') rule.params = rewriteValue(rule.params, true);
  });
  return stylesheet.toString();
}

/** Follow srcset's URL/descriptor boundaries without splitting the comma inside a data URL. */
export function srcsetPublicationReferences(srcset: string): string[] {
  return srcsetUrlRanges(srcset).map((item) => item.ref);
}

export function rewriteSrcsetPublicationReferences(srcset: string, rewrite: (ref: string) => string): string {
  let result = srcset;
  for (const item of srcsetUrlRanges(srcset).reverse()) {
    result = result.slice(0, item.start) + rewrite(item.ref) + result.slice(item.end);
  }
  return result;
}

function srcsetUrlRanges(srcset: string): { ref: string; start: number; end: number }[] {
  const urls: { ref: string; start: number; end: number }[] = [];
  let offset = 0;
  while (offset < srcset.length) {
    while (/[\s,]/.test(srcset[offset] ?? '') && offset < srcset.length) offset += 1;
    const start = offset;
    while (offset < srcset.length && !/\s/.test(srcset[offset] ?? '')) offset += 1;
    const token = srcset.slice(start, offset);
    if (!token) break;
    const ref = token.replace(/,+$/, '');
    urls.push({ ref, start, end: start + ref.length });
    if (token.endsWith(',')) continue;
    // Descriptors end at the next separator; commas inside parentheses are not separators.
    let parentheses = 0;
    while (offset < srcset.length) {
      const char = srcset[offset++];
      if (char === '(') parentheses += 1;
      if (char === ')') parentheses = Math.max(0, parentheses - 1);
      if (char === ',' && parentheses === 0) break;
    }
  }
  return urls;
}

/** Static imports and import.meta.url assets are dependencies; arbitrary script strings are not. */
export function scriptPublicationReferences(script: string): string[] {
  return scriptReferenceLiterals(script).map((literal) => literal.value);
}

/**
 * Regex fallback scans static module/URL syntax only. Tokenizing strings,
 * comments, templates and regex literals keeps runtime data and quoted code
 * from becoming publication consent even when the whole program cannot parse.
 */
export function fallbackScriptPublicationReferences(script: string): string[] {
  const tokens = fallbackScriptTokens(script);
  const refs: string[] = [];
  const add = (literal: string | undefined, relativeOnly = true): void => {
    if (!literal || !/^['"]/.test(literal)) return;
    try {
      const node = parseExpression(literal);
      if (node.type === 'StringLiteral' && (!relativeOnly || node.value.startsWith('.') || node.value.startsWith('/'))) refs.push(node.value);
    } catch { /* An invalid literal is not a usable static reference. */ }
  };
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'import' && !['.', '?.'].includes(tokens[i - 1] ?? '')) {
      if (tokens[i + 1] !== '(') add(tokens[i + 1]);
      else if (tokens[i + 3] === ')' || tokens[i + 3] === ',') add(tokens[i + 2]);
    }
    if (tokens[i] === 'import' || tokens[i] === 'export') add(moduleSourceLiteral(tokens, i));
    if (tokens[i] === 'new' && tokens[i + 1] === 'URL' && tokens[i + 2] === '(' && tokens.slice(i + 4, i + 11).join(' ') === ', import . meta . url )') add(tokens[i + 3], false);
  }
  return refs;
}

/** Find `from` only after the static module specifier grammar, never import.meta or expressions. */
function moduleSourceLiteral(tokens: string[], start: number): string | undefined {
  let offset = start + 1;
  const identifier = (value: string | undefined) => typeof value === 'string' && /^[A-Za-z_$][\w$]*$/.test(value);
  if (tokens[start] === 'import' && identifier(tokens[offset])) {
    offset += 1; // Default binding.
    if (tokens[offset] === ',') offset += 1;
    else return tokens[offset] === 'from' ? tokens[offset + 1] : undefined;
  }
  if (tokens[offset] === '*') {
    offset += 1;
    if (tokens[offset] === 'as' && identifier(tokens[offset + 1])) offset += 2;
  } else if (tokens[offset] === '{') {
    offset += 1;
    while (offset < tokens.length && tokens[offset] !== '}') {
      if (!identifier(tokens[offset]) && tokens[offset] !== ',' && !/^['"]/.test(tokens[offset] ?? '')) return undefined;
      offset += 1;
    }
    if (tokens[offset++] !== '}') return undefined;
  } else return undefined;
  return tokens[offset] === 'from' ? tokens[offset + 1] : undefined;
}

/** Lex without parsing: Acorn owns JS/JSX context, escapes and opaque text tokens. */
function fallbackScriptTokens(script: string): string[] {
  const tokens: string[] = [];
  const lexer = Parser.extend(jsx()).tokenizer(script, { ecmaVersion: 'latest', sourceType: 'module' });
  try {
    for (const token of lexer) {
      const raw = script.slice(token.start, token.end);
      // Template text is opaque; actual import expressions inside ${...}
      // retain the same static dependency semantics as the parsed collector.
      tokens.push(['template', 'invalidTemplate', 'jsxText', 'jsxName'].includes(token.type.label) ? '`' : raw);
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Do not rescan the tail of an unterminated string/regex as source code.
  }
  return tokens;
}

export function rewriteScriptPublicationReferences(script: string, rewrite: (ref: string) => string): string {
  let result = script;
  for (const literal of scriptReferenceLiterals(script).sort((a, b) => b.start - a.start)) {
    const relocated = rewrite(literal.value);
    if (relocated !== literal.value) result = result.slice(0, literal.start) + JSON.stringify(relocated).replace(/</g, '\\u003c') + result.slice(literal.end);
  }
  return result;
}

function scriptReferenceLiterals(script: string): { value: string; start: number; end: number }[] {
  const ast = parse(script, { sourceType: 'unambiguous', createImportExpressions: true });
  const refs: { value: string; start: number; end: number }[] = [];
  const add = (literal: unknown, relativeOnly = true) => {
    const node = literal as { value?: unknown; start?: number; end?: number } | undefined;
    if (typeof node?.value === 'string' && typeof node.start === 'number' && typeof node.end === 'number' && (!relativeOnly || node.value.startsWith('.') || node.value.startsWith('/'))) refs.push({ value: node.value, start: node.start, end: node.end });
  };
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    const node = value as Record<string, unknown>;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(String(node.type))) {
      add(node.source);
    }
    if (node.type === 'NewExpression' && (node.callee as { name?: string } | undefined)?.name === 'URL') {
      const args = node.arguments as { value?: unknown; type?: string; object?: { type?: string; meta?: { name?: string }; property?: { name?: string } }; property?: { name?: string } }[];
      const base = args[1];
      if (base?.type === 'MemberExpression' && base.property?.name === 'url' && base.object?.type === 'MetaProperty' && base.object.meta?.name === 'import' && base.object.property?.name === 'meta') add(args[0], false);
    }
    for (const [key, child] of Object.entries(node)) {
      if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) walk(child);
    }
  };
  walk(ast.program);
  return refs;
}
