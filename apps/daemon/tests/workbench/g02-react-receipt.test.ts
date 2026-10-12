import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GSAP_RECIPE_IDS } from '../../src/workbench/recipes/gsap/index.js';
import { G02_REACT_RECEIPT } from '../../src/workbench/targets/react/g02-receipt.js';
import { checkG02ReactReceipt, g02CoveredReactMajors, validateReactTargetReceipt } from '../../src/workbench/targets/react/receipt.js';
import { G02_RECEIPT_DOC_PATH, buildG02ReactReceipt, writeG02ReactReceipt } from './g02-react-receipt-build.js';

/**
 * G02 P0 React-target receipt (react-source/v1, W1). A pinned React 18 +
 * TypeScript fixture with the registered GSAP units builds in production
 * mode with the pinned esbuild, renders a static preview on the server and
 * hydrates it under Strict Mode with no error. The committed receipt must be
 * reproduced byte for byte by a fresh build, and the daemon gate validates it
 * against the current recipe units before any React unit is applied.
 */
describe('G02 react-source/v1 production receipt', () => {
  it('a fresh deterministic build reproduces the committed receipt, and the daemon mirror matches it', async () => {
    const fresh = await buildG02ReactReceipt();
    expect(fresh).toMatchObject({ status: 'passed', checks: { ssrWithoutWindow: true, hydrationErrors: 0, mountedRoots: GSAP_RECIPE_IDS.length, motionStarted: true } });
    expect(fresh.toolchain).toEqual({ esbuild: '0.28.0', react: '18.3.1', 'react-dom': '18.3.1', gsap: '3.15.0', '@gsap/react': '2.1.2' });
    // The receipt states where the toolchain came from and which sources it covers.
    expect(fresh.toolchainResolution).toMatch(/apps\/daemon.*node_modules.*pnpm-lock\.yaml.*no network install/su);
    expect(fresh.sources).toEqual(['gsap']);
    expect(await buildG02ReactReceipt()).toEqual(fresh);
    if (process.env.OD_UPDATE_G02_RECEIPT === '1') {
      writeG02ReactReceipt(fresh);
      expect(JSON.parse(readFileSync(G02_RECEIPT_DOC_PATH, 'utf8'))).toEqual(fresh);
      // The imported module is the previous receipt in this process. A fresh
      // verification run below proves its generated mirror and production gate.
      return;
    }
    expect(existsSync(G02_RECEIPT_DOC_PATH)).toBe(true);
    const committed: unknown = JSON.parse(readFileSync(G02_RECEIPT_DOC_PATH, 'utf8'));
    expect(committed).toEqual(fresh);
    expect(G02_REACT_RECEIPT).toEqual(committed);
  });

  it.skipIf(process.env.OD_UPDATE_G02_RECEIPT === '1')('the gate accepts the committed receipt and refuses missing, failed, stale-unit or off-pin receipts', () => {
    expect(checkG02ReactReceipt()).toEqual({ ok: true });
    // The receipt proves React 18 only; other majors stay pending until a receipt covers them.
    expect(checkG02ReactReceipt(18)).toEqual({ ok: true });
    expect(checkG02ReactReceipt(19)).toEqual({ ok: false, reason: 'react-major-uncovered' });
    expect(checkG02ReactReceipt(17)).toEqual({ ok: false, reason: 'react-major-uncovered' });
    expect(g02CoveredReactMajors()).toEqual([18]);
    const receipt = G02_REACT_RECEIPT!;
    const units = receipt.units.map(unit => ({ recipe: unit.recipe, sha256: unit.sha256 }));
    expect(validateReactTargetReceipt(receipt, units)).toEqual({ ok: true });
    expect(validateReactTargetReceipt(null, units)).toEqual({ ok: false, reason: 'receipt-missing' });
    expect(validateReactTargetReceipt({ ...receipt, schema: 'other' }, units)).toEqual({ ok: false, reason: 'receipt-invalid' });
    expect(validateReactTargetReceipt({ ...receipt, status: 'failed' }, units)).toEqual({ ok: false, reason: 'receipt-failed' });
    expect(validateReactTargetReceipt({ ...receipt, checks: { ...receipt.checks, hydrationErrors: 1 } }, units)).toEqual({ ok: false, reason: 'receipt-failed' });
    expect(validateReactTargetReceipt({ ...receipt, toolchain: { ...receipt.toolchain, gsap: '3.14.2' } }, units)).toEqual({ ok: false, reason: 'receipt-toolchain-mismatch' });
    expect(validateReactTargetReceipt(receipt, [{ ...units[0]!, sha256: 'f'.repeat(64) }, ...units.slice(1)])).toEqual({ ok: false, reason: 'receipt-unit-mismatch' });
    expect(checkG02ReactReceipt(18, 'gsap')).toEqual({ ok: true });
    expect(checkG02ReactReceipt(18, 'react-bits')).toEqual({ ok: false, reason: 'receipt-source-uncovered' });
  });
});
