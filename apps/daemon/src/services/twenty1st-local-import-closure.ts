/** Check only syntactic local file closure of a checksum-verified private source bundle. */
import { parse } from '@babel/parser';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import type { Twenty1stLocalImportClosure } from '@open-design/contracts';

type SourceFile = { path: string; content: string };
type Node = { type?: string; source?: Node; value?: unknown; name?: string; callee?: Node; arguments?: Node[]; object?: Node; property?: Node; expression?: Node; expressions?: Node[]; quasis?: Node[]; left?: Node; right?: Node; key?: Node; id?: Node; properties?: Node[]; operator?: string; computed?: boolean; shorthand?: boolean; [key: string]: unknown };
type Alias = { pattern: string; replacement: string; directory: string; owner: string; baseUrl?: string };
const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mts', '/index.mjs', '/index.cts', '/index.cjs'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const ownerDepth = (owner: string) => owner === '.' ? 0 : owner.split('/').length;

function withinBundle(value: string): string | null {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return null;
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return null;
  const candidate = normalized.replace(/^\.\//, '');
  if (candidate.length > 512 || !/^[A-Za-z0-9_.@()+ -]+(?:\/[A-Za-z0-9_.@()+ -]+)*$/.test(candidate)
    || candidate.split('/').some(part => part === '.' || part === '..' || part.trim() !== part || part.endsWith('.'))) return null;
  return candidate;
}

function aliases(files: SourceFile[]): Alias[] | null {
  const result: Alias[] = [];
  for (const file of files.filter(file => file.path.endsWith('/tsconfig.json') || file.path === 'tsconfig.json')) {
    const errors: ParseError[] = [];
    let parsed: unknown;
    try { parsed = parseJsonc(file.content, errors, { allowTrailingComma: true }); } catch { return null; }
    if (errors.length || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    if ('extends' in parsed) return null;
    const owner = path.posix.dirname(file.path);
    const options = (parsed as { compilerOptions?: unknown }).compilerOptions;
    if (options === undefined) { result.push({ pattern: '', replacement: '', directory: owner, owner }); continue; }
    if (typeof options !== 'object' || options === null) return null;
    const config = options as { baseUrl?: unknown; paths?: unknown };
    const baseUrl = config.baseUrl === undefined ? '.' : config.baseUrl;
    if (typeof baseUrl !== 'string' || baseUrl.startsWith('/') || baseUrl.includes('\\')) return null;
    const basePath = path.posix.join(owner, baseUrl);
    if (basePath !== '.' && !withinBundle(basePath)) return null;
    const base = basePath === '.' ? '.' : withinBundle(basePath)!;
    result.push({ pattern: '', replacement: '', directory: owner, owner, ...(config.baseUrl === undefined ? {} : { baseUrl: base }) });
    if (config.paths === undefined) continue;
    if (typeof config.paths !== 'object' || config.paths === null || Array.isArray(config.paths)) return null;
    for (const [pattern, targets] of Object.entries(config.paths)) {
      if (!pattern || (pattern.match(/\*/g) ?? []).length > 1 || !Array.isArray(targets) || targets.length < 1 || targets.some(target => typeof target !== 'string')) return null;
      for (const replacement of targets as string[]) {
        if (replacement.startsWith('/') || replacement.includes('\\') || (replacement.match(/\*/g) ?? []).length > 1 || !withinBundle(path.posix.join(base, replacement.replace('*', 'x')))) return null;
        result.push({ pattern, replacement, directory: base, owner });
      }
    }
  }
  return result;
}

/** Package installation is outside local source closure; use saved declarations, never guesses. */
function externalPackages(files: SourceFile[]): { owner: string; names: Set<string> }[] {
  const result: { owner: string; names: Set<string> }[] = [];
  for (const file of files.filter(file => file.path === 'package.json' || file.path.endsWith('/package.json'))) {
    let parsed: unknown;
    try { parsed = JSON.parse(file.content); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const names = new Set<string>();
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const group = (parsed as Record<string, unknown>)[key];
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
      for (const [name, version] of Object.entries(group)) {
        if (typeof version === 'string' && version.trim()) names.add(name);
      }
    }
    result.push({ owner: path.posix.dirname(file.path), names });
  }
  return result;
}

function matchAlias(specifier: string, alias: Alias): string | null {
  const at = alias.pattern.indexOf('*');
  if (at < 0) return specifier === alias.pattern ? alias.replacement : null;
  const prefix = alias.pattern.slice(0, at), suffix = alias.pattern.slice(at + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) return null;
  return alias.replacement.replace('*', specifier.slice(prefix.length, specifier.length - suffix.length));
}

export function inspectTwenty1stLocalImports(files: SourceFile[]): Twenty1stLocalImportClosure {
  if (files.length > 128) return { status: 'unverified', reason: 'limit-exceeded' };
  const filePaths = new Set(files.map(file => file.path));
  const declaredAliases = aliases(files);
  if (!declaredAliases) return { status: 'unverified', reason: 'invalid-tsconfig' };
  const declaredPackages = externalPackages(files);
  const missing = new Map<string, { importer: string; specifier: string; resolvedCandidate: string }>();
  let uncertainty: Extract<Twenty1stLocalImportClosure, { status: 'unverified' }>['reason'] | null = null;
  for (const file of files) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(file.path)) continue;
    let ast: Node;
    try { ast = parse(file.content, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] }) as unknown as Node; }
    catch { return { status: 'unverified', reason: 'parse-error' }; }
    const check = (specifier: string): void => {
      if (specifier.length > 512) { uncertainty = 'limit-exceeded'; return; }
      if (specifier.startsWith('node:') && isBuiltin(specifier)) return;
      const candidates: string[] = [];
      let baseUrlFallback = false;
      if (specifier.startsWith('.')) candidates.push(path.posix.join(path.posix.dirname(file.path), specifier));
      else {
        // A tsconfig applies only inside its owning tree; its baseUrl precedes package lookup.
        const applicable = declaredAliases.filter(alias => alias.owner === '.' || file.path.startsWith(`${alias.owner}/`));
        const nearest = Math.max(-1, ...applicable.map(alias => ownerDepth(alias.owner)));
        const scoped = applicable.filter(alias => ownerDepth(alias.owner) === nearest);
        const matching = scoped.filter(alias => matchAlias(specifier, alias) !== null);
        // TypeScript selects one paths key: exact first, otherwise the matching wildcard with the longest prefix.
        const selected = matching.find(alias => alias.pattern === specifier)?.pattern
          ?? matching.reduce<string | null>((best, alias) => best === null || alias.pattern.indexOf('*') > best.indexOf('*') ? alias.pattern : best, null);
        for (const alias of matching.filter(alias => alias.pattern === selected)) {
          const match = matchAlias(specifier, alias)!;
          candidates.push(path.posix.join(alias.directory, match));
        }
        const baseUrl = scoped.find(alias => alias.pattern === '')?.baseUrl;
        if (!candidates.length && baseUrl !== undefined) { candidates.push(path.posix.join(baseUrl, specifier)); baseUrlFallback = true; }
        if (!candidates.length && (specifier.startsWith('@/') || declaredAliases.some(alias => matchAlias(specifier, alias) !== null))) uncertainty = 'invalid-tsconfig';
      }
      if (!candidates.length) return;
      const safe = candidates.map(withinBundle);
      if (safe.some(candidate => candidate === null)) { uncertainty = 'unsafe-local-path'; return; }
      if (safe.some(candidate => extensions.some(extension => filePaths.has(`${candidate}${extension}`)))) return;
      if (baseUrlFallback) {
        const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
        if (isBuiltin(specifier) || declaredPackages.some(group =>
          (group.owner === '.' || file.path.startsWith(`${group.owner}/`)) && group.names.has(name))) return;
        uncertainty = 'ambiguous-baseurl-import'; return;
      }
      const resolvedCandidate = safe[0]!;
      const key = `${file.path}\0${specifier}\0${resolvedCandidate}`;
      missing.set(key, { importer: file.path, specifier, resolvedCandidate });
    };
    const handledLoaders = new Set<Node>();
    const metadataReferences = new Set<Node>();
    const metadataNames = new Map<string, readonly string[]>([
      ['require', ['main', 'cache']],
      ['module', ['filename', 'id', 'loaded', 'path', 'paths', 'parent', 'children']],
    ]);
    const staticText = (node: Node | undefined, depth = 0): string | undefined => {
      if (!node || depth > 8) return undefined;
      let text: unknown;
      if (node.type === 'StringLiteral') text = node.value;
      if (node.type === 'TemplateLiteral' && node.expressions?.length === 0 && node.quasis?.length === 1) {
        const value = node.quasis[0]?.value;
        if (value && typeof value === 'object') text = (value as { cooked?: unknown }).cooked;
      }
      if (node.type === 'BinaryExpression' && node.operator === '+') {
        const left = staticText(node.left, depth + 1), right = staticText(node.right, depth + 1);
        if (left !== undefined && right !== undefined) text = left + right;
      }
      return typeof text === 'string' && text.length <= 512 ? text : undefined;
    };
    const memberName = (node: Node): string | undefined => node.computed
      ? staticText(node.property)
      : node.property?.name;
    const patternKey = (node: Node): string | undefined => node.computed ? staticText(node.key) : node.key?.name ?? staticText(node.key);
    const visit = (value: unknown, parent?: Node, field?: string): void => {
      if (Array.isArray(value)) { value.forEach(child => visit(child, parent, field)); return; }
      if (!value || typeof value !== 'object') return;
      const node = value as Node;
      if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type ?? '') && node.object?.type === 'Identifier'
        && metadataNames.get(node.object.name ?? '')?.includes(memberName(node) ?? '')
        && !(field === 'callee' && ['CallExpression', 'OptionalCallExpression'].includes(parent?.type ?? ''))
        && !(parent?.type === 'AssignmentExpression' && field === 'left')
        && parent?.type !== 'UpdateExpression' && !(parent?.type === 'UnaryExpression' && parent.operator === 'delete')) metadataReferences.add(node.object);
      if (node.type === 'Identifier' && metadataNames.has(node.name ?? '') && parent?.type === 'VariableDeclarator' && field === 'init'
        && parent.id?.type === 'ObjectPattern' && parent.id.properties?.every(property =>
          property.type === 'ObjectProperty' && metadataNames.get(node.name!)!.includes(patternKey(property) ?? ''))) metadataReferences.add(node);
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type ?? '') && typeof node.source?.value === 'string') check(node.source.value);
      if (node.type === 'ImportExpression' || (node.type === 'CallExpression' && node.callee?.type === 'Import')) {
        const argument = node.type === 'ImportExpression' ? node.source : node.arguments?.[0];
        if (argument?.type === 'StringLiteral' && typeof argument.value === 'string') check(argument.value);
        else uncertainty = 'dynamic-local-import';
      }
      if (node.type === 'TSExternalModuleReference') {
        if (node.expression?.type === 'StringLiteral' && typeof node.expression.value === 'string') check(node.expression.value);
        else uncertainty = 'dynamic-local-import';
      }
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const direct = callee?.type === 'Identifier' && callee.name === 'require';
        const member = callee?.type === 'MemberExpression' && callee.object?.type === 'Identifier'
          && ((callee.object.name === 'require' && memberName(callee) === 'resolve')
            || (callee.object.name === 'module' && memberName(callee) === 'require'));
        if (direct || member) {
          handledLoaders.add(callee!);
          handledLoaders.add(direct ? callee! : callee!.object!);
          const argument = node.arguments?.[0];
          if (node.arguments?.length === 1 && argument?.type === 'StringLiteral' && typeof argument.value === 'string') check(argument.value);
          else uncertainty = 'dynamic-local-import';
        }
      }
      // Loader aliases and computed/dynamic access cannot establish complete source closure.
      if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type ?? '') && node.computed && memberName(node) === undefined
        && ((field === 'callee' && ['CallExpression', 'OptionalCallExpression'].includes(parent?.type ?? ''))
          || (node.object?.type === 'Identifier' && ['globalThis', 'global'].includes(node.object.name ?? '')))) uncertainty = 'dynamic-local-import';
      if (node.type === 'ObjectProperty' && parent?.type === 'ObjectPattern') {
        const name = patternKey(node);
        if (['require', 'module', 'createRequire'].includes(name ?? '') || (node.computed && name === undefined)) uncertainty = 'dynamic-local-import';
      }
      if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type ?? '')
        && memberName(node) === 'require' && !handledLoaders.has(node)) uncertainty = 'dynamic-local-import';
      // createRequire manufactures a new loader; this bounded check does not trace its bindings.
      if ((node.type === 'Identifier' && node.name === 'createRequire')
        || (['MemberExpression', 'OptionalMemberExpression'].includes(node.type ?? '') && memberName(node) === 'createRequire')
        || (node.type === 'StringLiteral' && node.value === 'createRequire' && ['key', 'imported'].includes(field ?? ''))) uncertainty = 'dynamic-local-import';
      if (node.type === 'Identifier' && (node.name === 'require' || node.name === 'module') && !handledLoaders.has(node) && !metadataReferences.has(node)) {
        const propertyName = field === 'property' && parent?.type === 'MemberExpression' && !parent.computed;
        const objectKey = field === 'key' && ['ObjectProperty', 'ObjectMethod'].includes(parent?.type ?? '') && !parent?.computed && !parent?.shorthand;
        const exportsObject = node.name === 'module' && field === 'object' && parent?.type === 'MemberExpression' && memberName(parent) === 'exports';
        const metadataTest = (parent?.type === 'UnaryExpression' && parent.operator === 'typeof')
          || (parent?.type === 'BinaryExpression' && ['==', '!=', '===', '!=='].includes(parent.operator ?? ''));
        if (!propertyName && !objectKey && !exportsObject && !metadataTest) uncertainty = 'dynamic-local-import';
      }
      for (const [key, child] of Object.entries(node)) if (key !== 'loc' && key !== 'comments' && key !== 'tokens' && key !== 'leadingComments' && key !== 'trailingComments') visit(child, node, key);
    };
    visit(ast);
  }
  if (uncertainty) return { status: 'unverified', reason: uncertainty };
  if (!missing.size) return { status: 'resolved' };
  const sorted = [...missing.values()].sort((a, b) => compare(a.importer, b.importer) || compare(a.specifier, b.specifier) || compare(a.resolvedCandidate, b.resolvedCandidate));
  if (sorted.length > 32) return { status: 'unverified', reason: 'limit-exceeded' };
  return { status: 'missing', missing: sorted };
}
