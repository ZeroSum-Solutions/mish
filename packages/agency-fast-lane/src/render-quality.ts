/** Concrete structural output checks, independent from facts and visual evaluation. */
export type RenderQualityCheck = 'page-heading' | 'unique-ids' | 'form-labels' | 'link-destinations';
export type RenderQualityIssue = { check: RenderQualityCheck; target: string; reason: string };
export type RenderQualityReport = { passed: boolean; checks: RenderQualityCheck[]; issues: RenderQualityIssue[]; scope: 'site' | 'static-prototype' };
export class RenderQualityError extends Error {
  readonly code = 'render-quality-failed';
  readonly report: RenderQualityReport;
  constructor(report: RenderQualityReport) {
    super('Rendered output failed structure checks');
    this.name = 'RenderQualityError'; this.report = report;
  }
}
function decoded(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', colon: ':', Tab: '\t', NewLine: '\n' };
  return value.replace(/&(#x[\da-f]+;?|#\d+;?|[a-z]+;)/gi, (all, entity: string) => {
    const key = entity.replace(/;$/, '');
    if (!key.startsWith('#')) return named[key] ?? all;
    const code = key.toLowerCase().startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}
function text(html: string): string {
  let plain = '', at = 0;
  for (const tag of tagsOf(html)) { plain += html.slice(at, tag.start); at = tag.end; }
  return decoded(plain + html.slice(at)).trim();
}
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tail = tag.replace(/^<\/?[a-z][a-z0-9-]*/i, '').replace(/\/?\s*>$/, '');
  for (const m of tail.matchAll(/([a-z_:][a-z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi)) out[m[1]!.toLowerCase()] = decoded(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}
type Tag = { name: string; attrs: Record<string, string>; start: number; end: number; close: boolean };
/** Quote-aware tags. Raw/inert elements and comments are removed before this scan. */
function tagsOf(source: string): Tag[] {
  const tags: Tag[] = [];
  const begin = /<\/?([a-z][a-z0-9-]*)\b/gi;
  for (let m = begin.exec(source); m; m = begin.exec(source)) {
    let quote = '', end = m.index + m[0].length;
    for (; end < source.length; end++) {
      const char = source[end]!;
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= source.length) break;
    tags.push({ name: m[1]!.toLowerCase(), attrs: attributes(source.slice(m.index, end + 1)), start: m.index, end: end + 1, close: source[m.index + 1] === '/' });
    begin.lastIndex = end + 1;
  }
  return tags;
}
export function checkRenderQuality(html: string, scope: 'site' | 'static-prototype' = 'site'): RenderQualityReport {
  const source = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const all = tagsOf(source), tags = all.filter((tag) => !tag.close), issues: RenderQualityIssue[] = [], checks: RenderQualityCheck[] = ['unique-ids'];
  const stack: Tag[] = [], contentEnds = new Map<number, number>(), hidden = new Set<number>();
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const tag of all) {
    if (tag.close) {
      const index = stack.findLastIndex(open => open.name === tag.name);
      if (index >= 0) { contentEnds.set(stack[index]!.start, tag.start); stack.splice(index); }
    } else {
      if (tag.attrs['aria-hidden'] === 'true' || 'hidden' in tag.attrs || stack.some(parent => hidden.has(parent.start))) hidden.add(tag.start);
      if (!voids.has(tag.name) && !/\/\s*>$/.test(source.slice(tag.start, tag.end))) stack.push(tag);
    }
  }
  const ids = new Map<string, Tag[]>();
  for (const tag of tags) if (tag.attrs.id) ids.set(tag.attrs.id, [...(ids.get(tag.attrs.id) ?? []), tag]);
  for (const [id, entries] of ids) if (entries.length > 1) issues.push({ check: 'unique-ids', target: id, reason: 'duplicate id' });
  const content = (tag: Tag) => {
    const end = contentEnds.get(tag.start);
    return end === undefined ? '' : source.slice(tag.end, end);
  };
  if (scope === 'site') {
    checks.push('page-heading', 'form-labels', 'link-destinations');
    const headings = tags.filter((tag) => tag.name === 'h1' && !hidden.has(tag.start));
    if (headings.length !== 1) issues.push({ check: 'page-heading', target: 'h1', reason: 'expected exactly one page heading' });
    else if (!text(content(headings[0]!)) && !headings[0]!.attrs['aria-label']?.trim() && !tagsOf(content(headings[0]!)).some((tag) => tag.name === 'img' && tag.attrs.alt?.trim())) issues.push({ check: 'page-heading', target: 'h1', reason: 'empty page heading' });
    const labels = tags.filter((tag) => tag.name === 'label' && text(content(tag)).length > 0);
    for (const tag of tags.filter((tag) => ['input', 'select', 'textarea'].includes(tag.name))) {
      if (tag.name === 'input' && ['hidden', 'submit', 'reset', 'button', 'image'].includes((tag.attrs.type ?? '').toLowerCase())) continue;
      // Disabled and hidden from assistive technology: decoration nobody can operate or reach. An
      // enabled control still needs a label even when hidden or out of the tab order (tabindex -1
      // only leaves the tab sequence; it stays focusable).
      if (hidden.has(tag.start) && 'disabled' in tag.attrs) continue;
      const a = tag.attrs;
      const labelledBy = a['aria-labelledby']?.trim().split(/\s+/).some((id) => (ids.get(id) ?? []).some((element) => text(content(element)).length > 0));
      const labelled = a['aria-label']?.trim() || a.title?.trim() || labelledBy || labels.some((label) => (a.id && label.attrs.for === a.id) || (!('for' in label.attrs) && label.start < tag.start && label.end + content(label).length >= tag.end));
      if (!labelled) issues.push({ check: 'form-labels', target: a.id || a.name || tag.name, reason: 'missing accessible label' });
    }
    for (const tag of tags.filter((tag) => tag.name === 'a' && tag.attrs.href !== undefined)) {
      const href = tag.attrs.href!.trim();
      let valid = false;
      if (href.startsWith('#')) {
        try { valid = href.length > 1 && ids.has(decodeURIComponent(href.slice(1))); } catch { /* malformed fragment */ }
      } else {
        let safeScheme = /^(?:mailto:|tel:)\S+/i.test(href);
        if (/^https?:\/\//i.test(href)) {
          try { safeScheme = new URL(href).hostname.length > 0; } catch { /* invalid absolute URL */ }
        }
        const relative = href.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !/[\u0000-\u001f\u007f\\]/.test(href);
        valid = (safeScheme || relative) && !/[\u0000-\u001f\u007f]/.test(href);
      }
      if (!valid) issues.push({ check: 'link-destinations', target: tag.attrs['data-od-id'] || href || 'a', reason: 'missing or unresolved link destination' });
    }
  }
  return { passed: issues.length === 0, checks, issues, scope };
}
