/**
 * AC-R13 state-matrix diagnostic against an explicitly supplied loopback runtime. Opt-in, not a
 * CI test, no lifecycle or provider calls (same rules as scripts/catalog-audit.ts).
 *
 *   pnpm --filter @open-design/e2e catalog:state-matrix http://127.0.0.1:<web-or-daemon-port> <label> [--family=a,b] [--only=id,id]
 *
 * Reads the frozen component ledger (apps/daemon/src/workbench/component-ledger.json), plans one
 * batch per dependency family and runs each batch in one browser (cold first item, warm rest).
 * Every probe opens the item's real preview at its viewport, actuates the state it can drive
 * (hover, keyboard focus, open), and records page errors, failed same-origin requests, policy
 * violations and a screenshot. A probe reports `rendered` when it ran without those failures;
 * that is evidence for review, not a visual pass. States it cannot drive yet stay
 * `inconclusive`. Items without a preview route report the gap. Results and screenshots go to
 * the ignored `.tmp/r13-state-matrix/<label>/`; the ledger is never written. An item whose served
 * preview is not the ledger revision is reported and not probed.
 */
import { chromium, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseComponentLedger, planStateMatrix, type StateMatrixProbe } from '@open-design/contracts';
import { T } from '../lib/timeouts.ts';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:3000');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('The state matrix requires a loopback origin');
const label = process.argv[3] ?? 'local';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid label');
const option = (name: string) => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3).split(',').filter(Boolean);
const families = option('family');
const only = option('only');

const repo = resolve(process.cwd(), '..');
const ledger = parseComponentLedger(JSON.parse(await readFile(resolve(repo, 'apps/daemon/src/workbench/component-ledger.json'), 'utf8')));
const plan = planStateMatrix(ledger, families ? { families } : {});
if (only) {
  for (const batch of plan.batches) batch.items = batch.items.filter(item => only.includes(item.id));
  plan.batches = plan.batches.filter(batch => batch.items.length);
  if (plan.batches.flatMap(batch => batch.items).length !== only.length) throw new Error('Unknown or skipped item in --only');
}
const out = resolve(repo, '.tmp/r13-state-matrix', label);
// The 21st preview route serves a saved private upstream demo first when the runtime has one,
// so a probe must prove it is looking at the ledger's owned alternative, not another revision.
const originals = (JSON.parse(await readFile(resolve(repo, 'packages/21st-catalog/generated/21st-originals.json'), 'utf8')) as { items: Array<{ id: string; files: Array<{ path: string; content: string }> }> }).items;
async function revisionMismatch(id: string, previewPath: string): Promise<string | null> {
  if (!id.startsWith('21st-dev:')) return null;
  const expected = originals.find(original => `21st-dev:${original.id}` === id)?.files.find(file => file.path === 'index.html')?.content;
  const served = await (await fetch(new URL(previewPath, origin))).text();
  return expected !== undefined && served === expected ? null : 'The runtime serves a different preview than the ledger revision (for example a saved private upstream demo)';
}
await mkdir(out, { recursive: true });

type ProbeResult = StateMatrixProbe & { status: 'rendered' | 'failed' | 'inconclusive'; reason: string | null; screenshot: string | null; pageErrors: number; failedRequests: number; policyViolations: number };
const slug = (value: string) => value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

const NO_WEBGL = () => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    if (/webgl/i.test(kind)) return null;
    return (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
  } as typeof HTMLCanvasElement.prototype.getContext;
};

async function actuate(page: Page, state: StateMatrixProbe['state']): Promise<string | null> {
  const target = page.locator('a, button, summary, [role=button], input, select, textarea, [tabindex]:not([tabindex="-1"])').first();
  switch (state) {
    case 'default': return null;
    case 'hover': {
      if (await target.count()) await target.hover({ timeout: T.short });
      else await page.mouse.move(page.viewportSize()!.width / 2, page.viewportSize()!.height / 2);
      return null;
    }
    case 'focus-visible': {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body && document.activeElement.matches(':focus-visible'));
      return focused ? null : 'Keyboard Tab did not reach a focus-visible element';
    }
    case 'open': {
      if (!(await target.count())) return 'No control to open';
      await target.click({ timeout: T.short });
      const opened = await page.evaluate(() => Boolean(document.querySelector('dialog[open], details[open], [aria-expanded="true"]')));
      return opened ? null : 'No dialog, details or expanded control after activation';
    }
    default: throw new Inconclusive(`State ${state} has no automated actuation yet`);
  }
}
class Inconclusive extends Error {}

const results: Array<Record<string, unknown>> = [];
for (const batch of plan.batches) {
  const runnable = batch.items.filter(item => item.previewPath);
  for (const item of batch.items.filter(candidate => !candidate.previewPath)) results.push({ id: item.id, family: batch.family, previewGap: item.previewGap, probes: [] });
  if (!runnable.length) continue;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    for (const item of runnable) {
      const probeResults: ProbeResult[] = [];
      const mismatch = await revisionMismatch(item.id, item.previewPath!);
      if (mismatch) {
        results.push({ id: item.id, family: batch.family, sourceDigest: item.sourceDigest, previewPath: item.previewPath, revisionMismatch: mismatch, probes: [] });
        console.log(`${item.id}: not probed, ${mismatch}`);
        continue;
      }
      for (const probe of item.probes) {
        const context = await browser.newContext({ viewport: { width: probe.viewport, height: 800 }, reducedMotion: probe.reducedMotion ? 'reduce' : 'no-preference' });
        await context.route('**/*', route => (new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort()));
        if (!probe.webgl) await context.addInitScript(NO_WEBGL);
        const page = await context.newPage();
        let pageErrors = 0, failedRequests = 0, policyViolations = 0;
        page.on('pageerror', () => { pageErrors++; });
        page.on('requestfailed', request => { if (request.url().startsWith(origin.origin)) failedRequests++; });
        page.on('response', response => { if (response.status() >= 400 && response.url().startsWith(origin.origin)) failedRequests++; });
        page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) policyViolations++; });
        const name = `${slug(batch.family)}/${slug(item.id)}-${probe.state}-${probe.viewport}${probe.reducedMotion ? '-rm' : ''}${probe.webgl ? '' : '-nowebgl'}.png`;
        let status: ProbeResult['status'] = 'rendered';
        let reason: string | null = null;
        let screenshot: string | null = null;
        try {
          const response = await page.goto(new URL(item.previewPath!, origin).href, { waitUntil: 'load', timeout: T.long });
          if (!response?.ok()) throw new Error(`Preview answered ${response?.status() ?? 'no response'}`);
          await page.waitForTimeout(300);
          reason = await actuate(page, probe.state);
          await page.waitForTimeout(200);
          await mkdir(resolve(out, slug(batch.family)), { recursive: true });
          await page.screenshot({ path: resolve(out, name) });
          screenshot = name;
          if (reason || pageErrors || failedRequests || policyViolations) status = 'failed';
        } catch (error) {
          status = error instanceof Inconclusive ? 'inconclusive' : 'failed';
          reason = error instanceof Error ? error.message.slice(0, 300) : String(error);
        } finally {
          await context.close();
        }
        probeResults.push({ ...probe, status, reason, screenshot, pageErrors, failedRequests, policyViolations });
      }
      results.push({ id: item.id, family: batch.family, sourceDigest: item.sourceDigest, previewPath: item.previewPath, cleanup: 'not-probed', probes: probeResults });
      console.log(`${item.id}: ${probeResults.filter(result => result.status === 'rendered').length}/${probeResults.length} rendered`);
    }
  } finally {
    await browser.close();
  }
}
await writeFile(resolve(out, 'results.json'), `${JSON.stringify({ origin: origin.origin, ledgerFrozenAt: ledger.frozenAt, summary: plan.summary, skipped: plan.skipped, results }, null, 2)}\n`);
console.log(`Wrote ${resolve(out, 'results.json')}`);
