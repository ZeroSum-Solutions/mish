// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDesignIndexProfiles } from '../../src/hooks/useDesignIndexProfiles';
import { DESIGN_INDEX_CHANGED_EVENT } from '../../src/state/design-index';
import { designProfileFixture } from '../fixtures/design-profile';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Probe({ active }: { active: boolean }) {
  const state = useDesignIndexProfiles(active);
  return (
    <div>
      <span data-testid="digests">
        {state.profiles.map((profile) => profile.source.digest).join(',')}
      </span>
      <span data-testid="flags">{`${state.loading}|${state.failed}`}</span>
    </div>
  );
}

function indexResponse(digests: string[]): Response {
  return new Response(
    JSON.stringify({
      profiles: digests.map((digest) => designProfileFixture({ digest })),
      matched: digests.length,
      total: digests.length,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function digests(): string {
  return screen.getByTestId('digests').textContent ?? '';
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useDesignIndexProfiles', () => {
  it('reads the index on every transition to active, not only on mount', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => indexResponse(['a']));
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<Probe active={false} />);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    view.rerender(<Probe active />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/design-index?limit=500');
    expect(digests()).toBe('a');

    // Home stays mounted while the user visits another tab, so leaving and
    // coming back has to re-read — a profile may have been stored meanwhile.
    view.rerender(<Probe active={false} />);
    await settle();
    view.rerender(<Probe active />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-reads on the design-index-changed event', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => indexResponse(['a', 'b']));
    vi.stubGlobal('fetch', fetchMock);

    render(<Probe active />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event(DESIGN_INDEX_CHANGED_EVENT));
      await Promise.resolve();
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(digests()).toBe('a,b');
  });

  it('drops a stale response when a later read has already started', async () => {
    const pending: Array<(value: Response) => void> = [];
    const fetchMock = vi.fn<typeof fetch>(
      () => new Promise<Response>((resolve) => { pending.push(resolve); }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<Probe active />);
    await settle();
    await act(async () => {
      window.dispatchEvent(new Event(DESIGN_INDEX_CHANGED_EVENT));
      await Promise.resolve();
    });
    expect(pending).toHaveLength(2);

    // The SECOND read answers first, then the first one lands late.
    await act(async () => {
      pending[1]!(indexResponse(['fresh']));
      await Promise.resolve();
    });
    await settle();
    expect(digests()).toBe('fresh');

    await act(async () => {
      pending[0]!(indexResponse(['stale']));
      await Promise.resolve();
    });
    await settle();
    expect(digests()).toBe('fresh');
  });

  it('keeps the profiles it already has when a read fails', async () => {
    let call = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      call += 1;
      return call === 1 ? indexResponse(['a']) : new Response('nope', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Probe active />);
    await settle();
    expect(digests()).toBe('a');

    await act(async () => {
      window.dispatchEvent(new Event(DESIGN_INDEX_CHANGED_EVENT));
      await Promise.resolve();
    });
    await settle();
    expect(digests()).toBe('a');
    expect(screen.getByTestId('flags').textContent).toBe('false|true');
  });
});
