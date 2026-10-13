import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractWithLLM, __resetMemoryTurnDedupeForTests } from '../src/memory-llm.js';
import { memoryDir, writeMemoryConfig } from '../src/memory.js';
import { __resetExtractionsForTests } from '../src/memory-extractions.js';

// The memory extractor sends the provider API key with every call. A provider
// answering 3xx must not make it replay the key and body to a host the SSRF
// guard never checked, so every provider call refuses redirects.

const dataDir = path.join(process.env.OD_DATA_DIR ?? process.cwd(), 'memory-llm-redirect-test');
const originalFetch = globalThis.fetch;

describe('memory-llm provider calls refuse redirects', () => {
  beforeEach(async () => {
    await fsp.rm(memoryDir(dataDir), { recursive: true, force: true });
    __resetExtractionsForTests();
    __resetMemoryTurnDedupeForTests();
    await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it.each(['anthropic', 'openai', 'azure', 'google', 'ollama'] as const)('%s', async (provider) => {
    const inits: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    await extractWithLLM(
      dataDir,
      { userMessage: 'Remember I ship on Fridays.', assistantMessage: 'Noted.' },
      {
        projectRoot: process.cwd(),
        conversationId: `conv-${provider}`,
        chatProvider: {
          provider,
          apiKey: 'sk-test',
          baseUrl: 'https://provider.example/v1',
          model: 'test-model',
          apiVersion: '',
        },
      },
    ).catch(() => undefined);

    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) expect(init.redirect).toBe('error');
  });
});
