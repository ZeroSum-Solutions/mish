import { describe, expect, it } from 'vitest';

import { parseDesignMd } from '../../src/runtime/design-md-parse';
import { parsedToKit, mergeBrandKitWithDesignMd } from '../../src/runtime/design-kit';

describe('parsedToKit package static assets', () => {
  it('keeps manifest-derived font faces when merging an editable brand with its package guide', () => {
    const original = parsedToKit(parseDesignMd('# Example'), { editable: true });
    const merged = mergeBrandKitWithDesignMd(original, '# Example', {
      designSystemId: 'user:example', editable: true,
      packageInfo: { availableFiles: ['fonts/inter.woff2', 'fonts/fonts.css'], manifest: {
        schemaVersion: 'od-design-system-project/v1', id: 'example', name: 'Example', category: 'Trust',
        fonts: [{ family: 'Inter', file: 'fonts/inter.woff2' }],
      } },
    });
    expect(merged.fontFaces?.[0]?.url).toBe('/api/design-systems/user%3Aexample/static?path=fonts%2Finter.woff2');
  });
  it('loads package fonts with the same canonical Workspace scope as the kit', () => {
    const kit = parsedToKit(parseDesignMd('# Example'), {
      designSystemId: 'user:example', editable: true, projectId: 'backing-project',
      workspaceContext: { workspaceId: 'team', workspaceMemberId: 'member' } as import('@open-design/contracts').WorkspaceCollabContext,
      packageInfo: { availableFiles: ['fonts/inter.woff2', 'fonts/fonts.css'], manifest: {
        schemaVersion: 'od-design-system-project/v1', id: 'example', name: 'Example', category: 'Trust',
        fonts: [{ family: 'Inter', file: 'fonts/inter.woff2' }],
      } },
    });
    expect(kit.fontFaces?.[0]?.url).toBe('/api/design-systems/user%3Aexample/static?path=fonts%2Finter.woff2&workspaceId=team&workspaceMemberId=member');
  });
  it('does not request a missing local font stylesheet', () => {
    const kit = parsedToKit(parseDesignMd('# Example'), {
      designSystemId: 'user:example', editable: true,
      packageInfo: { availableFiles: [], manifest: {
        schemaVersion: 'od-design-system-project/v1', id: 'example', name: 'Example', category: 'Trust',
        fonts: [{ family: 'Inter', file: 'fonts/inter.woff2' }],
      } },
    });
    expect(kit.fontFaces).toBeUndefined();
  });
  it('retains the canonical reference after an editable package workspace is opened', () => {
    const kit = parsedToKit(parseDesignMd('# Doppler'), {
      designSystemId: 'user:study-doppler', projectId: 'workspace-doppler',
      editable: true, previewImagePath: 'assets/preview.jpg',
    });
    expect(kit.referenceImageUrl).toBe('/api/design-systems/user%3Astudy-doppler/static?path=assets%2Fpreview.jpg');
    expect(kit.canUpload).toBe(true);
  });
  it('exposes the separate component lab when a package uses a showcase kit', () => {
    const kit = parsedToKit(parseDesignMd('# Study'), {
      designSystemId: 'user:study', editable: false,
      packageInfo: { availableFiles: ['system/kit.html', 'components.html'], manifest: {
        schemaVersion: 'od-design-system-project/v1', id: 'study', name: 'Study', category: 'Trust',
        files: { design: 'DESIGN.md', tokens: 'tokens.css', components: 'components.html' },
      } },
    });
    expect(kit.assets).toEqual([{ kind: 'components', label: 'Component lab', url: '/api/design-systems/user%3Astudy/static?path=components.html' }]);
  });

  it('loads a private imported package reference image without requiring a backing project', () => {
    const kit = parsedToKit(parseDesignMd('# Study'), {
      designSystemId: 'user:study', editable: true, previewImagePath: 'assets/preview.jpg',
      packageInfo: { availableFiles: ['assets/preview.jpg'], manifest: {
        schemaVersion: 'od-design-system-project/v1', id: 'study', name: 'Study', category: 'Trust',
      } },
    });
    expect(kit.referenceImageUrl).toBe('/api/design-systems/user%3Astudy/static?path=assets%2Fpreview.jpg');
    expect(kit.canUpload).toBe(false);
  });

  it('falls back to declared components and omits missing artifacts when packaged system files are absent', () => {
    const kit = parsedToKit(parseDesignMd('# Tom Modern Design'), {
      designSystemId: 'tom-modern',
      editable: false,
      packageInfo: {
        availableFiles: [
          'DESIGN.md',
          'tokens.css',
          'components.html',
        ],
        manifest: {
          schemaVersion: 'od-design-system-project/v1',
          id: 'tom-modern',
          name: 'Tom Modern Design',
          category: 'Starter',
          files: {
            design: 'DESIGN.md',
            tokens: 'tokens.css',
            components: 'components.html',
          },
        },
      },
    });

    expect(kit.system).toMatchObject({
      kitUrl: '/api/design-systems/tom-modern/static?path=components.html',
      kitLabel: 'components.html',
    });
    expect(kit.system?.kitDarkUrl).toBeUndefined();
    expect(kit.assets).toBeUndefined();
  });

  it('keeps generated system kit and artifact URLs when the package includes them', () => {
    const kit = parsedToKit(parseDesignMd('# Bento'), {
      designSystemId: 'bento',
      editable: false,
      packageInfo: {
        availableFiles: [
          'system/kit.html',
          'system/kit.dark.html',
          'system/artifacts/landing.html',
        ],
        manifest: {
          schemaVersion: 'od-design-system-project/v1',
          id: 'bento',
          name: 'Bento',
          category: 'Layout',
          files: {
            design: 'DESIGN.md',
            tokens: 'tokens.css',
            components: 'components.html',
          },
        },
      },
    });

    expect(kit.system).toMatchObject({
      kitUrl: '/api/design-systems/bento/static?path=system%2Fkit.html',
      kitDarkUrl: '/api/design-systems/bento/static?path=system%2Fkit.dark.html',
      kitLabel: 'system/kit.html',
    });
    expect(kit.assets).toEqual([
      {
        kind: 'landing',
        label: 'Landing page',
        url: '/api/design-systems/bento/static?path=system%2Fartifacts%2Flanding.html',
      },
    ]);
  });
});

it('rejects injected font descriptors and namespaces a package named after an app font', () => {
  const parsed = parseDesignMd("# Example\n\n## Typography\n- **Body:** 'Albert Sans' — weights: 400");
  const kit = parsedToKit(parsed, { designSystemId: 'user:hostile', editable: false,
    packageInfo: { availableFiles: ['fonts/good.woff2', 'fonts/bad.woff2'], manifest: {
      schemaVersion: 'od-design-system-project/v1', id: 'hostile', name: 'Hostile', category: 'Trust',
      fonts: [
        { family: 'Albert Sans', file: 'fonts/good.woff2', weight: '400' },
        { family: 'Evil', file: 'fonts/bad.woff2', weight: '400;}body{display:none}' },
        { family: 'Evil', file: 'fonts/bad.woff2', style: 'normal;}body{display:none}' },
        { family: 'Escape', file: 'fonts/../private.woff2' },
      ],
    } },
  });
  expect(kit.fontFaces).toHaveLength(1);
  expect(kit.fontFaces?.[0]?.family).toMatch(/^od-package-[0-9a-f_]+$/);
  expect(kit.fontFaces?.[0]?.family).not.toBe('Albert Sans');
  expect(kit.typography.body?.previewFamily).toBe(kit.fontFaces?.[0]?.family);
});
