// Owned synthetic protocol fixtures. These tests make no live CLI or provider evidence claim.
// Stop reasons use message_delta; legacy wrapper support is tested separately.
// Early path/progress events must never leak raw tool input JSON.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClaudeStreamHandler } from '../../src/runtimes/claude-stream.js';
import { stampToolTiming } from '../../src/runtimes/tool-timing.js';

type Event = Record<string, unknown>;
type Frame = Record<string, unknown>;

const SINGLE_TURN = 'partial-single-turn.jsonl';

function readRecording(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/daemon-b/claude-stream/${name}`, import.meta.url)),
    'utf8',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function syntheticEnvelope(): { start: Frame; delta: Frame; stop: Frame; fragmentLengths: number[] } {
  const frames = readRecording(SINGLE_TURN)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Frame);

  let start: Frame | null = null;
  let delta: Frame | null = null;
  let stop: Frame | null = null;
  const fragmentLengths: number[] = [];
  let inToolBlock = false;

  for (const frame of frames) {
    if (frame.type !== 'stream_event' || !isRecord(frame.event)) continue;
    const inner = frame.event;
    if (
      inner.type === 'content_block_start' &&
      isRecord(inner.content_block) &&
      inner.content_block.type === 'tool_use'
    ) {
      start = frame;
      inToolBlock = true;
      continue;
    }
    if (!inToolBlock) continue;
    if (inner.type === 'content_block_delta' && isRecord(inner.delta)) {
      if (inner.delta.type !== 'input_json_delta') continue;
      delta ??= frame;
      const partial = inner.delta.partial_json;
      if (typeof partial === 'string' && partial.length > 0) fragmentLengths.push(partial.length);
      continue;
    }
    if (inner.type === 'content_block_stop') {
      stop = frame;
      inToolBlock = false;
    }
  }

  expect(start, '合成样例里没有 tool_use 的 content_block_start —— 外壳取不到').not.toBeNull();
  expect(delta, '合成样例里没有 input_json_delta —— 外壳取不到').not.toBeNull();
  expect(stop, '合成样例里没有 content_block_stop —— 外壳取不到').not.toBeNull();
  expect(fragmentLengths.length, '合成样例里一个非空分片都没有').toBeGreaterThan(3);

  return { start: start!, delta: delta!, stop: stop!, fragmentLengths };
}

function chunkLikeRecording(json: string, lengths: number[]): string[] {
  const out: string[] = [];
  let i = 0;
  let k = 0;
  while (i < json.length) {
    const size = lengths[k % lengths.length]!;
    out.push(json.slice(i, i + size));
    i += size;
    k += 1;
  }
  return out;
}

const BLOCK_START_AT = 1_788_000_000_000;

const TICK_MS = 1_000;

interface Replay {
  events: Event[];

  blockStartAt: number;

  argumentsClosedAt: number;
}

function replay(options: {
  toolName: string;
  args: Record<string, unknown>;
}): Replay {
  const envelope = syntheticEnvelope();
  const fragments = chunkLikeRecording(JSON.stringify(options.args), envelope.fragmentLengths);

  let clock = BLOCK_START_AT - TICK_MS;
  const now = () => clock;

  const events: Event[] = [];
  const handler = createClaudeStreamHandler(
    (event) => {
      stampToolTiming(event, { now });
      events.push(event as Event);
    },
    { now },
  );

  const withToolName = (frame: Frame): Frame => {
    const clone = structuredClone(frame) as Frame;
    const inner = clone.event as Record<string, unknown>;
    (inner.content_block as Record<string, unknown>).name = options.toolName;
    (inner.content_block as Record<string, unknown>).input = {};
    return clone;
  };
  const withFragment = (frame: Frame, partial: string): Frame => {
    const clone = structuredClone(frame) as Frame;
    const inner = clone.event as Record<string, unknown>;
    (inner.delta as Record<string, unknown>).partial_json = partial;
    return clone;
  };

  clock += TICK_MS;
  const blockStartAt = clock;
  handler.feed(`${JSON.stringify(withToolName(envelope.start))}\n`);
  for (const fragment of fragments) {
    clock += TICK_MS;
    handler.feed(`${JSON.stringify(withFragment(envelope.delta, fragment))}\n`);
  }
  clock += TICK_MS;
  const argumentsClosedAt = clock;
  handler.feed(`${JSON.stringify(envelope.stop)}\n`);
  handler.flush();

  return { events, blockStartAt, argumentsClosedAt };
}

const targetsOf = (events: Event[]): Event[] =>
  events.filter((event) => event.type === 'tool_input_target');
const progressOf = (events: Event[]): Event[] =>
  events.filter((event) => event.type === 'tool_input_progress');
const toolUseOf = (events: Event[]): Event[] =>
  events.filter((event) => event.type === 'tool_use');

const LONG = 'a\nb\nc\n'.repeat(700);

describe('W136 · 早期那一行的计时起点', () => {
  describe('Edit 那一档:只有 tool_input_target,也必须能走秒', () => {
    it('tool_input_target 带得动的起点', () => {
      const { events } = replay({
        toolName: 'Edit',
        args: { file_path: '/repo/page.html', old_string: LONG, new_string: 'y' },
      });

      const targets = targetsOf(events);
      expect(targets, 'Edit 连早期那一行都没有 —— 前提就不成立了').toHaveLength(1);
      expect(
        progressOf(events),
        'Edit 不该有行数事件(−M 在途算不出来),前提变了就得重写这一单',
      ).toHaveLength(0);

      expect(
        typeof targets[0]!.startedAt,
        '早期那一行没有起点 —— 行上有文件名,秒表不走(spanElapsed(undefined) === null)',
      ).toBe('number');
    });

    it('起点是块开始那一刻,不是路径扫出来那一刻', () => {
      const { events, blockStartAt } = replay({
        toolName: 'Edit',
        args: { file_path: '/repo/page.html', old_string: LONG, new_string: 'y' },
      });
      const target = targetsOf(events)[0]!;
      expect(
        target.startedAt,
        '起点必须盖在内容块开始,而不是路径解析完成那一刻',
      ).toBe(blockStartAt);
    });

    it('起点排在入参传完之前 —— 否则整段流式传输不计入耗时', () => {
      const { events, argumentsClosedAt } = replay({
        toolName: 'Edit',
        args: { file_path: '/repo/page.html', old_string: LONG, new_string: 'y' },
      });
      const target = targetsOf(events)[0]!;
      expect(typeof target.startedAt).toBe('number');
      expect(
        (target.startedAt as number) < argumentsClosedAt,
        '早期起点不早于入参传完 —— 那就等于没有头程,行上只会剩落盘那零点几秒',
      ).toBe(true);

      expect(argumentsClosedAt - (target.startedAt as number)).toBeGreaterThan(10_000);
    });
  });

  describe('Write 那一档:一次调用只有一个起点', () => {
    it('target 与 progress 报的是同一个起点', () => {
      const { events } = replay({
        toolName: 'Write',
        args: { file_path: '/repo/page.html', content: LONG },
      });

      const target = targetsOf(events)[0];
      const progress = progressOf(events);
      expect(target, 'Write 没发早期那一行').toBeTruthy();
      expect(progress.length, 'Write 没发行数 —— 前提变了').toBeGreaterThan(2);

      const origins = new Set<unknown>([
        target!.startedAt,
        ...progress.map((event) => event.startedAt),
      ]);
      expect(
        origins.size,
        `同一次调用报了多个起点:${JSON.stringify([...origins])} —— 行上的秒数会被按回去`,
      ).toBe(1);
    });
  });

  describe('结算那一行的起点仍归出口盖(不改既有语义)', () => {

    it('tool_use 的起点晚于早期那一行的起点', () => {
      const { events } = replay({
        toolName: 'Edit',
        args: { file_path: '/repo/page.html', old_string: LONG, new_string: 'y' },
      });
      const target = targetsOf(events)[0]!;
      const settled = toolUseOf(events)[0];
      expect(settled, '没有结算行').toBeTruthy();
      expect(typeof settled!.startedAt).toBe('number');
      expect(
        (settled!.startedAt as number) > (target.startedAt as number),
        '结算行的起点没有晚于早期起点 —— 那客户端搬不搬都一样,这一单测不到东西',
      ).toBe(true);
    });
  });
});
