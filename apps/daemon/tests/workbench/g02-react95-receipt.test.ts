import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { validateReact95Receipt, currentReact95Units, type React95KitReceipt } from '../../src/workbench/targets/react/react95-receipt.js';
import { REACT95_RECEIPT_DOC_PATH, buildReact95Receipt, contrastRatio, runReact95BrowserChecks, writeReact95Receipt } from './g02-react95-receipt-build.js';
import { findBrowserExecutable } from '../../src/browser-sessions.js';

/**
 * AC-R17.2: the same G02 receipt mechanism gates React95 insertion. A fresh
 * deterministic build of both template units (type-check, production build,
 * server render, Strict Mode hydration, behavior/keyboard/isolation/contrast/
 * cleanup checks) reproduces the committed receipt and preview documents, and
 * the daemon gate admits React95 only on React majors that receipt covers.
 */
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const CHECKS = {
  'window-app': [
    'menu:opens from its button with focus on the first item', 'menu:arrow, Home and End move focus between items',
    'menu:Escape closes the menu and returns focus to its button', 'menu:Enter activates the focused item (New, then Save)',
    'resize:keyboard slider widens the window by one step', 'resize:pointer drag resizes from the handle and releases its listeners',
    'focus:the title bar reflects whether focus is inside the window', 'window:close removes the window and focuses its taskbar button',
    'window:reopen restores the window and moves focus into it', 'window:the File menu can close the window too',
  ],
  'settings-form': [
    'state:disabled controls are disabled and not editable', 'state:focus lands on an enabled field', 'state:invalid fields are marked, described and focused',
    'state:saving disables the action, then success is announced', 'state:a failed save shows the error with focus on Retry and keeps the input',
    'state:retry after the failure succeeds', 'state:radio and checkbox controls change state',
  ],
} as const;
const SHARED = [
  'ssr:renders on the server without a window', 'isolation:every server style rule is scoped to a component class',
  'isolation:no global style, reset or font face in the unit', 'focus:visible focus rules for inputs, menu items and the resize handle',
  'responsive:stacked layout below 768px and a 44px minimum for every control',
  'hydration:the preview document hydrates under Strict Mode without console errors', 'theme:the project-owned theme switch restyles only the template',
  'keyboard:every control has an accessible name', 'cleanup:unmount releases every listener the template added and empties its root',
  'hydration:the harness runs every interaction without console errors',
];

describe('AC-R17.2 G02 react-source/v1 receipt for the React95 kit', () => {
  it('a fresh deterministic build passes every check and reproduces the committed receipt, its daemon mirror and the served previews', async () => {
    const fresh = await buildReact95Receipt();
    const failures = fresh.receipt.templates.flatMap(entry => entry.checks.filter(item => !item.passed).map(item => `${entry.template} ${item.name}: ${item.detail}`));
    expect(failures).toEqual([]);
    expect(fresh.receipt.status).toBe('passed');
    expect(fresh.receipt.templates.map(entry => entry.typecheck.diagnostics)).toEqual([0, 0]);
    for (const entry of fresh.receipt.templates) {
      const names = entry.checks.map(item => item.name);
      for (const name of [...SHARED, ...CHECKS[entry.template as keyof typeof CHECKS]]) expect(names).toContain(name);
      expect(names.filter(name => name.startsWith('contrast:'))).toHaveLength(14);
      expect(entry.outputs.preview.sha256).toBe(sha256(fresh.previews[entry.template]!));
    }
    expect(fresh.receipt.toolchain).toEqual({
      esbuild: '0.28.0', typescript: '5.9.3', react: '18.3.1', 'react-dom': '18.3.1', 'react-is': '18.3.1', 'styled-components': '5.3.11',
      '@types/react': '18.3.28', '@types/react-dom': '18.3.7', '@types/styled-components': '5.1.36',
    });
    expect(fresh.receipt.toolchainResolution).toMatch(/apps\/daemon.*node_modules.*pnpm-lock\.yaml.*no network install/su);
    // The preview bundles only pinned packages, each with the licence evidence its published bytes carry.
    const bundled = Object.fromEntries(fresh.receipt.bundledPackages.map(entry => [entry.name, entry]));
    expect(bundled['styled-components']).toMatchObject({ version: '5.3.11', manifestLicense: 'MIT', licenceFile: null });
    expect(bundled.react).toMatchObject({ version: '18.3.1', manifestLicense: 'MIT', licenceFile: { path: 'LICENSE' } });
    expect(await buildReact95Receipt()).toEqual(fresh);
    if (process.env.OD_UPDATE_REACT95_RECEIPT === '1') writeReact95Receipt({ ...fresh, receipt: { ...fresh.receipt, browser: await runReact95BrowserChecks(fresh.previews) } });
    expect(existsSync(REACT95_RECEIPT_DOC_PATH)).toBe(true);
    // The browser section comes from a real headless run (below); everything else is reproduced byte for byte.
    const committed = JSON.parse(readFileSync(REACT95_RECEIPT_DOC_PATH, 'utf8')) as React95KitReceipt;
    expect({ ...committed, browser: undefined }).toEqual({ ...fresh.receipt, browser: undefined });
    const { G02_REACT95_RECEIPT } = await import('../../src/workbench/targets/react/g02-react95-receipt.js');
    expect(G02_REACT95_RECEIPT).toEqual(committed);
    // The recorded browser results are bound to the exact preview documents this build produced.
    expect(committed.browser!.templates.map(entry => [entry.template, entry.previewSha256])).toEqual(fresh.receipt.templates.map(entry => [entry.template, entry.outputs.preview.sha256]));
    const { REACT95_PREVIEWS } = await import('../../src/workbench/kits/react95/preview.generated.js');
    expect(REACT95_PREVIEWS).toEqual(fresh.previews);
  }, 120_000);

  it('the committed receipt carries the real-browser check: both previews at 320/375/768/1440, no overflow, 44px targets, keyboard order, no console errors', async () => {
    const { G02_REACT95_RECEIPT } = await import('../../src/workbench/targets/react/g02-react95-receipt.js');
    const browser = (G02_REACT95_RECEIPT as React95KitReceipt).browser!;
    expect(browser).toMatchObject({ worker: 'cdp-review/headless', widths: [320, 375, 768, 1440] });
    expect(browser.templates.map(entry => entry.template)).toEqual(['window-app', 'settings-form']);
    for (const entry of browser.templates) {
      for (const width of [320, 375, 768, 1440]) {
        for (const kind of ['no horizontal overflow', 'every interactive target is at least 44px', 'keyboard order follows the document with a visible focus at every stop', 'no console errors and every resource served']) {
          expect(entry.checks.find(check => check.name === `browser:${width}:${kind}`), `${entry.template} ${width} ${kind}`).toMatchObject({ passed: true });
        }
      }
    }
  });

  it.skipIf(process.env.OD_REVIEW_BROWSER_TESTS !== '1')('a fresh headless run through the daemon review worker reproduces the recorded browser results', async () => {
    expect(findBrowserExecutable(), 'Install Chrome/Edge/Chromium or set OD_BROWSER_EXECUTABLE_PATH').not.toBeNull();
    const { G02_REACT95_RECEIPT } = await import('../../src/workbench/targets/react/g02-react95-receipt.js');
    const { REACT95_PREVIEWS } = await import('../../src/workbench/kits/react95/preview.generated.js');
    expect(await runReact95BrowserChecks(REACT95_PREVIEWS)).toEqual((G02_REACT95_RECEIPT as React95KitReceipt).browser);
  }, 300_000);

  it('contrast is computed, not assumed: the upstream inactive title colors fail and are not used', () => {
    expect(contrastRatio('#c6c6c6', '#7f787f')).toBeLessThan(4.5);
    expect(contrastRatio('#0a0a0a', '#c6c6c6')).toBeGreaterThan(4.5);
  });

  it('the gate admits the committed receipt only for React 18, and refuses failed, off-pin or stale-unit receipts', async () => {
    const { G02_REACT95_RECEIPT } = await import('../../src/workbench/targets/react/g02-react95-receipt.js');
    const { checkG02ReactReceipt, g02CoveredReactMajors } = await import('../../src/workbench/targets/react/receipt.js');
    const receipt = G02_REACT95_RECEIPT as React95KitReceipt;
    expect(validateReact95Receipt(receipt)).toEqual({ ok: true });
    expect(checkG02ReactReceipt(18, 'react95')).toEqual({ ok: true });
    expect(checkG02ReactReceipt(19, 'react95')).toEqual({ ok: false, reason: 'react-major-uncovered' });
    expect(checkG02ReactReceipt(17, 'react95')).toEqual({ ok: false, reason: 'react-major-uncovered' });
    expect(g02CoveredReactMajors('react95')).toEqual([18]);
    // The GSAP receipt does not cover React95, and the React95 receipt does not cover GSAP or another source.
    expect(checkG02ReactReceipt(18, 'gsap')).toEqual({ ok: true });
    expect(checkG02ReactReceipt(18, 'react-bits')).toEqual({ ok: false, reason: 'receipt-source-uncovered' });
    expect(validateReact95Receipt(null)).toEqual({ ok: false, reason: 'receipt-missing' });
    expect(validateReact95Receipt({ ...receipt, sources: ['gsap'] })).toEqual({ ok: false, reason: 'receipt-invalid' });
    expect(validateReact95Receipt({ ...receipt, status: 'failed' })).toEqual({ ok: false, reason: 'receipt-failed' });
    // Without the real-browser results, or with one failed or stale, the receipt does not cover the units.
    expect(validateReact95Receipt({ ...receipt, browser: undefined })).toEqual({ ok: false, reason: 'receipt-failed' });
    const failedBrowser = { ...receipt, browser: { ...receipt.browser!, templates: receipt.browser!.templates.map((entry, index) => index ? entry : { ...entry, checks: [{ ...entry.checks[0]!, passed: false }, ...entry.checks.slice(1)] }) } };
    expect(validateReact95Receipt(failedBrowser)).toEqual({ ok: false, reason: 'receipt-failed' });
    const staleBrowser = { ...receipt, browser: { ...receipt.browser!, templates: receipt.browser!.templates.map(entry => ({ ...entry, previewSha256: 'f'.repeat(64) })) } };
    expect(validateReact95Receipt(staleBrowser)).toEqual({ ok: false, reason: 'receipt-failed' });
    expect(validateReact95Receipt({ ...receipt, browser: { ...receipt.browser!, widths: [1440] } })).toEqual({ ok: false, reason: 'receipt-failed' });
    const failedCheck = { ...receipt, templates: receipt.templates.map((entry, index) => index ? entry : { ...entry, checks: [{ ...entry.checks[0]!, passed: false }, ...entry.checks.slice(1)] }) };
    expect(validateReact95Receipt(failedCheck)).toEqual({ ok: false, reason: 'receipt-failed' });
    expect(validateReact95Receipt({ ...receipt, toolchain: { ...receipt.toolchain, 'styled-components': '6.1.0' } })).toEqual({ ok: false, reason: 'receipt-toolchain-mismatch' });
    const units = currentReact95Units();
    expect(validateReact95Receipt(receipt, [{ ...units[0]!, sha256: 'f'.repeat(64) }, ...units.slice(1)])).toEqual({ ok: false, reason: 'receipt-unit-mismatch' });
  });
});
