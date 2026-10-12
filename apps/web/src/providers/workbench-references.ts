import {
  parseReferenceFanoutRequest, parseReferenceFanoutResponse,
  type ReferenceFanoutRequest, type ReferenceFanoutResponse,
} from '@mish/contracts';
import { checkedWorkbenchResponse } from './workbench-connectors';

export type ReferenceFanoutInput = Omit<ReferenceFanoutRequest, 'limit'> & { limit?: number };
/** Explicit read-only search. No generation, selection or resource adoption is performed. */
export async function fanoutReferences(input: ReferenceFanoutInput, options?: { signal?: AbortSignal }): Promise<ReferenceFanoutResponse> {
  const request = parseReferenceFanoutRequest(input);
  const response = await fetch('/api/workbench/references/fanout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  return parseReferenceFanoutResponse(await checkedWorkbenchResponse(response));
}
