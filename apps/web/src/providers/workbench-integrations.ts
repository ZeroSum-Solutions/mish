import {
  parseIntegrationRoster, parseIntegrationRosterEntry, parseLicenceRecordSnapshot, parsePutLicenceRecord,
  type IntegrationRoster, type IntegrationRosterEntry, type LicenceRecordSnapshot, type PutLicenceRecord,
} from '@open-design/contracts';
import { WorkbenchRequestError } from './workbench';

/** Same endpoints and DTOs as `od workbench integrations` and `od workbench licence`. */
async function checked(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {};
    const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
    throw new WorkbenchRequestError(response.status, typeof details.reason === 'string' ? details.reason : typeof error.code === 'string' ? error.code : 'workbench-request-failed',
      typeof error.message === 'string' ? error.message : 'Request failed', [], details.current);
  }
  return body;
}
export async function getIntegrationRoster(): Promise<IntegrationRoster> {
  return parseIntegrationRoster(await checked(await fetch('/api/workbench/integrations')));
}
export async function putLicenceRecord(sourceId: string, input: PutLicenceRecord): Promise<LicenceRecordSnapshot> {
  const response = await fetch(`/api/workbench/licences/${encodeURIComponent(sourceId)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsePutLicenceRecord(input)),
  });
  return parseLicenceRecordSnapshot(await checked(response));
}

/** Runs the same bounded read-only probe as od integrations test. */
export async function testIntegration(id: string): Promise<IntegrationRosterEntry> {
  return parseIntegrationRosterEntry(await checked(await fetch(`/api/workbench/integrations/${encodeURIComponent(id)}/test`, { method: 'POST' })));
}
