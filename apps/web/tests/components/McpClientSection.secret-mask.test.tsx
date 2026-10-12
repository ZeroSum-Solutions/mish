// @vitest-environment jsdom

// B-121: the daemon masks saved MCP secrets. The settings UI shows the mask with a hint, and a
// save that leaves a masked field alone sends the mask back unchanged, so the daemon keeps the
// stored secret; editing the field sends the new value.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_SECRET_MASK } from '@mish/contracts';
import { McpClientSection, type McpClientSectionHandle } from '../../src/components/McpClientSection';

const MASKED = {
  id: 'remote',
  label: 'Remote',
  transport: 'http',
  enabled: true,
  authMode: 'none',
  url: MCP_SECRET_MASK,
  headers: { Authorization: MCP_SECRET_MASK, 'X-Team': MCP_SECRET_MASK },
};

let puts: unknown[] = [];
let refuse = false;
let reconnectRequired = false;
let unsafeGet = false;
let unsafeSave = false;
let unsafeStore: 'tokens' | 'client-cache' | null = null;
let oauthConnected = false;
let resetFails = false;
let resets: unknown[] = [];
const storeFile = (store: 'tokens' | 'client-cache') => store === 'tokens' ? 'mcp-tokens.json' : 'mcp-oauth-clients.json';
const storeMessage = (store: 'tokens' | 'client-cache') => `${storeFile(store)} cannot be read securely. Restore a private file owned by this user or explicitly reset this saved OAuth store.`;
const unsafeBody = (store: 'tokens' | 'client-cache') => ({ code: 'MCP_CREDENTIAL_FILE_UNSAFE', error: storeMessage(store), store, file: storeFile(store) });
const UNSAFE_MESSAGE = 'Saved MCP credentials cannot be read securely. Replace the configuration with all connection values entered again, or restore a private file owned by this user.';

beforeEach(() => {
  puts = [];
  refuse = false;
  reconnectRequired = false;
  unsafeGet = false;
  unsafeSave = false;
  unsafeStore = null;
  oauthConnected = false;
  resetFails = false;
  resets = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/mcp/servers')) {
      if ((unsafeGet && init?.method !== 'PUT') || (unsafeSave && init?.method === 'PUT')) {
        return new Response(JSON.stringify({ error: UNSAFE_MESSAGE, code: 'MCP_CREDENTIAL_FILE_UNSAFE' }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        if (refuse) return new Response(JSON.stringify({ error: 'x', code: 'MCP_SECRET_MASK_UNMATCHED', serverId: 'remote', field: 'header Authorization' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ servers: [{ ...MASKED, authMode: reconnectRequired ? 'oauth' : 'none' }], templates: [] }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('/api/mcp/oauth/status')) {
      if (unsafeStore === 'tokens') return new Response(JSON.stringify(unsafeBody(unsafeStore)), { status: 409 });
      return new Response(JSON.stringify({ connected: oauthConnected, code: reconnectRequired ? 'MCP_OAUTH_RECONNECT_REQUIRED' : undefined }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/mcp/oauth/start') && unsafeStore === 'client-cache') return new Response(JSON.stringify(unsafeBody(unsafeStore)), { status: 409 });
    if (url.endsWith('/api/mcp/oauth/disconnect') && unsafeStore === 'tokens') return new Response(JSON.stringify(unsafeBody(unsafeStore)), { status: 409 });
    if (url.endsWith('/api/mcp/oauth/reset-credentials')) {
      resets.push(JSON.parse(String(init?.body)));
      if (resetFails) return new Response(JSON.stringify({ code: 'MCP_CREDENTIAL_RESET_FAILED', error: 'Reset failed. The original entry is preserved for owner repair.' }), { status: 500 });
      unsafeStore = null;
      oauthConnected = false;
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openRow() {
  fireEvent.click(await screen.findByRole('button', { name: /Expand this MCP server/i }));
  return screen.getByLabelText(/Headers/i) as HTMLTextAreaElement;
}

describe('McpClientSection with masked secrets', () => {
  it('offers Reconnect when saved authorization is no longer bound to this endpoint', async () => {
    reconnectRequired = true;
    render(<McpClientSection />);
    await openRow();
    expect(await screen.findByRole('button', { name: /^Reconnect$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Connect$/i })).toBeNull();
  });
  it('accepts a saved opaque URL unchanged without treating the marker as malformed', async () => {
    const ref = createRef<McpClientSectionHandle>();
    render(<McpClientSection ref={ref} />);
    await openRow();
    expect(await ref.current!.save()).toBe(true);
    expect(puts[0]).toMatchObject({ servers: [{ url: MCP_SECRET_MASK }] });
  });
  it('shows the mask with a hint and sends it back unchanged on save', async () => {
    const ref = createRef<McpClientSectionHandle>();
    render(<McpClientSection ref={ref} />);
    const headers = await openRow();
    expect(headers.value).toContain(`Authorization=${MCP_SECRET_MASK}`);
    expect(screen.getAllByTestId('mcp-secret-kept-hint')[0]!.textContent).toContain(MCP_SECRET_MASK);

    // Delete one header and keep the other masked.
    fireEvent.change(headers, { target: { value: `Authorization=${MCP_SECRET_MASK}` } });
    await ref.current!.save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ servers: [{ id: 'remote', headers: { Authorization: MCP_SECRET_MASK } }] });
    expect((puts[0] as { servers: Array<{ headers: Record<string, string> }> }).servers[0]!.headers).not.toHaveProperty('X-Team');
  });

  it('sends a replaced value as typed', async () => {
    const ref = createRef<McpClientSectionHandle>();
    render(<McpClientSection ref={ref} />);
    const headers = await openRow();
    fireEvent.change(headers, { target: { value: 'Authorization=Bearer new\nX-Team=' + MCP_SECRET_MASK } });
    await ref.current!.save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ servers: [{ headers: { Authorization: 'Bearer new', 'X-Team': MCP_SECRET_MASK } }] });
  });

  it('says which secret to enter again when the daemon cannot keep it', async () => {
    refuse = true;
    const ref = createRef<McpClientSectionHandle>();
    render(<McpClientSection ref={ref} />);
    await openRow();
    fireEvent.change(screen.getByLabelText(/Headers/i), { target: { value: `Authorization=${MCP_SECRET_MASK}` } });
    expect(await ref.current!.save()).toBe(false);
    expect(await screen.findByText(/enter the secret for header Authorization on "remote" again/i)).toBeTruthy();
  });
});


it('shows unsafe credential recovery and allows a complete explicit replacement from an empty form', async () => {
  unsafeGet = true;
  const ref = createRef<McpClientSectionHandle>();
  render(<McpClientSection ref={ref} />);
  expect(await screen.findByText(UNSAFE_MESSAGE)).toBeTruthy();
  expect(screen.queryByText(/Could not reach the local daemon/i)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Add server/i }));
  fireEvent.click(screen.getByRole('button', { name: /Custom server/i }));
  fireEvent.click(await screen.findByRole('button', { name: /Expand this MCP server/i }));
  fireEvent.change(screen.getByLabelText(/^Command$/i), { target: { value: 'synthetic-public-command' } });
  expect(await ref.current!.save()).toBe(true);
  expect(puts[0]).toMatchObject({ servers: [{ id: 'custom', command: 'synthetic-public-command' }] });
  expect(JSON.stringify(puts[0])).not.toContain(MCP_SECRET_MASK);
  expect(screen.queryByText(UNSAFE_MESSAGE)).toBeNull();
});

it('keeps the edited draft and shows the safe typed message when the saved file becomes unsafe', async () => {
  const ref = createRef<McpClientSectionHandle>();
  render(<McpClientSection ref={ref} />);
  await openRow();
  const headers = screen.getByLabelText(/Headers/i) as HTMLTextAreaElement;
  fireEvent.change(headers, { target: { value: 'Authorization=synthetic-reentered-value' } });
  unsafeSave = true;
  expect(await ref.current!.save()).toBe(false);
  expect(await screen.findByText(UNSAFE_MESSAGE)).toBeTruthy();
  expect(headers.value).toBe('Authorization=synthetic-reentered-value');
  expect(screen.queryByText(/Save failed. Check that the daemon/i)).toBeNull();
});


it.each(['tokens', 'client-cache'] as const)('offers explicit confirmed recovery of only the unsafe %s store', async store => {
  reconnectRequired = true;
  unsafeStore = store;
  render(<McpClientSection />);
  await openRow();
  if (store === 'client-cache') fireEvent.click(await screen.findByRole('button', { name: /^Reconnect$/i }));
  expect(await screen.findByText(storeMessage(store))).toBeTruthy();
  const name = store === 'tokens' ? /Reset saved OAuth tokens/i : /Reset OAuth client registrations/i;
  fireEvent.click(await screen.findByRole('button', { name }));
  expect(resets).toEqual([]);
  expect(screen.getByText(/original entry.*preserved/i)).toBeTruthy();
  expect(screen.getByText(new RegExp(`${storeFile(store).replaceAll('.', '\\.')}.*reconnect`, 'i'))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
  expect(resets).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name }));
  fireEvent.click(screen.getByRole('button', { name: /Confirm reset/i }));
  await waitFor(() => expect(resets).toEqual([{ store, confirm: true }]));
  await waitFor(() => expect(screen.queryByRole('button', { name })).toBeNull());
});

it('shows a safe recovery failure and retains the repair action for an unsafe token store', async () => {
  reconnectRequired = true;
  unsafeStore = 'tokens';
  resetFails = true;
  render(<McpClientSection />);
  await openRow();
  fireEvent.click(await screen.findByRole('button', { name: /Reset saved OAuth tokens/i }));
  fireEvent.click(screen.getByRole('button', { name: /Confirm reset/i }));
  expect(await screen.findByText(/Reset failed. The original entry is preserved for owner repair/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /Reset saved OAuth tokens/i })).toBeTruthy();
});

it('shows typed token recovery when disconnect encounters an unsafe saved store', async () => {
  reconnectRequired = true;
  oauthConnected = true;
  render(<McpClientSection />);
  await openRow();
  const disconnect = await screen.findByRole('button', { name: /^Disconnect$/i });
  unsafeStore = 'tokens';
  fireEvent.click(disconnect);
  expect(await screen.findByText(storeMessage('tokens'))).toBeTruthy();
  expect(screen.getByRole('button', { name: /Reset saved OAuth tokens/i })).toBeTruthy();
});
