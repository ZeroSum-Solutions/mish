// @vitest-environment jsdom
// AC-R01.1: each named surface accepts an OS file drop without navigating away,
// and the file lands in that surface's own destination. App.tsx mounts one
// WorkbenchIntake for every surface; `surfaceTarget` mirrors its route →
// destination rule (App.tsx, the `<WorkbenchIntake ... target={{` mount).
// Untargeted drops stay in library custody until the user chooses Attach. The
// Electron-level refusal of an unclaimed `file:` navigation is covered in
// apps/desktop/tests/main/native-drop-handlers.test.ts; the physical Finder
// drop on each surface stays the open native probe gate (N1-*).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CreateIntakeBatchRequest, IntakeBatchSnapshot, IntakeFilePutResponse } from '@mish/contracts';
import { IntakeStore, type IntakeTarget } from '../../src/runtime/intake/intake-store';
import { WorkbenchDropModeButton, WorkbenchIntake } from '../../src/components/WorkbenchIntake';
import { parseRoute, type Route } from '../../src/router';

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });

function surfaceTarget(route: Route): IntakeTarget {
 return {
  destination: route.kind === 'project'
   ? { kind: 'project', projectId: route.projectId, ...(route.conversationId ? { conversationId: route.conversationId } : {}) }
   : { kind: 'pending' },
  context: null,
 };
}

function fixture() {
 const receipts = new Map<string, IntakeBatchSnapshot>();
 const create = vi.fn(async (request: CreateIntakeBatchRequest) => {
  const receipt: IntakeBatchSnapshot = { intakeBatchId: request.intakeBatchId, revision: 1, destination: request.destination, files: request.files.map(file => ({ clientFileId: file.clientFileId, order: file.order, descriptor: file, state: 'queued', retryable: true, hasSuccessfulAttachment: false })), createdAt: 1, updatedAt: 1 };
  receipts.set(receipt.intakeBatchId, receipt); return receipt;
 });
 const put = vi.fn(async (id: string): Promise<IntakeFilePutResponse> => { const receipt = receipts.get(id)!; return { intakeBatchId: id, revision: receipt.revision, file: receipt.files[0]! }; });
 const store = new IntakeStore({
  create, put,
  get: async id => receipts.get(id)!,
  list: async () => ({ batches: [...receipts.values()] }),
  clear: async id => receipts.get(id)!,
  attach: async id => ({ intakeBatchId: id, revision: 1, attachments: [], files: [] }),
 });
 return { store, create };
}

function osDrop(element: Element, file: File): boolean {
 return fireEvent.drop(element, { dataTransfer: { types: ['Files'], files: [file], items: [] } });
}

const SURFACES: Array<[name: string, path: string]> = [
 ['Home', '/'],
 ['session', '/projects/p1/conversations/c1'],
 ['canvas', '/projects/p1/conversations/c1/files/index.html'],
 ['library', '/library'],
 ['settings', '/settings'],
];

for (const [name, path] of SURFACES) {
 it(`accepts an OS file drop on ${name} into its own destination without navigating away`, async () => {
  window.history.replaceState(null, '', path);
  const before = { href: window.location.href, length: window.history.length };
  const route = parseRoute(window.location.pathname); const target = surfaceTarget(route);
  const f = fixture();
  render(<WorkbenchIntake store={f.store} target={target}><main data-testid={`surface-${name}`} /></WorkbenchIntake>);

  const notCancelled = osDrop(screen.getByTestId(`surface-${name}`), new File(['x'], 'brief.pdf'));

  expect(notCancelled).toBe(false); // the app claimed the drop; no browser default
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
  expect(f.create.mock.calls[0]?.[0].destination).toEqual({ kind: 'pending' });
  expect(parseRoute(window.location.pathname)).toEqual(route);
  expect({ href: window.location.href, length: window.history.length }).toEqual(before);
 });
}

it('embedded browser: without drop mode the guest keeps the drop; with drop mode the app claims it and stays put', async () => {
 window.history.replaceState(null, '', '/projects/p1/conversations/c1');
 const before = { href: window.location.href, length: window.history.length };
 const target = surfaceTarget(parseRoute(window.location.pathname)); const f = fixture();
 render(<WorkbenchIntake store={f.store} target={target}><WorkbenchDropModeButton /><div className="db-fallback"><iframe title="Guest" src="about:blank" /></div></WorkbenchIntake>);
 const guest = screen.getByTitle('Guest');

 // Inactive: the host does not suppress the guest, so an OS drop over it goes to the guest.
 expect(screen.queryByTestId('workbench-drop-overlay')).toBeNull();
 expect(guest.style.visibility).toBe('');

 fireEvent.click(screen.getByTestId('workbench-drop-mode'));
 const overlay = screen.getByTestId('workbench-drop-overlay');
 expect(guest.style.visibility).toBe('hidden');
 expect(osDrop(overlay, new File(['x'], 'shot.png'))).toBe(false);
 await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
 expect(f.create.mock.calls[0]?.[0].destination).toEqual(target.destination);
 expect({ href: window.location.href, length: window.history.length }).toEqual(before);
});
