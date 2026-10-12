// Owned synthetic protocol fixtures. These tests make no live CLI or provider evidence claim.
// Stop reasons use message_delta; legacy wrapper support is tested separately.
// Early path/progress events must never leak raw tool input JSON.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClaudeStreamHandler } from '../../src/runtimes/claude-stream.js';

type Event = Record<string, unknown>;

function readRecording(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/daemon-b/claude-stream/${name}`, import.meta.url)),
    'utf8',
  );
}

function replayWithLineNumbers(source: string, options: Record<string, unknown> = {}): Event[] {
  const events: Event[] = [];
  let line = 0;
  const handler = createClaudeStreamHandler((event) => {
    events.push({ __line: line, ...(event as Event) });
  }, options);
  for (const raw of source.split('\n')) {
    if (!raw.trim()) continue;
    line += 1;
    handler.feed(`${raw}\n`);
  }
  handler.flush();
  return events;
}

const SINGLE_TURN = 'partial-single-turn.jsonl';
const TWO_TURNS = 'partial-two-turns.jsonl';
const ECHO = 'partial-same-turn-echo.jsonl';
const NO_PARTIAL = 'no-partial-messages.jsonl';

function firstOfType(events: Event[], type: string): Event | undefined {
  return events.find((event) => event.type === type);
}

describe('W115 · 在途写文件行的文件名', () => {

  it('前提:合成样例里路径字符比 tool_use 早好几帧(模拟分片空窗)', () => {
    const events = replayWithLineNumbers(readRecording(SINGLE_TURN));
    const deltas = events.filter((event) => event.type === 'tool_input_delta');
    const toolUse = firstOfType(events, 'tool_use');

    expect(deltas.length, '合成样例里没有 input_json_delta —— 换一份合成样例').toBeGreaterThan(3);
    expect(toolUse, '合成样例里没有 tool_use').toBeDefined();

    const assembled = deltas.map((event) => String(event.delta)).join('');
    expect(assembled).toContain('alpha.html');

    let acc = '';
    let pathCompleteLine = -1;
    for (const delta of deltas) {
      acc += String(delta.delta);
      if (pathCompleteLine < 0 && /alpha\.html"/u.test(acc)) pathCompleteLine = Number(delta.__line);
    }
    expect(pathCompleteLine).toBeGreaterThan(0);
    expect(Number(toolUse?.__line)).toBeGreaterThan(pathCompleteLine);
  });


  it('路径一收尾就发一次 tool_input_target,早于 tool_use', () => {
    const events = replayWithLineNumbers(readRecording(SINGLE_TURN));
    const target = firstOfType(events, 'tool_input_target');
    const toolUse = firstOfType(events, 'tool_use');

    expect(target, '路径已经完整了,却没有任何事件带着文件名').toBeDefined();
    expect(target?.name).toBe('Write');
    expect(String(target?.path)).toMatch(/alpha\.html$/u);
    expect(target?.id).toBe(toolUse?.id);

    expect(
      Number(target?.__line),
      '文件名和 tool_use 同一帧到 —— 等于没提前',
    ).toBeLessThan(Number(toolUse?.__line));
  });


  it('同一个工具调用只发一次', () => {
    const events = replayWithLineNumbers(readRecording(SINGLE_TURN));
    const targets = events.filter((event) => event.type === 'tool_input_target');
    expect(targets).toHaveLength(1);
  });


  it('提前发的路径和最终 tool_use.input 里的完全一致', () => {
    for (const fixture of [SINGLE_TURN, TWO_TURNS, ECHO]) {
      const events = replayWithLineNumbers(readRecording(fixture));
      const targets = events.filter((event) => event.type === 'tool_input_target');
      expect(targets.length, `${fixture}: 一个 target 都没有`).toBeGreaterThan(0);

      for (const target of targets) {
        const finalCall = events.find(
          (event) => event.type === 'tool_use' && event.id === target.id,
        );
        expect(finalCall, `${fixture}: target ${String(target.id)} 没有对应的 tool_use`).toBeDefined();
        const input = finalCall?.input as Record<string, unknown> | undefined;
        expect(
          input?.file_path ?? input?.path,
          `${fixture}: 提前发的名字和最终入参对不上`,
        ).toBe(target.path);
      }
    }
  });


  it('反向:target 事件里没有一个字节的 content', () => {
    const events = replayWithLineNumbers(readRecording(SINGLE_TURN));
    const targets = events.filter((event) => event.type === 'tool_input_target');
    expect(targets.length).toBeGreaterThan(0);

    for (const target of targets) {
      const { __line: _line, ...payload } = target;

      expect(Object.keys(payload).sort()).toEqual(['id', 'name', 'path', 'startedAt', 'type'].sort());

      expect(typeof payload.startedAt, 'startedAt 不是数字 —— 白名单被塞了别的东西').toBe('number');
      const serialized = JSON.stringify(payload);
      expect(serialized, '文件正文漏进 target 事件了').not.toContain('doctype');
      expect(serialized).not.toContain('<h1>');

      expect(serialized.length).toBeLessThan(400);
    }
  });


  it('反向:路径值还没收尾时一个字都不发', () => {
    const events: Event[] = [];
    const handler = createClaudeStreamHandler((event) => events.push(event as Event));
    for (const frame of frameShape([
      '{"content": "<!doctype html><html><body><h1>x</h1>',
      '</body></html>", "file_path": "/repo/late.h',
    ])) {
      handler.feed(`${JSON.stringify(frame)}\n`);
    }

    expect(
      events.filter((event) => event.type === 'tool_input_target'),
      '路径只到 "/repo/late.h" 就把半截名字发出去了',
    ).toHaveLength(0);
  });


  it('正向对照:同一条流里路径一收尾就发(不是永远不发)', () => {
    const events: Event[] = [];
    const handler = createClaudeStreamHandler((event) => events.push(event as Event));
    for (const frame of frameShape([
      '{"content": "<html></html>", "file_path": "/repo/late.h',
      'tml"}',
    ])) {
      handler.feed(`${JSON.stringify(frame)}\n`);
    }
    const targets = events.filter((event) => event.type === 'tool_input_target');
    expect(targets).toHaveLength(1);
    expect(targets[0]?.path).toBe('/repo/late.html');
  });


  it('反向:Bash / Grep 不发 target', () => {
    for (const [tool, json] of [
      ['Bash', ['{"command": "cat > /repo/login.html <<', "'ODEOF'\"}"]],
      ['Grep', ['{"pattern": "foo", "path": "/repo', '/src"}']],
    ] as const) {
      const events: Event[] = [];
      const handler = createClaudeStreamHandler((event) => events.push(event as Event));
      for (const frame of frameShape([...json], tool)) {
        handler.feed(`${JSON.stringify(frame)}\n`);
      }
      expect(
        events.filter((event) => event.type === 'tool_input_target'),
        `${tool} 也发了 target —— 这一档只给确实写文件的工具`,
      ).toHaveLength(0);
    }
  });


  it('反向:没有 partial-messages 的合成样例里 tool_use 不受影响', () => {
    const events = replayWithLineNumbers(readRecording(NO_PARTIAL));
    expect(events.filter((event) => event.type === 'tool_input_target')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'tool_use').length).toBeGreaterThan(0);
  });
});

function frameShape(partials: string[], toolName = 'Write'): Record<string, unknown>[] {
  const wrap = (event: Record<string, unknown>): Record<string, unknown> => ({
    type: 'stream_event',
    uuid: 'w115',
    session_id: 'w115',
    parent_tool_use_id: null,
    event,
  });
  return [
    wrap({
      type: 'message_start',
      message: { id: 'msg_w115', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null },
    }),
    wrap({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_w115', name: toolName, input: {} },
    }),
    ...partials.map((partial_json) =>
      wrap({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } }),
    ),
  ];
}
