import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@/playwright/suite';
import { routeMockAgents, routeAppConfig, STORAGE_KEY } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

// AC-R07 preamble and AC-R07.2 on the real local UI/API chain (no workbench route mocks):
// compiled HTML sections (HyperUI block, Cult layout), a WebGL demo and a page that used to
// load the Tailwind Play CDN all preview in the Enlarge shell; the width switch resizes the same
// document; a variant switch keeps the dialog and the chosen width and discloses target
// dependencies; and no preview ever requests anything from another origin.
test('[P1] Enlarge previews compiled sections, WebGL and variants with no CDN request', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(T.xlong * 3);
  // Chromium announces a request the page's policy then blocks (DevTools "blocked:csp"), so a
  // request alone is not a load: a response, or a failure other than a CSP block, is.
  const foreignLoaded: string[] = [];
  const foreignBlocked: string[] = [];
  const pageErrors: string[] = [];
  const observations: Record<string, unknown> = {};
  const isForeign = (raw: string) => { const url = new URL(raw); return /^(?:https?|wss?):$/u.test(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); };
  // Sol r07 BLOCK: preview subresources must not reach any /api route other than the preview's own assets.
  const probeLoaded: string[] = [];
  const probeBlocked: string[] = [];
  page.on('response', (response) => { if (isForeign(response.url())) foreignLoaded.push(response.url()); if (response.url().includes('r07probe=')) probeLoaded.push(response.url()); });
  // A request that fails for any reason other than the page policy (for example Opaque Response
  // Blocking of a JSON body) still reached the daemon, so it counts as reached.
  page.on('requestfailed', (request) => {
    if (!request.url().includes('r07probe=')) return;
    const reason = request.failure()?.errorText ?? '';
    (/BLOCKED_BY_CSP|csp/iu.test(reason) ? probeBlocked : probeLoaded).push(`${request.url()} (${reason})`);
  });
  page.on('requestfailed', (request) => {
    if (!isForeign(request.url())) return;
    const reason = request.failure()?.errorText ?? '';
    (/BLOCKED_BY_CSP|csp/iu.test(reason) ? foreignBlocked : foreignLoaded).push(`${request.url()} (${reason})`);
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  async function captureEnlarged(detail: import('@playwright/test').Locator, name: string, title: string) {
    await detail.getByRole('button', { name: 'Enlarge preview' }).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await capture(name);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  async function capture(name: string) {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  }
  await routeMockAgents(page);
  await routeAppConfig(page);
  await page.addInitScript(({ key }) => {
    if (window !== window.top) return;
    localStorage.setItem(key, JSON.stringify({ mode: 'daemon', agentId: 'mock', onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } }));
  }, { key: STORAGE_KEY });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const probeName = `r07-probe-${randomUUID()}`;
  const probeTitle = `R07 API probe ${probeName}`;
  const fixture = join(toolsDev.root, 'fixtures', probeName);
  await mkdir(join(fixture, 'assets'), { recursive: true });
  await writeFile(join(fixture, 'open-design.json'), JSON.stringify({ name: probeName, title: probeTitle, version: '1.0.0', description: 'Preview API-boundary probe', license: 'MIT', tags: ['scenario'], od: { kind: 'scenario', mode: 'prototype', preview: { type: 'html', entry: 'assets/preview.html' } } }));
  await writeFile(join(fixture, 'SKILL.md'), '# Probe\nPreview API boundary.');
  await writeFile(join(fixture, 'assets/own.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="teal"/></svg>');
  await writeFile(join(fixture, 'assets/preview.html'), '<!doctype html><html><head><link rel="stylesheet" href="/api/plugins?r07probe=link"><script src="/api/health?r07probe=script"></script></head><body><img alt="Own asset" src="own.svg"><img alt="API probe" src="/api/projects?r07probe=img"><p>Probe</p></body></html>');
  const install = await page.request.post(toolsDev.url.daemon('/api/plugins/install'), { data: { source: fixture } });
  expect(install.ok(), await install.text()).toBeTruthy();
  const project = await page.request.post('/api/projects', { data: { id: randomUUID(), name: 'R07 adapters', skillId: null, designSystemId: null, metadata: { kind: 'prototype', nameSource: 'user' } } });
  expect(project.ok()).toBeTruthy();
  const created = await project.json();
  await page.goto(`/projects/${created.project.id}/conversations/${created.conversationId}`);
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long });

  async function open(query: string, title: string) {
    if (!(await page.getByRole('textbox', { name: 'Search resources' }).isVisible())) {
      await page.getByTestId('chat-plus-trigger').click();
      await page.getByTestId('composer-plus-resources').click();
    }
    await page.getByRole('textbox', { name: 'Search resources' }).fill(query);
    const result = page.getByRole('button', { name: new RegExp(`^${title.replace(/[()]/g, '\\$&')} · `, 'u') });
    await expect(result.first()).toBeVisible({ timeout: T.long });
    await result.first().click();
    const detail = page.getByTestId('workbench-resource-detail');
    await expect(detail.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: T.long });
    return detail;
  }

  // 0. A preview that points subresources at /api routes reaches none of them; its own asset still loads.
  const probe = await open(probeTitle, probeTitle);
  await expect(probe.locator('[data-preview-state="ready"]')).toBeVisible({ timeout: T.long });
  await expect.poll(() => probe.locator('iframe').contentFrame().getByAltText('Own asset').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(24);
  await page.waitForTimeout(500);
  observations.apiProbe = { loaded: probeLoaded, blocked: probeBlocked };
  expect(probeLoaded).toEqual([]);
  expect(probeBlocked).toHaveLength(3);

  // 1. A HyperUI block: compiled utilities, width switch, variants (eleven designs → a select).
  let detail = await open('Application Charts 1', 'Application Charts 1');
  const block = detail.locator('[data-preview-adapter="compiled-html-section"]');
  await expect(block).toHaveAttribute('data-preview-state', 'ready', { timeout: T.long });
  const blockFrame = detail.locator('iframe').contentFrame();
  await expect.poll(() => blockFrame.locator('div.rounded-lg').first().evaluate((node) => getComputedStyle(node).borderTopLeftRadius)).toBe('8px');
  await expect(detail.getByTestId('workbench-target-dependencies')).toContainText('tailwindcss 4.3.3');
  await capture('hyperui-detail');
  await detail.getByRole('button', { name: 'Enlarge preview' }).click();
  let dialog = page.getByRole('dialog', { name: 'Application Charts 1', exact: true });
  await expect(dialog).toBeVisible();
  const widths = dialog.getByRole('group', { name: 'Viewport width' });
  const iframe = dialog.locator('iframe');
  await iframe.evaluate((node) => { (window as unknown as { r07Node: Element }).r07Node = node; });
  for (const width of [320, 375, 768, 1024, 1440]) {
    await widths.getByRole('button', { name: `${width} px`, exact: true }).click();
    await expect(widths.getByRole('button', { name: `${width} px`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => iframe.contentFrame().locator('html').evaluate(() => window.innerWidth)).toBe(width);
    expect(await iframe.evaluate((node) => node === (window as unknown as { r07Node: Element }).r07Node)).toBe(true);
  }
  // Keyboard: the width buttons are reachable and operable without a pointer.
  await widths.getByRole('button', { name: '375 px', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(widths.getByRole('button', { name: '375 px', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await capture('hyperui-enlarged-375');
  await dialog.getByRole('combobox', { name: 'Variant' }).selectOption({ label: '2 · Application Charts 2' });
  dialog = page.getByRole('dialog', { name: 'Application Charts 2', exact: true });
  await expect(dialog).toBeVisible({ timeout: T.long });
  await expect(dialog.locator('[data-preview-state="ready"]')).toBeVisible({ timeout: T.long });
  await expect(dialog.getByRole('group', { name: 'Viewport width' }).getByRole('button', { name: '375 px', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('workbench-resource-detail').getByRole('button', { name: 'Enlarge preview' })).toBeFocused();

  // 2. A Cult section that was "adapter-missing" now previews its compiled layout.
  detail = await open('About (series VT)', 'About (series VT)');
  await expect(detail.locator('[data-preview-adapter="compiled-html-section"]')).toHaveAttribute('data-preview-state', 'ready', { timeout: T.long });
  await expect(detail.locator('iframe').contentFrame().locator('[data-od-section="od-live-preview"]')).toBeVisible();
  await captureEnlarged(detail, 'cult-section-enlarged', 'About (series VT)');

  // 3. A WebGL demo: ready with a live context, or a labelled fallback, never an unlabelled failure.
  detail = await open('Silk', 'Silk');
  const webgl = detail.locator('[data-preview-adapter="webgl"]');
  await expect(webgl).toHaveAttribute('data-preview-state', /^(ready|unavailable)$/u, { timeout: T.long });
  if (await webgl.getAttribute('data-preview-state') === 'unavailable') {
    await expect(webgl).toHaveAttribute('data-preview-reason', /^webgl-/u);
    await expect(webgl.getByRole('alert')).toContainText('WebGL');
  }
  observations.webgl = { state: await webgl.getAttribute('data-preview-state'), reason: await webgl.getAttribute('data-preview-reason') };
  await captureEnlarged(detail, 'webgl-enlarged', 'Silk');

  // 4. GSAP target variants disclose what each brings into the project.
  detail = await open('Section entrance', 'Section entrance (HTML)');
  await expect(detail.getByTestId('workbench-target-dependencies')).toContainText('gsap 3.15.0');
  await detail.getByRole('button', { name: 'Enlarge preview' }).click();
  dialog = page.getByRole('dialog', { name: 'Section entrance (HTML)', exact: true });
  await dialog.getByRole('radiogroup', { name: 'Variant' }).getByRole('radio', { name: 'React' }).click();
  dialog = page.getByRole('dialog', { name: 'Section entrance (React)', exact: true });
  await expect(dialog).toBeVisible({ timeout: T.long });
  await expect(dialog.getByTestId('workbench-target-dependencies')).toContainText('@gsap/react ^2.1.2');
  await expect(dialog.getByTestId('workbench-target-dependencies')).toContainText('project dependency');
  await capture('gsap-react-variant');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // 5. The page that used to load the Tailwind Play CDN renders with its compiled utilities.
  detail = await open('Device 3D Showcase', 'Device 3D Showcase');
  await expect(detail.locator('[data-preview-state="ready"]')).toBeVisible({ timeout: T.long });
  await expect.poll(() => detail.locator('iframe').contentFrame().locator('body').evaluate((node) => getComputedStyle(node).display)).toBe('flex');
  await captureEnlarged(detail, 'device-showcase-enlarged', 'Device 3D Showcase');

  observations.foreign = { loaded: foreignLoaded, blockedByPolicy: foreignBlocked };
  writeFileSync(testInfo.outputPath('observations.json'), JSON.stringify(observations, null, 2));
  await testInfo.attach('observations', { path: testInfo.outputPath('observations.json'), contentType: 'application/json' });
  expect(foreignLoaded).toEqual([]);
  expect(pageErrors).toEqual([]);
});
