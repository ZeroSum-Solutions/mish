// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReusableUnitManifest, UnitInsertReceipt } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchUnitInsert } from '../../../src/components/workbench/WorkbenchUnitInsert';
import { CaptureRequestError, unitApi } from '../../../src/providers/workbench-capture';

vi.mock('../../../src/state/projects', () => ({ listProjects: vi.fn(async () => [{ id: 'a', name: 'Source' }, { id: 'b', name: 'Second project' }]) }));
const unit = { unitId: 'unit_AAAAAAAAAAAAAAAAAAAA', name: 'Demo', provenance: { projectId: 'a' }, dependencies: [], rights: { status: 'redistributable' } } as unknown as ReusableUnitManifest;
const receipt = { insertId: 'insert_AAAAAAAAAAAAAAAAAAAA', status: 'inserted', projectId: 'b', directory: 'unit-insert-AAAAAAAAAAAAAAAAAAAA', entryPath: 'unit-insert-AAAAAAAAAAAAAAAAAAAA/index.html', files: [{ path: 'unit-insert-AAAAAAAAAAAAAAAAAAAA/index.html' }], dependenciesInstalled: false, actionVerification: 'not-run' } as unknown as UnitInsertReceipt;
beforeEach(() => { vi.spyOn(unitApi, 'listInsertions').mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('AC-R14.4 insertion UI', () => {
  it('picks a second project, shows actual copied file status, opens the editable file and undoes', async () => {
    const insert = vi.spyOn(unitApi, 'insert').mockResolvedValue(receipt);
    const undo = vi.spyOn(unitApi, 'undoInsert').mockResolvedValue({ ...receipt, status: 'undone' });
    render(<I18nProvider initial="en"><WorkbenchUnitInsert unit={unit} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Insert into project…' }));
    const picker = await screen.findByLabelText('Destination project');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Second project' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Source' })).toBeNull();
    fireEvent.change(picker, { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add editable artifact' }));
    await screen.findByText(/Copied 1 editable file/);
    expect(insert).toHaveBeenCalledWith(unit.unitId, { projectId: 'b', mode: 'standalone-artifact' }, undefined, expect.any(String));
    expect(screen.getByRole('link', { name: 'Open editable artifact' }).getAttribute('href')).toBe('/projects/b/files/unit-insert-AAAAAAAAAAAAAAAAAAAA/index.html');
    expect(screen.getByText(/Actions have not been verified/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo insertion' }));
    await screen.findByText('Insertion undone. The source project and saved unit are unchanged.');
    expect(undo).toHaveBeenCalledWith(receipt.insertId, undefined);
    expect(screen.queryByRole('link', { name: 'Open editable artifact' })).toBeNull();
  });
  it('restores the undo affordance after the popover is reopened', async () => {
    vi.mocked(unitApi.listInsertions).mockResolvedValue([receipt]);
    render(<I18nProvider initial="en"><WorkbenchUnitInsert unit={unit} /></I18nProvider>);
    await screen.findByRole('button', { name: 'Undo insertion' });
    expect(screen.getByRole('link', { name: 'Open editable artifact' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Insert into project…' })).toBeNull();
  });
  it('shows typed rights refusal without claiming insertion', async () => {
    vi.spyOn(unitApi, 'insert').mockRejectedValue(new CaptureRequestError(403, 'rights-blocked', 'reference-only files'));
    render(<I18nProvider initial="en"><WorkbenchUnitInsert unit={unit} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Insert into project…' }));
    const picker = await screen.findByLabelText('Destination project');
    await screen.findByRole('option', { name: 'Second project' });
    fireEvent.change(picker, { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add editable artifact' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The saved unit does not permit reuse in this project.');
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('shows edited paths and requires confirmation before backing up and removing edits', async () => {
    vi.mocked(unitApi.listInsertions).mockResolvedValue([receipt]);
    const undo = vi.spyOn(unitApi, 'undoInsert')
      .mockRejectedValueOnce(new CaptureRequestError(409, 'insert-conflict', 'Changed files', [receipt.entryPath], null, true))
      .mockRejectedValueOnce(new CaptureRequestError(409, 'insert-conflict', 'Changed files', [receipt.entryPath], null, true))
      .mockResolvedValueOnce({ ...receipt, status: 'undone', recoveryPath: `.od-undo/${receipt.insertId}` });
    render(<I18nProvider initial="en"><WorkbenchUnitInsert unit={unit} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo insertion' }));
    await screen.findByText(receipt.entryPath);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep edited files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep edited files' }));
    expect(screen.queryByRole('button', { name: 'Back up edits and undo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo insertion' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back up edits and undo' }));
    await screen.findByText(`Edited files were backed up to .od-undo/${receipt.insertId}.`);
    expect(undo).toHaveBeenLastCalledWith(receipt.insertId, undefined, { discardEdits: true });
  });

  it('does not offer discard confirmation for a non-edit insertion conflict', async () => {
    vi.mocked(unitApi.listInsertions).mockResolvedValue([receipt]);
    vi.spyOn(unitApi, 'undoInsert').mockRejectedValue(new CaptureRequestError(409, 'insert-conflict', 'Ambiguous ownership', [receipt.entryPath]));
    render(<I18nProvider initial="en"><WorkbenchUnitInsert unit={unit} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo insertion' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(receipt.entryPath);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back up edits and undo' })).toBeNull();
  });
  it.each(['rights-blocked', 'unsupported-target-format', 'same-project', 'unsafe-path', 'insert-conflict', 'insert-not-found', 'insert-incomplete', 'idempotency-conflict', 'project-not-found', 'project-directory-missing', 'unit-file-missing'])('maps %s to a readable message', async reason => {
    vi.mocked(unitApi.listInsertions).mockRejectedValue(new CaptureRequestError(409, reason, 'raw daemon message'));
    render(<I18nProvider initial="en"><WorkbenchUnitInsert unit={unit} /></I18nProvider>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain(reason);
    expect(alert.textContent).not.toContain('raw daemon message');
    expect(alert.textContent!.length).toBeGreaterThan(15);
  });

  it('passes literal discard consent through HTTP and parses the edited-file marker', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Edited files', details: { reason: 'insert-conflict', paths: [receipt.entryPath], discardEditsAllowed: true } } }), { status: 409 }));
    await expect(unitApi.undoInsert(receipt.insertId, undefined, { discardEdits: true })).rejects.toMatchObject({ reason: 'insert-conflict', paths: [receipt.entryPath], discardEditsAllowed: true });
    expect(fetchMock).toHaveBeenCalledWith(`/api/workbench/unit-inserts/${receipt.insertId}/undo`, expect.objectContaining({ body: JSON.stringify({ discardEdits: true }) }));
  });

  it('keeps the recovery path visible after reopening', async () => {
    vi.mocked(unitApi.listInsertions).mockResolvedValue([{ ...receipt, status: 'undone', recoveryPath: `.od-undo/${receipt.insertId}` }]);
    render(<I18nProvider initial="en"><WorkbenchUnitInsert unit={unit} /></I18nProvider>);
    await screen.findByText(`Edited files were backed up to .od-undo/${receipt.insertId}.`);
    expect(screen.queryByRole('button', { name: 'Undo insertion' })).toBeNull();
  });
  it('explains differing partial files without claiming they are user edits', async () => {
    vi.mocked(unitApi.listInsertions).mockResolvedValue([{ ...receipt, status: 'inserting' }]);
    vi.spyOn(unitApi, 'undoInsert').mockRejectedValue(new CaptureRequestError(409, 'insert-conflict', 'Changed files', [receipt.entryPath], null, true));
    render(<I18nProvider initial="en"><WorkbenchUnitInsert unit={unit} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo insertion' }));
    await screen.findByText(/These files differ from the insertion receipt/);
  });

});
