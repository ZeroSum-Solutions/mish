import type { MishPackErrorCode } from '@mish/contracts';

/** A refusal the install surface reports with a fixed code. The message never carries a secret. */
export class MishPackError extends Error {
  readonly code: MishPackErrorCode;

  constructor(code: MishPackErrorCode, message: string) {
    super(message);
    this.name = 'MishPackError';
    this.code = code;
  }
}

export function isMishPackError(value: unknown): value is MishPackError {
  return value instanceof MishPackError;
}

const STATUS: Record<MishPackErrorCode, number> = {
  INVALID_MANIFEST: 400,
  INVALID_ARCHIVE: 400,
  UNSAFE_PATH: 400,
  MISSING_RESOURCE: 400,
  SOURCE_NOT_FOUND: 400,
  TOO_LARGE: 413,
  NOT_FOUND: 404,
  BUSY: 409,
  READ_ONLY: 409,
  INTERNAL_ERROR: 500,
};

export function mishPackHttpStatus(code: MishPackErrorCode): number {
  return STATUS[code];
}
