// Exercises the REAL file-read path in src/motionsites/local-corpus-source.ts (package resolution
// + readFile + importLocalCorpus), unlike motionsites-bridge.test.ts and motionsites-routes.test.ts
// which inject fixture rows via resetLocalCorpusCache and never touch the shipped data file. No
// network involved — this is local package data, not an MCP call.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLocalCorpusEntries, getLocalCorpusText, resetLocalCorpusCache } from '../src/motionsites/local-corpus-source.js';

describe('local-corpus-source (real bundled data file)', () => {
  beforeEach(() => resetLocalCorpusCache(null));
  afterEach(() => resetLocalCorpusCache(null));

  it('resolves and reads @open-design/section-catalog/data/zerosum-local-corpus.json and normalizes every row', async () => {
    const entries = await getLocalCorpusEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.sourceKind).toBe('local-corpus');
      expect(entry.sourceType).toBe('zerosum-kit');
      expect(entry.id.startsWith('zerosum-kit:')).toBe(true);
    }
    // Never carries our_text. NIT (delta audit): a `/# [A-Z]/` markdown-heading proxy passes today
    // only because entries never carry our_text by construction, but would ALSO pass if a future
    // entry legitimately had a markdown heading in `title` — it proves nothing about the specific
    // real our_text body. Assert against a real row's actual our_text (resolved the same way
    // design-reference.ts does, via getLocalCorpusText) instead.
    const corpusId = (entries[0]!.content as { corpusId: string }).corpusId;
    const ourText = await getLocalCorpusText(corpusId);
    expect(ourText).toBeTruthy();
    expect(JSON.stringify(entries)).not.toContain(ourText);
  });

  it('returns consistent entries across repeated calls (the row cache, not a fresh file read, backs the second call)', async () => {
    const first = await getLocalCorpusEntries();
    const second = await getLocalCorpusEntries();
    expect(second).toEqual(first);
  });

  it('resolves a real row\'s text on demand by corpusId, matching a catalog entry\'s content.corpusId', async () => {
    const entries = await getLocalCorpusEntries();
    const first = entries[0]!;
    expect(first.content.kind).toBe('local-prompt');
    const corpusId = (first.content as { corpusId: string }).corpusId;
    const text = await getLocalCorpusText(corpusId);
    expect(typeof text).toBe('string');
    expect(text!.length).toBeGreaterThan(0);
  });

  it('returns null for an unknown corpusId', async () => {
    await expect(getLocalCorpusText('not-a-real-corpus-id')).resolves.toBeNull();
  });
});
