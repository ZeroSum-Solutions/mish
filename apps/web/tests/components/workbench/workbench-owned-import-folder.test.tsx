// @vitest-environment jsdom
// AC-R12.4: a Magic Patterns export is a folder tree. The import offers a folder
// picker that keeps each file's path relative to the chosen folder, so nested
// styles, scripts and assets keep their references and two files with the same
// name in different folders import as two files.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchOwnedImport } from '../../../src/components/workbench/WorkbenchOwnedImport';
import { createOwnedImport, listOwnedImports } from '../../../src/providers/workbench-owned-imports';

vi.mock('../../../src/providers/workbench-owned-imports', async original => ({ ...await original<typeof import('../../../src/providers/workbench-owned-imports')>(), createOwnedImport: vi.fn(), listOwnedImports: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function inFolder(relative: string, body: string): File {
  const file = new File([body], relative.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', { value: relative });
  return file;
}

describe('owned import folder picker', () => {
  it('offers a directory picker and keeps folder-relative paths, duplicate basenames included', async () => {
    vi.mocked(listOwnedImports).mockResolvedValue({ imports: [] });
    vi.mocked(createOwnedImport).mockRejectedValue(new Error('stop'));
    render(<I18nProvider initial="en"><WorkbenchOwnedImport /></I18nProvider>);
    const folder = screen.getByLabelText('Export folder') as HTMLInputElement;
    expect(folder.type).toBe('file');
    expect(folder.hasAttribute('webkitdirectory')).toBe(true);
    fireEvent.change(folder, { target: { files: [
      inFolder('landing-export/pages/index.html', '<link rel="stylesheet" href="../styles/site.css">'),
      inFolder('landing-export/styles/site.css', 'h1{}'),
      inFolder('landing-export/hero/logo.svg', '<svg/>'),
      inFolder('landing-export/footer/logo.svg', '<svg/>'),
    ] } });
    expect((screen.getByLabelText('Entry file') as HTMLSelectElement).value).toBe('pages/index.html');
    fireEvent.change(screen.getByLabelText('Import name'), { target: { value: 'Landing export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import prototype' }));
    await waitFor(() => expect(createOwnedImport).toHaveBeenCalled());
    const request = vi.mocked(createOwnedImport).mock.calls[0]![0];
    expect(request.entryPath).toBe('pages/index.html');
    expect(request.files.map(file => file.path).sort()).toEqual(['footer/logo.svg', 'hero/logo.svg', 'pages/index.html', 'styles/site.css']);
  });

  it('leaves hidden entries and node_modules out of a folder pick, as od does', async () => {
    vi.mocked(listOwnedImports).mockResolvedValue({ imports: [] });
    vi.mocked(createOwnedImport).mockRejectedValue(new Error('stop'));
    render(<I18nProvider initial="en"><WorkbenchOwnedImport /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Export folder'), { target: { files: [
      inFolder('landing-export/index.html', '<p>x</p>'),
      inFolder('landing-export/.DS_Store', 'x'),
      inFolder('landing-export/.git/config', 'x'),
      inFolder('landing-export/node_modules/pkg/index.js', 'x'),
    ] } });
    fireEvent.change(screen.getByLabelText('Import name'), { target: { value: 'Landing export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import prototype' }));
    await waitFor(() => expect(createOwnedImport).toHaveBeenCalled());
    expect(vi.mocked(createOwnedImport).mock.calls[0]![0].files.map(file => file.path)).toEqual(['index.html']);
  });
});
