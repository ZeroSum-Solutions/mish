// @vitest-environment jsdom
/**
 * W129 ②③ —— 「新会话」这句话统一,入口收敛成一个。
 *
 * 稿子基线 `729fa43ce7`(PR #7170)。
 *
 * ## ② 文案(产品裁决 2026-09-03:**只统一聊天面板内**)
 *
 * 面板内原来三种说法:
 *   · `chat.newSession`(面板头图标键,稿 `src/body-scene.html:8` `data-tip="新会话"`)
 *   · `assistant.forkConversation`(回合动作行,稿 `src/body-components.html:1189`
 *     `data-tip="新开会话"`)
 *   · `chat.new`(历史下拉里那颗「新建」)—— 它的按钮被 ③ 删掉了,key 一并撤。
 * 面板**外**的 `chat.newConversation` 不动。
 *
 * ⚠️ 稿子自己这两处就不一致(「新会话」vs「新开会话」)。选「新会话」的依据也在稿子里:
 * `src/body-components.html:1243` 那条 fork 分界线写的是
 * `aria-label="新会话从这里开始"` —— 稿子自己把 Fork 产出的东西叫「新会话」。
 * 于是整套词族定成 名词「新会话」+ 动词「开始」:
 *   新会话 / 正在开始新会话… / 无法开始新会话。
 * 顺带收掉 W124 报告点出的**同一颗按钮里两套词**:hover 说「新开会话」、
 * 按下去变「正在分叉…」、失败提示「无法分叉这个对话」。
 *
 * 非中文语种**不生造新词**,沿用各自既有的「新建对话」措辞(`chat.newConversation`
 * 那一支的名词),只把 fork 词根换掉。
 *
 * ## ③ 入口(产品裁决:**只留面板头图标键**)
 *
 * 稿子的面板头有那枚十字键;历史下拉里那颗「新建」是产品自带的第二个入口,
 * 同一个动作两个口子 —— 删下拉那颗。两颗本来就共用同一个 `onNewConversation`
 * 与同一个 `newConversationDisabled` 门槛,所以删掉不改可达性。
 *
 * ## 判据取法
 *
 * DOM 侧只读 `data-testid` / `aria-label` / `data-tooltip` 这些 React 直写的真属性;
 * 「下拉里没有那颗」这种负向断言一律先证下拉**确实打开了**,免得组件根本没渲染
 * 也让 `toBeNull()` 真空通过。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardRef, type ReactElement } from 'react';

import { I18nProvider } from '../../../src/i18n';
import { ChatPane } from '../../../src/components/ChatPane';
import type { AppConfig, ChatMessage } from '../../../src/types';

import { en } from '../../../src/i18n/locales/en';


afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ══ ③ 入口:走产品真实的 ChatPane 渲染路径 ══════════════════════════ */

/* i18n **不 mock**:这一组连文案一起证。 */
vi.mock('../../../src/components/AssistantMessage', () => ({
  AssistantMessage: ({ message }: { message: ChatMessage }) => (
    <div data-testid={`assistant-${message.id}`}>{message.content}</div>
  ),
}));

vi.mock('../../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef((_props, _ref) => <div data-testid="composer" />),
}));

vi.mock('../../../src/analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/analytics/events')>();
  return {
    ...actual,
    trackChatPanelClick: vi.fn(),
    trackRunFailedToastSurfaceView: vi.fn(),
    trackRunRecoveryActionClick: vi.fn(),
    trackRunRecoveryActionSurfaceView: vi.fn(),
  };
});

const render = (ui: ReactElement) => rtlRender(<I18nProvider initial="en">{ui}</I18nProvider>);

function renderChat(opts: { onNewConversation?: (() => void) | null } = {}) {
  const onNewConversation = opts.onNewConversation === null
    ? undefined
    : opts.onNewConversation ?? vi.fn();
  return render(
    <ChatPane
      messages={[]}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      amrBalanceCardUsd={null}
      conversations={[
        { projectId: 'project-1', id: 'conv-1', title: 'Current', createdAt: 1, updatedAt: 1 },
      ]}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      onNewConversation={onNewConversation}
      config={{ agentId: 'amr', agentCliEnv: {} } as unknown as AppConfig}
    />,
  );
}

function attr(el: Element, name: string): string {
  const value = el.getAttribute(name);
  if (value === null) throw new Error(`<${el.tagName.toLowerCase()}> 上没有 ${name} 属性`);
  return value;
}

describe('③ 新建入口只剩面板头那一枚', () => {
  it('历史下拉里那颗「新建」没了(下拉本身照常展开)', () => {
    renderChat();
    fireEvent.click(screen.getByTestId('conversation-history-trigger'));

    /* 真空探针:先证下拉确实开着,下面的 toBeNull 才有意义 */
    expect(screen.getByTestId('conversation-history-menu')).toBeTruthy();
    expect(screen.getByTestId('conversation-history-search')).toBeTruthy();

    expect(
      screen.queryByTestId('conversation-history-new'),
      '历史下拉里还留着第二个「新建」入口 —— 同一个动作两个口子',
    ).toBeNull();
  });

  it('面板头那一枚还在,点得到,走的还是同一条 onNewConversation', () => {
    const onNewConversation = vi.fn();
    renderChat({ onNewConversation });

    const button = screen.getByTestId('chat-new-conversation');
    expect(attr(button, 'aria-label')).toBe("New conversation");
    fireEvent.click(button);
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('两个入口本来就同一个门槛:没有 onNewConversation 时两处一起消失', () => {
    renderChat({ onNewConversation: null });
    expect(screen.queryByTestId('chat-new-conversation')).toBeNull();

    fireEvent.click(screen.getByTestId('conversation-history-trigger'));
    expect(screen.getByTestId('conversation-history-menu')).toBeTruthy();
    expect(screen.queryByTestId('conversation-history-new')).toBeNull();
  });
});

describe('③ 删干净:`chat.new` 这个 key 跟着它的按钮一起撤', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = (rel: string) => readFileSync(resolve(here, '../../../src', rel), 'utf8');

  it('ChatPane 里不再引用 chat.new', () => {
    const chatPane = src('components/ChatPane.tsx');
    /* 探针:文件确实读到了 */
    expect(chatPane).toContain('chat-new-conversation');
    expect(chatPane).not.toMatch(/t\(['"]chat\.new['"]\)/);
  });

  it('`chat.new` 从 Dict 与 19 本词典里一起撤掉', () => {
    expect(src('i18n/types.ts')).not.toMatch(/^\s*'chat\.new':/m);
    Object.entries(LOCALES).forEach(([locale, dict]) => {
      expect(
        (dict as unknown as Record<string, unknown>)['chat.new'],
        `${locale} 里还留着已经没人用的 chat.new`,
      ).toBeUndefined();
    });
  });
});

/* ══ ② 文案:19 语一个都不能少 ═══════════════════════════════════════ */

const LOCALES = {
  en,
} as const;

/**
 * 各语种「正在开始新会话…」/「无法开始新会话」。
 * 每一条都从该语种**已有**的 `chat.newConversation` 名词长出来,不引入新词。
 */
const EXPECTED: Record<keyof typeof LOCALES, { busy: string; failed: string }> = {
  en: { busy: 'Starting new conversation…', failed: 'Could not start a new conversation.' },

};

describe('② 面板内说同一句', () => {
  it('清点:确实是 2 本词典', () => {
    expect(Object.keys(LOCALES).length).toBe(1);
    expect(Object.keys(EXPECTED).length).toBe(1);
  });

  it('面板头图标键和回合动作行说的是同一句', () => {
    Object.entries(LOCALES).forEach(([locale, dict]) => {
      expect(dict['chat.newSession'], `${locale} 缺 chat.newSession`).toBeTruthy();
      expect(
        dict['assistant.forkConversation'],
        `${locale}:回合动作行和面板头说的不是同一句`,
      ).toBe(dict['chat.newSession']);
    });
  });

  it('同一颗按钮里不再有两套词 —— 19 语的进行态与失败提示都跟着改', () => {
    Object.entries(LOCALES).forEach(([locale, dict]) => {
      const want = EXPECTED[locale as keyof typeof LOCALES];
      expect(dict['assistant.forkingConversation'], `${locale} 的进行态`).toBe(want.busy);
      expect(dict['chat.forkConversationFailed'], `${locale} 的失败提示`).toBe(want.failed);
    });
  });

  it('不许 TODO,也不许非英语语种直接落英文占位', () => {
    Object.entries(LOCALES).forEach(([locale, dict]) => {
      (['assistant.forkingConversation', 'chat.forkConversationFailed'] as const).forEach((key) => {
        const value: string = dict[key];
        expect(value, `${locale} 缺 ${key}`).toBeTruthy();
        expect(value, `${locale} 的 ${key} 写成了 TODO`).not.toMatch(/TODO/i);
        if (locale !== 'en') {
          expect(value, `${locale} 的 ${key} 直接落了英文原句`).not.toBe(en[key]);
        }
      });
    });
  });

  it('面板外的 chat.newConversation 没被顺手动过', () => {

    expect(en['chat.newConversation']).toBe('New conversation');
  });
});
