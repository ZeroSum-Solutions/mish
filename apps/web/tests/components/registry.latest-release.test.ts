import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MishGithubLatestReleaseResponse } from '@mish/contracts';

import { fetchLatestGithubReleaseInfo } from '../../src/providers/registry';

const originalFetch = globalThis.fetch;

describe('fetchLatestGithubReleaseInfo', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('reads the latest release metadata from the daemon endpoint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        repo: 'ZeroSum-Solutions/mish',
        tag_name: 'v0.8.0-prerelease.3',
        html_url: 'https://github.com/ZeroSum-Solutions/mish/releases/tag/v0.8.0-prerelease.3',
        fetchedAt: Date.parse('2026-05-22T00:00:00.000Z'),
        stale: false,
      } satisfies MishGithubLatestReleaseResponse),
    } satisfies Partial<Response>) as typeof fetch;

    const result = await fetchLatestGithubReleaseInfo();

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/github/mish/releases/latest');
    expect(result).toEqual({
      tagName: 'v0.8.0-prerelease.3',
      htmlUrl: 'https://github.com/ZeroSum-Solutions/mish/releases/tag/v0.8.0-prerelease.3',
      stale: false,
    });
  });

  it('returns null when the daemon endpoint fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false } satisfies Partial<Response>) as typeof fetch;

    await expect(fetchLatestGithubReleaseInfo()).resolves.toBeNull();
  });
});
