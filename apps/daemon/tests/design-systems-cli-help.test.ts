import { describe, expect, it } from 'vitest';

import {
  DESIGN_SYSTEMS_USAGE,
  designSystemInstallReportLines,
  isDesignSystemsHelpArg,
} from '../src/cli-help/index.js';

describe('od design-systems help surface', () => {
  it('routes help, --help, and -h to the usage text', () => {
    expect(isDesignSystemsHelpArg('help')).toBe(true);
    expect(isDesignSystemsHelpArg('--help')).toBe(true);
    expect(isDesignSystemsHelpArg('-h')).toBe(true);
  });

  it('does not treat subcommands or a missing arg as a help request', () => {
    expect(isDesignSystemsHelpArg('list')).toBe(false);
    expect(isDesignSystemsHelpArg('show')).toBe(false);
    expect(isDesignSystemsHelpArg('rename')).toBe(false);
    expect(isDesignSystemsHelpArg(undefined)).toBe(false);
  });

  it('advertises rename and import commands alongside list and show so the surface cannot drift', () => {
    expect(DESIGN_SYSTEMS_USAGE).toContain('list');
    expect(DESIGN_SYSTEMS_USAGE).toContain('show');
    expect(DESIGN_SYSTEMS_USAGE).toContain('rename');
    expect(DESIGN_SYSTEMS_USAGE).toContain('download');
    expect(DESIGN_SYSTEMS_USAGE).toContain('import-local');
    expect(DESIGN_SYSTEMS_USAGE).toContain('import-github');
    expect(DESIGN_SYSTEMS_USAGE).toContain('import-shadcn');
    expect(DESIGN_SYSTEMS_USAGE).toContain('rebuild-token-contract');
    expect(DESIGN_SYSTEMS_USAGE).toContain('--workspace <id>');
    expect(DESIGN_SYSTEMS_USAGE).toContain('--workspace-member <id>');
  });

  it('advertises install and publish, the two steps that make a kit usable', () => {
    expect(DESIGN_SYSTEMS_USAGE).toContain('install <path|github-url>');
    expect(DESIGN_SYSTEMS_USAGE).toContain('publish <id>');
  });
});

describe('od design-systems install report', () => {
  it('reports a draft install with its status and the one-line publish command', () => {
    const lines = designSystemInstallReportLines('Installed', {
      designSystem: { id: 'user:acme', title: 'Acme', status: 'draft' },
      selectability: {
        selectable: false,
        reason: 'draft',
        message: 'Design kit "Acme" is a draft. Publish it to use it for generation.',
        publishCommand: 'od design-systems publish user:acme',
      },
    });
    expect(lines).toEqual([
      'Installed user:acme -> Acme',
      'Status: draft. Generation skips draft kits until they are published.',
      'Publish it: od design-systems publish user:acme',
    ]);
  });

  it('derives the publish command from the status when an older daemon omits selectability', () => {
    const lines = designSystemInstallReportLines('Imported', {
      designSystem: { id: 'user:acme', title: 'Acme', status: 'draft' },
    });
    expect(lines.at(-1)).toBe('Publish it: od design-systems publish user:acme');
  });

  it('reports a published kit as ready', () => {
    expect(designSystemInstallReportLines('Installed', {
      designSystem: { id: 'user:acme', title: 'Acme', status: 'published' },
      selectability: { selectable: true },
    })).toEqual([
      'Installed user:acme -> Acme',
      'Status: published. Ready for generation.',
    ]);
  });
});

it('advertises revision-bound approve and unapprove actions', () => {
  expect(DESIGN_SYSTEMS_USAGE).toContain('approve <id>');
  expect(DESIGN_SYSTEMS_USAGE).toContain('unapprove <id>');
});

it('reports Unreviewed imports with an Approve action rather than a publish action', () => {
  expect(designSystemInstallReportLines('Installed', { designSystem: { id: 'user:kit', status: 'published' }, selectability: { selectable: false, reason: 'unreviewed' } })).toEqual(['Installed user:kit', 'Status: Unreviewed. Approve the inspected revision before generation.', 'Approve it: od design-system approve user:kit']);
});
