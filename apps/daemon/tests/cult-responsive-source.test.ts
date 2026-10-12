import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { cultResponsiveSourceCopy } from '../src/cult-responsive-source.js';

// Pinned registry excerpts from burn-rate-analysis-panel.tsx and feature-sticky-section-demo.tsx.
// Keep the exact reviewed class literals; full licensed modules remain in the private source kit.
const analysis = `
function MetricsGrid() {
  return <div className="grid grid-cols-2 gap-4 lg:grid-cols-4"><p>$390,000</p></div>;
}
export function BurnRateAnalysisPanel() {
  return <div>
    <div className="grid grid-cols-3 gap-4 border-t pt-2"><div>$390,000</div><div>$540,000</div><div>-$150,000</div></div>
    <div className="grid grid-cols-2 gap-4">
      <div className="flex items-center justify-between"><span>Total Revenue</span><span>$390,000</span></div>
      <div className="flex items-center justify-between text-xs"><span>2026-01</span><span>$40,000</span></div>
    </div>
  </div>;
}`;
const stickyDemo = `
function FeatureStickySectionDemo() {
  return <StickySection.Root>
    <div className="flex gap-8">
      <aside className="w-44 shrink-0">
        <StickySection.List asChild><ul className="sticky top-6 flex flex-col gap-1"><li>Overview</li></ul></StickySection.List>
      </aside>
      <StickySection.Content asChild><div className="min-w-0 flex-1 space-y-24">Overview Details Summary</div></StickySection.Content>
    </div>
  </StickySection.Root>;
}`;
const parseTsx = (source: string) => parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });

describe('reviewed responsive source exports', () => {
  it('stacks monetary columns on phones and restores original columns at sm/lg without changing values', () => {
    const result = cultResponsiveSourceCopy(analysis, 'ai-artifact-chart');
    expect(result).toContain('grid grid-cols-1 gap-4 border-t pt-2 sm:grid-cols-3');
    expect(result).toContain('grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4');
    expect(result).toContain('grid grid-cols-1 gap-4 sm:grid-cols-2');
    expect(result).toContain('max-sm:flex-wrap max-sm:gap-2');
    expect(result.match(/\$[\d,]+/g)).toEqual(analysis.match(/\$[\d,]+/g));
    expect(() => parseTsx(result)).not.toThrow();
  });

  it('stacks the demo navigation and retains all triggers, panel content and the original sm sidebar width', () => {
    const result = cultResponsiveSourceCopy(stickyDemo, 'feature-sticky-section-demo');
    expect(result).toContain('flex flex-col gap-8 sm:flex-row');
    expect(result).toContain('sticky top-4 z-10 w-full shrink-0 bg-background sm:static sm:z-auto sm:w-44 sm:bg-transparent');
    expect(result).toContain('flex-row flex-wrap gap-1 sm:flex-col sm:flex-nowrap');
    expect(result).toContain('<li>Overview</li>');
    expect(result).toContain('Overview Details Summary');
    expect(() => parseTsx(result)).not.toThrow();
    expect(cultResponsiveSourceCopy(result, 'feature-sticky-section-demo')).toBe(result);
  });

  it('leaves the already-responsive canonical sticky module and converted compositions unchanged', () => {
    const canonical = 'export function StickySection() { return <aside className="sticky top-0 hidden w-72 shrink-0 flex-col self-start p-10 md:flex"/>; }';
    expect(cultResponsiveSourceCopy(canonical, 'feature-sticky-section')).toBe(canonical);
    for (const item of ['marketing-integrations-2', 'marketing-integrations-vertical', 'marketing-model-comparison-table-1', 'marketing-hero-ribbon', 'unknown']) {
      expect(cultResponsiveSourceCopy(analysis, item)).toBe(analysis);
    }
  });

  it('does not apply an owner item decision to another file in that multi-file item', () => {
    const unrelated = 'export function BurnRateChart(){return <div className="grid grid-cols-2 gap-4"/>;}';
    expect(cultResponsiveSourceCopy(unrelated, 'ai-artifact-chart')).toBe(unrelated);
    expect(cultResponsiveSourceCopy(stickyDemo, 'ai-artifact-chart')).toBe(stickyDemo);
    expect(cultResponsiveSourceCopy(analysis, 'feature-sticky-section-demo')).toBe(analysis);
  });

  it('preserves upstream changes, computed classes, comments and source-like text', () => {
    const source = `// <aside className="w-44 shrink-0">
const documentation = '<aside className="w-44 shrink-0">';
function FeatureStickySectionDemo(){return <div className={cn("flex gap-8")}><aside className="w-48 shrink-0"/></div>;}`;
    expect(cultResponsiveSourceCopy(source, 'feature-sticky-section-demo')).toBe(source);
    const malformed = 'function FeatureStickySectionDemo(){ return <div className="flex gap-8">';
    expect(cultResponsiveSourceCopy(malformed, 'feature-sticky-section-demo')).toBe(malformed);
  });
});
