// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LibraryAsset } from '@mish/contracts';
import { LibraryPreviewModal } from '../../src/components/LibraryPreviewModal';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const asset = (kind: LibraryAsset['kind']): LibraryAsset => ({ id: 'asset', kind, storage: 'owned', capturedAt: 1, archivedDate: '2026-10-03', contentHash: 'a'.repeat(64), tags: [], sources: [{ id: 'source', assetId: 'asset', sourceKind: 'drop', createdAt: 1 }], size: 200 * 1024 * 1024, createdAt: 1, updatedAt: 1 });
function show(kind: LibraryAsset['kind']) { return render(<LibraryPreviewModal asset={asset(kind)} hasPrev={false} hasNext={false} onPrev={() => {}} onNext={() => {}} onClose={() => {}} onDelete={() => {}} />); }
it.each(['file', 'text'] as const)('offers a direct opaque/large%s download without reading a200MiB text/blob body', kind => {
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); show(kind);
 expect(screen.getByText('Original file available for download.')).toBeTruthy(); expect(screen.getAllByRole('link', { name: /Download/ })[0]?.getAttribute('href')).toBe('/api/library/assets/asset/raw'); expect(fetcher).not.toHaveBeenCalled();
});
it.each(['html', 'design-system'] as const)('preserves interactive%s only through the explicit isolated preview endpoint', kind => {
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); show(kind);
 const frame = document.querySelector('iframe'); expect(frame?.getAttribute('src')).toBe('/api/library/assets/asset/preview'); expect(frame?.getAttribute('sandbox')).toBe('allow-scripts'); expect(fetcher).not.toHaveBeenCalled();
});
it('labels a stored opaque Library file with the model-readability notice, and not a large readable text asset', () => {
 vi.stubGlobal('fetch', vi.fn());
 show('file'); expect(screen.getByTestId('library-opaque-note').textContent).toBe('Stored; contents cannot be read by this model.');
 expect(screen.getAllByRole('link', { name: /Download/ })[0]?.getAttribute('href')).toBe('/api/library/assets/asset/raw');
 cleanup(); show('text'); expect(screen.queryByTestId('library-opaque-note')).toBeNull(); expect(screen.queryByText('Stored; contents cannot be read by this model.')).toBeNull();
});
