// Owned synthetic protocol fixtures. These tests make no live CLI or provider evidence claim.
// Stop reasons use message_delta; legacy wrapper support is tested separately.
// Early path/progress events must never leak raw tool input JSON.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClaudeStreamHandler } from '../../src/runtimes/claude-stream.js';
import { applyClaudeStreamJsonRunBookkeeping } from '../../src/runtimes/chat-run-lifecycle.js';

type Frame = Record<string, unknown>;
type Event = Record<string, unknown>;

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/daemon-b/claude-stream/${name}`, import.meta.url));
}

function readRecording(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

function frames(name: string): Frame[] {
  return readRecording(name)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Frame);
}

function replay(source: string, options: Record<string, unknown> = {}): Event[] {
  const events: Event[] = [];
  const handler = createClaudeStreamHandler((event) => events.push(event as Event), options);
  handler.feed(source);
  handler.flush();
  return events;
}

function replayRecording(name: string, options: Record<string, unknown> = {}): Event[] {
  return replay(readRecording(name), options);
}

function assistantText(events: Event[]): string {
  return events
    .filter((event) => event.type === 'text_delta' && typeof event.delta === 'string')
    .map((event) => event.delta as string)
    .join('');
}

function turnEndStopReasons(events: Event[]): unknown[] {
  return events.filter((event) => event.type === 'turn_end').map((event) => event.stopReason);
}

const PARTIAL_RECORDINGS = [
  'partial-two-turns.jsonl',
  'partial-same-turn-echo.jsonl',
  'partial-single-turn.jsonl',
  'partial-forwarded-subagent.jsonl',
];
const ALL_RECORDINGS = [
  ...PARTIAL_RECORDINGS,
  'no-partial-messages.jsonl',
  'no-partial-two-turns.jsonl',
];

describe('synthetic Claude stream shape', () => {
  it('never carries stop_reason on the assistant wrapper frame', () => {
    const offenders: string[] = [];
    for (const name of ALL_RECORDINGS) {
      for (const frame of frames(name)) {
        if (frame.type !== 'assistant') continue;
        const message = frame.message as Record<string, unknown> | undefined;
        if (message && message.stop_reason != null) {
          offenders.push(`${name}: ${String(message.stop_reason)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries the protocol stop reason on message_delta when partial messages are on', () => {
    const stopReasons = frames('partial-two-turns.jsonl')
      .filter((frame) => frame.type === 'stream_event')
      .map((frame) => frame.event as Record<string, unknown>)
      .filter((event) => event?.type === 'message_delta')
      .map((event) => (event.delta as Record<string, unknown>).stop_reason);
    expect(stopReasons).toEqual(['tool_use', 'end_turn', 'end_turn']);
  });

  it('has no stream_event frames at all without --include-partial-messages', () => {
    for (const name of ['no-partial-messages.jsonl', 'no-partial-two-turns.jsonl']) {
      expect(frames(name).some((frame) => frame.type === 'stream_event')).toBe(false);
    }
  });

  it('actually contains the second turn inline artifact the dedup must not eat', () => {
    for (const name of ['partial-two-turns.jsonl', 'no-partial-two-turns.jsonl']) {
      expect(readRecording(name)).toContain('title=\\"Beta\\"');
    }
  });
});

describe('turn_end from a synthetic CLI protocol stream', () => {
  it('fires once per assistant message, reading message_delta', () => {
    const events = replayRecording('partial-two-turns.jsonl');
    expect(turnEndStopReasons(events)).toEqual(['tool_use', 'end_turn', 'end_turn']);
  });

  it('does not double-fire when a build populates both the wrapper and message_delta', () => {

    const hybrid = withLegacyStopReasonRestored('partial-two-turns.jsonl', { keepStreamEvents: true });
    expect(turnEndStopReasons(replay(hybrid))).toEqual(['tool_use', 'end_turn', 'end_turn']);
  });

  it('still reads the legacy wrapper field when message_delta is absent', () => {

    const legacy = withLegacyStopReasonRestored('partial-two-turns.jsonl', { keepStreamEvents: false });
    expect(turnEndStopReasons(replay(legacy))).toEqual(['tool_use', 'end_turn', 'end_turn']);
  });
});

describe('HTML artifact echo dedup is scoped to one turn', () => {
  it('keeps a later turn inline HTML artifact after an earlier turn wrote an HTML file', () => {
    const events = replayRecording('partial-two-turns.jsonl', {
      suppressHtmlArtifactsAfterFileWrite: true,
    });
    const text = assistantText(events);
    expect(text).toContain('DONE1');
    expect(text).toContain('<artifact type="text/html" title="Beta">');
    expect(text).toContain('<h1>Beta</h1>');
  });

  it('keeps it on the no-partial stream too, where result is the only turn boundary', () => {
    const events = replayRecording('no-partial-two-turns.jsonl', {
      suppressHtmlArtifactsAfterFileWrite: true,
    });
    const text = assistantText(events);
    expect(text).toContain('DONE1');
    expect(text).toContain('<artifact type="text/html" title="Beta">');
  });

  it('still swallows the same-turn echo of the file it just wrote', () => {
    const events = replayRecording('partial-same-turn-echo.jsonl', {
      suppressHtmlArtifactsAfterFileWrite: true,
    });
    expect(assistantText(events)).not.toContain('<artifact');
    expect(events.some((event) => event.type === 'tool_use' && event.name === 'Write')).toBe(true);
  });

  it('leaves a single-turn transcript alone', () => {
    const events = replayRecording('partial-single-turn.jsonl', {
      suppressHtmlArtifactsAfterFileWrite: true,
    });
    expect(assistantText(events)).toBe('DONE1');
    expect(events.filter((event) => event.type === 'tool_use' && event.name === 'Write')).toHaveLength(1);
  });
});

describe('forwarded sub-agent frames never close the parent turn', () => {
  it('emits turn_end only for the parent stream', () => {
    const source = 'partial-forwarded-subagent.jsonl';
    const childFrames = frames(source).filter((frame) => frame.parent_tool_use_id != null);
    expect(childFrames.length).toBeGreaterThan(0);
    expect(turnEndStopReasons(replayRecording(source))).toEqual(['tool_use', 'tool_use', 'end_turn']);
  });

  it('drops a message_delta that arrives under a parent_tool_use_id', () => {

    const reparented = frames('partial-two-turns.jsonl')
      .map((frame) => (frame.type === 'stream_event' ? { ...frame, parent_tool_use_id: 'toolu_child_1' } : frame))
      .map((frame) => `${JSON.stringify(frame)}\n`)
      .join('');
    expect(turnEndStopReasons(replay(reparented))).toEqual([]);
  });

  it('drops a legacy wrapper stop_reason that arrives under a parent_tool_use_id', () => {
    const legacyChild = withLegacyStopReasonRestored('partial-forwarded-subagent.jsonl', {
      keepStreamEvents: false,
      onlyParented: true,
    });
    expect(turnEndStopReasons(replay(legacyChild))).toEqual([]);
  });
});

describe('usage stays the terminal fallback', () => {
  it('terminates a no-partial fixture through usage and closes stdin', () => {
    const events = replayRecording('no-partial-messages.jsonl');
    const usage = events.filter((event) => event.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]?.stopReason).toBe('end_turn');

    const run = { stdinOpen: true, turnCompletedCleanly: false, child: null };
    for (const event of events) applyClaudeStreamJsonRunBookkeeping(run, event);
    expect(run.turnCompletedCleanly).toBe(true);
    expect(run.stdinOpen).toBe(false);
  });

  it('holds stdin open across the mid-tool pause of a synthetic fixture, then closes on the turn', () => {

    const events = replayRecording('partial-two-turns.jsonl');
    const run = { stdinOpen: true, turnCompletedCleanly: false, child: null };
    const stdinAfter: Array<[unknown, boolean]> = [];
    for (const event of events) {
      applyClaudeStreamJsonRunBookkeeping(run, event);
      if (event.type === 'turn_end' || event.type === 'usage') {
        stdinAfter.push([event.stopReason, run.stdinOpen]);
      }
    }
    expect(stdinAfter[0]).toEqual(['tool_use', true]);
    expect(stdinAfter[1]?.[1]).toBe(false);
  });

  it('keeps a tool_use usage frame non-terminal', () => {
    const run = { stdinOpen: true, turnCompletedCleanly: false, child: null };
    applyClaudeStreamJsonRunBookkeeping(run, { type: 'usage', stopReason: 'tool_use', isError: true });
    expect(run.stdinOpen).toBe(true);
    expect(run.turnCompletedCleanly).toBe(false);
  });

  it('closes stdin without marking clean on an error usage terminal', () => {
    const run = { stdinOpen: true, turnCompletedCleanly: false, child: null };
    applyClaudeStreamJsonRunBookkeeping(run, { type: 'usage', stopReason: 'end_turn', isError: true });
    expect(run.stdinOpen).toBe(false);
    expect(run.turnCompletedCleanly).toBe(false);
  });
});

function withLegacyStopReasonRestored(
  name: string,
  opts: { keepStreamEvents: boolean; onlyParented?: boolean },
): string {
  const all = frames(name);

  const stopReasonByMessage = new Map<string, string>();
  let openMessageId: string | null = null;
  for (const frame of all) {
    if (frame.type === 'stream_event') {
      const event = frame.event as Record<string, unknown>;
      if (event?.type === 'message_start') {
        const message = event.message as Record<string, unknown> | undefined;
        openMessageId = typeof message?.id === 'string' ? message.id : null;
      } else if (event?.type === 'message_delta' && openMessageId) {
        const stopReason = (event.delta as Record<string, unknown>)?.stop_reason;
        if (typeof stopReason === 'string') stopReasonByMessage.set(openMessageId, stopReason);
      }
    }
  }

  for (const frame of all) {
    if (frame.type !== 'assistant' || frame.parent_tool_use_id == null) continue;
    const message = frame.message as Record<string, unknown>;
    if (typeof message.id === 'string' && !stopReasonByMessage.has(message.id)) {
      stopReasonByMessage.set(message.id, 'end_turn');
    }
  }

  const lastWrapperIndexByMessage = new Map<string, number>();
  all.forEach((frame, index) => {
    if (frame.type !== 'assistant') return;
    const message = frame.message as Record<string, unknown>;
    if (typeof message.id === 'string') lastWrapperIndexByMessage.set(message.id, index);
  });

  const out: string[] = [];
  all.forEach((frame, index) => {
    if (!opts.keepStreamEvents && frame.type === 'stream_event') return;
    if (frame.type === 'assistant') {
      const message = frame.message as Record<string, unknown>;
      const id = typeof message.id === 'string' ? message.id : null;
      const eligible = opts.onlyParented ? frame.parent_tool_use_id != null : true;
      if (id && eligible && lastWrapperIndexByMessage.get(id) === index && stopReasonByMessage.has(id)) {
        out.push(JSON.stringify({
          ...frame,
          message: { ...message, stop_reason: stopReasonByMessage.get(id) },
        }));
        return;
      }
    }
    out.push(JSON.stringify(frame));
  });
  return `${out.join('\n')}\n`;
}
