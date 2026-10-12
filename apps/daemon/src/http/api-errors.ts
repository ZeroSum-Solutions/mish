import { ProviderHttpError, ProviderKeyError, ProviderKeyUnreadableError } from '@mish/agency-fast-lane/deepseek';
import { STATUS_CODES } from 'node:http';
import type { ApiError, ApiErrorCode, ApiErrorResponse } from '@mish/contracts';
import type { NextFunction, Request, Response } from 'express';

import { recordApiFailure } from './api-failure-journal.js';

export function createCompatApiError(
  code: ApiErrorCode,
  message: string,
  init: Omit<ApiError, 'code' | 'message'> = {},
): ApiError {
  return { code, message, ...init };
}

export function createCompatApiErrorResponse(
  code: ApiErrorCode,
  message: string,
  init: Omit<ApiError, 'code' | 'message'> = {},
): ApiErrorResponse {
  return { error: createCompatApiError(code, message, init) };
}

export function sendApiError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  init: Omit<ApiError, 'code' | 'message'> = {},
  responseFields: { ok?: false; platform?: string } = {},
): Response<ApiErrorResponse> {
  const request = res.req;
  recordApiFailure({
    at: new Date().toISOString(),
    request,
    status,
    code,
    retryable: init.retryable === true,
    ...(init.requestId ? { requestId: init.requestId } : {}),
  });
  return res
    .status(status)
    .json({ ...responseFields, ...createCompatApiErrorResponse(code, message, init) });
}

/** Keep diagnostic detail in daemon logs, never in the response body. */
export function sendInternalError(
  res: Response,
  error: unknown,
  code: ApiErrorCode = 'INTERNAL_ERROR',
  message = 'internal server error',
  responseFields: { ok?: false; platform?: string } = {},
): Response<ApiErrorResponse> {
  console.error(`[api] ${res.req?.method ?? ''} ${res.req?.path ?? ''} failed`, error);
  if (code === 'INTERNAL_ERROR') {
    const provider = error instanceof ProviderHttpError || error instanceof ProviderKeyError || error instanceof ProviderKeyUnreadableError
      ? error.provider : null;
    // Provider errors keep arbitrary upstream detail on .detail or .cause.
    // Build public text from the known identity, never from those diagnostics.
    const label = provider && ['deepseek', 'cerebras', 'groq', 'openrouter', 'qwen', 'kimi', 'openai', 'anthropic', 'azure', 'gemini', 'fal', 'kie', 'elevenlabs', 'aihubmix', 'xai'].includes(provider)
      ? `provider ${provider}` : 'the model provider';
    if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) {
      code = 'PROVIDER_AUTH_REJECTED';
      message = `${label} rejected key`;
    } else if (error instanceof ProviderKeyError) {
      code = 'PROVIDER_CREDENTIAL_MISSING';
      message = `${label} has no configured API key`;
    } else if (error instanceof ProviderKeyUnreadableError) {
      code = 'PROVIDER_CREDENTIAL_UNREADABLE';
      message = `${label} credential could not be read`;
    } else if (error instanceof Error && error.message === 'invalid KIE API key') {
      code = 'PROVIDER_CREDENTIAL_INVALID';
      message = error.message;
    } else if (error instanceof Error && error.message === 'no KIE credential — configure its API key in Settings / Media providers.') {
      code = 'PROVIDER_CREDENTIAL_MISSING';
      message = error.message;
    }
  }
  return sendApiError(res, 500, code, message, {}, responseFields);
}

/** Final middleware, after domain handlers (including their body parsers). */
export function apiErrorMiddleware(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) { next(error); return; }
  const type = error !== null && typeof error === 'object' ? (error as { type?: unknown }).type : undefined;
  switch (type) {
    case 'entity.too.large':
      sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', 'the request body is too large');
      return;
    case 'entity.parse.failed':
      sendApiError(res, 400, 'BAD_REQUEST', 'the request body is not valid JSON');
      return;
    case 'request.aborted':
    case 'request.size.invalid':
      sendApiError(res, 400, 'BAD_REQUEST', 'the request body is incomplete');
      return;
    case 'charset.unsupported':
    case 'encoding.unsupported':
      sendApiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'the request body encoding is not supported');
      return;
    case 'entity.verify.failed':
      sendApiError(res, 403, 'FORBIDDEN', 'the request body was rejected');
      return;
    default: {
      const httpError = error !== null && typeof error === 'object'
        ? error as { status?: unknown; statusCode?: unknown } : {};
      const status = [httpError.status, httpError.statusCode].find(
        (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 400 && value < 500,
      );
      if (status !== undefined) {
        const codes: Partial<Record<number, ApiErrorCode>> = {
          400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
          409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE',
          416: 'RANGE_NOT_SATISFIABLE', 422: 'VALIDATION_FAILED', 429: 'RATE_LIMITED',
        };
        sendApiError(res, status, codes[status] ?? 'BAD_REQUEST',
          status === 416 ? 'the requested range is not satisfiable' : STATUS_CODES[status]?.toLowerCase() ?? 'the request was rejected',
          status === 429 ? { retryable: true } : {});
        return;
      }
      sendInternalError(res, error);
    }
  }
}
