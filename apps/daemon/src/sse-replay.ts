export interface SseReplayRecord {
  event: string;
  data: unknown;
  id?: number;
}

/** Preserve lightweight test/custom clients while production replay uses the
 * response's drain-aware pump instead of serializing a whole backlog at once. */
export function replaySseEvents(
  sse: {
    send: (event: string, data: unknown, id?: number) => unknown;
    replay?: (records: Iterable<SseReplayRecord>) => unknown;
  },
  records: Iterable<SseReplayRecord>,
): void {
  if (sse.replay) {
    sse.replay(records);
    return;
  }
  for (const record of records) sse.send(record.event, record.data, record.id);
}
