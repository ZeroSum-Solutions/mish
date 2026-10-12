import { runSuccessor } from '@open-design/contracts';

export async function streamRunEvents(base: string, initialRunId: string, workspaceHeaders: Record<string, string> = {}) {
  let runId = initialRunId;
  const visited = new Set();
  while (true) {
    if (visited.has(runId)) {
      console.error(`run watch failed: cyclic strategy task chain at ${runId}`);
      process.exit(1);
    }
    visited.add(runId);
    const resp = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events`, {
      headers: { accept: 'text/event-stream', ...workspaceHeaders },
    });
    if (!resp.ok || !resp.body) {
      console.error(`run watch failed: ${resp.status}`);
      process.exit(1);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let nextRunId = null;
    let successor = null;
    let ended = false;
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const lines = block.split('\n');
        const eventLine = lines.find((l) => l.startsWith('event: '));
        const dataLines = lines
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length));
        const event = eventLine ? eventLine.slice('event: '.length) : 'message';
        const dataRaw = dataLines.join('\n');
        let parsed;
        try { parsed = JSON.parse(dataRaw); } catch { parsed = dataRaw; }
        process.stdout.write(JSON.stringify({ event, data: parsed }) + '\n');
        if (event !== 'end') continue;
        successor = runSuccessor(parsed, runId);
        ended = true;
        break;
      }
    }
    await reader.cancel();
    const successorDeadline = Date.now() + 30_000;
    while (successor?.pending) {
      if (Date.now() >= successorDeadline) throw new Error(`Run successor allocation timed out for ${runId}`);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (Date.now() >= successorDeadline) throw new Error(`Run successor allocation timed out for ${runId}`);
      const readSignal = AbortSignal.timeout(Math.max(1, successorDeadline - Date.now()));
      try {
        const status = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`, { headers: workspaceHeaders, signal: readSignal });
        if (!status.ok) { console.error(`run watch failed: ${status.status}`); process.exit(1); }
        successor = runSuccessor(await status.json() as Parameters<typeof runSuccessor>[0], runId);
        if (Date.now() >= successorDeadline) throw new Error(`Run successor allocation timed out for ${runId}`);
      } catch (error) {
        if (readSignal.aborted || Date.now() >= successorDeadline) throw new Error(`Run successor allocation timed out for ${runId}`);
        throw error;
      }
    }
    nextRunId = successor?.nextRunId;
    if (!nextRunId) return;
    runId = nextRunId;
  }
}
