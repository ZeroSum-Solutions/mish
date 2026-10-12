import { parseOwnedImportList, parseOwnedImportRecord, parseOwnedImportRequest, type OwnedImportList, type OwnedImportRecord, type OwnedImportRequest, type WorkspaceCollabContext } from '@mish/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';
import { checkedWorkbenchResponse } from './workbench-connectors';

/** The caller's workspace identity, so the daemon keys the import to that member (never `local-owner` in a team). */
const identity = (workspaceContext?: WorkspaceCollabContext | null): HeadersInit => workspaceContext ? workspaceProjectHeaders(workspaceContext) : {};

/** AC-R12.4: same routes and DTOs as `od workbench import create|list|show`. */
export async function createOwnedImport(request: OwnedImportRequest, workspaceContext?: WorkspaceCollabContext | null): Promise<OwnedImportRecord> {
  const response = await fetch('/api/workbench/imports', { method: 'POST', headers: { 'Content-Type': 'application/json', ...identity(workspaceContext) }, body: JSON.stringify(parseOwnedImportRequest(request)) });
  return parseOwnedImportRecord(await checkedWorkbenchResponse(response));
}
export async function listOwnedImports(workspaceContext?: WorkspaceCollabContext | null): Promise<OwnedImportList> {
  return parseOwnedImportList(await checkedWorkbenchResponse(await fetch('/api/workbench/imports', { headers: identity(workspaceContext) })));
}
