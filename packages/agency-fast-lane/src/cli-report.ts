/**
 * The fast-lane CLI's `--report` JSON body and console summary, split out of `src/cli.ts`'s
 * `runCli` (which only orchestrates: parse -> preflight -> route -> build -> report) purely for
 * file/function size. No behavior changes: every line printed, and the strict-failure exit, are
 * unchanged from before this extraction.
 */

import { CliExit } from './cli-args.ts';
import type { RouteDecision } from './route.ts';
import type { FastLaneMode, RunReport } from './run.ts';
import { publicSectionEntryId } from './cult-public-ids.ts';
import type { VerifyMode } from './verify-policy.ts';

/**
 * The `--report` JSON body: the run's own report minus the large `html`/`recipe`/`manifest`/
 * `approvedAssets` fields (written separately to `--out-dir` when requested), with the CLI-level
 * `verifyMode` spread in — invisible to `RunReport` itself, which only knows `strict` true/false —
 * and the route decision ahead of it when this was a routed `--family auto` build, so an operator
 * can see what was routed to without a separate `--report` run.
 */
export function buildReportBody(report: RunReport, verifyMode: VerifyMode, route: RouteDecision | undefined) {
  const { html: _html, recipe: _recipe, manifest: _manifest, approvedAssets: _assets, composition, ...summary } = report;
  // A written report names Cult blocks by public id, like everything else a build puts out.
  const publicComposition = composition
    ? {
        ...composition,
        ...(composition.blocks ? { blocks: composition.blocks.map(publicSectionEntryId) } : {}),
        ...(composition.budgetDropped ? { budgetDropped: composition.budgetDropped.map(publicSectionEntryId) } : {}),
      }
    : undefined;
  return { verifyMode, ...(route ? { route } : {}), ...summary, ...(publicComposition ? { composition: publicComposition } : {}) };
}

export type PrintRunSummaryInput = {
  report: RunReport;
  verifyMode: VerifyMode;
  family: string;
  mode: FastLaneMode;
  provider: string;
  modelName: string;
  entry: string;
  revision: number;
  dryRun: boolean;
  stdout: (line: string) => void;
};

/**
 * Prints the run's console summary. On a strict failure, prints the failure detail and throws
 * `CliExit(2)` with no message — the detail already went to stdout, so `main`'s catch must not
 * print it again.
 */
export function printRunSummary(input: PrintRunSummaryInput): void {
  const { report, verifyMode, family, mode, provider, modelName, entry, revision, dryRun, stdout } = input;
  const t = report.timings;
  stdout('');
  stdout(`${family} ${mode} ${provider} ${modelName}: first token ${t.firstTokenMs ?? '-'} ms, first paint ${t.firstPaintMs ?? '-'} ms, final paint ${t.finalPaintMs ?? '-'} ms, registered ${t.registeredMs ?? '-'} ms, total ${t.totalMs} ms`);
  stdout(`calls ${report.calls}, repairs ${report.repairs}, retries ${report.retries}, clipped ${report.truncated.length}, paints ${report.paints}, tokens in ${report.usage.input} (cached ${report.usage.cachedRead}) out ${report.usage.output}, text slots changed ${report.applied}, missing ${report.missing.length}, nulled ${report.nulled.length}`);
  if (report.nulled.length > 0) stdout(`nulled (the brief states no such fact): ${report.nulled.join(', ')}`);
  stdout(`entry ${entry}, revision ${revision}, recipe digest ${report.recipeDigest}`);
  stdout(`verify-mode: ${verifyMode}`);
  if (report.verify) {
    const v = report.verify;
    stdout(`verify (${v.provider}): checked ${v.checked}, illustrative ${v.illustrative}, flagged ${v.flagged.length}, repaired ${v.repaired}, remaining ${v.remaining.length}, ${v.ms} ms${v.skipped ? ` — SKIPPED: ${v.skipped}` : ''}${v.oversized && v.oversized.length > 0 ? ` — oversized: ${v.oversized.length}` : ''}`);
    if (v.remaining.length > 0) {
      stdout('');
      stdout(`!!! UNRESOLVED FABRICATIONS (${v.remaining.length}) — review before client use: ${v.remaining.join(', ')}`);
    }
    if (v.oversized && v.oversized.length > 0) {
      stdout(`!!! OVERSIZED, NOT CHECKED (${v.oversized.length}): ${v.oversized.join(', ')}`);
    }
  }
  if (report.strict) {
    stdout('');
    if (report.strict.passed) {
      if (report.strict.checked === 0) stdout('strict: passed with 0 slots checked (all locked)');
      // A dry run never publishes (there is no `ensurePublisher`, strict pass or not), so the
      // summary must not claim a registration that never happened.
      stdout(dryRun ? 'verify-strict: passed — dry run, nothing registered.' : `verify-strict: passed — registered${report.projectId ? ` (project ${report.projectId})` : ''}.`);
    } else {
      stdout(`!!! VERIFY-STRICT FAILED: ${report.strict.reason}`);
      stdout('Nothing was registered: no project, no assets, no pages, no state files.');
      throw new CliExit(2);
    }
  }
}
