import {
  parseConnectorDetailResponse, parseConnectorSearchResponse,
  type ConnectorDetailRequest, type ConnectorReferenceDetailResponse, type ConnectorSearchRequest, type ConnectorSearchResponse,
} from '@mish/contracts';
import { WorkbenchRequestError } from './workbench';

/** Typed refusal with the daemon's code, message and recovery (nextSteps or missing receipts). */
export async function checkedWorkbenchResponse(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const envelope = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const error = envelope.error && typeof envelope.error === 'object' ? envelope.error as Record<string, unknown> : {};
    const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
    const steps = [details.nextSteps, details.missingReceipts].flatMap(value => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    const code = typeof details.reason === 'string' ? details.reason : typeof error.code === 'string' ? error.code : 'workbench-request-failed';
    throw new WorkbenchRequestError(response.status, code, typeof error.message === 'string' ? error.message : code, [...new Set(steps)]);
  }
  return body;
}

/** AC-R12.2: same POST routes and DTOs as `od workbench connector search|detail`. */
export async function searchConnector(connectorId: string, request: ConnectorSearchRequest): Promise<ConnectorSearchResponse> {
  const response = await fetch(`/api/workbench/connectors/${encodeURIComponent(connectorId)}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  return parseConnectorSearchResponse(await checkedWorkbenchResponse(response));
}
export async function getConnectorDetail(connectorId: string, request: ConnectorDetailRequest): Promise<ConnectorReferenceDetailResponse> {
  const response = await fetch(`/api/workbench/connectors/${encodeURIComponent(connectorId)}/detail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  return parseConnectorDetailResponse(await checkedWorkbenchResponse(response));
}
