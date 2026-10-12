/** Reviewed responsive utility refinements applied only to exported, checksum-verified source. */
import { parse } from '@babel/parser';

const analysisClasses = new Map([
  ['grid grid-cols-3 gap-4 border-t pt-2', 'grid grid-cols-1 gap-4 border-t pt-2 sm:grid-cols-3'],
  ['grid grid-cols-2 gap-4 lg:grid-cols-4', 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4'],
  ['grid grid-cols-2 gap-4', 'grid grid-cols-1 gap-4 sm:grid-cols-2'],
  ['flex items-center justify-between', 'flex items-center justify-between max-sm:flex-wrap max-sm:gap-2'],
  ['flex items-center justify-between text-xs', 'flex items-center justify-between text-xs max-sm:flex-wrap max-sm:gap-2'],
  ['flex items-center gap-2', 'flex items-center gap-2 max-sm:flex-wrap'],
]);
const stickyDemoClasses = new Map([
  ['flex gap-8', 'flex flex-col gap-8 sm:flex-row'],
  ['w-44 shrink-0', 'sticky top-4 z-10 w-full shrink-0 bg-background sm:static sm:z-auto sm:w-44 sm:bg-transparent'],
  ['sticky top-6 flex flex-col gap-1', 'sticky top-6 flex flex-row flex-wrap gap-1 sm:flex-col sm:flex-nowrap'],
]);

interface SourceNode {
  type?: string;
  name?: unknown;
  value?: unknown;
  start?: number | null;
  end?: number | null;
  [key: string]: unknown;
}

/**
 * Only literal JSX className values in the two reviewed owner modules change. Other files in
 * the same multi-file registry item, comments, copy, templates and computed classes stay intact.
 * The canonical StickySection module already hides its sidebar on phones; only its demo needs
 * the stacking refinement. Existing sm+ layout utilities retain their previous values.
 */
export function cultResponsiveSourceCopy(source: string, item: string): string {
  const classes = item === 'ai-artifact-chart' ? analysisClasses
    : item === 'feature-sticky-section-demo' ? stickyDemoClasses : null;
  if (!classes) return source;
  let ast: unknown;
  try { ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] }); }
  catch { return source; }

  const functions = new Set<string>();
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== 'object' || value === null) return;
    const node = value as SourceNode;
    if (node.type === 'FunctionDeclaration') {
      const id = node.id as SourceNode | null;
      if (typeof id?.name === 'string') functions.add(id.name);
    }
    if (node.type === 'JSXAttribute') {
      const name = node.name as SourceNode | null;
      const literal = node.value as SourceNode | null;
      if (name?.name === 'className' && literal?.type === 'StringLiteral' && typeof literal.value === 'string') {
        const replacement = classes.get(literal.value);
        if (replacement && typeof literal.start === 'number' && typeof literal.end === 'number') {
          edits.push({ start: literal.start, end: literal.end, replacement: JSON.stringify(replacement) });
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'comments' && key !== 'tokens') visit(child);
    }
  };
  visit(ast);
  const owner = item === 'ai-artifact-chart'
    ? functions.has('BurnRateAnalysisPanel') && functions.has('MetricsGrid')
    : functions.has('FeatureStickySectionDemo');
  if (!owner) return source;
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}
