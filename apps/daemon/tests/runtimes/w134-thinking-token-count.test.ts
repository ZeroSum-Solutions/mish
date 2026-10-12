// Owned synthetic protocol fixtures. These tests make no live CLI or provider evidence claim.
// Stop reasons use message_delta; legacy wrapper support is tested separately.
// Early path/progress events must never leak raw tool input JSON.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClaudeStreamHandler } from '../../src/runtimes/claude-stream.js';
import { daemonAgentPayloadToPersistedAgentEvent } from '../../src/runtimes/chat-run-messages.js';

type Frame = Record<string, unknown>;
type Event = Record<string, unknown>;

function readRecording(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/daemon-b/claude-stream/${name}`, import.meta.url)),
    'utf8',
  );
}

function frames(name: string): Frame[] {
  return readRecording(name)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Frame);
}

function replayRecording(name: string, options: Record<string, unknown> = {}): Event[] {
  const events: Event[] = [];
  const handler = createClaudeStreamHandler((event) => events.push(event as Event), options);
  handler.feed(readRecording(name));
  handler.flush();
  return events;
}

function syntheticSystemCounts(name: string): unknown[] {
  return frames(name)
    .filter((f) => f.type === 'system' && f.subtype === 'thinking_tokens')
    .map((f) => f.estimated_tokens);
}

function syntheticDeltaCounts(name: string): unknown[] {
  const out: unknown[] = [];
  for (const f of frames(name)) {
    if (f.type !== 'stream_event') continue;
    const event = f.event as Record<string, unknown> | undefined;
    const delta = event?.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'thinking_delta') out.push(delta.estimated_tokens);
  }
  return out;
}

function emittedCounts(events: Event[]): unknown[] {
  return events.filter((e) => e.type === 'thinking_tokens').map((e) => e.tokens);
}

const PARTIAL_RECORDINGS = [
  'partial-two-turns.jsonl',
  'partial-same-turn-echo.jsonl',
  'partial-single-turn.jsonl',
  'partial-forwarded-subagent.jsonl',
];
const NO_PARTIAL_RECORDINGS = [
  'no-partial-messages.jsonl',
  'no-partial-two-turns.jsonl',
];
const ALL_RECORDINGS = [...PARTIAL_RECORDINGS, ...NO_PARTIAL_RECORDINGS];

describe('合成样例语料:进度信号确实在流里', () => {
  it('六份合成样例每一份都带 `system/thinking_tokens`,累计值一个 null 都没有', () => {
    const total: unknown[] = [];
    for (const name of ALL_RECORDINGS) {
      const counts = syntheticSystemCounts(name);
      expect(counts.length, `${name} 里一帧都没有`).toBeGreaterThan(0);
      total.push(...counts);
    }
    expect(total.length, '语料规模变了就重新量一遍').toBe(36);
    expect(
      total.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0),
      '系统帧的累计值全是正整数',
    ).toBe(true);
  });

  it('反面:`thinking_delta` 上那个同名字段一半是 null —— 旧结论看的是它', () => {
    const all = PARTIAL_RECORDINGS.flatMap((name) => syntheticDeltaCounts(name));
    expect(all.length, 'partial 合成样例里确实有 thinking_delta').toBeGreaterThan(0);
    expect(all.some((n) => n === null), '每个块的收尾帧都是 null').toBe(true);
  });

  it('反面:delta 上那个字段是**增量**,当累计用会一路往回跳', () => {

    const name = 'partial-single-turn.jsonl';
    expect(syntheticSystemCounts(name)).toEqual([100, 292, 100, 300, 600, 900, 1122]);
    expect(syntheticDeltaCounts(name)).toEqual([100, null, 100, 200, 300, 300, null]);
  });


  it('反面:结算值是另一个数,而且样例的系统估算值与结算值不同 —— 两者不可互换', () => {
    const name = 'partial-single-turn.jsonl';
    const billed: number[] = [];
    for (const f of frames(name)) {
      if (f.type !== 'stream_event') continue;
      const event = f.event as Record<string, unknown> | undefined;
      if (event?.type !== 'message_delta') continue;
      const usage = event.usage as Record<string, unknown> | undefined;
      const details = usage?.output_tokens_details as Record<string, unknown> | undefined;
      if (typeof details?.thinking_tokens === 'number') billed.push(details.thinking_tokens);
    }

    expect(billed).toEqual([182, 900]);
    const estimatedBlockEnds = [292, 1122];
    for (const [i, settled] of billed.entries()) {
      expect(estimatedBlockEnds[i]! > settled, `第 ${i + 1} 块的估算值应当偏大`).toBe(true);
    }
  });

  it('反面:不开 `--include-partial-messages` 时 delta 帧一帧都没有,系统帧一帧不少', () => {
    for (const name of NO_PARTIAL_RECORDINGS) {
      expect(syntheticDeltaCounts(name), `${name} 没有 stream_event`).toEqual([]);
      expect(syntheticSystemCounts(name).length, `${name} 的系统帧还在`).toBeGreaterThan(0);
    }
  });
});

describe('daemon 把推理 token 计数发出来', () => {
  it('每一份合成样例发出的数,逐个等于合成样例里那些系统帧的累计值', () => {
    for (const name of ALL_RECORDINGS) {
      expect(emittedCounts(replayRecording(name)), name).toEqual(syntheticSystemCounts(name));
    }
  });

  it('不开 `--include-partial-messages` 的 CLI 上照样发得出来', () => {

    const events = replayRecording('no-partial-messages.jsonl');
    expect(events.some((e) => e.type === 'stream_event')).toBe(false);
    expect(emittedCounts(events)).toEqual([2, 32, 62, 86, 306, 2, 4, 28, 30, 208]);
  });

  it('计数按 thinking 块从头累计 —— 换一块就从小数重新开始', () => {

    const counts = emittedCounts(replayRecording('no-partial-two-turns.jsonl'));
    expect(counts).toEqual([100, 300, 520, 100, 306, 100, 302]);
  });

  it('值原样搬运,不做换算 —— 发出来的数只可能来自帧里', () => {
    for (const name of ALL_RECORDINGS) {
      const synthetic = new Set(syntheticSystemCounts(name));
      for (const n of emittedCounts(replayRecording(name))) {
        expect(synthetic.has(n), `${name} 发出了合成样例里没有的 ${String(n)}`).toBe(true);
      }
    }
  });

  it('不带计数的帧不发事件 —— 缺字段 / 非数 / 负数一律当没有', () => {
    const events: Event[] = [];
    const handler = createClaudeStreamHandler((e) => events.push(e as Event));
    handler.feed([
      '{"type":"system","subtype":"thinking_tokens","session_id":"s"}',
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":null,"session_id":"s"}',
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":"120","session_id":"s"}',
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":-5,"session_id":"s"}',
      '{"type":"system","subtype":"thinking_tokens","estimated_tokens":120,"session_id":"s"}',
      '',
    ].join('\n'));
    handler.flush();
    expect(emittedCounts(events)).toEqual([120]);
  });


  it('不落库 —— 这种事件不许变成持久化事件', () => {
    expect(daemonAgentPayloadToPersistedAgentEvent({ type: 'thinking_tokens', tokens: 3278 }))
      .toBeNull();

    expect(daemonAgentPayloadToPersistedAgentEvent({ type: 'thinking_delta', delta: '想…' }))
      .toEqual({ kind: 'thinking', text: '想…' });
  });

  it('系统帧照旧不落进正文 —— 一个字符都不许流到回答里', () => {
    for (const name of ALL_RECORDINGS) {
      const text = replayRecording(name)
        .filter((e) => e.type === 'text_delta' && typeof e.delta === 'string')
        .map((e) => e.delta as string)
        .join('');
      expect(text, name).not.toContain('thinking_tokens');
      expect(text, name).not.toContain('estimated_tokens');
    }
  });
});
