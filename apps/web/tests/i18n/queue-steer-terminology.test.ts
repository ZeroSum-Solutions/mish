/**
 * OPEND-2613 —— 队列那一族文案统一用产品术语:英文 steer,中文「引导」。
 *
 * 屏幕上今天只剩一句:队列行领头那颗按钮的名字 `chat.queuedSteer`,三处
 * (可见标签 / `title` / `data-tooltip` / `aria-label`)逐字相同,由
 * `tests/components/chat/queue-steer-single-button.test.tsx` 量渲染结果。
 *
 * 这一页管的是同一族里**当下没有消费方**的那几条:
 * `chat.queuedSteerInterrupts` / `Unsupported` / `Closed` / `Failed` / `TextOnly`。
 * 其中 `Interrupts`(「会中断当前运行」)是 2026-09-08 那次并按钮之后转入休眠的
 * —— 它曾挂在引导键的 hover 上,而交付稿
 * (`729fa43ce7:docs/design/chat-panel-next.html` 组件 17)写的是
 * `data-tip="引导对话"`,收敛回稿子之后这句话在屏幕上没有位置了。
 *
 * 为什么没有消费方还要钉:这一族说的事(为什么此刻引导不了、这一轮什么状态)
 * 随时可能被接回屏幕上 —— `QueuedSendStrip` 的 `steerBlockedReason` 也是**故意
 * 留着没删**的(见 `ChatPane.tsx` 那条 docblock:这句解释该摆在界面哪里还没
 * 裁决)。等它接回来的那天才发现中文写的是「插话」,就晚了。参照仓库先例:
 * 休眠件还在就不删键(`specs/current/chat-panel-decisions-sheet.md`「六个
 * `qf.visual*` 键一个不删」)。
 *
 * ⚠️ **这是一条对文案数据的 lint,不是行为测试。** 它读词典、断言词典,
 * 证明不了任何用户在屏幕上看到的事 —— 屏幕那一半在 w117 那一页。
 * 它能挡住的只有一件事:有人在这一族里重新写下「插话」。
 *
 * English is the only shipped locale (owner decision 2026-10-10).
 * Keep the specific English terminology assertion and general key checks.
 */
import { describe, expect, it } from 'vitest';

import { en } from '../../src/i18n/locales/en';

import type { Dict } from '../../src/i18n/types';

/** 队列「引导对话」那一族的全部文案键。 */
const STEER_KEYS = [
  'chat.queuedSteer',
  'chat.queuedSteerInterrupts',
  'chat.queuedSteerUnsupported',
  'chat.queuedSteerClosed',
  'chat.queuedSteerFailed',
  'chat.queuedSteerTextOnly',
] as const satisfies ReadonlyArray<keyof Dict>;

const ALL_LOCALES: ReadonlyArray<readonly [string, Dict]> = [
  ['en', en],
  ["en", en],
];

describe('OPEND-2613:队列「引导对话」一族的术语', () => {
  it('先证明这把尺子够得着 —— 每一条都真的存在且非空', () => {
    // 键写错时 `dict[key]` 是 undefined —— 下面这条断言会变成看不出问题的空断言。
    for (const [locale, dict] of ALL_LOCALES) {
      for (const key of STEER_KEYS) {
        expect(typeof dict[key], `${locale} ${key}`).toBe('string');
        expect((dict[key] ?? '').length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('说得出这个动作的那几条,英文用 steer', () => {
    // 英文侧:动作名那两条已经用 steer,不可用那条今天说的是「收不了消息」——
    // 描述的是同一件事,没有错词可查,所以这里只钉这两条。
    expect(en['chat.queuedSteer']).toMatch(/steer/i);
    expect(en['chat.queuedSteerInterrupts']).toMatch(/steer/i);
    // `Interrupts` 今天不上屏,但它休眠前说的那件事必须留住 —— 接回来的那天
    // 它得还在说「会中断」,而不是在中途被改成别的意思。
    expect(en['chat.queuedSteerInterrupts']).toMatch(/interrupt|stop/i);
  });
});
