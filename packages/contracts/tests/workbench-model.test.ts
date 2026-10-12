import { describe, expect, it } from 'vitest';
import {
  byokChoiceCompletenessIssues,
  canonicalizeSessionByokBinding,
  parseModelPreflightRequest,
  parseModelPreflightResult,
  parsePutSessionModel,
  parseSessionByokBinding,
  parseSessionModelChoice,
  parseSessionModelSnapshot,
  sessionByokBindingsEqual,
  sessionModelChoicesEqual,
} from '../src/api/workbench-model.js';
import type { ByokChatProtocol } from '../src/api/chat.js';

const native = { agentId: 'codex', modelId: 'default' };
const binding = { protocol: 'openai' as const, baseUrl: 'https://gateway.example/v1', requiresApiKey: true };
const byok = { agentId: 'byok-opencode', modelId: 'vendor/model', byokBinding: binding };

describe('public session model boundary', () => {
  it('accepts native defaults, complete BYOK choices, and only the seven existing protocols', () => {
    expect(parseSessionModelChoice(native)).toEqual(native);
    expect(parseSessionModelChoice(byok)).toEqual(byok);
    const protocols: ByokChatProtocol[] = ['anthropic', 'openai', 'azure', 'google', 'ollama', 'senseaudio', 'aihubmix'];
    for (const protocol of protocols) expect(parseSessionByokBinding({ ...binding, protocol }).protocol).toBe(protocol);
    expect(() => parseSessionByokBinding({ ...binding, protocol: 'bedrock' })).toThrow();
  });

  it('retains existing display-form native IDs while rejecting unsafe raw BYOK models', () => {
    expect(parseSessionModelChoice({ agentId: 'antigravity', modelId: 'Gemini 3.1 Pro (High)' }).modelId).toBe('Gemini 3.1 Pro (High)');
    expect(() => parseSessionModelChoice({ ...byok, modelId: 'unknown model with spaces' })).toThrow();
    expect(() => parseSessionModelChoice({ ...native, modelId: 'line\nbreak' })).toThrow();
  });

  it.each([
    { ...native, byokBinding: binding },
    { agentId: 'byok-opencode', modelId: 'model' },
    { ...byok, modelId: ' DEFAULT ' },
    { ...byok, modelId: 'mish-byok/model' },
    { ...byok, byokBinding: { ...binding, apiKey: 'sentinel-secret' } },
    { ...native, nativeSessionId: 'private-handle' },
    { ...native, apiKeyHash: 'not-public-identity' },
    { ...native, profileId: 'unapproved-registry' },
  ])('refuses invalid complete choice or private fields %#', input => {
    expect(() => parseSessionModelChoice(input)).toThrow();
  });

  it('validates safe revisions/timestamps without coercion and preserves a stale expected revision for authorized CAS handling', () => {
    const snapshot = { sessionId: 'conversation-1', projectId: 'project-1', revision: 7, choice: byok, updatedAt: 123 };
    expect(parseSessionModelSnapshot(snapshot)).toEqual(snapshot);
    expect(parseSessionModelSnapshot({ ...snapshot, revision: 0, choice: null, updatedAt: 0 }).choice).toBeNull();
    expect(parsePutSessionModel({ ...byok, expectedRevision: 0 }).expectedRevision).toBe(0);
    expect(parsePutSessionModel({ ...native, expectedRevision: Number.MAX_SAFE_INTEGER }).expectedRevision).toBe(Number.MAX_SAFE_INTEGER);
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1', null]) {
      expect(() => parsePutSessionModel({ ...native, expectedRevision: invalid })).toThrow();
      expect(() => parseSessionModelSnapshot({ ...snapshot, revision: invalid })).toThrow();
      expect(() => parseSessionModelSnapshot({ ...snapshot, updatedAt: invalid })).toThrow();
    }
    expect(() => parsePutSessionModel(native)).toThrow();
    expect(() => parsePutSessionModel({ ...native, expectedRevision: 1, apiKey: 'sentinel-secret' })).toThrow();
    expect(() => parseSessionModelSnapshot({ ...snapshot, nativeSessionId: 'private' })).toThrow();
  });

  it('trims public IDs but rejects blank/control/path-bearing IDs, while retaining scoped raw model IDs', () => {
    expect(parseSessionModelChoice({ agentId: ' codex ', modelId: ' default ' })).toEqual(native);
    expect(parseSessionModelChoice({ agentId: 'ollama', modelId: 'owner/model:tag' }).modelId).toBe('owner/model:tag');
    for (const invalid of ['', '  ', 'a\nb', 'a\0b', '/private/model', '../model', 'C:\\private', 'a\\b']) {
      expect(() => parseSessionModelChoice({ ...native, agentId: invalid })).toThrow();
      expect(() => parseSessionModelChoice({ ...native, modelId: invalid })).toThrow();
      expect(() => parseSessionModelSnapshot({ sessionId: invalid, projectId: 'project', revision: 0, choice: null, updatedAt: 0 })).toThrow();
    }
  });
});

// Expected endpoint facts are read-only derivations from the existing daemon
// byok-opencode builder and its route fixtures. This test imports pure contracts
// only; integrated execution parity remains the daemon/e2e owner's gate.
describe('public endpoint normalization matching current execution rules', () => {
  it.each([
    ['anthropic', 'https://api.anthropic.com/v1'],
    ['openai', 'https://api.openai.com/v1'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta'],
    ['ollama', 'https://ollama.com/v1'],
    ['senseaudio', 'https://api.senseaudio.cn'],
    ['aihubmix', 'https://aihubmix.com/v1'],
  ] as const)('%s fills its existing default before canonicalizing a blank endpoint', (protocol, baseUrl) => {
    const blank = parseSessionByokBinding({ protocol, baseUrl: '  ', requiresApiKey: true });
    expect(blank.baseUrl).toBe(baseUrl);
    expect(sessionByokBindingsEqual(blank, { protocol, baseUrl, requiresApiKey: true })).toBe(true);
  });

  it.each([
    ['anthropic', 'HTTPS://API.ANTHROPIC.COM:443/', 'https://api.anthropic.com/v1'],
    ['anthropic', 'https://api.minimax.io/anthropic/', 'https://api.minimax.io/anthropic/v1'],
    ['anthropic', 'https://gateway.example/anthropic/v2/proxy/', 'https://gateway.example/anthropic/v2/proxy'],
    ['anthropic', 'https://gateway.example/tenant//route', 'https://gateway.example/tenant//route/v1'],
    ['openai', 'https://api.openai.com/', 'https://api.openai.com/v1'],
    ['openai', 'https://gateway.example/tenant/', 'https://gateway.example/tenant'],
    ['google', 'https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta'],
    ['google', 'https://gateway.example/google/v1beta/', 'https://gateway.example/google/v1beta'],
    ['ollama', 'https://ollama.com', 'https://ollama.com/v1'],
    ['ollama', 'http://localhost:11434/', 'http://localhost:11434/v1'],
    ['ollama', 'http://127.0.0.1:11434/api/', 'http://127.0.0.1:11434/v1'],
    ['ollama', 'https://ollama.example/api', 'https://ollama.example/v1'],
    ['senseaudio', 'https://API.SENSEAUDIO.CN:443/', 'https://api.senseaudio.cn'],
    ['aihubmix', 'https://aihubmix.com/v1/', 'https://aihubmix.com/v1'],
    ['azure', 'https://resource.services.ai.azure.com/api/projects/p/openai/v1/', 'https://resource.services.ai.azure.com/api/projects/p/openai/v1'],
  ] as const)('%s normalizes %s without collapsing distinct endpoint paths', (protocol, baseUrl, expected) => {
    expect(canonicalizeSessionByokBinding({ protocol, baseUrl, requiresApiKey: true }).baseUrl).toBe(expected);
  });

  it('keeps classic Azure default, v1 omitted-default mode, and explicit versions structured', () => {
    const azure = { ...binding, protocol: 'azure' as const, baseUrl: 'https://example.openai.azure.com' };
    expect(parseSessionByokBinding(azure).apiVersion).toBe('2024-10-21');
    expect(() => parseSessionByokBinding({ ...azure, baseUrl: '' })).toThrow(/Azure.*explicit/i);
    expect(parseSessionByokBinding({ ...azure, apiVersion: ' 2025-01-01-preview ' }).apiVersion).toBe('2025-01-01-preview');
    expect(parseSessionByokBinding({ ...azure, baseUrl: `${azure.baseUrl}/openai/v1`, apiVersion: '' })).not.toHaveProperty('apiVersion');
    expect(parseSessionByokBinding({ ...azure, baseUrl: `${azure.baseUrl}/openai/v1`, apiVersion: 'v1' }).apiVersion).toBe('v1');
    expect(() => parseSessionByokBinding({ ...binding, apiVersion: '2024-10-21' })).toThrow();
    expect(() => parseSessionByokBinding({ ...azure, apiVersion: 'v1&api-key=sentinel' })).toThrow();
  });

  it('preserves current effective keyless policy and does not infer a billing principal', () => {
    expect(parseSessionByokBinding({ protocol: 'ollama', baseUrl: 'http://localhost:11434', requiresApiKey: true }).requiresApiKey).toBe(false);
    expect(parseSessionByokBinding({ ...binding, baseUrl: 'http://127.0.0.1:8000/v1', requiresApiKey: false }).requiresApiKey).toBe(false);
    expect(parseSessionByokBinding({ protocol: 'ollama', baseUrl: 'https://ollama.com', requiresApiKey: true }).requiresApiKey).toBe(true);
    // Current builder tests hostname against bare ::1; URL returns [::1]. Do
    // not silently change that execution policy in the public DTO checkpoint.
    expect(parseSessionByokBinding({ protocol: 'ollama', baseUrl: 'http://[::1]:11434', requiresApiKey: true })).toMatchObject({ baseUrl: 'http://[::1]:11434', requiresApiKey: true });
  });

  it.each(['https://user:sentinel@host.example/v1', 'https://@host.example/v1', 'https://host.example/v1?tenant=x', 'https://host.example/v1?', 'https://host.example/v1#route', 'https://host.example/v1#', 'file:///private/model', 'javascript:alert(1)', '/relative', 'https:gateway.example/v1', 'https://ho\nst.example', 'https://host.example\\v1'])('refuses unsafe or unsupported pinned endpoint %s', baseUrl => {
    expect(() => parseSessionByokBinding({ ...binding, baseUrl })).toThrow();
  });

  it('requires complete public binding fields and rejects secrets, cache identities and coercion', () => {
    for (const input of [{ protocol: 'openai', baseUrl: binding.baseUrl }, { ...binding, requiresApiKey: 'false' }, { ...binding, baseUrl: undefined }, { ...binding, apiKey: 'sentinel-secret' }, { ...binding, apiKeyHash: 'secret-derived' }, { ...binding, model: 'hidden-override' }, { ...binding, cacheKey: 'discovery-identity' }]) expect(() => parseSessionByokBinding(input)).toThrow();
  });
});

describe('complete requested choice equality', () => {
  it('recognizes canonical lost-success retry while expected revision remains outside choice identity', () => {
    const canonical = parseSessionModelChoice({ ...byok, byokBinding: { ...binding, baseUrl: 'https://gateway.example/v1' } });
    const retry = parsePutSessionModel({ ...byok, expectedRevision: 0, byokBinding: { ...binding, baseUrl: 'HTTPS://GATEWAY.EXAMPLE:443/v1/' } });
    expect(sessionModelChoicesEqual(canonical, retry)).toBe(true);
    expect(sessionModelChoicesEqual(null, null)).toBe(true);
    expect(sessionModelChoicesEqual(null, canonical)).toBe(false);
    expect(sessionModelChoicesEqual(native, { agentId: 'codex', modelId: 'gpt-5.5' })).toBe(false);
  });

  it('distinguishes model, agent, endpoint path, protocol, API version and effective key policy', () => {
    for (const choice of [{ ...byok, modelId: 'other' }, { ...byok, byokBinding: { ...binding, baseUrl: 'https://gateway.example/other/v1' } }, { ...byok, byokBinding: { ...binding, protocol: 'aihubmix' as const } }, { ...byok, byokBinding: { ...binding, requiresApiKey: false } }, native]) expect(sessionModelChoicesEqual(byok, choice)).toBe(false);
    const azure = { protocol: 'azure' as const, baseUrl: 'https://example.openai.azure.com', requiresApiKey: true };
    expect(sessionByokBindingsEqual(azure, { ...azure, apiVersion: '2025-01-01-preview' })).toBe(false);
    expect(sessionByokBindingsEqual(azure, { ...azure, apiVersion: '2024-10-21' })).toBe(true);
    expect(sessionByokBindingsEqual(undefined, undefined)).toBe(true);
    expect(sessionByokBindingsEqual(binding, undefined)).toBe(false);
  });

  it('keeps an endpoint-only mutation unequal at the same stale revision for caller conflict handling', () => {
    const current = parseSessionModelSnapshot({ sessionId: 'session', projectId: 'project', revision: 9, choice: byok, updatedAt: 1 });
    const retry = parsePutSessionModel({ ...byok, expectedRevision: 0 });
    const changed = parsePutSessionModel({ ...byok, expectedRevision: 0, byokBinding: { ...binding, baseUrl: 'https://gateway.example/another-tenant/v1' } });
    expect(sessionModelChoicesEqual(current.choice, retry)).toBe(true);
    expect(sessionModelChoicesEqual(current.choice, changed)).toBe(false);
    expect(retry.expectedRevision).toBe(changed.expectedRevision);
  });
});

// AC-R02.3: additive request/result boundary for the model/attachment
// preflight check. Does not touch SessionModelSnapshot/PutSessionModel.
describe('model preflight boundary', () => {
  it('accepts a bare agent/model request and an attachment-bearing one, trimming/normalizing public fields', () => {
    expect(parseModelPreflightRequest(native)).toEqual({ agentId: 'codex', modelId: 'default' });
    const withAttachments = { agentId: ' codex ', modelId: ' default ', attachments: [{ name: 'brief.png', kind: 'image' as const, size: 10, declaredMime: 'image/png' }] };
    expect(parseModelPreflightRequest(withAttachments)).toEqual({ agentId: 'codex', modelId: 'default', attachments: [{ name: 'brief.png', kind: 'image', size: 10, declaredMime: 'image/png' }] });
  });

  it('rejects unsafe attachment names, unknown kinds, negative/non-integer sizes and private fields', () => {
    for (const attachments of [
      [{ name: '../escape', kind: 'file' }],
      [{ name: 'a/b.png', kind: 'image' }],
      [{ name: '.', kind: 'file' }],
      [{ name: 'x', kind: 'not-a-kind' }],
      [{ name: 'x', kind: 'file', size: -1 }],
      [{ name: 'x', kind: 'file', size: 1.5 }],
      [{ name: 'x', kind: 'file', path: '/etc/passwd' }],
    ]) expect(() => parseModelPreflightRequest({ ...native, attachments })).toThrow();
    expect(() => parseModelPreflightRequest({ agentId: 'codex' })).toThrow();
    expect(() => parseModelPreflightRequest({ ...native, apiKey: 'sentinel-secret' })).toThrow();
  });

  it('parses a result for every mismatch code and refuses an unknown one', () => {
    const result = { agentId: 'hermes', modelId: 'default', ok: false, mismatches: [
      { code: 'model-unavailable' as const, message: 'Model "default" is not available for Hermes' },
      { code: 'image-attachments-unsupported' as const, message: 'Hermes does not forward image attachments to its model', attachmentNames: ['brief.png'] },
      { code: 'attachment-too-large' as const, message: 'Attachment exceeds the 200 MiB upload limit', attachmentNames: ['scene.mp4'] },
    ] };
    expect(parseModelPreflightResult(result)).toEqual(result);
    expect(parseModelPreflightResult({ ...result, ok: true, mismatches: [] })).toEqual({ ...result, ok: true, mismatches: [] });
    expect(() => parseModelPreflightResult({ ...result, mismatches: [{ code: 'not-a-real-code', message: 'x' }] })).toThrow();
  });

  it('accepts an optional byokBinding so a byok-opencode candidate can be evaluated for completeness', () => {
    expect(parseModelPreflightRequest({ ...byok })).toEqual(byok);
    expect(parseModelPreflightRequest(native)).not.toHaveProperty('byokBinding');
  });

  it('byokChoiceCompletenessIssues: flags a byok-opencode candidate missing a binding/concrete model, matching putSessionModel admission', () => {
    // The exact combination a preflight must not silently pass: `modelId:
    // 'default'` with no `byokBinding` at all (it is optional on the request).
    expect(byokChoiceCompletenessIssues({ agentId: 'byok-opencode', modelId: 'default' })).toEqual([
      { path: 'byokBinding', message: 'BYOK session choices require a complete public binding' },
      { path: 'modelId', message: 'BYOK session choices require a concrete raw model ID without the OpenCode provider prefix' },
    ]);
    expect(byokChoiceCompletenessIssues(byok)).toEqual([]);
    expect(byokChoiceCompletenessIssues(native)).toEqual([]);
  });
});
