// @vitest-environment jsdom

import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesignKitView, useBrandFonts } from '../../src/components/DesignKitView';
import { PreviewModal } from '../../src/components/PreviewModal';
import { createDropCoordinator } from '../../src/runtime/intake/drop-coordinator';
import { I18nProvider } from '../../src/i18n';
import type { DesignKit } from '../../src/runtime/design-kit';
import type { WorkspaceCollabContext } from '@mish/contracts';

function previewKit(): DesignKit {
  return {
    designSystemId: 'user:preview-kit',
    name: 'Preview Kit',
    editable: true,
    canUpload: false,
    logoSrc: null,
    logoAlternates: [],
    colors: [{ role: 'Primary', name: 'Primary', hex: '#123456', usage: 'Primary actions' }],
    typography: {
      display: { family: 'Inter', fallbacks: [], weights: [700] },
      body: { family: 'Inter', fallbacks: [], weights: [400] },
    },
    fonts: [],
    system: {
      kitUrl: '/raw/projects/preview/system/kit.html',
    },
    assets: [{
      kind: 'landing',
      label: 'Landing page',
      url: '/raw/projects/preview/system/artifacts/landing.html',
    }],
    showcaseHtml: '<main><a target="_blank" href="/">Open</a></main>',
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DesignKitView iframe sandboxing', () => {
  it.each([
    ['accepted image', true, 'logo.png', 'image/png', true],
    ['unsupported document', true, 'reference.pdf', 'application/pdf', false],
    ['disabled upload', false, 'logo.png', 'image/png', false],
  ])('keeps %s drops with the accepting owner', (_label, canUpload, filename, mime, accepted) => {
    const upload = vi.fn(); const fallback = vi.fn();
    render(<I18nProvider initial="en"><DesignKitView kit={{ ...previewKit(), canUpload, logoSrc: '/raw/brand/logo.svg' }} onUploadModule={upload} /></I18nProvider>);
    const owner = createDropCoordinator({ getSnapshot: () => 'project', onDrop: fallback }); const dispose = owner.mount(document);
    const file = new File(['bytes'], filename, { type: mime }); const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file], items: [{ kind: 'file', getAsFile: () => file }] } });
    try {
      screen.getByTestId('design-kit-logo-section').dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      if (accepted) { expect(upload).toHaveBeenCalledExactlyOnceWith('logo', file); expect(fallback).not.toHaveBeenCalled(); }
      else { expect(upload).not.toHaveBeenCalled(); expect(fallback).toHaveBeenCalledTimes(1); }
    } finally { dispose(); }
  });

  it('shows source rules, imagery, layout dimensions and the real asset viewer', () => {
    const kit = previewKit();
    kit.description = 'A precise booking system built around natural-light photography.';
    kit.rules = { do: ['Keep coral on the search trigger.'], avoid: ['Do not use coral for body text.'] };
    kit.imagery = { style: 'Rooms in natural light.', subjects: [], treatment: '', avoid: [], samples: [] };
    kit.layout = { description: 'A centered 1200px frame.', radius: '20px cards', borderWeight: '1px', spacing: '12px / 48px', postureRules: ['Left aligned sections.'] };
    render(<I18nProvider initial="en"><DesignKitView kit={kit} showCover={false} /></I18nProvider>);
    expect(screen.getByText('Keep coral on the search trigger.')).toBeTruthy();
    expect(screen.getByText('Do not use coral for body text.')).toBeTruthy();
    expect(screen.getByText('A centered 1200px frame.')).toBeTruthy();
    expect(screen.getByText('20px cards')).toBeTruthy();
    expect(screen.getByText('12px / 48px')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Landing page/ }));
    expect(screen.getByRole('dialog', { name: 'Landing page' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Landing page' }).querySelector('iframe')?.getAttribute('src')).toBe('/raw/projects/preview/system/artifacts/landing.html');
  });

  it('edits the canonical rule section without swallowing typography or preserved source rules', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const kit = previewKit();
    kit.rules = { do: ['Use the documented accent.'], avoid: [] };
    const body = '# Study\n\n## Typography Rules\n- Preserve this font rule.\n\n## Do and avoid\n### Do\n- Use the documented accent.\n\n## Source specification\nPreserve this source boundary.\n\n## Rules\n**Do**\n- Preserve this original rule.';
    render(<I18nProvider initial="en"><DesignKitView kit={kit} designMd={{ body, onSave }} /></I18nProvider>);
    fireEvent.click(screen.getByTitle('Edit Do and don’t section'));
    const textarea = screen.getByRole('textbox', { name: 'Do and don’t DESIGN.md section' }) as HTMLTextAreaElement;
    expect(textarea.value).not.toContain('Typography Rules');
    expect(textarea.value).not.toContain('Preserve this original rule.');
    fireEvent.change(textarea, { target: { value: '## Do and avoid\n### Do\n- Keep the source roles.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save module' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toContain('Preserve this font rule.');
    expect(onSave.mock.calls[0]?.[0]).toContain('Preserve this original rule.');
  });

  it('shows a visual specimen using the source palette and type instead of an empty logo stage', () => {
    const kit = previewKit();
    kit.colors = [
      { role: '--bg', name: 'Canvas', hex: '#f8f8f7', usage: 'Page canvas' },
      { role: '--fg', name: 'Text', hex: '#16171a', usage: 'Primary text' },
      { role: '--accent', name: 'Action', hex: '#1e5a78', usage: 'Primary action' },
    ];
    render(<I18nProvider initial="en"><DesignKitView kit={kit} showCover={false} /></I18nProvider>);
    const specimen = screen.getByTestId('design-kit-specimen');
    expect(specimen.style.getPropertyValue('--specimen-bg')).toBe('#f8f8f7');
    expect(specimen.style.getPropertyValue('--specimen-ink')).toBe('#16171a');
    expect(within(specimen).getByText('Aa')).toBeTruthy();
    expect(within(specimen).getByText('#1E5A78')).toBeTruthy();
    expect(screen.queryByText('No logo yet')).toBeNull();
  });
  it('keeps fetch headers while browser font URLs use server-derived project authority', async () => {
    const context = {
      workspaceId: 'workspace-team',
      workspaceType: 'team',
      workspaceMemberId: 'member-1',
      role: 'member',
      memberStatus: 'active',
      lifecycleState: 'active',
      permissions: {
        canShareProjects: false,
        canWriteSyncedFiles: false,
      },
    } as WorkspaceCollabContext;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/files')
        ? Response.json({ files: [{ name: 'fonts/manifest.json' }] })
        : Response.json({ files: [{
            file: 'inter.woff2', family: 'Inter', format: 'woff2', weight: 400, style: 'normal',
          }] }),
    );

    const { unmount } = renderHook(() => useBrandFonts('project-team', [], context));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-team/raw/fonts/manifest.json',
        {
          cache: 'no-store',
          headers: expect.objectContaining({
            'x-od-workspace-id': 'workspace-team',
            'x-od-workspace-member-id': 'member-1',
          }),
        },
      );
      expect(document.head.querySelector('style[data-brand-fonts="project-team"]')?.textContent)
        .toContain(
          '/api/projects/project-team/raw/fonts/inter.woff2',
        );
    });
    unmount();
  });

  it('skips the raw font manifest request when the project file list lacks it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ files: [] }));
    const { unmount } = renderHook(() => useBrandFonts('fontless-project', [], null));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/fontless-project/files', expect.any(Object),
    ));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/raw/fonts/manifest.json'))).toBe(false);
    unmount();
  });

  it('does not let generated kit previews escape the iframe sandbox', () => {
    const { container } = render(
      <I18nProvider initial="en">
        <DesignKitView kit={previewKit()} />
      </I18nProvider>,
    );

    const iframes = Array.from(container.querySelectorAll('iframe'));
    expect(iframes.length).toBeGreaterThan(0);
    for (const iframe of iframes) {
      expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-popups');
    }
    expect(container.innerHTML).not.toContain('allow-popups-to-escape-sandbox');
    expect(container.innerHTML).not.toContain('allow-same-origin');
  });

  it('renders new kit actions with the active non-English locale', () => {
    const kit = { ...previewKit(), canUpload: true };
    render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={kit}
          designMd={{
            body: '# Preview Kit',
            onSave: async () => {},
            saving: false,
          }}
          onUploadModule={() => {}}
          onRefresh={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.getAllByTitle("Copy DESIGN.md").length).toBeGreaterThan(0);
    expect(screen.getByTitle("Add font file")).toBeTruthy();
    expect(screen.getByTitle("Copy Typography section")).toBeTruthy();
    expect(screen.getByTitle("Refresh")).toBeTruthy();
  });

  it('edits only the selected DESIGN.md module section', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={previewKit()}
          designMd={{
            body: [
              '# Preview Kit',
              '',
              'The system overview.',
              '',
              '## Color Palette',
              '',
              '| Role | Name | Hex | Usage |',
              '| --- | --- | --- | --- |',
              '| primary | Primary | `#123456` | Primary actions |',
              '',
              '## Voice & Tone',
              '',
              '- Direct and clear.',
            ].join('\n'),
            onSave,
            saving: false,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTitle('Edit Palette section'));

    const textarea = screen.getByRole('textbox', { name: 'Palette DESIGN.md section' }) as HTMLTextAreaElement;
    expect(textarea.value).toContain('## Color Palette');
    expect(textarea.value).not.toContain('## Voice & Tone');

    fireEvent.change(textarea, {
      target: {
        value: [
          '## Color Palette',
          '',
          '| Role | Name | Hex | Usage |',
          '| --- | --- | --- | --- |',
          '| primary | Primary | `#FF6A3D` | Primary actions |',
        ].join('\n'),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save module' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0]?.[0] as string;
    expect(saved).toContain('# Preview Kit');
    expect(saved).toContain('## Voice & Tone');
    expect(saved).toContain('`#FF6A3D`');
    expect(saved).not.toContain('`#123456`');
  });

  it('preserves the original source document when editing an imported palette', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const original = '## Complete original source specification\n\n# Original\n\n## Color\n\nOriginal source palette.\n\n## Typography\n\nOriginal source typography.';
    render(<I18nProvider initial="en"><DesignKitView kit={previewKit()} designMd={{
      body: `# Study\n\n## Colors\n\nNative palette.\n\n## Typography\n\nNative typography.\n\n${original}`,
      onSave, saving: false,
    }} /></I18nProvider>);
    fireEvent.click(screen.getByTitle('Edit Palette section'));
    const textarea = screen.getByRole('textbox', { name: 'Palette DESIGN.md section' }) as HTMLTextAreaElement;
    expect(textarea.value).toBe('## Colors\n\nNative palette.');
    fireEvent.change(textarea, { target: { value: '## Colors\n\nUpdated native palette.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save module' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toContain(original);
    expect(onSave.mock.calls[0]?.[0]).toContain('Native typography.');
  });

  it('keeps upload, full-system preview, and shortcut help out of the sticky more menu', () => {
    const baseKit = previewKit();
    const kit = {
      ...baseKit,
      canUpload: true,
      system: {
        kitUrl: baseKit.system!.kitUrl,
        kitDarkUrl: baseKit.system?.kitDarkUrl,
        tokensUrl: baseKit.system?.tokensUrl,
        indexUrl: '/raw/projects/preview/system/index.html',
      },
    };

    render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={kit}
          stickyHeader
          designMd={{
            body: '# Preview Kit',
            onSave: async () => {},
            saving: false,
          }}
          onUploadModule={() => {}}
          onRefresh={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.queryByTestId('design-kit-shortcuts-hint')).toBeNull();

    fireEvent.click(screen.getByTestId('design-kit-more-actions'));

    expect(screen.getByRole('menuitem', { name: 'Edit DESIGN.md' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy DESIGN.md' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Upload MD' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Open full system' })).toBeNull();
  });

  it('renders sticky header action loading state in the overflow menu', () => {
    render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={previewKit()}
          stickyHeader
          headerMenuActions={[
            {
              id: 'refresh',
              label: 'Refresh',
              icon: 'refresh',
              onClick: () => {},
              disabled: true,
              loading: true,
            },
          ]}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('design-kit-more-actions'));
    const refresh = screen.getByRole('menuitem', { name: 'Refresh' });
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports clipboard success for DESIGN.md copy actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const onActionFeedback = vi.fn();
    render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={previewKit()}
          stickyHeader
          designMd={{ body: '# Preview Kit' }}
          onActionFeedback={onActionFeedback}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('design-kit-more-actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy DESIGN.md' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Preview Kit'));
    expect(onActionFeedback).toHaveBeenCalledWith('loading', 'Copy DESIGN.md...');
    expect(onActionFeedback).toHaveBeenCalledWith('success', 'Copied!');
  });

  it('renders the embedded component kit without an Open full system action', () => {
    const baseKit = previewKit();
    const kit = {
      ...baseKit,
      system: {
        kitUrl: baseKit.system!.kitUrl,
        indexUrl: '/raw/projects/preview/system/index.html',
      },
    };

    const { container } = render(
      <I18nProvider initial="en">
        <DesignKitView kit={kit} />
      </I18nProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Open full system' })).toBeNull();
    expect(container.querySelector('iframe[src="/raw/projects/preview/system/kit.html"]')).toBeTruthy();
  });

  it('opens the component kit on the light file before explicit dark selection', () => {
    const baseKit = previewKit();
    const kit = {
      ...baseKit,
      system: {
        kitUrl: baseKit.system!.kitUrl,
        kitDarkUrl: '/raw/projects/preview/system/kit.dark.html',
      },
    };

    const { container } = render(
      <I18nProvider initial="en">
        <DesignKitView kit={kit} />
      </I18nProvider>,
    );

    expect(container.querySelector('iframe[src="/raw/projects/preview/system/kit.html"]')).toBeTruthy();
    expect(container.querySelector('iframe[src="/raw/projects/preview/system/kit.dark.html"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(container.querySelector('iframe[src="/raw/projects/preview/system/kit.dark.html"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(container.querySelector('iframe[src="/raw/projects/preview/system/kit.html"]')).toBeTruthy();
  });

  it('lets users browse design-system images inside the preview modal', () => {
    const kit: DesignKit = {
      ...previewKit(),
      imagery: {
        style: '',
        subjects: [],
        treatment: '',
        avoid: [],
        samples: [
          { url: '/raw/projects/preview/imagery/hero.png', caption: 'Hero image', kind: 'hero' },
          { url: '/raw/projects/preview/imagery/detail.png', caption: 'Detail image', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-3.png', caption: 'Filler image 3', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-4.png', caption: 'Filler image 4', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-5.png', caption: 'Filler image 5', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-6.png', caption: 'Filler image 6', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-7.png', caption: 'Filler image 7', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-8.png', caption: 'Filler image 8', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/hidden.png', caption: 'Hidden image', kind: 'detail' },
        ],
      },
    };

    render(
      <I18nProvider initial="en">
        <DesignKitView kit={kit} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hero image' }));

    let dialog = screen.getByRole('dialog', { name: 'Hero image' });
    expect(within(dialog).getByRole('img', { name: 'Hero image' }).getAttribute('src')).toBe(
      '/raw/projects/preview/imagery/hero.png',
    );
    expect(within(dialog).getByText('1 / 9')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous' }));

    dialog = screen.getByRole('dialog', { name: 'Hidden image' });
    expect(within(dialog).getByRole('img', { name: 'Hidden image' }).getAttribute('src')).toBe(
      '/raw/projects/preview/imagery/hidden.png',
    );
    expect(within(dialog).getByText('9 / 9')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'ArrowRight' });

    dialog = screen.getByRole('dialog', { name: 'Hero image' });
    expect(within(dialog).getByRole('img', { name: 'Hero image' }).getAttribute('src')).toBe(
      '/raw/projects/preview/imagery/hero.png',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));

    dialog = screen.getByRole('dialog', { name: 'Detail image' });
    expect(within(dialog).getByRole('img', { name: 'Detail image' }).getAttribute('src')).toBe(
      '/raw/projects/preview/imagery/detail.png',
    );
    expect(within(dialog).getByText('2 / 9')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'ArrowLeft' });

    dialog = screen.getByRole('dialog', { name: 'Hero image' });
    expect(within(dialog).getByRole('img', { name: 'Hero image' }).getAttribute('src')).toBe(
      '/raw/projects/preview/imagery/hero.png',
    );
  });

  it('skips a hidden gallery image when it fails after opening in the lightbox', async () => {
    const kit: DesignKit = {
      ...previewKit(),
      imagery: {
        style: '',
        subjects: [],
        treatment: '',
        avoid: [],
        samples: [
          { url: '/raw/projects/preview/imagery/hero.png', caption: 'Hero image', kind: 'hero' },
          { url: '/raw/projects/preview/imagery/detail.png', caption: 'Detail image', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-3.png', caption: 'Filler image 3', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-4.png', caption: 'Filler image 4', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-5.png', caption: 'Filler image 5', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-6.png', caption: 'Filler image 6', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-7.png', caption: 'Filler image 7', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/filler-8.png', caption: 'Filler image 8', kind: 'detail' },
          { url: '/raw/projects/preview/imagery/hidden.png', caption: 'Hidden image', kind: 'detail' },
        ],
      },
    };

    render(
      <I18nProvider initial="en">
        <DesignKitView kit={kit} />
      </I18nProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Hidden image' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Hero image' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Hero image' })).getByRole('button', { name: 'Previous' }),
    );

    const hiddenDialog = screen.getByRole('dialog', { name: 'Hidden image' });
    fireEvent.error(within(hiddenDialog).getByRole('img', { name: 'Hidden image' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Hidden image' })).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Filler image 8' })).toBeTruthy();
    });

    const fallbackDialog = screen.getByRole('dialog', { name: 'Filler image 8' });
    expect(within(fallbackDialog).getByRole('img', { name: 'Filler image 8' }).getAttribute('src')).toBe(
      '/raw/projects/preview/imagery/filler-8.png',
    );
    expect(within(fallbackDialog).getByText('8 / 8')).toBeTruthy();
  });

  it('lets Escape close an image lightbox before the outer preview modal', () => {
    const onClose = vi.fn();
    const kit: DesignKit = {
      ...previewKit(),
      imagery: {
        style: '',
        subjects: [],
        treatment: '',
        avoid: [],
        samples: [
          { url: '/raw/projects/preview/imagery/hero.png', caption: 'Hero image', kind: 'hero' },
        ],
      },
    };

    render(
      <I18nProvider initial="en">
        <PreviewModal
          title="Preview Kit"
          views={[{
            id: 'kit',
            label: 'Kit',
            custom: <DesignKitView kit={kit} />,
          }]}
          exportTitleFor={() => 'preview-kit'}
          onClose={onClose}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hero image' }));
    expect(screen.getByRole('dialog', { name: 'Hero image' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Hero image' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Preview Kit preview' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('scrolls to Logo and reveals edit controls for edit focus requests', () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const { container, unmount } = render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={previewKit()}
          editFocusRequest={{ module: 'logo', nonce: 1 }}
        />
      </I18nProvider>,
    );

    try {
      const logoSection = container.querySelector<HTMLElement>('[data-testid="design-kit-logo-section"]');
      if (!logoSection) throw new Error('Expected Logo section to render');
      expect(logoSection.textContent).toContain(
        'Edit Logo here. Hover this section to reveal controls.',
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    } finally {
      unmount();
      vi.useRealTimers();
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });
});

it('rejects CSS rules smuggled through project font descriptors', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => Response.json({ files: String(input).endsWith('/files') ? [
    { name: 'fonts/manifest.json' },
  ] : [
    { file: 'evil.woff2', family: 'Evil', format: 'woff2', weight: '400;}body{display:none}', style: 'normal' },
    { file: 'bad-style.woff2', family: 'Bad', weight: '400', style: 'oblique 10deg;}body{display:none}' },
    { file: 'bad-angle.woff2', family: 'Bad', weight: '400', style: 'oblique 91deg' },
    { file: 'inter.woff2', family: 'Inter', format: 'woff2', weight: '400', style: 'normal' },
  ] }));
  const { unmount } = renderHook(() => useBrandFonts('hostile-project', []));
  await waitFor(() => expect(document.head.querySelector('style[data-brand-fonts="hostile-project"]')?.textContent).toContain('inter.woff2'));
  expect(document.head.querySelector('style[data-brand-fonts="hostile-project"]')?.textContent).not.toContain('display:none');
  expect(document.head.querySelector('style[data-brand-fonts="hostile-project"]')?.textContent).not.toContain('evil.woff2');
  expect(document.head.querySelector('style[data-brand-fonts="hostile-project"]')?.textContent).not.toContain('bad-style.woff2');
  expect(document.head.querySelector('style[data-brand-fonts="hostile-project"]')?.textContent).not.toContain('bad-angle.woff2');
  unmount();fetchMock.mockRestore();
});

it.each([
  ['normal', 'normal', '400'],
  ['bold', 'italic', '700'],
  ['400', 'oblique 10deg', '400'],
  ['100 900', 'oblique -10deg 20deg', '100 900'],
  ['500', 'oblique 0.125turn', '500'],
  ['normal bold', 'oblique 90deg', '400 700'],
  ['100  900', 'oblique 20deg -10deg', '100 900'],
  ['bold 900', 'Italic', '700 900'],
])('loads harvested project font weight %s and style %s', async (weight, style, expectedWeight) => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => Response.json({
    files: String(input).endsWith('/files')
      ? [{ name: 'fonts/manifest.json' }]
      : [{ family: 'Harvested', file: 'harvested.woff2', weight, style }],
  }));
  const { unmount } = renderHook(() => useBrandFonts('harvested-project', []));
  await waitFor(() => expect(document.head.querySelector('style[data-brand-fonts="harvested-project"]')?.textContent)
    .toContain(`font-weight:${expectedWeight};font-style:${style.toLowerCase()};`));
  unmount();
  fetchMock.mockRestore();
});
