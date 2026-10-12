// Owned synthetic protocol fixtures. These tests make no live CLI or provider evidence claim.
// Stop reasons use message_delta; legacy wrapper support is tested separately.
// Early path/progress events must never leak raw tool input JSON.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClaudeStreamHandler } from '../../src/runtimes/claude-stream.js';
import { daemonAgentPayloadToPersistedAgentEvent } from '../../src/runtimes/chat-run-messages.js';

type Event = Record<string, unknown>;
type Frame = Record<string, unknown>;

const SINGLE_TURN = 'partial-single-turn.jsonl';
const NO_PARTIAL = 'no-partial-messages.jsonl';

function readRecording(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/daemon-b/claude-stream/${name}`, import.meta.url)),
    'utf8',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function syntheticEnvelope(): {
  start: Frame;
  delta: Frame;
  stop: Frame;
  fragmentLengths: number[];
} {
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

interface Replay {
  events: Event[];
  fragments: number;
  argumentJson: string;
}

function replayWrite(options: {
  toolName?: string;
  path?: string | null;
  content?: string | null;
  extraArgs?: Record<string, unknown>;
  closeArguments?: boolean;
  now?: () => number;
}): Replay {
  const {
    toolName = 'Write',
    path = '/repo/scratchpad/w120.html',
    content = null,
    extraArgs = {},
    closeArguments = true,
  } = options;
  const envelope = syntheticEnvelope();

  const args: Record<string, unknown> = {};
  if (path !== null) args.file_path = path;
  if (content !== null) args.content = content;
  Object.assign(args, extraArgs);

  const full = JSON.stringify(args);
  /*
   * 入参没写完的那一档:从**正文中间**砍断(不是只砍掉收尾的 `}` —— 那样正文那个
   * 字符串还是收了尾的,补报会照常发生,测不出取消),并且**不发**
   * `content_block_stop`。这就是 run 被取消时流的样子。
   */
  const argumentJson = closeArguments ? full : full.slice(0, Math.floor(full.length * 0.6));
  const fragments = chunkLikeRecording(argumentJson, envelope.fragmentLengths);

  const events: Event[] = [];
  const handler = createClaudeStreamHandler(
    (event) => events.push(event as Event),
    options.now ? { now: options.now } : {},
  );

  const withToolName = (frame: Frame): Frame => {
    const clone = structuredClone(frame) as Frame;
    const inner = clone.event as Record<string, unknown>;
    (inner.content_block as Record<string, unknown>).name = toolName;
    (inner.content_block as Record<string, unknown>).input = {};
    return clone;
  };
  const withFragment = (frame: Frame, partial: string): Frame => {
    const clone = structuredClone(frame) as Frame;
    const inner = clone.event as Record<string, unknown>;
    (inner.delta as Record<string, unknown>).partial_json = partial;
    return clone;
  };

  handler.feed(`${JSON.stringify(withToolName(envelope.start))}\n`);
  for (const fragment of fragments) {
    handler.feed(`${JSON.stringify(withFragment(envelope.delta, fragment))}\n`);
  }
  if (closeArguments) handler.feed(`${JSON.stringify(envelope.stop)}\n`);
  handler.flush();

  return { events, fragments: fragments.length, argumentJson };
}

const progressOf = (events: Event[]): Event[] =>
  events.filter((event) => event.type === 'tool_input_progress');
const linesOf = (events: Event[]): number[] => progressOf(events).map((e) => Number(e.lines));

const settledAddedLines = (content: string): number => content.split('\n').length;

const LONG_CONTENT = Array.from({ length: 160 }, (_, i) => `Owned line ${i}: ${'x'.repeat(160)}`).join('\n');

const DENSE_CONTENT = ((): string => {
  const rows: string[] = [];
  for (let i = 0; i < 733; i += 1) {
    rows.push(`      <div class="card" data-i="${String(i).padStart(4, '0')}">`);
  }
  return `${rows.join('\n')}\n`;
})();

describe('W120 · 在途写文件行的行数', () => {
  describe('前提', () => {

    it('合成样例里最大的一次 Write 只有 1 行 —— 增长在现有语料里看不见', () => {
      let biggest = 0;
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const rec = node as Record<string, unknown>;
        if (rec.type === 'tool_use' && isRecord(rec.input) && typeof rec.input.content === 'string') {
          biggest = Math.max(biggest, settledAddedLines(rec.input.content));
        }
        for (const key of Object.keys(rec)) walk(rec[key]);
      };
      for (const name of [
        SINGLE_TURN,
        'partial-two-turns.jsonl',
        'partial-same-turn-echo.jsonl',
        'no-partial-two-turns.jsonl',
      ]) {
        for (const line of readRecording(name).split('\n')) {
          if (!line.trim()) continue;
          walk(JSON.parse(line));
        }
      }
      expect(biggest).toBe(1);
    });


    it('长写入语料有几十行、上千个分片', () => {
      const replay = replayWrite({ content: LONG_CONTENT });
      expect(settledAddedLines(LONG_CONTENT)).toBeGreaterThan(20);
      expect(replay.fragments).toBeGreaterThan(500);
    });
  });

  describe('增长', () => {
    it('入参还在流的过程中,行数变过至少两次且单调不减', () => {
      const { events } = replayWrite({ content: LONG_CONTENT });
      const lines = linesOf(events);

      expect(lines.length, '一条计数事件都没有 —— 行上还是静止的').toBeGreaterThan(2);
      const distinct = new Set(lines);
      expect(distinct.size, `行数从头到尾没变过:${JSON.stringify(lines.slice(0, 5))}`)
        .toBeGreaterThanOrEqual(3);
      for (let i = 1; i < lines.length; i += 1) {
        expect(lines[i]!, `第 ${i} 条计数比上一条小了(${lines[i - 1]} → ${lines[i]})`)
          .toBeGreaterThanOrEqual(lines[i - 1]!);
      }
    });


    it('在途最后一个行数 == 落定后的 +N', () => {
      for (const content of [LONG_CONTENT, 'a\nb\nc', 'a\nb\nc\n', '', 'single line']) {
        const { events } = replayWrite({ content });
        const lines = linesOf(events);
        const toolUse = events.find((event) => event.type === 'tool_use');
        const settled = (toolUse?.input as Record<string, unknown> | undefined)?.content;

        expect(typeof settled, '合成样例流没有落定成 tool_use').toBe('string');
        expect(lines.length, `content=${JSON.stringify(content.slice(0, 20))}: 没有任何计数`)
          .toBeGreaterThan(0);
        expect(
          lines[lines.length - 1],
          `content=${JSON.stringify(content.slice(0, 20))}: 在途最后一个行数和落定对不上`,
        ).toBe(settledAddedLines(String(settled)));
      }
    });
  });

  describe('节流', () => {

    it('前提:密集语料几乎每个分片都跨过一个换行', () => {
      expect(settledAddedLines(DENSE_CONTENT)).toBe(734);
      expect(DENSE_CONTENT.length).toBeGreaterThan(26_000);
      expect(DENSE_CONTENT.length).toBeLessThan(29_000);
      const { fragments } = replayWrite({ content: DENSE_CONTENT });

      expect(fragments).toBeGreaterThan(600);
    });


    it('计数事件数远小于 delta 帧数', () => {
      for (const [label, content] of [
        ['27.6KB / 734 行的页面', DENSE_CONTENT],
        ['合成样例自己的字节', LONG_CONTENT],
      ] as const) {
        const { events, fragments } = replayWrite({ content });
        const counts = progressOf(events).length;

        expect(counts, `${label}: 一条计数都没有`).toBeGreaterThan(2);
        expect(
          counts * 5,
          `${label}:节流没生效 —— ${fragments} 个分片发了 ${counts} 条计数`,
        ).toBeLessThan(fragments);
      }
    });
  });

  describe('反向', () => {
    it('Bash / Grep 不发计数', () => {
      for (const [toolName, args] of [
        ['Bash', { command: 'cat > /repo/login.html <<ODEOF\nline\nline\nODEOF\n' }],
        ['Grep', { pattern: 'foo', path: '/repo/src' }],
      ] as const) {
        const { events } = replayWrite({
          toolName,
          path: null,
          content: null,
          extraArgs: args as Record<string, unknown>,
        });
        expect(progressOf(events), `${toolName} 也发了计数`).toHaveLength(0);
      }
    });


    it('Edit 不发计数(−M 在途算不出来,不许填 0 冒充)', () => {
      const { events } = replayWrite({
        toolName: 'Edit',
        extraArgs: { old_string: 'a\nb\nc', new_string: 'x\ny\nz\nw' },
        content: null,
      });
      expect(events.some((event) => event.type === 'tool_input_target')).toBe(true);
      expect(progressOf(events), 'Edit 报了半个改动量').toHaveLength(0);
    });


    it('只有 Write / write_file 会数行:同样带 content 的其他写文件工具一条都不发', () => {
      for (const toolName of ['Edit', 'MultiEdit', 'NotebookEdit', 'replace']) {
        const { events } = replayWrite({ toolName, content: 'a\nb\nc\nd\ne\nf\ng' });
        expect(
          events.some((event) => event.type === 'tool_input_target'),
          `${toolName}: 连文件名都没发 —— 这条测的就不是计数`,
        ).toBe(true);
        expect(
          progressOf(events),
          `${toolName} 报了行数,可它落定后 diffStat 给的是 null —— 那一格会凭空消失`,
        ).toHaveLength(0);
      }
    });


    it('路径没收尾时不发计数', () => {
      const envelope = syntheticEnvelope();
      const events: Event[] = [];
      const handler = createClaudeStreamHandler((event) => events.push(event as Event));
      const withFragment = (partial: string): Frame => {
        const clone = structuredClone(envelope.delta) as Frame;
        const inner = clone.event as Record<string, unknown>;
        (inner.delta as Record<string, unknown>).partial_json = partial;
        return clone;
      };
      handler.feed(`${JSON.stringify(envelope.start)}\n`);

      for (const fragment of [
        '{"content": "alpha\\nbeta\\ngamma\\ndelta\\n',
        'epsilon\\nzeta\\n", "file_path": "/repo/la',
      ]) {
        handler.feed(`${JSON.stringify(withFragment(fragment))}\n`);
      }
      expect(progressOf(events), '路径还没收尾就把行数发出去了').toHaveLength(0);

      handler.feed(`${JSON.stringify(withFragment('te.html"}'))}\n`);
      handler.feed(`${JSON.stringify(envelope.stop)}\n`);
      const lines = linesOf(events);
      expect(lines.length, '路径收尾之后仍然一条计数都没有').toBeGreaterThan(0);
      expect(lines[lines.length - 1]).toBe(settledAddedLines('alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n'));
    });


    it('计数事件里没有一个字节的正文', () => {
      const { events } = replayWrite({ content: LONG_CONTENT });
      const counts = progressOf(events);
      expect(counts.length).toBeGreaterThan(2);

      for (const event of counts) {
        expect(Object.keys(event).sort()).toEqual(
          ['id', 'lines', 'name', 'path', 'startedAt', 'type'].sort(),
        );
        const serialized = JSON.stringify(event);
        expect(serialized, '文件正文漏进计数事件了').not.toContain('partial_json');
        expect(serialized).not.toContain('content_block_delta');
        expect(serialized.length, '计数事件不该有几百字节').toBeLessThan(400);
      }
    });


    it('写到一半被取消:停在最后一个数字上,不落定成 tool_use', () => {
      const { events } = replayWrite({ content: DENSE_CONTENT, closeArguments: false });
      const lines = linesOf(events);

      expect(lines.length, '取消前一条计数都没有').toBeGreaterThan(2);
      expect(
        lines[lines.length - 1],
        '取消时补出了一个收尾值 —— 那份正文根本没写完',
      ).toBeLessThan(settledAddedLines(DENSE_CONTENT));
      expect(
        events.filter((event) => event.type === 'tool_use'),
        '没写完的入参落定成了一次调用',
      ).toHaveLength(0);
    });

    it('没有 partial-messages 的合成样例里不发计数', () => {
      const events: Event[] = [];
      const handler = createClaudeStreamHandler((event) => events.push(event as Event));
      for (const line of readRecording(NO_PARTIAL).split('\n')) {
        if (!line.trim()) continue;
        handler.feed(`${line}\n`);
      }
      handler.flush();
      expect(progressOf(events)).toHaveLength(0);
      expect(events.filter((event) => event.type === 'tool_use').length).toBeGreaterThan(0);
    });
  });

  describe('不落库', () => {

    it('计数事件不进落库', () => {
      expect(
        daemonAgentPayloadToPersistedAgentEvent({
          type: 'tool_input_progress',
          id: 'toolu_x',
          name: 'Write',
          path: '/repo/a.html',
          lines: 128,
          startedAt: 1,
        }),
        '计数事件落库了 —— 重开会话会看到几十行同一次写入',
      ).toBeNull();
    });
  });

  describe('计时起点', () => {

    it('同一次调用的所有计数事件共用一个 startedAt', () => {
      let clock = 1_787_809_851_233;
      const { events } = replayWrite({
        content: LONG_CONTENT,
        now: () => (clock += 250),
      });
      const stamps = progressOf(events).map((event) => event.startedAt);
      expect(stamps.length).toBeGreaterThan(2);
      expect(new Set(stamps).size, `startedAt 每条都在变:${JSON.stringify(stamps.slice(0, 4))}`).toBe(1);
      expect(typeof stamps[0]).toBe('number');
    });
  });
});
