// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchProjectFilePreview: vi.fn(async () => null),
  };
});

function documentFile(overrides: Partial<ProjectFile>): ProjectFile {
  return {
    name: 'report.pdf',
    path: 'report.pdf',
    type: 'file',
    size: 1.2 * 1024 * 1024,
    mtime: 1710000000,
    kind: 'pdf',
    mime: 'application/pdf',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('FileViewer document toolbar meta', () => {
  it.each([
    ['pdf', 'PDF · 1.2 MB'],
    ['document', 'Document · 1.2 MB'],
    ['presentation', 'Presentation · 1.2 MB'],
  ] as const)('labels a %s file once with its size and no raw placeholder', (kind, label) => {
    const { container } = render(
      <FileViewer projectId="project-1" projectKind="prototype" file={documentFile({ kind })} />,
    );
    const meta = container.querySelector('.document-viewer .viewer-meta');
    expect(meta?.textContent).toBe(label);
    expect(meta?.textContent).not.toMatch(/\{\w+\}/);
  });
});
