// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectPreviewBaseHref } from '../src/hooks/useProjectPreviewBaseHref';
import {
  refreshProjectPreviewScope,
  resetProjectPreviewScopeCache,
} from '../src/runtime/preview-scope-cache';

const HOUR = 60 * 60 * 1000;
const MINT_URL = '/api/projects/p1/preview-url?file=pages%2Findex.html';

function Probe() {
  const base = useProjectPreviewBaseHref('p1', 'pages/index.html');
  return <span data-testid="base">{base.settled ? base.href ?? 'raw' : 'pending'}</span>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function stubPreviewScopeFetch(options: { renewOk: boolean }) {
  const scopes = ['scope-aaaaaaaa1', 'scope-bbbbbbbb2'];
  let minted = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === MINT_URL) {
      const scope = scopes[Math.min(minted, scopes.length - 1)];
      minted += 1;
      return json({
        url: `/api/projects/p1/preview/${scope}/pages/index.html`,
        file: 'pages/index.html',
        expiresAt: Date.now() + HOUR,
      });
    }
    if (/^\/api\/projects\/p1\/preview\/[^/]+\/renew$/u.test(url)) {
      return options.renewOk
        ? json({ expiresAt: Date.now() + HOUR })
        : json({ error: { code: 'PREVIEW_SCOPE_NOT_FOUND' } }, 404);
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const calls = (pattern: RegExp) => fetchMock.mock.calls.filter(([input]) => pattern.test(String(input))).length;
  return { fetchMock, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetProjectPreviewScopeCache();
});

afterEach(() => {
  cleanup();
  resetProjectPreviewScopeCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useProjectPreviewBaseHref renewal', () => {
  it('renews a mounted scope before it expires, again and again', async () => {
    const { calls } = stubPreviewScopeFetch({ renewOk: true });

    render(<Probe />);
    await advance(0);
    expect(screen.getByTestId('base').textContent)
      .toBe('http://localhost:3000/api/projects/p1/preview/scope-aaaaaaaa1/pages/');
    expect(calls(/\/renew$/u)).toBe(0);

    await advance(50 * 60 * 1000);
    expect(calls(/\/api\/projects\/p1\/preview\/scope-aaaaaaaa1\/renew$/u)).toBe(1);
    expect(screen.getByTestId('base').textContent)
      .toBe('http://localhost:3000/api/projects/p1/preview/scope-aaaaaaaa1/pages/');

    // A preview left open for hours keeps a live capability.
    await advance(3 * HOUR);
    expect(calls(/\/renew$/u)).toBeGreaterThanOrEqual(3);
    expect(calls(/preview-url/u)).toBe(1);
  });

  it('replaces the scope when renewal is refused (expired or daemon restarted)', async () => {
    const { calls } = stubPreviewScopeFetch({ renewOk: false });

    render(<Probe />);
    await advance(0);
    expect(screen.getByTestId('base').textContent)
      .toBe('http://localhost:3000/api/projects/p1/preview/scope-aaaaaaaa1/pages/');

    await advance(50 * 60 * 1000);

    expect(calls(/preview-url/u)).toBe(2);
    expect(screen.getByTestId('base').textContent)
      .toBe('http://localhost:3000/api/projects/p1/preview/scope-bbbbbbbb2/pages/');
  });

  it('keeps retrying with backoff while the daemon is down, then recovers', async () => {
    let daemonUp = true;
    let minted = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!daemonUp) throw new TypeError('Failed to fetch');
      if (url === MINT_URL) {
        minted += 1;
        return json({
          url: `/api/projects/p1/preview/scope-${minted === 1 ? 'aaaaaaaa1' : 'cccccccc3'}/pages/index.html`,
          file: 'pages/index.html',
          expiresAt: Date.now() + HOUR,
        });
      }
      // The restarted daemon no longer knows the first scope.
      if (/\/renew$/u.test(url)) return json({ error: { code: 'PREVIEW_SCOPE_NOT_FOUND' } }, 404);
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Probe />);
    await advance(0);
    expect(screen.getByTestId('base').textContent)
      .toBe('http://localhost:3000/api/projects/p1/preview/scope-aaaaaaaa1/pages/');

    // Renewal time arrives while the daemon is down: renew and mint fail.
    daemonUp = false;
    await advance(46 * 60 * 1000);
    // The preview keeps its current base while it waits.
    expect(screen.getByTestId('base').textContent)
      .toBe('http://localhost:3000/api/projects/p1/preview/scope-aaaaaaaa1/pages/');
    const attemptsWhileDown = fetchMock.mock.calls.length;
    await advance(10 * 60 * 1000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(attemptsWhileDown);

    daemonUp = true;
    await advance(10 * 60 * 1000);
    expect(screen.getByTestId('base').textContent)
      .toBe('http://localhost:3000/api/projects/p1/preview/scope-cccccccc3/pages/');
  });

  it('moves mounted previews onto a scope another caller replaced, and converges', async () => {
    const { calls } = stubPreviewScopeFetch({ renewOk: false });

    render(<Probe />);
    await advance(0);
    const stale = 'http://localhost:3000/api/projects/p1/preview/scope-aaaaaaaa1/pages/';
    expect(screen.getByTestId('base').textContent).toBe(stale);

    // FileViewer (HtmlViewer) finds its scope gone and replaces it.
    let viewerResult: Awaited<ReturnType<typeof refreshProjectPreviewScope>> = null;
    await act(async () => {
      viewerResult = await refreshProjectPreviewScope('p1', stale, 'pages/index.html');
    });
    expect(viewerResult).toMatchObject({ kind: 'replaced' });
    expect(screen.getByTestId('base').textContent)
      .toBe('http://localhost:3000/api/projects/p1/preview/scope-bbbbbbbb2/pages/');

    // A second caller still holding the stale scope converges on the same
    // replacement instead of minting a third one.
    let second: Awaited<ReturnType<typeof refreshProjectPreviewScope>> = null;
    await act(async () => {
      second = await refreshProjectPreviewScope('p1', stale, 'pages/other.html');
    });
    expect(second).toEqual({
      kind: 'replaced',
      scope: {
        href: 'http://localhost:3000/api/projects/p1/preview/scope-bbbbbbbb2/pages/',
        expiresAt: expect.any(Number),
      },
    });
    expect(calls(/preview-url/u)).toBe(2);
  });

  it('stops renewing once no preview uses the scope', async () => {
    const { calls } = stubPreviewScopeFetch({ renewOk: true });

    const view = render(<Probe />);
    await advance(0);
    view.unmount();
    await advance(2 * HOUR);

    expect(calls(/\/renew$/u)).toBe(0);
  });
});
