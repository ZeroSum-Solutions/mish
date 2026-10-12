import { expect, it } from 'vitest';
import { observeComponentTokens } from '../../src/workbench/component-token-evidence.js';
const ref = { sourceType: 'section', sourceId: 'sections', itemId: 'button', revisionOrDigest: 'v1' } as const;
it('observes actual CSS token bindings at the source revision without guessing TSX/theme adaptability', () => {
  const file = (path: string, content: string) => ({ path, role: 'source' as const, bytes: Buffer.from(content) });
  const bound = observeComponentTokens(ref, [file('button.html', '<style>.button{color:var(--foreground);border-radius:var(--radius);font-family:var(--font-family)}</style>')]);
  expect(bound).toMatchObject({ sourceRevisionOrDigest: 'v1', color: 'adaptable', radius: 'adaptable', type: 'adaptable' });
  expect(bound.evidenceRef).toMatch(/^source-css-bindings:[a-f0-9]{64}$/u);
  expect(observeComponentTokens(ref, [file('button.tsx', 'export const Button = () => <button className="rounded-md text-primary" />')])).toMatchObject({ color: 'unknown', radius: 'unknown', type: 'unknown' });
  expect(observeComponentTokens(ref, [file('button.css', '.button{color:red;border-radius:4px;font-family:sans-serif}')])).toMatchObject({ color: 'fixed', radius: 'fixed', type: 'fixed' });
});
it('does not let a comment or broken stylesheet count as adaptability evidence', () => {
  const evidence = observeComponentTokens(ref, [{ path: 'button.css', role: 'style', bytes: Buffer.from('/* color:var(--brand); border-radius:var(--radius); font-family:var(--font); */') }]);
  expect(evidence).toMatchObject({ color: 'unknown', radius: 'unknown', type: 'unknown' });
});
it('does not hide fixed shorthands, inline styles, local variables or runtime styling behind token bindings', () => {
  const css = '.button{color:var(--fg);border-radius:var(--radius);font:var(--font)}';
  const file = (path: string, text: string) => ({ path, role: 'source' as const, bytes: Buffer.from(text) });
  expect(observeComponentTokens(ref, [file('button.css', `${css}.button{background:#fff;border:1px solid #000}`)]).color).toBe('fixed');
  expect(observeComponentTokens(ref, [file('button.html', `<style>${css}</style><button style="color:red">x</button>`)]).color).toBe('fixed');
  expect(observeComponentTokens(ref, [file('button.html', `<style>${css}</style><button style=color:red>x</button>`)]).color).toBe('unknown');
  expect(observeComponentTokens(ref, [file('button.css', `${css}.button{--fg:red}`)]).color).toBe('fixed');
  expect(observeComponentTokens(ref, [file('button.css', css), file('button.tsx', 'export const Button = () => <button style={{color:"red"}} />')]).color).toBe('unknown');
  for (const channel of ['<iframe src="external.html"></iframe>', '<object data="external.html"></object>', '<embed src="external.html">', '<link rel="stylesheet" href="theme.css">', '<svg fill="#f00"></svg>', '<button onclick="this.style.color=\'red\'">x</button>']) {
    expect(observeComponentTokens(ref, [file('button.html', `<style>${css}</style>${channel}`)]).color).toBe('unknown');
  }
  expect(observeComponentTokens(ref, [file('button.css', `@import "theme.css";${css}`)]).color).toBe('unknown');
  expect(observeComponentTokens(ref, [file('button.css', `${css}.button{border:1px solid var(--border)}`)]).color).toBe('unknown');
});
