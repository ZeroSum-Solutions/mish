// Mish pack size budgets, the `projects` and `designIndex` resources, and the `projects.json` rows
// file. Every value here is invented.

import { describe, expect, it } from 'vitest';

import {
  MISH_PACK_LIMITS,
  MISH_PACK_PROJECT_ID_PATTERN,
  mishPackManifestSchema,
  mishPackProjectsFileSchema,
} from '../src/api/mish-packs.js';

const GIB = 1024 * 1024 * 1024;

function row(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: `Project ${id}`, createdAt: 1, updatedAt: 2, ...extra };
}

describe('Mish pack limits', () => {
  it('fit a team packet of several gigabytes', () => {
    expect(MISH_PACK_LIMITS.archiveMaxBytes).toBe(12 * GIB);
    expect(MISH_PACK_LIMITS.extractedMaxBytes).toBe(24 * GIB);
    expect(MISH_PACK_LIMITS.fileMaxBytes).toBe(2 * GIB);
    expect(MISH_PACK_LIMITS.extractedMaxBytes).toBeGreaterThan(MISH_PACK_LIMITS.archiveMaxBytes);
  });
});

describe('Mish pack manifest: projects and design index', () => {
  it('accepts safe relative paths and refuses climbing ones', () => {
    const manifest = (provides: Record<string, unknown>) => ({ schemaVersion: 1, id: 'team-projects', name: 'Team projects', version: '1', provides });
    expect(mishPackManifestSchema.safeParse(manifest({ projects: 'projects', designIndex: 'design-index' })).success).toBe(true);
    expect(mishPackManifestSchema.safeParse(manifest({ projects: '../projects' })).success).toBe(false);
    expect(mishPackManifestSchema.safeParse(manifest({ designIndex: '/abs' })).success).toBe(false);
  });
});

describe('projects.json', () => {
  it('accepts rows as the daemon stores them', () => {
    const parsed = mishPackProjectsFileSchema.safeParse({
      schema: 'mish-pack-projects/1',
      projects: [
        row('ds-atlas-one', { designSystemId: 'user:atlas-one', metadata: { kind: 'other', importedFrom: 'design-system' } }),
        row('0b1c2d3e-aaaa-bbbb-cccc-123456789012', { skillId: null, pendingPrompt: null, customInstructions: 'Be brief.', metadata: null }),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an unsafe id, a duplicate id (in any letter case), an unknown key and another schema', () => {
    const file = (projects: unknown[], schema = 'mish-pack-projects/1') => mishPackProjectsFileSchema.safeParse({ schema, projects }).success;
    expect(file([row('../up')])).toBe(false);
    expect(file([row('.hidden')])).toBe(false);
    expect(file([row('a/b')])).toBe(false);
    expect(file([row('same'), row('SAME')])).toBe(false);
    expect(file([row('ok', { workspace: 'x' })])).toBe(false);
    expect(file([row('ok')], 'mish-pack-projects/2')).toBe(false);
    expect(new RegExp(MISH_PACK_PROJECT_ID_PATTERN, 'u').test('ds-study-108-intra')).toBe(true);
  });
});
