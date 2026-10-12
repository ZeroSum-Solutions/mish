// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_OPERATIONS, type ConnectorResource, type OwnedImportRecord, type ResourceResult } from '@open-design/contracts';
import { I18nProvider } from '../../src/i18n';
import { WorkbenchConnectorSearch } from '../../src/components/workbench/WorkbenchConnectorSearch';
import { WorkbenchOwnedImport } from '../../src/components/workbench/WorkbenchOwnedImport';
import { WorkbenchResourceDetail } from '../../src/components/workbench/WorkbenchResourceDetail';
import { getConnectorDetail, searchConnector } from '../../src/providers/workbench-connectors';
import { createOwnedImport, listOwnedImports } from '../../src/providers/workbench-owned-imports';
import { getWorkbenchResource, WorkbenchRequestError } from '../../src/providers/workbench';

vi.mock('../../src/providers/workbench-connectors', async original => ({ ...await original<typeof import('../../src/providers/workbench-connectors')>(), searchConnector: vi.fn(), getConnectorDetail: vi.fn() }));
vi.mock('../../src/providers/workbench-owned-imports', async original => ({ ...await original<typeof import('../../src/providers/workbench-owned-imports')>(), createOwnedImport: vi.fn(), listOwnedImports: vi.fn() }));
vi.mock('../../src/providers/workbench', async original => ({ ...await original<typeof import('../../src/providers/workbench')>(), getWorkbenchResource: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const operations = SOURCE_OPERATIONS.map(operation => ({ operation, decision: operation === 'cache-source-content' ? 'blocked' as const : 'unknown' as const, reason: 'No RightsAssessment recorded (G30)' }));
const hero: ConnectorResource = {
  connectorId: 'motionsites', itemId: 'fixture-hero-01', title: 'Fixture Aurora Hero', canonicalUrl: 'https://motionsites.ai/?prompt=fixture-hero-01',
  capturedAt: '2026-10-08T12:00:00.000Z', category: 'Hero', access: 'free', attribution: { provider: 'MotionSites', url: 'https://motionsites.ai' },
  rights: { status: 'restricted', summary: 'All rights reserved; reference viewing only.', operations }, supportedOperations: ['open-source-link'], untrusted: true,
};
const receipt = { binding: 'daemon-mcp-config' as const, toolName: 'search_prompts', schemaDigest: 'e'.repeat(64), attempts: 1, durationMs: 9, retrievedAt: '2026-10-08T12:00:00.000Z' };
const wrap = (node: JSX.Element) => render(<I18nProvider initial="en">{node}</I18nProvider>);

describe('canvas connector search (AC-R12.2)', () => {
  it('searches the selected connector and shows attribution, rights and the captured detail', async () => {
    vi.mocked(searchConnector).mockResolvedValue({ schema: 'connector-search/1', connectorId: 'motionsites', results: [hero], receipt, excluded: 0 });
    vi.mocked(getConnectorDetail).mockResolvedValue({ schema: 'connector-detail/1', connectorId: 'motionsites', resource: hero, source: 'captured-reference', receipt });
    wrap(<WorkbenchConnectorSearch />);
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'motionsites' } });
    fireEvent.change(screen.getByLabelText('Reference query'), { target: { value: 'hero' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search connector' }));
    const row = await screen.findByRole('article', { name: 'Fixture Aurora Hero' });
    expect(searchConnector).toHaveBeenCalledWith('motionsites', { query: 'hero', limit: 10 });
    expect(within(row).getByRole('link', { name: 'MotionSites' }).getAttribute('href')).toBe('https://motionsites.ai/?prompt=fixture-hero-01');
    expect(within(row).getByText(/restricted/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Reference details' }));
    const detail = await screen.findByTestId('workbench-connector-detail');
    expect(getConnectorDetail).toHaveBeenCalledWith('motionsites', { itemId: 'fixture-hero-01' });
    expect(within(detail).getByText(/cache-source-content · blocked/)).toBeTruthy();
    expect(within(detail).getByText(/2026-10-08T12:00:00.000Z/)).toBeTruthy();
    expect(within(detail).getByText(/search_prompts/)).toBeTruthy();
  });

  it('shows a typed refusal with its missing receipts instead of results', async () => {
    vi.mocked(searchConnector).mockRejectedValue(new WorkbenchRequestError(422, 'connector-schema-not-frozen', 'Refero has no frozen tool schema', ['Authorized search/detail with attribution and terms (G18)']));
    wrap(<WorkbenchConnectorSearch />);
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'refero' } });
    fireEvent.change(screen.getByLabelText('Reference query'), { target: { value: 'pricing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search connector' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('connector-schema-not-frozen');
    expect(alert).toHaveTextContent('Authorized search/detail with attribution and terms (G18)');
  });
});

describe('canvas Mobbin search (G29, AC-R12.2)', () => {
  it('searches Mobbin screens, flows or sections on a platform, shows the provider notice as text and names how to bind when the daemon has none', async () => {
    const patreon: ConnectorResource = {
      ...hero, connectorId: 'mobbin', itemId: 'd6cac496-7f42-4ddf-ad94-bf72570cfbb0', title: 'Patreon', category: 'flow · ios', access: 'unknown',
      canonicalUrl: 'https://mobbin.com/screens/d6cac496-7f42-4ddf-ad94-bf72570cfbb0', attribution: { provider: 'Mobbin', url: 'https://mobbin.com' },
    };
    vi.mocked(searchConnector).mockResolvedValueOnce({ schema: 'connector-search/1', connectorId: 'mobbin', results: [patreon], receipt: { ...receipt, toolName: 'search_flows' }, excluded: 0, providerNotice: 'Usage notice\nCredit the original app.' });
    wrap(<WorkbenchConnectorSearch />);
    expect(screen.queryByLabelText('Search for')).toBeNull();
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'mobbin' } });
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'flows' } });
    fireEvent.change(screen.getByLabelText('Platform'), { target: { value: 'ios' } });
    fireEvent.change(screen.getByLabelText('Reference query'), { target: { value: 'checkout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search connector' }));
    const row = await screen.findByRole('article', { name: 'Patreon' });
    expect(searchConnector).toHaveBeenCalledWith('mobbin', { query: 'checkout', limit: 10, kind: 'flows', platform: 'ios' });
    expect(within(row).getByRole('link', { name: 'Mobbin' }).getAttribute('href')).toBe('https://mobbin.com/screens/d6cac496-7f42-4ddf-ad94-bf72570cfbb0');
    expect(screen.getByTestId('workbench-connector-notice').textContent).toBe('Usage notice\nCredit the original app.');
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'sections' } });
    expect(screen.queryByLabelText('Platform')).toBeNull();
    vi.mocked(searchConnector).mockRejectedValueOnce(new WorkbenchRequestError(409, 'connector-binding-missing', 'Mishh Mashh has no Mobbin connection of its own', ['Add the official Mobbin MCP server in Settings → MCP']));
    fireEvent.click(screen.getByRole('button', { name: 'Search connector' }));
    const alert = await screen.findByRole('alert');
    expect(searchConnector).toHaveBeenLastCalledWith('mobbin', { query: 'checkout', limit: 10, kind: 'sections' });
    expect(alert).toHaveTextContent('connector-binding-missing');
    expect(alert).toHaveTextContent('Add the official Mobbin MCP server in Settings → MCP');
  });
});

describe('canvas Refero fallback search (B069, D8)', () => {
  it('sends screens/flows and platform through the daemon and never offers sections', async () => {
    const reference: ConnectorResource = { ...hero, connectorId: 'refero', title: 'Refero example', attribution: { provider: 'Refero', url: 'https://refero.design' }, canonicalUrl: 'https://refero.design/screens/example', rights: { ...hero.rights, status: 'reference-only', summary: 'D8 fallback; does not close Mobbin G29.' } };
    vi.mocked(searchConnector).mockResolvedValue({ schema: 'connector-search/1', connectorId: 'refero', results: [reference], receipt, excluded: 0 });
    wrap(<WorkbenchConnectorSearch />);
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'mobbin' } });
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'sections' } });
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'refero' } });
    expect(screen.getByLabelText('Search for')).toHaveValue('screens');
    expect(within(screen.getByLabelText('Search for')).queryByRole('option', { name: 'Sections' })).toBeNull();
    expect(screen.getByLabelText('Platform')).toHaveValue('web');
    fireEvent.change(screen.getByLabelText('Reference query'), { target: { value: 'pricing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search connector' }));
    const row = await screen.findByRole('article', { name: 'Refero example' });
    expect(searchConnector).toHaveBeenLastCalledWith('refero', { query: 'pricing', limit: 10, kind: 'screens', platform: 'web' });
    expect(within(row).getByText(/reference-only/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'flows' } });
    fireEvent.change(screen.getByLabelText('Platform'), { target: { value: 'ios' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search connector' }));
    await waitFor(() => expect(searchConnector).toHaveBeenLastCalledWith('refero', { query: 'pricing', limit: 10, kind: 'flows', platform: 'ios' }));
  });
});

describe('owned prototype import (AC-R12.4)', () => {
  it('imports owner-provided files and labels placeholder data and actions', async () => {
    const record: OwnedImportRecord = {
      schema: 'owned-import/1', id: 'import-0123456789abcdef', revision: 1, provider: 'magic-patterns', name: 'Landing export', principalId: 'local-owner',
      entryPath: 'index.html', artifactSha256: 'a'.repeat(64),
      files: [{ path: 'index.html', sha256: 'b'.repeat(64), bytes: 10, role: 'source' }],
      placeholders: [{ path: 'index.html', line: 5, kind: 'placeholder-link', excerpt: '<a href="#">' }],
      provenance: { origin: 'owned', acquisition: 'owner-provided-local-file', declaration: 'owner-provided-export', exportedFrom: null, providerAccountUsed: false, providerMcpUsed: false, termsVersion: '2025-04-01', evidenceRef: 'docs/plans/2026-10-02-design-workbench/evidence/aisdkagents-magicpatterns-audit.md' },
      createdAt: '2026-10-08T12:00:00.000Z',
    };
    vi.mocked(listOwnedImports).mockResolvedValue({ imports: [] });
    vi.mocked(createOwnedImport).mockResolvedValue(record);
    wrap(<WorkbenchOwnedImport />);
    const input = screen.getByLabelText('Exported files');
    fireEvent.change(input, { target: { files: [new File(['<a href="#">x</a>'], 'index.html', { type: 'text/html' })] } });
    fireEvent.change(screen.getByLabelText('Import name'), { target: { value: 'Landing export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import prototype' }));
    await waitFor(() => expect(createOwnedImport).toHaveBeenCalled());
    const request = vi.mocked(createOwnedImport).mock.calls[0]![0];
    expect(request).toMatchObject({ provider: 'magic-patterns', name: 'Landing export', entryPath: 'index.html' });
    const result = await screen.findByTestId('workbench-owned-import-record');
    expect(within(result).getByText(/placeholder-link/)).toBeTruthy();
    expect(within(result).getByText(/a{12}/)).toBeTruthy();
    expect(within(result).getByText(/No provider account or MCP was used/)).toBeTruthy();
  });
});

describe('reference source identity in inspect (AC-R18.7, AC-R18.8)', () => {
  it('shows the pinned repository, reference-link acquisition and the documented, unexecuted connector', async () => {
    const resource: ResourceResult = {
      refKey: 'k', ref: { sourceType: 'reference', sourceId: 'cnblocks', itemId: 'veil/hero-one', revisionOrDigest: '81c7209fc9696bd7823911a4b9d076f657202ef4:sha256:4c15' },
      title: 'Hero one (Veil)', category: 'section', readiness: 'reference-only',
      compatibility: { nativeFormat: 'svelte', targets: [], state: 'unsupported', reason: 'Native Svelte 5 source; accepted targets are HTML/CSS/JS and React.' },
      rightsStatus: 'unknown', fitReasons: [], previewCapability: { available: false, kind: 'none', reason: 'reference-only' },
      adoptionCapability: { available: false, reason: 'unsupported-capability' }, sourceAttribution: { title: 'SikandarJODD/cnblocks', url: 'https://github.com/SikandarJODD/cnblocks' },
      operationGrants: [], admissionStage: 'reference-only', needDecision: 'reference-only', needReason: 'Deferred under G24.',
      sourceIdentity: {
        repositoryUrl: 'https://github.com/SikandarJODD/cnblocks', commit: '81c7209fc9696bd7823911a4b9d076f657202ef4', registryLocator: null, contentSha256: null,
        acquisitionMode: 'reference-link', documentedConnector: { name: 'jsrepo MCP', state: 'documented-unexecuted', evidenceRef: 'docs/x.json' },
        operationRights: [], nextGate: 'G24 need and Svelte target scope', evidenceRefs: ['docs/x.md'],
      },
    };
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource, sourceStatus: { sourceId: 'cnblocks', state: 'searched', reason: null, itemCount: 1, listingDigest: 'd' } });
    wrap(<WorkbenchResourceDetail selected={resource} plugins={[]} onPickPlugin={() => undefined} onClose={() => undefined} onRefresh={() => undefined} />);
    const identity = await screen.findByTestId('workbench-source-identity');
    expect(identity).toHaveTextContent('github.com/SikandarJODD/cnblocks @ 81c7209');
    expect(identity).toHaveTextContent('reference-link');
    expect(identity).toHaveTextContent('jsrepo MCP · documented-unexecuted');
    expect(identity).toHaveTextContent('G24 need and Svelte target scope');
    expect(screen.queryByTestId('workbench-apply-action')).toBeNull();
  });
});
