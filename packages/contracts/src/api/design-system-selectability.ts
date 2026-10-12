// Whether a design kit can drive generation, and why not when it cannot.
//
// Generation requires approval of the exact content revision and publication.
// Every refusal uses this contract so HTTP, CLI, pickers and run notices carry
// the selected identity and the same recovery action.

import { isApprovedDesignSystem } from './design-system-approval.js';
import type { DesignSystemSummary } from './registry.js';

/** Why a kit that exists cannot drive generation. */
export type DesignSystemUnselectableReason = 'draft' | 'unreviewed';

/**
 * Why a run did not inject the design kit it was asked to use.
 *  - `unreviewed`: the current content revision has not been approved.
 *  - `draft`: the kit exists but is unpublished.
 *  - `not_found`: no kit with that id is visible to the run.
 *  - `empty`: the kit resolved but has no DESIGN.md body to inject.
 */
export type DesignSystemRunNoticeReason = DesignSystemUnselectableReason | 'not_found' | 'empty';

export type DesignSystemSelectability =
  | { selectable: true }
  | {
      selectable: false;
      reason: DesignSystemUnselectableReason;
      /** Plain-language explanation, safe to print as-is. */
      message: string;
      /** One-line `od` command that makes the kit selectable. */
      publishCommand: string;
      approveCommand?: string;
    };

/**
 * Typed record of a requested kit that a run did not inject. Carried on the
 * run status (`designSystemNotice`), persisted with the run, and emitted to the
 * chat as a `design_system_notice` agent event.
 */
export interface DesignSystemRunNotice {
  reason: DesignSystemRunNoticeReason;
  /** The revision observed when generation was refused. Approval must bind it. */
  revision?: string;
  designSystemId: string;
  title: string | null;
  /** Plain-language explanation, safe to print as-is. */
  message: string;
  /** One-line `od` command that fixes the cause, or null when none exists. */
  resolveCommand: string | null;
}

/** The one-line command that publishes a kit. */
export function designSystemPublishCommand(designSystemId: string): string {
  return `od design-systems publish ${designSystemId}`;
}

/**
 * Is this kit selectable for generation, and if not, why.
 *
 * Missing or stale approval fails closed. Publication alone is insufficient.
 * Built-in kits use the same exact-revision approval gate as installed kits.
 */
export function designSystemSelectability(
  summary: Pick<DesignSystemSummary, 'id' | 'title' | 'status' | 'approval'>,
): DesignSystemSelectability {
  const name = summary.title?.trim() || summary.id;
  if (!isApprovedDesignSystem(summary)) {
    const approveCommand = `od design-system approve ${summary.id}`;
    return { selectable: false, reason: 'unreviewed', message: `Design kit "${name}" is Unreviewed. Approve this revision before generation.`, approveCommand, publishCommand: approveCommand };
  }
  if (summary.status !== 'draft') return { selectable: true };
  return {
    selectable: false,
    reason: 'draft',
    message: `Design kit "${name}" is a draft. Publish it to use it for generation.`,
    publishCommand: designSystemPublishCommand(summary.id),
  };
}

/**
 * Build the notice for a run that asked for `designSystemId` but injected no
 * kit. `summary` is the catalogue entry the run could see, or null.
 */
export function designSystemRunNotice(input: {
  designSystemId: string;
  summary: Pick<DesignSystemSummary, 'id' | 'title' | 'status' | 'approval'> | null | undefined;
  hasBody: boolean;
}): DesignSystemRunNotice {
  const { designSystemId, summary } = input;
  const title = summary?.title?.trim() || null;
  const name = title ?? designSystemId;
  if (!summary) {
    return {
      reason: 'not_found',
      designSystemId,
      title: null,
      message: `Design kit "${designSystemId}" was not found. Select an installed, approved kit before generation.`,
      resolveCommand: null,
    };
  }
  const selectability = designSystemSelectability(summary);
  if (!selectability.selectable) {
    return {
      reason: selectability.reason,
      ...(summary.approval?.revision ? { revision: summary.approval.revision } : {}),
      designSystemId,
      title,
      message: selectability.message,
      resolveCommand: selectability.publishCommand,
    };
  }
  return {
    reason: 'empty',
    designSystemId,
    title,
    message: `Design kit "${name}" has no DESIGN.md content. Restore its content and approve the revision before generation.`,
    resolveCommand: null,
  };
}

const NOTICE_REASONS = new Set<DesignSystemRunNoticeReason>(['draft', 'unreviewed', 'not_found', 'empty']);

/** Validate an untrusted value (persisted record, SSE payload) as a notice. */
export function parseDesignSystemRunNotice(value: unknown): DesignSystemRunNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.reason !== 'string' || !NOTICE_REASONS.has(record.reason as DesignSystemRunNoticeReason)) {
    return null;
  }
  if (typeof record.designSystemId !== 'string' || !record.designSystemId) return null;
  return {
    reason: record.reason as DesignSystemRunNoticeReason,
    ...(typeof record.revision === 'string' && /^[a-f0-9]{64}$/.test(record.revision) ? { revision: record.revision } : {}),
    designSystemId: record.designSystemId,
    title: typeof record.title === 'string' && record.title ? record.title : null,
    message: typeof record.message === 'string' ? record.message : '',
    resolveCommand:
      typeof record.resolveCommand === 'string' && record.resolveCommand
        ? record.resolveCommand
        : null,
  };
}
