/**
 * Live witness for block composition (goal criterion C22): a real brief, real providers and real
 * Jev, against a runtime that is already running with its keys. Opt-in: it skips unless
 * `OD_LIVE_WEB_URL` and `OD_LIVE_DAEMON_URL` name that runtime, so the CI pools (no live keys)
 * never run it. It uses `clusterTest`, which boots no worker tools-dev runtime of its own.
 *
 *   OD_LIVE_WEB_URL=http://127.0.0.1:3012 OD_LIVE_DAEMON_URL=http://127.0.0.1:7468 \
 *   OD_LIVE_ARTIFACT_DIR=<dir> pnpm --filter @mish/e2e exec playwright test \
 *     -c playwright.config.ts ui/agency-compose-live.test.ts --workers 1
 *
 * Two surfaces, the same brief and the same checks: Home -> "Build with Jev" (which sends
 * `composition: 'auto'`), and `od agency build --composition auto --json`. For each: the build is
 * done, the published page carries at least three distinct `data-od-selected-section="cult:…"`
 * ids in the order the build reports (and, for Home, the order the result card lists), the header
 * names the business as the brief does, and the visible text states no price, year, month-date or
 * percent the brief does not (the same patterns as the C21 proof check).
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { clusterTest as test, expect } from '@/playwright/suite';

const execFileAsync = promisify(execFile);

const WEB = process.env.OD_LIVE_WEB_URL;
const DAEMON = process.env.OD_LIVE_DAEMON_URL;
const ARTIFACTS = process.env.OD_LIVE_ARTIFACT_DIR;
const BUILD_TIMEOUT_MS = 6 * 60_000;

const BRIEF = 'Ledgerline is accounting software for small creative agencies. It brings invoices, time tracking and payroll into one place, so a studio owner can see which projects make money. Ledgerline connects to Stripe, QuickBooks and Gusto, and sends automatic payment reminders to clients who pay late. Agencies can start a free trial from the website, with no credit card needed.\n\nCommon questions: Can I import my existing clients? Yes, from a CSV file. Does it work for freelancers? Yes, it works for teams of one. Is my data backed up? Yes, every night.';
const BUSINESS = 'Ledgerline';

/** Facts the brief never states: the C21 proof check's patterns, on visible text. */
const UNSTATED: Record<string, RegExp> = {
  price: /[$€£]\s?\d/g,
  year: /\b(?:19|20)\d\d\b/g,
  'month-date': /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/g,
  percent: /\d\s?%/g,
};

test.skip(!WEB || !DAEMON, 'live witness: set OD_LIVE_WEB_URL and OD_LIVE_DAEMON_URL to a running runtime with provider and Jev keys');

type Snapshot = { id: string; status: string; projectId?: string; entry?: string; composition?: { used: string; blocks?: string[]; fallback?: string; directionId?: string } };

async function waitForBuild(page: Page, id: string): Promise<Snapshot> {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  for (;;) {
    const response = await page.request.get(`${DAEMON}/api/agency/builds/${encodeURIComponent(id)}`);
    const body = (await response.json()) as { build?: Snapshot } & Snapshot;
    const snapshot = body.build ?? body;
    if (['done', 'failed', 'unrouted', 'cancelled'].includes(snapshot.status)) return snapshot;
    if (Date.now() > deadline) throw new Error(`build ${id} still ${snapshot.status} after ${BUILD_TIMEOUT_MS} ms`);
    await page.waitForTimeout(2000);
  }
}

/** Opens the published page in the browser and checks it against the build's own report. */
async function checkPublishedSite(page: Page, snapshot: Snapshot, label: string): Promise<{ ids: string[]; url: string; screenshot?: string }> {
  expect(snapshot.status, `${label}: build status`).toBe('done');
  expect(snapshot.composition?.used, `${label}: composed (fallback ${snapshot.composition?.fallback ?? '-'})`).toBe('blocks');
  const reported = snapshot.composition?.blocks ?? [];
  const url = `${WEB}/api/projects/${encodeURIComponent(snapshot.projectId!)}/raw/${encodeURIComponent(snapshot.entry ?? 'composed-r1.html')}`;
  await page.goto(url, { waitUntil: 'load' });
  const ids = await page.locator('[data-od-selected-section]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-od-selected-section') ?? ''));
  expect(ids, `${label}: page order is the reported order`).toEqual(reported);
  const cult = new Set(ids.filter((id) => id.startsWith('cult:')));
  expect(cult.size, `${label}: distinct cult blocks`).toBeGreaterThanOrEqual(3);

  const brand = (await page.locator('[data-od-id="chrome--brand"]').innerText()).trim();
  expect(brand, `${label}: the header names the business as the brief does`).toBe(BUSINESS);
  expect(await page.title()).toBe(BUSINESS);
  const headline = (await page.locator('h1').first().innerText()).trim();
  expect(headline.length, `${label}: a headline`).toBeGreaterThan(0);
  const visible = await page.locator('body').innerText();
  for (const [kind, pattern] of Object.entries(UNSTATED)) {
    const found = [...visible.matchAll(pattern)].map((match) => match[0]).filter((text) => !BRIEF.includes(text));
    expect(found, `${label}: unstated ${kind}`).toEqual([]);
  }
  let screenshot: string | undefined;
  if (ARTIFACTS) {
    await mkdir(ARTIFACTS, { recursive: true });
    screenshot = join(ARTIFACTS, `C22-${label}-site.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await writeFile(join(ARTIFACTS, `C22-${label}.html`), await page.content());
    await writeFile(join(ARTIFACTS, `C22-${label}.json`), `${JSON.stringify({ snapshot, ids, brand, headline }, null, 2)}\n`);
  }
  return { ids, url, ...(screenshot ? { screenshot } : {}) };
}

/** The daemon's onboarding gate stands in front of Home: mark it complete, as other UI specs do. */
async function completeOnboarding(page: Page): Promise<() => Promise<void>> {
  const prior = await (await page.request.get(`${DAEMON}/api/app-config`)).json() as Record<string, unknown>;
  const config = { ...(prior.config as Record<string, unknown> ?? prior), onboardingCompleted: true, privacyDecisionAt: 1 };
  expect((await page.request.put(`${DAEMON}/api/app-config`, { data: config })).ok()).toBeTruthy();
  await page.addInitScript((value) => localStorage.setItem('mish:config', JSON.stringify(value)), config);
  return async () => { await page.request.put(`${DAEMON}/api/app-config`, { data: prior.config ?? prior }); };
}

test('[P2] live: Home Build with Jev composes the brief from reviewed blocks', async ({ page }) => {
  test.setTimeout(BUILD_TIMEOUT_MS + 120_000);
  const restore = await completeOnboarding(page);
  try {
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
    const privacy = page.getByRole('dialog').filter({ hasText: /Help us improve/i });
    if (await privacy.isVisible().catch(() => false)) await privacy.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
    await expect(page.getByTestId('home-hero')).toBeVisible({ timeout: 60_000 });

    const pill = page.getByTestId('home-hero-type-pill-jev-site');
    if (!(await pill.isVisible().catch(() => false))) await page.getByTestId('home-hero-type-pills-more').click();
    await pill.click();
    await page.getByTestId('home-hero-input').click();
    await page.keyboard.insertText(BRIEF);

    const started = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/agency/build');
    await page.getByTestId('home-hero-submit').click();
    const response = await started;
    expect(response.ok()).toBeTruthy();
    const request = response.request().postDataJSON() as { composition?: string; verify?: string };
    expect(request.composition).toBe('auto');
    expect(request.verify).toBeUndefined();
    const buildId = ((await response.json()) as { build: { id: string } }).build.id;

    // The result card lists the chosen blocks as soon as the composition decision lands.
    const card = page.getByTestId('home-jev-build').getByTestId('agency-composition');
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card).toHaveAttribute('data-used', 'blocks');
    const listed = await card.locator('li[data-block-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-block-id') ?? ''));

    const snapshot = await waitForBuild(page, buildId);
    const checked = await checkPublishedSite(page, snapshot, 'home');
    // The card listed the plan before the fill; the page carries the published plan, which may be
    // shorter only by budget drops (reported on the snapshot).
    expect(listed.filter((id) => checked.ids.includes(id))).toEqual(checked.ids);
  } finally {
    await restore();
  }
});

test('[P2] live: od agency build --composition auto composes the same brief', async ({ page }) => {
  test.setTimeout(BUILD_TIMEOUT_MS + 120_000);
  const od = fileURLToPath(new URL('../../apps/daemon/bin/od.mjs', import.meta.url));
  // The artifact dir when one is named, otherwise a fresh temp dir: never the working directory.
  const briefDir = ARTIFACTS ?? await mkdtemp(join(tmpdir(), 'od-c22-'));
  await mkdir(briefDir, { recursive: true });
  const briefFile = join(briefDir, 'C22-brief.txt');
  await writeFile(briefFile, BRIEF);
  const { stdout } = await execFileAsync(process.execPath, [od, 'agency', 'build', '--daemon-url', DAEMON!, '--prompt-file', briefFile, '--composition', 'auto', '--json'], { maxBuffer: 32 * 1024 * 1024, timeout: BUILD_TIMEOUT_MS });
  if (ARTIFACTS) await writeFile(join(ARTIFACTS, 'C22-cli-stdout.json'), stdout);
  const printed = JSON.parse(stdout) as Snapshot;
  await checkPublishedSite(page, printed, 'cli');
});
