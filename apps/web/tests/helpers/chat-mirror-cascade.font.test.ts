// @vitest-environment jsdom
/**
 * 量尺的第三个零件:**`font` 简写**和**套在 fallback 里的 `var()`**。
 *
 * UI system(`docs/design/ui-system.md` §Type)规定 type role 一律用
 * `font: var(--font-*)` 简写。共享 `Button` 的 `.button` 按这条改写之后,量尺
 * 看不见简写,把那颗按钮的字重读成了 chat.css 一条 (0,0,1) 规则的值 —— 浏览器里
 * (0,1,0) 的简写照样把 font-weight 写成 500。这里校三件事:
 *   ① 简写落到 font-weight / font-size / line-height / font-family 四条长手上,
 *      没写的 weight / line-height 取初始值 `normal`;
 *   ② 简写按自己选择器的特异性参加层叠,同一条规则里后写的长手照样赢;
 *   ③ fallback 里再套一层 `var()` 时按括号深度配对,不在内层 `)` 处截断。
 */
import { describe, expect, it } from 'vitest';
import { createResolver, fontLonghand } from './chat-mirror-cascade';

const TOKENS = ':root { --w: 500; --size: 14px; --sans: "Albert Sans", sans-serif; --role: var(--w) var(--size) / normal var(--sans); }';
const TARGETS = ['font-weight', 'font-size', 'line-height', 'font-family'] as const;

function resolverFor(css: string) {
  return createResolver([css], [TOKENS], TARGETS);
}

describe('chat-mirror-cascade · font 简写', () => {
  it('拆开一条已解完 var 的简写', () => {
    const v = '600 13px/20px "Albert Sans", sans-serif';
    expect(fontLonghand(v, 'font-weight')).toBe('600');
    expect(fontLonghand(v, 'font-size')).toBe('13px');
    expect(fontLonghand(v, 'line-height')).toBe('20px');
    expect(fontLonghand(v, 'font-family')).toBe('"Albert Sans", sans-serif');
  });

  it('没写 weight / line-height 时取初始值 normal', () => {
    expect(fontLonghand('italic 12px serif', 'font-weight')).toBe('normal');
    expect(fontLonghand('italic 12px serif', 'line-height')).toBe('normal');
  });

  it('拆不开就大声失败,不读成一个像样的假值', () => {
    expect(fontLonghand('caption', 'font-weight')).toMatch(/^<unparsed font:/);
  });

  it('`font: var(--role)` 解开 token 后落到四条长手', () => {
    document.body.innerHTML = '<button class="b"></button>';
    const el = document.querySelector('.b')!;
    expect(resolverFor('.b { font: var(--role) }').resolved(el)).toEqual({
      'font-weight': '500',
      'font-size': '14px',
      'line-height': 'normal',
      'font-family': '"Albert Sans", sans-serif',
    });
  });

  it('fallback 里套 var() 时按括号配对,不截断', () => {
    document.body.innerHTML = '<button class="b"></button>';
    const el = document.querySelector('.b')!;
    const got = resolverFor('.b { font: var(--missing, 600 12px / 16px var(--sans)) }').resolved(el);
    expect(got['font-weight']).toBe('600');
    expect(got['font-family']).toBe('"Albert Sans", sans-serif');
  });

  it('类名上的简写压过 (0,0,1) 的长手;同一条规则里后写的长手赢', () => {
    document.body.innerHTML = '<div data-root><button class="b"></button></div>';
    const el = document.querySelector('.b')!;
    const css = ':where([data-root]) button { font-weight: 400 } .b { font: var(--role) }';
    expect(resolverFor(css).resolved(el)['font-weight']).toBe('500');
    expect(resolverFor(css).declaring(el, 'font-weight').at(-1)?.selector).toBe('.b');
    expect(resolverFor('.b { font: inherit; font-weight: 700 }').resolved(el)).toMatchObject({
      'font-weight': '700',
      'line-height': 'inherit',
    });
  });
});
