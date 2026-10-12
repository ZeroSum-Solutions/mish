// @vitest-environment jsdom
// AC-R12.4 in a team workspace: the import UI sends the caller's workspace and
// member identity on every owned-import request, so the daemon stores the
// import under that member and member-scoped search and apply can find it.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchOwnedImport } from '../../../src/components/workbench/WorkbenchOwnedImport';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const team = {
  workspaceId: 'ws-team', workspaceType: 'team', workspaceMemberId: 'member-7', role: 'member', lifecycleState: 'active', memberStatus: 'active',
  permissions: { canShareProjects: true, canWriteSyncedFiles: true },
} as unknown as WorkspaceCollabContext;

const record = {
  schema: 'owned-import/1', id: 'import-0123456789abcdef', revision: 1, provider: 'magic-patterns', name: 'Landing export', principalId: 'member:member-7',
  entryPath: 'index.html', artifactSha256: 'a'.repeat(64),
  files: [{ path: 'index.html', sha256: 'b'.repeat(64), bytes: 10, role: 'source' }], placeholders: [],
  provenance: { origin: 'owned', acquisition: 'owner-provided-local-file', declaration: 'owner-provided-export', exportedFrom: null, providerAccountUsed: false, providerMcpUsed: false, termsVersion: '2025-04-01', evidenceRef: 'docs/plans/2026-10-02-design-workbench/evidence/aisdkagents-magicpatterns-audit.md' },
  createdAt: '2026-10-08T12:00:00.000Z',
};

describe('owned import in a team workspace', () => {
  it('lists and creates with the workspace and member identity', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? record : { imports: [] }), { status: init?.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    render(<I18nProvider initial="en"><WorkbenchOwnedImport workspaceContext={team} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Exported files'), { target: { files: [new File(['<p>x</p>'], 'index.html', { type: 'text/html' })] } });
    fireEvent.change(screen.getByLabelText('Import name'), { target: { value: 'Landing export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import prototype' }));
    await screen.findByTestId('workbench-owned-import-record');
    await waitFor(() => expect(fetcher.mock.calls.map(([, init]) => init?.method ?? 'GET').sort()).toEqual(['GET', 'POST']));
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toMatch(/^\/api\/workbench\/imports$/u);
      const headers = new Headers(init?.headers);
      expect(headers.get('x-od-workspace-id'), init?.method ?? 'GET').toBe('ws-team');
      expect(headers.get('x-od-workspace-member-id'), init?.method ?? 'GET').toBe('member-7');
    }
  });

  it('sends no workspace identity outside a workspace', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ imports: [] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    render(<I18nProvider initial="en"><WorkbenchOwnedImport /></I18nProvider>);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(new Headers(((fetcher.mock.calls[0] as unknown[])[1] as RequestInit | undefined)?.headers).get('x-od-workspace-id')).toBeNull();
  });
});
