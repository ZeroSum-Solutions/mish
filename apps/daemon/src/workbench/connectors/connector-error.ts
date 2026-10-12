import type { ConnectorErrorCode } from '@open-design/contracts';

export class ConnectorError extends Error {
  constructor(readonly status: number, readonly code: ConnectorErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message); this.name = 'ConnectorError';
  }
}
