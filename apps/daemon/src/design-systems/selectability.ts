// Daemon entry point for "is this design kit selectable for generation, and
// if not, why". The rule and its wording live in `@mish/contracts` so
// the web app, the CLI and every daemon route agree; this module adds the
// catalogue-lookup result shape that routes consume.
//
// Routes get the scoped lookup as `resolveDesignSystemSelectability(id, scope)`
// from `createDesignSystemServices` (see `server-services.ts`); a route that
// refuses a draft should answer with `sendDesignSystemNotSelectable`.

import type { Response } from 'express';
import type { DesignSystemUnselectableReason } from '@mish/contracts';
import { sendApiError } from '../http/api-errors.js';

export {
  designSystemPublishCommand,
  designSystemRunNotice,
  designSystemSelectability,
  parseDesignSystemRunNotice,
} from '@mish/contracts';
export type {
  DesignSystemRunNotice,
  DesignSystemRunNoticeReason,
  DesignSystemSelectability,
  DesignSystemUnselectableReason,
} from '@mish/contracts';

type SummaryLike = { id: string } & Record<string, unknown>;

export type DesignSystemSelectabilityResult =
  | { found: true; selectable: true; summary: SummaryLike }
  | {
      found: true;
      selectable: false;
      reason: DesignSystemUnselectableReason;
      message: string;
      publishCommand: string;
      approveCommand?: string;
      summary: SummaryLike;
    }
  | {
      found: false;
      selectable: false;
      reason: 'not_found';
      message: string;
      publishCommand: null;
    };

/**
 * Standard refusal for a route that requires a selectable kit: 404 when the
 * kit is missing, 422 when it exists but is a draft. The body carries the
 * typed reason and the one-line publish command.
 */
export function sendDesignSystemNotSelectable(
  res: Response,
  result: Extract<DesignSystemSelectabilityResult, { selectable: false }>,
): void {
  sendApiError(
    res,
    result.found ? 422 : 404,
    result.found ? (result.reason === 'unreviewed' ? 'DESIGN_SYSTEM_NOT_APPROVED' : 'DESIGN_SYSTEM_NOT_PUBLISHED') : 'DESIGN_SYSTEM_NOT_FOUND',
    result.message,
    {
      retryable: false,
      details: { reason: result.reason, publishCommand: result.publishCommand, ...(result.found && result.approveCommand ? { approveCommand: result.approveCommand } : {}) },
    },
  );
}
