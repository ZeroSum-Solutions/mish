import { createHash } from 'node:crypto';
import { GSAP_PIN, GSAP_REACT_PIN } from '../../recipes/gsap/runtime.js';
import { GSAP_RECIPE_IDS, GSAP_RECIPES } from '../../recipes/gsap/recipes.js';
import { G02_REACT_RECEIPT } from './g02-receipt.js';
import { G02_REACT95_RECEIPT } from './g02-react95-receipt.js';
import { validateReact95Receipt } from './react95-receipt.js';

/**
 * G02 P0 React-target receipt (`g02-react-receipt/1`): a pinned React 18 +
 * TypeScript fixture with the adopted GSAP units, built in production mode
 * with the pinned esbuild, rendered to a static preview without a window and
 * hydrated under Strict Mode with no error. Generated deterministically by
 * `tests/workbench/g02-react-receipt-build.ts`; the evidence copy lives at
 * `docs/plans/2026-10-02-design-workbench/evidence/implementation-start/g02-react-receipt.json`.
 */
export interface ReactTargetReceipt {
  schema: 'g02-react-receipt/1';
  adapter: 'react-source/v1';
  status: 'passed' | 'failed';
  /** Catalogue sources whose react-source/v1 units this receipt covers. */
  sources: string[];
  /** Where the recorded toolchain versions were resolved from. */
  toolchainResolution: string;
  fixture: { path: string; files: { path: string; sha256: string }[] };
  toolchain: { esbuild: string; react: string; 'react-dom': string; gsap: string; '@gsap/react': string };
  build: { tool: 'esbuild'; options: Record<string, unknown>; generator: string };
  units: { recipe: string; path: string; sha256: string }[];
  outputs: { productionBundle: { path: string; sha256: string; bytes: number }; staticPreview: { path: string; sha256: string; bytes: number } };
  checks: { ssrWithoutWindow: boolean; strictModeHydration: boolean; hydrationErrors: number; mountedRoots: number; motionStarted: boolean };
}

export type ReactReceiptCheck =
  | { ok: true }
  | { ok: false; reason: 'receipt-missing' | 'receipt-invalid' | 'receipt-failed' | 'receipt-toolchain-mismatch' | 'receipt-unit-mismatch' | 'react-major-uncovered' | 'receipt-source-uncovered' };

const HEX = /^[a-f0-9]{64}$/u;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Validates a receipt against the current pins and the exact unit bytes the
 * adapter would write. Any change to a recipe unit or a pin makes the receipt
 * stale until it is regenerated, so the gate never trusts an old build.
 */
export function validateReactTargetReceipt(receipt: unknown, expectedUnits: readonly { recipe: string; sha256: string }[]): ReactReceiptCheck {
  if (receipt === null || receipt === undefined) return { ok: false, reason: 'receipt-missing' };
  if (!isObject(receipt) || receipt.schema !== 'g02-react-receipt/1' || receipt.adapter !== 'react-source/v1' || !isObject(receipt.toolchain)
    || !isObject(receipt.checks) || !isObject(receipt.outputs) || !Array.isArray(receipt.units)
    || !Array.isArray(receipt.sources) || receipt.sources.length === 0 || !receipt.sources.every(source => typeof source === 'string')
    || typeof receipt.toolchainResolution !== 'string' || !receipt.toolchainResolution) return { ok: false, reason: 'receipt-invalid' };
  const outputs = receipt.outputs as Record<string, unknown>;
  for (const name of ['productionBundle', 'staticPreview']) {
    const output = outputs[name];
    if (!isObject(output) || typeof output.sha256 !== 'string' || !HEX.test(output.sha256) || typeof output.bytes !== 'number' || output.bytes <= 0) return { ok: false, reason: 'receipt-invalid' };
  }
  const checks = receipt.checks as Record<string, unknown>;
  if (receipt.status !== 'passed' || checks.ssrWithoutWindow !== true || checks.strictModeHydration !== true || checks.hydrationErrors !== 0 || checks.motionStarted !== true) {
    return { ok: false, reason: 'receipt-failed' };
  }
  const toolchain = receipt.toolchain as Record<string, unknown>;
  if (toolchain.gsap !== GSAP_PIN.version || toolchain['@gsap/react'] !== GSAP_REACT_PIN.version || toolchain.esbuild !== '0.28.0'
    || typeof toolchain.react !== 'string' || toolchain['react-dom'] !== toolchain.react || !/^1[89]\./u.test(toolchain.react)) {
    return { ok: false, reason: 'receipt-toolchain-mismatch' };
  }
  const recorded = new Map((receipt.units as { recipe?: unknown; sha256?: unknown }[]).map(unit => [unit.recipe, unit.sha256]));
  if (expectedUnits.length === 0 || expectedUnits.some(unit => recorded.get(unit.recipe) !== unit.sha256)) return { ok: false, reason: 'receipt-unit-mismatch' };
  return { ok: true };
}

/** The adapter's units as apply writes them: the React source of every GSAP recipe. */
export function currentReactUnits(): { recipe: string; sha256: string }[] {
  return GSAP_RECIPE_IDS.map(recipe => ({ recipe, sha256: createHash('sha256').update(GSAP_RECIPES[recipe].react).digest('hex') }));
}

/**
 * Sources with their own G02 receipt (same mechanism, own toolchain and
 * units). Every other `react-source/v1` source is judged by the GSAP receipt,
 * which names the sources it covers.
 */
const SOURCE_RECEIPTS: Readonly<Record<string, { check: () => ReactReceiptCheck; reactMajor: () => number }>> = {
  react95: { check: () => validateReact95Receipt(G02_REACT95_RECEIPT), reactMajor: () => Number(G02_REACT95_RECEIPT!.toolchain.react.split('.')[0]) },
};

/** React majors the committed receipt for `sourceId` proves (its pinned react build); empty when no receipt validates. */
export function g02CoveredReactMajors(sourceId?: string): number[] {
  const own = sourceId !== undefined ? SOURCE_RECEIPTS[sourceId] : undefined;
  if (own) return own.check().ok ? [own.reactMajor()] : [];
  if (!validateReactTargetReceipt(G02_REACT_RECEIPT, currentReactUnits()).ok) return [];
  return [Number(G02_REACT_RECEIPT!.toolchain.react.split('.')[0])];
}

/**
 * Default `react-source/v1` gate: the committed receipt for the source,
 * validated against the current units, and (when the target's React major is
 * given) covering that major. A project on a React major no validating
 * receipt proves stays pending (`react-major-uncovered`) until a receipt for
 * that major is committed.
 */
export function checkG02ReactReceipt(reactMajor?: number | null, sourceId?: string): ReactReceiptCheck {
  const own = sourceId !== undefined ? SOURCE_RECEIPTS[sourceId] : undefined;
  const check = own ? own.check() : validateReactTargetReceipt(G02_REACT_RECEIPT, currentReactUnits());
  if (!check.ok) return check;
  // Generic over react-source/v1 sources: a source no receipt names stays pending.
  if (!own && sourceId !== undefined && !G02_REACT_RECEIPT!.sources.includes(sourceId)) return { ok: false, reason: 'receipt-source-uncovered' };
  if (reactMajor === undefined) return check;
  return reactMajor !== null && g02CoveredReactMajors(sourceId).includes(reactMajor) ? check : { ok: false, reason: 'react-major-uncovered' };
}
