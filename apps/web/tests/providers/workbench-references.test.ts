import { afterEach, expect, it, vi } from 'vitest';
import { fanoutReferences } from '../../src/providers/workbench-references';
import { WorkbenchRequestError } from '../../src/providers/workbench';
import { referenceFanout } from '../helpers/reference-fanout';
afterEach(() => vi.unstubAllGlobals());
it('posts a validated typed request and parses the response', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(referenceFanout())));
  vi.stubGlobal('fetch', fetcher);
  expect(await fanoutReferences({ brief: 'Dentistry', spineCode: 'TL' })).toEqual(referenceFanout());
  expect(fetcher).toHaveBeenCalledWith('/api/workbench/references/fanout', expect.objectContaining({ method: 'POST', body: JSON.stringify({ brief: 'Dentistry', spineCode: 'TL', limit: 10 }) }));
  fetcher.mockResolvedValue(new Response(JSON.stringify({ references: [] })));
  await expect(fanoutReferences({ brief: 'Dentistry' })).rejects.toThrow();
});
it('refuses invalid input before transport and retains typed HTTP failure', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'reference-request-invalid', message: 'Invalid request' } }), { status: 422 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(fanoutReferences({ brief: '' })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(fanoutReferences({ brief: 'Dentistry' })).rejects.toBeInstanceOf(WorkbenchRequestError);
});
