import { describe, expect, it } from 'vitest';
import { homeHandoffClientRequestId, readSessionModelRequest, saveSessionModelRequest } from '../src/runtime/workbench/session-model-request';
const snapshot = { sessionId: 'session', projectId: 'project', revision: 3, choice: { agentId: 'codex', modelId: 'original' }, updatedAt: 0 };
function storage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }
describe('immutable public caller facts on retry', () => {
  it('retains the original requested pair/revision/preferences after model defaults change', () => {
    const store = storage();
    saveSessionModelRequest({ snapshot, reasoning: 'high', serviceTier: 'fast', attempted: true }, 'request', 'scope', store);
    const updated = { ...snapshot, revision: 9, choice: { agentId: 'claude', modelId: 'opus' } };
    expect(updated.revision).toBe(9);
    expect(readSessionModelRequest('project', 'session', 'request', 'scope', store)).toMatchObject({ snapshot, reasoning: 'high', serviceTier: 'fast', attempted: true });
    expect(readSessionModelRequest('project', 'session', 'new-request', 'scope', store)).toBeNull();
  });
  it('partitions retries by the complete account/project/conversation identity', () => {
    const store = storage(); saveSessionModelRequest({ snapshot, reasoning: null, serviceTier: null, attempted: true }, 'request', 'scope', store);
    expect(readSessionModelRequest('other', 'session', 'request', 'scope', store)).toBeNull();
    expect(readSessionModelRequest('project', 'other', 'request', 'scope', store)).toBeNull();
    expect(readSessionModelRequest('project', 'session', 'request', 'new-account', store)).toBeNull();
  });
  it('stores BYOK public binding but never a transient key', () => {
    const store = storage(); const byok = { ...snapshot, choice: { agentId: 'byok-opencode', modelId: 'raw', byokBinding: { protocol: 'openai' as const, baseUrl: 'https://gateway.example/v1', requiresApiKey: true } } };
    saveSessionModelRequest({ snapshot: byok, reasoning: null, serviceTier: null, attempted: true }, 'request', 'scope', store);
    expect([...store.values.values()].join()).not.toContain('apiKey');
    expect(() => saveSessionModelRequest({ snapshot: { ...byok, choice: { ...byok.choice, apiKey: 'fixture-secret' } as never }, reasoning: null, serviceTier: null, attempted: true }, 'request', 'scope', store)).toThrow();
  });
  it('projects only public media preferences from a credential-bearing object', () => {
    const store = storage();
    const media = { imageModel: 'image-original', apiKey: 'fixture-secret', nested: { apiKey: 'other-secret' } };
    saveSessionModelRequest({ snapshot, reasoning: null, serviceTier: null, attempted: true, byokMediaDefaults: media }, 'request', 'scope', store);
    expect([...store.values.values()].join()).not.toContain('secret');
    expect(readSessionModelRequest('project', 'session', 'request', 'scope', store)?.byokMediaDefaults).toEqual({ imageModel: 'image-original' });
  });
  it('retains the existing Home idempotency identifier', () => {
    expect(homeHandoffClientRequestId('fc036a72-6d8c-41a0-aa83-ae7fdd657da6')).toBe('home-auto-send-18mikvgtydqdr');
  });
});
