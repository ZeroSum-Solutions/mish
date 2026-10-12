// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCaptureImportMetadata, type CaptureView } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchCapturePanel } from '../../../src/components/workbench/WorkbenchCapturePanel';
import * as imaging from '../../../src/components/workbench/capture-image';

// AC-R14.1 web canvas: uploaded and pasted screenshots and permission-granted
// screen capture are saved through POST /api/workbench/captures (the same
// endpoint as `od workbench capture import`); the cross-origin restriction is
// stated; saved captures are listed again after a reload (resume).

vi.mock('../../../src/components/workbench/capture-image', async original => ({
  ...await original<typeof import('../../../src/components/workbench/capture-image')>(),
  readImageFrame: vi.fn(async () => ({ width: 30, height: 20 })),
  cropImage: vi.fn(async (blob: Blob) => blob),
  displayCaptureSupported: vi.fn(() => true),
  grabDisplayFrame: vi.fn(),
}));

function decodeHeader(value: string): unknown {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0))));
}

const saved: CaptureView = {
  capture: {
    schema: 'workbench-capture/1', id: 'cap_AAAAAAAAAAAAAAAAAAAA', assetId: 'asset-1', projectId: 'p1', captureMode: 'native-page',
    sourceUrl: 'https://example.com/pricing', sourceUrlRedacted: true, sourceTitle: 'Pricing', viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
    frame: { width: 2560, height: 1600 }, region: null, image: { mediaType: 'image/png', width: 2560, height: 1600, bytes: 1000 },
    contentHash: 'a'.repeat(64), capturePermission: 'desktop-host-user-action', rightsDeclaration: null, rightsDeclaredVia: null, parentCaptureId: null, createdAt: '2026-10-08T10:00:00.000Z',
  },
  bytesAvailable: true,
  imageUrl: '/api/workbench/captures/cap_AAAAAAAAAAAAAAAAAAAA/image?projectId=p1',
};

let requests: { url: string; init: RequestInit }[] = [];
beforeEach(() => {
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); requests.push({ url, init });
    if (url.startsWith('/api/workbench/captures?') && (init.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ projectId: 'p1', captures: [saved], nextCursor: null }), { status: 200 });
    if (url.startsWith('/api/workbench/captures?') && init.method === 'POST') {
      const metadata = parseCaptureImportMetadata(decodeHeader(String((init.headers as Record<string, string>)['x-od-capture-metadata'])));
      return new Response(JSON.stringify({ ...saved, capture: { ...saved.capture, id: 'cap_BBBBBBBBBBBBBBBBBBBB', captureMode: metadata.captureMode, sourceUrl: null, viewport: null } }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(imaging.grabDisplayFrame).mockReset(); vi.mocked(imaging.displayCaptureSupported).mockReturnValue(true); });

const view = () => <I18nProvider initial="en"><WorkbenchCapturePanel projectId="p1" /></I18nProvider>;
const posts = () => requests.filter(request => request.init.method === 'POST');

describe('WorkbenchCapturePanel', () => {
  describe.each([
    ['en', 'Upload a screenshot', "HEIC/HEIF isn't supported yet; export as PNG or JPEG"],
    ["en", "Upload a screenshot", "HEIC/HEIF isn't supported yet; export as PNG or JPEG"],
  ] as const)('unsupported uploads in %s', (locale, uploadLabel, message) => {
    it.each([
      ['shot.heic', 'image/heic'], ['shot.heif', 'image/heif'],
      ['shot.heic', 'image/heic-sequence'], ['shot.heif', 'image/heif-sequence'],
      ['SHOT.HEIC', ''], ['SHOT.HEIF', 'application/octet-stream'],
    ])('explains how to recover from %s (%s) before decoding or saving', async (name, type) => {
      render(<I18nProvider initial={locale}><WorkbenchCapturePanel projectId="p1" /></I18nProvider>);
      await screen.findByTestId('workbench-capture-item');
      const decodeCalls = vi.mocked(imaging.readImageFrame).mock.calls.length;
      fireEvent.change(screen.getByLabelText(uploadLabel), { target: { files: [new File(['x'], name, { type })] } });
      expect((await screen.findByRole('alert')).textContent).toBe(message);
      expect(vi.mocked(imaging.readImageFrame).mock.calls).toHaveLength(decodeCalls);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(posts()).toHaveLength(0);
    });
  });

  it('lists saved captures with their source, viewport and capture time so work resumes after a restart', async () => {
    render(view());
    const item = await screen.findByTestId('workbench-capture-item');
    expect(item.textContent).toContain('https://example.com/pricing');
    expect(item.textContent).toContain('1280 × 800');
    expect(item.querySelector('img')?.getAttribute('src')).toBe(saved.imageUrl);
    expect(item.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-08T10:00:00.000Z');
    // The web app cannot read another site's page; that limit is stated, not hidden.
    expect(screen.getByText(/cannot read pages from other sites/i)).toBeTruthy();
    expect(screen.getByText(/EXIF.*GPS.*removed.*before/i)).toBeTruthy();
  });

  it('saves an uploaded screenshot with its frame, optional source URL and an idempotency key', async () => {
    render(view());
    await screen.findByTestId('workbench-capture-item');
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Upload a screenshot'), { target: { files: [file] } });
    fireEvent.change(await screen.findByLabelText('Source URL (optional)'), { target: { value: 'https://example.com/landing' } });
    expect(screen.getByRole('dialog').textContent).toMatch(/EXIF.*GPS.*removed.*before/i);
    fireEvent.click(screen.getByRole('button', { name: 'Save capture' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const post = posts()[0]!;
    const headers = post.init.headers as Record<string, string>;
    expect(post.url).toBe('/api/workbench/captures?projectId=p1');
    expect(headers['content-type']).toBe('image/png');
    expect(headers['idempotency-key']).toBeTruthy();
    expect(parseCaptureImportMetadata(decodeHeader(headers['x-od-capture-metadata']!))).toEqual({ projectId: 'p1', captureMode: 'upload', frame: { width: 30, height: 20 }, sourceUrl: 'https://example.com/landing', viewport: null, region: null });
    await screen.findByText('Capture saved');
  });

  it('crops to a region in frame pixels and rejects a region outside the image before sending', async () => {
    render(view());
    await screen.findByTestId('workbench-capture-item');
    fireEvent.change(screen.getByLabelText('Upload a screenshot'), { target: { files: [new File(['x'], 's.png', { type: 'image/png' })] } });
    fireEvent.click(await screen.findByLabelText('Save a region'));
    fireEvent.change(screen.getByLabelText('Region left'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Region width'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save capture' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Region left'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Region height'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save capture' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const metadata = parseCaptureImportMetadata(decodeHeader((posts()[0]!.init.headers as Record<string, string>)['x-od-capture-metadata']!));
    expect(metadata.region).toEqual({ x: 5, y: 0, width: 10, height: 8 });
    expect(imaging.cropImage).toHaveBeenCalledWith(expect.any(Blob), { x: 5, y: 0, width: 10, height: 8 });
  });

  it('saves a pasted screenshot as a paste capture', async () => {
    render(view());
    const zone = await screen.findByTestId('workbench-capture-paste');
    const file = new File(['x'], 'clip.png', { type: 'image/png' });
    fireEvent.paste(zone, { clipboardData: { files: [file], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save capture' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(parseCaptureImportMetadata(decodeHeader((posts()[0]!.init.headers as Record<string, string>)['x-od-capture-metadata']!)).captureMode).toBe('paste');
  });

  it('captures the screen only after the browser grants permission, and offers upload when permission is denied', async () => {
    vi.mocked(imaging.grabDisplayFrame).mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    render(view());
    await screen.findByTestId('workbench-capture-item');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Capture screen' })); });
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission was not granted.*upload/i);
    expect(posts()).toHaveLength(0);

    vi.mocked(imaging.grabDisplayFrame).mockResolvedValueOnce({ blob: new Blob(['x'], { type: 'image/png' }), width: 30, height: 20 });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Capture screen' })); });
    fireEvent.click(await screen.findByRole('button', { name: 'Save capture' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(parseCaptureImportMetadata(decodeHeader((posts()[0]!.init.headers as Record<string, string>)['x-od-capture-metadata']!))).toMatchObject({ captureMode: 'screen-share', viewport: { width: 30, height: 20, deviceScaleFactor: 1 } });
  });

  it('explains when this browser has no screen capture instead of offering a dead button', async () => {
    vi.mocked(imaging.displayCaptureSupported).mockReturnValue(false);
    render(view());
    await screen.findByTestId('workbench-capture-item');
    expect((screen.getByRole('button', { name: 'Capture screen' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/does not support screen capture/i)).toBeTruthy();
  });
});
