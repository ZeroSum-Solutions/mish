import { describe, expect, it } from 'vitest';
import { VERCEL_RESERVED_PROJECT_NAMES, validateVercelProjectName, vercelSiteNameSuggestion } from '../src/api/projects.js';

const reservedNames = ['app', 'mail', 'dashboard', 'docs', 'status', 'login', 'ns1', 'ns2', 'localhost', 'www', 'api', 'vercel', 'admin'];

describe('reserved Vercel project names', () => {
  it('exports the complete reserved list', () => {
    expect(VERCEL_RESERVED_PROJECT_NAMES).toEqual(reservedNames);
  });

  it.each(reservedNames)('rejects %s and suggests a valid alternative', (name) => {
    expect(validateVercelProjectName(name)).toEqual({ valid: false, reason: 'reserved' });
    expect(validateVercelProjectName(vercelSiteNameSuggestion(name))).toEqual({ valid: true });
  });

  it.each(['my-app', 'mailroom', 'docs-site', 'administrator'])('accepts non-reserved name %s', (name) => {
    expect(validateVercelProjectName(name)).toEqual({ valid: true });
  });
});
