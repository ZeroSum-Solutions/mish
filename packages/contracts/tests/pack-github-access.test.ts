// P1-2 spec 6: the GitHub-access status DTO names a source and never a token.

import { describe, expect, it } from 'vitest';

import {
  PACK_ERROR_MESSAGES,
  PACK_GITHUB_ACCESS_ERROR_CODES,
  PACK_INSTALL_ERROR_CODES,
  PACK_REMOVE_ERROR_CODES,
  parsePackApiError,
  parsePackGithubAccessStatus,
  parsePackListResponse,
  parsePackManifest,
  PACK_ID_PATTERN,
  packManifestJsonSchema,
} from '../src/index.js';
import { SETTINGS_LICENSED_PACKS, SETTINGS_LICENSED_PACKS_PATH } from '../src/settings-nav.js';

describe('pack GitHub-access status (P1-2 spec 6)', () => {
  it('parses each source and keeps configured in step with it', () => {
    expect(parsePackGithubAccessStatus({ configured: true, source: 'stored' })).toEqual({ configured: true, source: 'stored' });
    expect(parsePackGithubAccessStatus({ configured: true, source: 'env' })).not.toBeNull();
    expect(parsePackGithubAccessStatus({ configured: true, source: 'gh-cli' })).not.toBeNull();
    expect(parsePackGithubAccessStatus({ configured: false, source: 'none' })).not.toBeNull();
    expect(parsePackGithubAccessStatus({ configured: true, source: 'none' })).toBeNull();
    expect(parsePackGithubAccessStatus({ configured: false, source: 'stored' })).toBeNull();
    expect(parsePackGithubAccessStatus({ configured: true, source: 'keychain' })).toBeNull();
  });

  it('rejects a status object that carries a token, a tail or any other key', () => {
    expect(parsePackGithubAccessStatus({ configured: true, source: 'stored', token: 'ghp_x' })).toBeNull();
    expect(parsePackGithubAccessStatus({ configured: true, source: 'stored', tail: 'abcd' })).toBeNull();
    expect(parsePackGithubAccessStatus(null)).toBeNull();
  });
});

describe('pack HTTP error codes', () => {
  it('has one fixed message for every install, remove and GitHub-access code', () => {
    const codes = [...PACK_INSTALL_ERROR_CODES, ...PACK_REMOVE_ERROR_CODES, ...PACK_GITHUB_ACCESS_ERROR_CODES, 'FORBIDDEN'];
    for (const code of codes) {
      const message = PACK_ERROR_MESSAGES[code as keyof typeof PACK_ERROR_MESSAGES];
      expect(message, code).toBeTruthy();
      expect(message).not.toMatch(/https?:\/\//);
    }
  });

  it('reads the error envelope and refuses an unknown code', () => {
    expect(parsePackApiError({ error: { code: 'PACK_NOT_FOUND', message: 'x' } })).toEqual({ code: 'PACK_NOT_FOUND', message: 'x' });
    expect(parsePackApiError({ error: { code: 'SOMETHING_ELSE', message: 'x' } })).toBeNull();
    expect(parsePackApiError({ ok: true })).toBeNull();
  });

  it('parses a list response and refuses one with a bad status', () => {
    const pack = {
      id: 'p', version: '1.0.0', title: 'P', licenceScope: 'internal', contents: [{ kind: 'component-kit', id: 'k', count: 2 }],
      status: 'ready', digest: 'a'.repeat(64), source: 'local:p.tgz', installedAt: '2026-10-07T00:00:00.000Z',
    };
    expect(parsePackListResponse({ packs: [pack] })?.packs[0]?.id).toBe('p');
    expect(parsePackListResponse({ packs: [{ ...pack, status: 'fine' }] })).toBeNull();
  });
});

describe('Licensed packs destination', () => {
  it('is written as Settings → Licensed packs', () => {
    expect(SETTINGS_LICENSED_PACKS).toBe('Licensed packs');
    expect(SETTINGS_LICENSED_PACKS_PATH).toBe('Settings → Licensed packs');
  });
});

describe('reserved pack id (lane round)', () => {
  const manifest = (id: string) => ({
    format: 'mishh-pack@1',
    id,
    version: '1.0.0',
    title: 'T',
    licence: { scope: 's', evidence: [] },
    contents: [{ kind: 'component-kit', schema: 'od-cult-kit/1', id: 'kit', path: 'kits/demo' }],
    files: [{ path: 'kits/demo/manifest.json', bytes: 2, sha256: 'a'.repeat(64) }],
  });

  it('refuses github-access, which DELETE /api/packs/github-access would shadow, in the parser and the JSON Schema pattern', () => {
    expect(parsePackManifest(manifest('github-access')).ok).toBe(false);
    expect(new RegExp(PACK_ID_PATTERN).test('github-access')).toBe(false);
    expect(new RegExp(packManifestJsonSchema.properties.id.pattern).test('github-access')).toBe(false);
  });

  it('still accepts ids that only start or end like it', () => {
    for (const id of ['github-access-kit', 'my-github-access', 'github', 'access']) {
      expect(parsePackManifest(manifest(id)).ok, id).toBe(true);
    }
  });
});
