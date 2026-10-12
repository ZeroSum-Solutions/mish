import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@/playwright/suite';
import { routeMockAgents, routeAppConfig, STORAGE_KEY } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

// One real local UI/API fixture chain. No workbench route mock and no provider upload.
test('[P0] Resources inspect and enlarge the same HTML document across viewport sizes', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(T.xlong);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const httpErrors: { path: string; status: number }[] = [];
  async function captureEntry(name: string) {
    const path = testInfo.outputPath(`${name}-entry.png`);
    await page.screenshot({ path });
    await testInfo.attach(`${name}-entry`, { path, contentType: 'image/png' });
  }
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  // The generic storage seed runs in opaque frames before their sandbox shim.
  // Use its route helpers and a top-page-only seed for this iframe-specific test.
  await routeMockAgents(page);
  await routeAppConfig(page);
  await page.addInitScript(({ key }) => {
    if (window !== window.top) return;
    localStorage.setItem(key, JSON.stringify({ mode: 'daemon', agentId: 'mock', onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } }));
  }, { key: STORAGE_KEY });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const name = `w1-preview-${randomUUID()}`;
  const title = `W1 Form ${name}`;
  const fixture = join(toolsDev.root, 'fixtures', name);
  await mkdir(join(fixture, 'assets'), { recursive: true });
  await writeFile(join(fixture, 'mish.json'), JSON.stringify({ name, title, version: '1.0.0', description: 'Local resource preview acceptance fixture', license: 'MIT', tags: ['scenario', 'prototype'], od: { kind: 'scenario', mode: 'prototype', preview: { type: 'html', entry: 'assets/preview.html' } } }));
  await writeFile(join(fixture, 'SKILL.md'), '# Local fixture\nInspect a preview form.');
  await writeFile(join(fixture, 'assets/fixture.css'), '.linked{color:rgb(12,34,56)}');
  await writeFile(join(fixture, 'assets/fixture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/></svg>');
  await writeFile(join(fixture, 'assets/preview.html'), '<!doctype html><html><head><link rel="stylesheet" href="fixture.css"><style>body{margin:16px;min-height:2400px}.moving{animation:move 8s linear infinite}@keyframes move{to{transform:translateX(20px)}}</style></head><body><label>Name<input aria-label="Name" value="initial"></label><button>Local action</button><p class="moving linked">Motion sample</p><img alt="Linked fixture" src="fixture.svg"><p style="margin-top:280px">Scroll retained marker</p></body></html>');
  const install = await page.request.post(toolsDev.url.daemon('/api/plugins/install'), { data: { source: fixture } });
  expect(install.ok(), await install.text()).toBeTruthy();
  const search = await page.request.post(toolsDev.url.daemon('/api/workbench/resources/search'), { data: { query: title, useProjectContext: true, facets: {}, limit: 20 } });
  expect(search.ok(), 'Real workbench search route must exist before UI proof').toBeTruthy();
  const searchBody = await search.json();
  expect(searchBody.context).toMatchObject({
    requested: true, applied: false, reason: 'no-project', projectId: null,
    preferenceRevision: 0, observedContextRevision: 0,
    selection: 'request-override', resultMode: 'lexical',
  });
  expect(searchBody.contextRevision).toBeNull();
  expect(searchBody.results.some((item: { title: string; readiness: string }) => item.title === title && item.readiness === 'unverified')).toBe(true);
  const project = await page.request.post('/api/projects', { data: { id: randomUUID(), name: 'W1 preview fixture', skillId: null, designSystemId: null, metadata: { kind: 'prototype', nameSource: 'user' } } });
  expect(project.ok()).toBeTruthy();
  const created = await project.json();
  await page.goto(`/projects/${created.project.id}/conversations/${created.conversationId}`);
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long });
  await page.getByTestId('chat-plus-trigger').click();
  await page.getByTestId('composer-plus-resources').click();
  await page.getByRole('textbox', { name: 'Search resources' }).fill(title);
  // V06 includes fit and acceptance separately; missing acceptance stays informational.
  const result = page.getByRole('button', { name: `${title} · unverified · Fit unknown · Acceptance pending`, exact: true });
  await expect(result).toBeVisible();
  await expect(result.getByText('unverified', { exact: true })).toBeVisible();
  await expect(result.getByTestId('component-acceptance')).toHaveText(' · Acceptance pending');
  await captureEntry('resources-search');
  await result.click();
  const detail = page.getByTestId('workbench-resource-detail');
  await expect(detail.getByText('adapter-missing', { exact: true })).toBeVisible();
  await expect(detail.locator('[data-preview-state="ready"]')).toBeVisible({ timeout: T.long });
  const iframe = detail.locator('iframe');
  const content = iframe.contentFrame();
  await expect.poll(() => content.locator('.linked').evaluate((node) => getComputedStyle(node).color)).toBe('rgb(12, 34, 56)');
  await expect.poll(() => content.getByAltText('Linked fixture').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(40);
  await captureEntry('resources-detail');
  await content.getByRole('textbox', { name: 'Name' }).fill('Retained value');
  await content.locator('body').evaluate(() => window.scrollTo(0, 300));
  await iframe.evaluate((node) => {
    const host = window as unknown as { w1Node: Element; w1Parent: Node | null; w1Window: Window | null; w1Loads: number };
    host.w1Node = node; host.w1Parent = node.parentNode; host.w1Window = (node as HTMLIFrameElement).contentWindow; host.w1Loads = 0;
    node.addEventListener('load', () => host.w1Loads++);
  });
  await expect(detail.locator('button').filter({ hasText: 'Back to preview' })).toBeHidden();
  const enlarge = detail.getByRole('button', { name: 'Enlarge preview' });
  await enlarge.click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await expect(dialog).toBeVisible();
  await content.locator('body').evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'Fixture non-blocking runtime warning' })));
  await expect(dialog.getByRole('status')).toHaveText('Preview reported an issue. Content remains available.');
  await expect(detail.locator('[data-preview-state="ready"]')).toBeVisible();
  await expect(dialog.locator('button').filter({ hasText: 'Enlarge preview' })).toBeHidden();
  const geometry: unknown[] = [];
  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => dialog.boundingBox()).toEqual({ x: 0, y: 0, width, height: 800 });
    const rect = await dialog.boundingBox();
    expect(rect?.x).toBe(0); expect(rect?.y).toBe(0); expect(rect?.width).toBe(width); expect(rect?.height).toBe(800);
    geometry.push({ surface: 'resources', viewportWidth: width, ...rect });
    await dialog.getByRole('button', { name: 'Back to preview' }).click({ trial: true });
    const toolbar = dialog.locator(':scope > div').first();
    expect((await toolbar.boundingBox())?.y).toBe(1); // The shell retains its 1px border.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (width === 320 || width === 1440) {
      const path = testInfo.outputPath(`workbench-${width}.png`);
      await page.screenshot({ path });
      await testInfo.attach(`workbench-${width}`, { path, contentType: 'image/png' });
    }
  }
  expect(await iframe.evaluate((node) => {
    const host = window as unknown as { w1Node: Element; w1Parent: Node; w1Window: Window; w1Loads: number };
    return node === host.w1Node && node.parentNode === host.w1Parent && (node as HTMLIFrameElement).contentWindow === host.w1Window && host.w1Loads === 0;
  })).toBe(true);
  await expect(content.getByRole('textbox', { name: 'Name' })).toHaveValue('Retained value');
  expect(await content.locator('body').evaluate(() => window.scrollY)).toBe(300);
  expect(await content.locator('.moving').evaluate((node) => getComputedStyle(node).animationDuration)).toBe('1e-05s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => content.locator('.moving').evaluate((node) => getComputedStyle(node).animationDuration)).toBe('8s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => content.locator('.moving').evaluate((node) => getComputedStyle(node).animationDuration)).toBe('1e-05s');
  await content.getByRole('button', { name: 'Local action' }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Back to preview' })).toBeFocused();
  await content.getByRole('textbox', { name: 'Name' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Back to preview' })).toBeFocused();
  // Escape originates inside the opaque sandbox's editable field.
  await content.getByRole('textbox', { name: 'Name' }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(enlarge).toBeFocused();
  await page.mouse.move(1200, 500);
  await page.waitForTimeout(350); // Exercise the existing 200ms flyout close timer.
  await expect(detail).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search resources' })).toHaveValue(title);
  await expect(content.getByRole('textbox', { name: 'Name' })).toHaveValue('Retained value');
  expect(await iframe.evaluate((node) => node === (window as unknown as { w1Node: Element }).w1Node)).toBe(true);
  await detail.getByRole('button', { name: 'Close details' }).click();
  await expect(detail).toHaveCount(0);
  await page.mouse.click(1200, 500); // Deliberate dismissal after retained-state proof.

  for (const surface of ['plugins', 'toolbox'] as const) {
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.getByTestId('chat-plus-trigger').click();
    if (surface === 'plugins') {
      await page.getByTestId('composer-plus-plugins').click();
      await page.getByRole('textbox', { name: 'Plugins', exact: true }).fill(title);
      await page.getByRole('menuitem', { name: title, exact: true }).hover();
    } else {
      await page.getByText('Design toolbox', { exact: true }).click();
      await page.getByRole('textbox', { name: 'Search design toolbox resources' }).fill(title);
      await page.getByRole('menuitem', { name: title, exact: true }).hover();
    }
    const hero = surface === 'plugins' ? page.locator('.plus-menu__plugin-pane > .plus-menu__preview') : page.locator('.plus-menu__detail .plus-menu__preview');
    const live = hero.locator('iframe');
    await expect(hero.locator('[data-preview-state="ready"]')).toBeVisible({ timeout: T.long });
    expect(await live.evaluate((node) => ({ width: getComputedStyle(node).width, pointerEvents: getComputedStyle(node).pointerEvents, tabIndex: (node as HTMLIFrameElement).tabIndex }))).toEqual({ width: '1440px', pointerEvents: 'none', tabIndex: -1 });
    await captureEntry(surface);
    await live.evaluate((node) => {
      const host = window as unknown as { w1Node: Element; w1Window: Window | null; w1Parent: Node | null; w1Loads: number };
      host.w1Node = node; host.w1Parent = node.parentNode; host.w1Window = (node as HTMLIFrameElement).contentWindow; host.w1Loads = 0;
      node.addEventListener('load', () => host.w1Loads++);
    });
    await hero.getByRole('button', { name: 'Enlarge preview' }).click();
    await expect(dialog).toBeVisible();
    const liveContent = live.contentFrame();
    await liveContent.getByRole('textbox', { name: 'Name' }).fill(`${surface} retained`);
    for (const width of [320, 375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(() => dialog.boundingBox()).toEqual({ x: 0, y: 0, width, height: 800 });
      const rect = await dialog.boundingBox();
      expect(rect).toEqual({ x: 0, y: 0, width, height: 800 });
      geometry.push({ surface, viewportWidth: width, ...rect });
      await dialog.getByRole('button', { name: 'Back to preview' }).click({ trial: true });
      if (width === 320 || width === 1440) {
        const path = testInfo.outputPath(`${surface}-${width}.png`);
        await page.screenshot({ path });
        await testInfo.attach(`${surface}-${width}`, { path, contentType: 'image/png' });
      }
    }
    await dialog.getByRole('button', { name: 'Back to preview' }).click();
    await page.mouse.move(1200, 500);
    await page.waitForTimeout(350); // Both flyout and portaled-detail timer must retain it.
    await expect(hero).toBeVisible();
    await expect(liveContent.getByRole('textbox', { name: 'Name' })).toHaveValue(`${surface} retained`);
    expect(await live.evaluate((node) => {
      const host = window as unknown as { w1Node: Element; w1Window: Window; w1Parent: Node; w1Loads: number };
      return node === host.w1Node && node.parentNode === host.w1Parent && (node as HTMLIFrameElement).contentWindow === host.w1Window && host.w1Loads === 0;
    })).toBe(true);
    expect(await live.evaluate((node) => getComputedStyle(node).width)).toBe('1440px');
    await page.mouse.click(1200, 500);
    await expect(hero).toHaveCount(0);
  }
  await testInfo.attach('workbench-observations', { body: JSON.stringify({ geometry, sameNodeWindowParent: true, reloadsDuringEnlarge: 0, inputRetained: true, scrollRetained: true, pointerOutsideAfterRestore: true, iframeTabBoundaries: true, linkedCssImage: true, runtimeWarningNonBlocking: true, pluginThumbnailWidth: 1440, toolboxPortalEnlargement: true, escapeInsideInput: true, liveReducedMotion: true, contextRequested: true, contextApplied: false, pageErrors, consoleErrors, httpErrors }, null, 2), contentType: 'application/json' });
  expect(pageErrors).toEqual([]);
  expect(httpErrors.filter(({ path }) => path.startsWith('/api/workbench/') || path.includes(`/${name}/`))).toEqual([]);
});
