import { createHash, randomUUID } from 'node:crypto';
import { test, expect } from '@/playwright/suite';
import { routeAppConfig, routeMockAgents, STORAGE_KEY } from '@/playwright/mock-factory';
import { openNewProjectModal } from '@/playwright/rail';
import { T } from '@/timeouts';
import { openAllProjectFiles } from '@/playwright/workspace';
import type { Page } from '@playwright/test';

async function dropFile(page: Page, name: string, bytes: Buffer, declaredMime = 'application/zip') {
 await page.evaluate(({ name, bytes, declaredMime }) => {
  const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], name, { type: declaredMime }));
  document.querySelector('.workspace-shell')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
 }, { name, bytes: [...bytes], declaredMime });
}

async function openManualProject(page: Page) {
 await openNewProjectModal(page); await page.getByTestId('new-project-tab-prototype').click(); await page.getByTestId('new-project-name').fill(`W2 intake ${randomUUID()}`);
 await page.getByTestId('create-project').click(); await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long });
}

test('[P0] saved file tray leaves privacy consent controls actionable', async ({ page }) => {
 test.setTimeout(T.xlong);
 await routeMockAgents(page);
 const config = { mode: 'daemon', agentId: 'mock', onboardingCompleted: true, agentModels: {}, privacyDecisionAt: null, telemetry: { metrics: false, content: false, artifactManifest: false } };
 await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: STORAGE_KEY, value: config });
 await page.route('**/api/app-config', async route => {
  if (route.request().method() !== 'GET') return route.continue();
  await route.fulfill({ json: { config } });
 });
 await page.goto('/');
 await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.long });
 const consent = page.getByRole('region', { name: /Help us improve Mishh Mashh/i });
 await expect(consent).toBeVisible();
 const filename = `consent-${randomUUID()}.zip`;
 await dropFile(page, filename, Buffer.from('saved reference'));
 const row = page.getByTestId('workbench-intake-tray').locator('li').filter({ hasText: filename });
 await expect(row).toContainText('Ready', { timeout: T.long });
 await consent.getByRole('button', { name: /Don['’]t share/i }).click({ timeout: T.medium });
 await expect(consent).toHaveCount(0);
 await expect(row).toContainText('Ready');
 await row.getByRole('button', { name: 'Clear', exact: true }).click();
 await expect(row).toHaveCount(0);
});

// Real intake/create/attach/download APIs; no provider invocation and no intake route mock.
test('[P0] shell file drop survives reload and attaches stored bytes to a new project without another upload', async ({ page }, testInfo) => {
 test.setTimeout(T.xlong);
 await routeMockAgents(page); await routeAppConfig(page);
 await page.addInitScript(({ key }) => { if (window === window.top) localStorage.setItem(key, JSON.stringify({ mode: 'daemon', agentId: 'mock', onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } })); }, { key: STORAGE_KEY });
 const name = `opaque-${randomUUID()}.png`; const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 9, 0, 255]);
 const transfers: string[] = []; const runs: string[] = [];
 page.on('request', request => { const path = new URL(request.url()).pathname; if (request.method() === 'PUT' && /^\/api\/workbench\/intake\/.+\/files\//.test(path)) transfers.push(path); if (request.method() === 'POST' && (path === '/api/runs' || path === '/api/chat')) runs.push(path); });
 await page.goto('/'); await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.long });
 // Save and use one predecessor without clearing it. Reload must preserve its
 // receipt and bytes while excluding it from this journey's next Home handoff.
 const usedName = `already-used-${randomUUID()}.zip`; const usedBytes = Buffer.from('saved predecessor');
 const usedAccepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/intake' && response.request().method() === 'POST');
 await dropFile(page, usedName, usedBytes); const usedBatch = await (await usedAccepted).json();
 const usedRow = page.getByTestId('workbench-intake-tray').locator('li').filter({ hasText: usedName });
 await expect(usedRow).toContainText('Ready', { timeout: T.long });
 await openManualProject(page);
 // R01: a saved file only attaches into the new project+conversation once the
 // user explicitly clicks "Attach to this chat" (no more silent auto-carry).
 const usedAttachResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/workbench/intake/${usedBatch.intakeBatchId}/attach` && response.request().method() === 'POST');
 await usedRow.getByRole('button', { name: 'Attach to this chat', exact: true }).click();
 const usedAttach = await usedAttachResponse; expect(usedAttach.ok(), await usedAttach.text()).toBeTruthy();
 const usedStored = (await usedAttach.json()).attachments.find((file: { clientFileId: string }) => file.clientFileId === usedBatch.files[0].clientFileId); expect(usedStored).toBeTruthy();
 await expect(page.getByTestId('chat-composer').getByRole('button', { name: `Remove ${usedName}`, exact: true })).toBeVisible({ timeout: T.long });
 await page.goto('/'); await page.reload(); await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.long });
 await expect(usedRow).toContainText('Ready', { timeout: T.long }); expect(transfers).toHaveLength(1); expect(runs).toEqual([]);
 const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/intake' && response.request().method() === 'POST');
 const uploaded = page.waitForResponse(response => response.request().method() === 'PUT' && /^\/api\/workbench\/intake\/[^/]+\/files\/[^/]+$/.test(new URL(response.url()).pathname));
 await dropFile(page, name, bytes, 'image/png');
 const batchResponse = await accepted; expect(batchResponse.ok(), await batchResponse.text()).toBeTruthy();
 const batch = await batchResponse.json(); const fileId = batch.files[0].clientFileId;
 expect(batch.files[0].descriptor.declaredMime).toBe('image/png');
 const upload = await uploaded; expect(upload.ok(), await upload.text()).toBeTruthy();
 const outcome = (await upload.json()).file; expect(outcome.clientFileId).toBe(fileId);
 expect(outcome.stored.detectedMime).toBe('application/octet-stream'); expect(outcome.stored.kind).toBe('file');
 const tray = page.getByTestId('workbench-intake-tray'); const row = tray.locator('li').filter({ hasText: name });
 await expect(row).toContainText('Ready', { timeout: T.long }); expect(transfers).toHaveLength(2); expect(runs).toEqual([]);
 await expect(row).toContainText('Stored; contents cannot be read by this model.');
 const download = await page.request.get(await row.getByRole('link', { name: 'Download' }).getAttribute('href') ?? '');
 expect(download.ok()).toBeTruthy(); expect(createHash('sha256').update(await download.body()).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
 await page.reload(); await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.long }); await expect(row).toContainText('Ready', { timeout: T.long }); expect(transfers).toHaveLength(2);
 await openManualProject(page);
 // R01: attaching a saved file into the new project+conversation is an
 // explicit "Attach to this chat" click, not an automatic carry-over.
 const attachResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/workbench/intake/${batch.intakeBatchId}/attach` && response.request().method() === 'POST');
 await row.getByRole('button', { name: 'Attach to this chat', exact: true }).click();
 const attach = await attachResponse; expect(attach.ok(), await attach.text()).toBeTruthy(); const attached = await attach.json(); const stored = attached.attachments.find((file: { clientFileId: string }) => file.clientFileId === fileId); expect(stored).toBeTruthy();
 expect(attach.request().postDataJSON().clientFileIds).toEqual([fileId]);
 expect(transfers).toHaveLength(2); expect(runs).toEqual([]);
 const composer = page.getByTestId('chat-composer');
 await expect(composer.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible({ timeout: T.long });
 await expect(composer.locator('.msg-att-doc').filter({ has: page.getByRole('button', { name: `Remove ${name}`, exact: true }) })).toBeVisible();
 // AC-R01.3: the composer chip for stored opaque bytes carries the readability notice.
 await expect(composer.locator('.msg-att-doc').filter({ has: page.getByRole('button', { name: `Remove ${name}`, exact: true }) })).toContainText('Stored; contents cannot be read by this model.');
 await expect(composer.getByRole('button', { name: `Remove ${usedName}`, exact: true })).toHaveCount(0);
 const projectFiles = await page.request.get(`/api/projects/${stored.projectId}/files`); expect(projectFiles.ok()).toBeTruthy();
 const newNames = ((await projectFiles.json()) as { files: { name: string }[] }).files.map(file => file.name);
 expect(newNames).toContain(stored.relPath); expect(newNames.some(file => file.endsWith(usedName))).toBe(false);
 const savedReceipt = await page.request.get(`/api/workbench/intake/${usedBatch.intakeBatchId}`); expect(savedReceipt.ok()).toBeTruthy();
 expect((await savedReceipt.json()).files[0].hasSuccessfulAttachment).toBe(true);
 const savedBytes = await page.request.get(await usedRow.getByRole('link', { name: 'Download' }).getAttribute('href') ?? ''); expect(savedBytes.ok()).toBeTruthy();
 expect(createHash('sha256').update(await savedBytes.body()).digest('hex')).toBe(createHash('sha256').update(usedBytes).digest('hex'));
 // The markdown editor accepts image drops; a PDF must reach its enclosing
 // project intake instead of navigating the browser or disappearing.
 const markdownName = `native-drop-${randomUUID()}.md`;
 const markdownUpload = await page.request.post(`/api/projects/${stored.projectId}/upload`, { multipart: { files: { name: markdownName, mimeType: 'text/markdown', buffer: Buffer.from('# Native drop reference') } } });
 expect(markdownUpload.ok()).toBeTruthy();
 await page.reload(); await expect(composer).toBeVisible({ timeout: T.long }); await openAllProjectFiles(page);
 await page.getByTestId(`design-file-row-${markdownName}`).getByRole('button').first().click();
 await page.getByRole('tab', { name: 'Code', exact: true }).click();
 const markdownEditor = page.locator('textarea.markdown-editor'); await expect(markdownEditor).toBeVisible({ timeout: T.long });
 const nativeName = `native-reference-${randomUUID()}.pdf`; const locationBeforeNativeDrop = page.url();
 const nativeAccepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workbench/intake' && response.request().method() === 'POST');
 await markdownEditor.evaluate((node, name) => {
  const transfer = new DataTransfer(); transfer.items.add(new File(['%PDF-1.7 native reference'], name, { type: 'application/pdf' }));
  node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
 }, nativeName);
 const nativeBatch = await nativeAccepted; expect(nativeBatch.ok(), await nativeBatch.text()).toBeTruthy();
 expect((await nativeBatch.json()).destination).toMatchObject({ kind: 'project', projectId: stored.projectId, conversationId: stored.conversationId });
 await expect(tray.locator('li').filter({ hasText: nativeName })).toContainText('Ready', { timeout: T.long });
 await expect(composer.getByRole('button', { name: `Remove ${nativeName}`, exact: true })).toBeVisible({ timeout: T.long });
 expect(page.url()).toBe(locationBeforeNativeDrop); expect(transfers).toHaveLength(3); expect(runs).toEqual([]);
 // Explicit renderer mode does not manufacture native/Finder acceptance.
 const previewName = `retain-${randomUUID()}.html`;
 const previewUpload = await page.request.post(`/api/projects/${stored.projectId}/upload`, { multipart: { files: { name: previewName, mimeType: 'text/html', buffer: Buffer.from('<!doctype html><label>Name<input aria-label="Name" value="retained"></label><script>window.fixtureCounter=1</script>') } } });
 expect(previewUpload.ok()).toBeTruthy();
 await page.reload(); await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long }); await openAllProjectFiles(page);
 await page.getByTestId(`design-file-row-${previewName}`).getByRole('button').first().click();
 const frame = page.getByTestId('artifact-preview-frame');
 await expect(frame).toBeVisible({ timeout: T.long }); await expect(frame.contentFrame().getByRole('textbox', { name: 'Name' })).toHaveValue('retained');
 await frame.contentFrame().getByRole('textbox', { name: 'Name' }).fill('value survives');
 await frame.evaluate(node => { const host = window as unknown as { intakeFrame: Element; intakeWindow: Window | null; intakeLoads: number }; host.intakeFrame = node; host.intakeWindow = (node as HTMLIFrameElement).contentWindow; host.intakeLoads = 0; node.addEventListener('load', () => { host.intakeLoads++; }); });
 await page.getByTestId('workbench-drop-mode').click(); await expect(page.getByTestId('workbench-drop-overlay')).toBeVisible(); expect(await frame.evaluate(node => getComputedStyle(node).visibility)).toBe('hidden');
 await page.keyboard.press('Escape'); await expect(page.getByTestId('workbench-drop-overlay')).toHaveCount(0);
 expect(await frame.evaluate(node => { const host = window as unknown as { intakeFrame: Element; intakeWindow: Window | null; intakeLoads: number }; return node === host.intakeFrame && (node as HTMLIFrameElement).contentWindow === host.intakeWindow && host.intakeLoads === 0; })).toBe(true);
 await expect(frame.contentFrame().getByRole('textbox', { name: 'Name' })).toHaveValue('value survives');

 const screenshot = testInfo.outputPath('durable-file-tray.png'); await page.screenshot({ path: screenshot }); await testInfo.attach('durable-file-tray', { path: screenshot, contentType: 'image/png' });
 await row.getByRole('button', { name: 'Clear', exact: true }).click(); await expect(row).toHaveCount(0);
 const retained = await page.request.get(`/api/workbench/intake/${batch.intakeBatchId}/files/${fileId}/download`);
 // Clear unlinks the receipt tray only; project bytes remain independently materialized.
 const projectFile = await page.request.get(`/api/projects/${stored.projectId}/files/${encodeURIComponent(stored.relPath)}`);
 expect(projectFile.ok()).toBeTruthy(); expect(createHash('sha256').update(await projectFile.body()).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex')); expect(retained.status()).toBeGreaterThanOrEqual(400);
});

// J4-06: at 390px the tray's `position: fixed; bottom: 16px` card landed in
// the same band as the fixed chat composer, with no way to dismiss it. The
// close control hides the tray (never the files) and a media query keeps
// the tray clear of the composer at phone widths.
// Round 2: the top-anchor fix itself landed the close button UNDER the
// docked chrome header (elementFromPoint returned the header; a real
// Playwright click was intercepted). Check the English close control.
async function trayNeverOverlapsComposerOrHeader(page: Page, locale: 'en', closeLabel: string, withPet = false) {
 test.setTimeout(T.xlong);
 if (locale !== 'en') {
  await page.addInitScript((nextLocale) => {
   window.localStorage.setItem('mish:locale', nextLocale);
   window.localStorage.setItem('mish:locale-source', 'manual');
  }, locale);
 }
 await routeMockAgents(page); await routeAppConfig(page);
 await page.setViewportSize({ width: 390, height: 844 });
 // This file's own P0 predecessor ("shell file drop survives reload...")
 // deliberately leaves one saved file in the tray uncleared, to prove reload
 // preserves it. On the shared worker-scoped daemon (e2e/AGENTS.md: one
 // tools-dev runtime per worker) that leftover tray rehydrates on this
 // fresh Home load too, and at 390px it covers the "New project" button.
 // Its async hydrate fetch races `openManualProject`'s own navigation and
 // clicks — an upfront check-then-navigate here only moved the race (a
 // second `/projects` goto in front of `openManualProject`'s own left the
 // nav rail's hover-peek state stuck mid-transition instead). Race a
 // background closer against `openManualProject` itself rather than
 // sequencing around it: whichever path reaches the tray first closes it
 // (closing a tray that is not there is a no-op), and `openManualProject`'s
 // own actionability retries absorb the rest.
 const closeStrayTray = async () => {
  for (let attempt = 0; attempt < 25; attempt++) {
   const strayClose = page.getByTestId('workbench-intake-tray').getByRole('button', { name: /^close/iu });
   if (await strayClose.count()) { await strayClose.click().catch(() => undefined); return; }
   await page.waitForTimeout(200);
  }
 };
 await Promise.all([closeStrayTray(), openManualProject(page)]);
 if (withPet) {
  const pet = { adopted: true, enabled: true, petId: 'custom', custom: { name: 'Intake witness', glyph: '🐈', accent: '#353535', greeting: 'Synthetic companion' } };
  await page.addInitScript(({ key, pet }) => {
   if (window !== window.top) return;
   const config = JSON.parse(window.localStorage.getItem(key) ?? '{}');
   window.localStorage.setItem(key, JSON.stringify({ ...config, pet }));
   window.localStorage.setItem('mish:pet-position', JSON.stringify({ right: 24, bottom: 24 }));
  }, { key: STORAGE_KEY, pet });
  await page.route('**/api/app-config', async route => {
   if (route.request().method() !== 'GET') return route.continue();
   await route.fulfill({ json: { config: { onboardingCompleted: true, agentId: 'mock', skillId: null, designSystemId: null, agentModels: {}, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false }, pet } } });
  });
  await page.reload();
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long });
  await expect(page.locator('.pet-overlay--docked .pet-sprite')).toBeVisible();
 }
 const name = `tray-overlap-${randomUUID()}.zip`;
 await dropFile(page, name, Buffer.from('tray overlap check'));
 const tray = page.getByTestId('workbench-intake-tray');
 const row = tray.locator('li').filter({ hasText: name });
 await expect(row).toContainText('Ready', { timeout: T.long });
 const composer = page.getByTestId('chat-composer');
 // The docked chrome header is the OTHER fixed element at this width.
 const header = page.locator('header.app-chrome-header.workspace-tabs-chrome');
 const trayBox = await tray.boundingBox(); const composerBox = await composer.boundingBox(); const headerBox = await header.boundingBox();
 expect(trayBox).toBeTruthy(); expect(composerBox).toBeTruthy(); expect(headerBox).toBeTruthy();
 const overlapsVertically = (a: { y: number; height: number }, b: { y: number; height: number }) => a.y < b.y + b.height && a.y + a.height > b.y;
 expect(overlapsVertically(trayBox!, composerBox!), `tray ${JSON.stringify(trayBox)} vs composer ${JSON.stringify(composerBox)}`).toBe(false);
 expect(overlapsVertically(trayBox!, headerBox!), `tray ${JSON.stringify(trayBox)} vs header ${JSON.stringify(headerBox)}`).toBe(false);
 const closeButton = tray.getByRole('button', { name: closeLabel });
 if (withPet) {
  const spriteBox = await page.locator('.pet-overlay--docked .pet-sprite').boundingBox();
  const closeBox = await closeButton.boundingBox();
  expect(spriteBox).toBeTruthy(); expect(closeBox).toBeTruthy();
  const overlapsHorizontally = spriteBox!.x < closeBox!.x + closeBox!.width && spriteBox!.x + spriteBox!.width > closeBox!.x;
  expect(overlapsHorizontally && overlapsVertically(spriteBox!, closeBox!), `pet ${JSON.stringify(spriteBox)} must overlap close ${JSON.stringify(closeBox)} to exercise hit-testing`).toBe(true);
 }
 // The close button must be the element actually hit at its own center —
 // not merely positioned over empty space while the header's hit box wins.
 const hit = await closeButton.evaluate(node => {
  const rect = node.getBoundingClientRect();
  const atCenter = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return atCenter === node || node.contains(atCenter);
 });
 expect(hit, 'the close button must be the top-hit element, not covered by the docked header or pet').toBe(true);
 // The click itself must succeed with no interception (Playwright's own
 // actionability check fails loudly, naming the intercepting element, if it
 // is not).
 await closeButton.click();
 await expect(tray).toHaveCount(0);
 await expect(composer).toBeVisible();
 // Closing only hides the tray; dropping another file reopens it with the
 // earlier file's row still present (never cleared by closing).
 const secondName = `tray-reopen-${randomUUID()}.zip`;
 await dropFile(page, secondName, Buffer.from('reopened'));
 const reopened = page.getByTestId('workbench-intake-tray');
 const secondRow = reopened.locator('li').filter({ hasText: secondName });
 await expect(reopened.locator('li').filter({ hasText: name })).toBeVisible({ timeout: T.long });
 await expect(secondRow).toContainText('Ready', { timeout: T.long });
 // Both tests in this file share one tools-dev runtime per Playwright
 // worker (e2e/AGENTS.md "one tools-dev daemon/web/data root per worker"),
 // and the intake tray persists across a Home reload. Leaving these rows
 // behind let a later test's own Home setup intercept pointer events on the
 // "New project" button — clear both of THIS test's own rows so the next
 // test on this worker starts clean. Assert only that: a predecessor file
 // (this suite's own P0 case deliberately leaves one uncleared, to prove
 // reload preserves it) may legitimately still be in the tray, so asserting
 // the whole tray is gone would make this test order-dependent on siblings
 // it does not own.
 const clearLabel = 'Clear';
 const firstRow = reopened.locator('li').filter({ hasText: name });
 await firstRow.getByRole('button', { name: clearLabel, exact: true }).click();
 await secondRow.getByRole('button', { name: clearLabel, exact: true }).click();
 await expect(firstRow).toHaveCount(0);
 await expect(secondRow).toHaveCount(0);
}

test('[P2] intake tray never overlaps the composer or the docked header at 390px, and its close control hides it without discarding files', async ({ page }) => {
 await trayNeverOverlapsComposerOrHeader(page, 'en', 'Close files tray');
});

test('[P2] intake tray close stays actionable with an overlapping docked pet at 390px and retains saved files', async ({ page }) => {
 await trayNeverOverlapsComposerOrHeader(page, 'en', 'Close files tray', true);
});

// AC-R01.3: a real browser never runs a dropped HTML/SVG script by navigating to
// its raw or download bytes. The positive control proves the probe would see it.
test('[P0] dropped HTML and SVG scripts never execute through raw or download navigation', async ({ page }) => {
 test.setTimeout(T.xlong);
 await routeMockAgents(page); await routeAppConfig(page);
 await page.addInitScript(({ key }) => { if (window === window.top) localStorage.setItem(key, JSON.stringify({ mode: 'daemon', agentId: 'mock', onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } })); }, { key: STORAGE_KEY });
 const marker = `/__intake-script-ran-${randomUUID()}`; const ran: string[] = [];
 await page.route(`**${marker}**`, route => { ran.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 204 }); });
 const probe = `fetch(${JSON.stringify(marker)} + '?' + document.contentType)`;
 const payloads = [
  { name: `inert page ${randomUUID()}.html`, mime: 'text/html', body: `<!doctype html><html><body><script>${probe}</script></body></html>` },
  { name: `inert logo é ${randomUUID()}.svg`, mime: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg"><script>${probe}</script><rect width="1" height="1"/></svg>` },
 ];
 await page.goto('/'); await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.long });
 const origin = new URL(page.url()).origin;
 // Positive control: the same script runs when the page itself hosts it.
 await page.evaluate(source => { const script = document.createElement('script'); script.textContent = source; document.body.append(script); }, probe);
 await expect.poll(() => ran.length, { timeout: T.medium }).toBe(1); ran.length = 0;
 for (const payload of payloads) {
  const uploaded = page.waitForResponse(response => response.request().method() === 'PUT' && /^\/api\/workbench\/intake\/[^/]+\/files\/[^/]+$/.test(new URL(response.url()).pathname));
  await dropFile(page, payload.name, Buffer.from(payload.body), payload.mime);
  const upload = await uploaded; expect(upload.ok(), await upload.text()).toBeTruthy();
  const outcome = (await upload.json()).file; const downloadPath = new URL(upload.url()).pathname + '/download';
  const rawPath = `/api/library/assets/${outcome.stored.assetId}/raw`;
  const raw = await page.request.get(rawPath); expect(raw.headers()['x-content-type-options']).toBe('nosniff'); expect(raw.headers()['content-security-policy']).toBe('sandbox');
  const download = await page.request.get(downloadPath);
  expect(download.headers()['content-disposition']).toMatch(/^attachment;/); expect(download.headers()['x-content-type-options']).toBe('nosniff'); expect(download.headers()['content-security-policy']).toBe('sandbox');
  const viewer = await page.context().newPage();
  try {
   await viewer.route(`**${marker}**`, route => { ran.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 204 }); });
   await viewer.goto(origin + rawPath, { waitUntil: 'load' });
   const saved = viewer.waitForEvent('download', { timeout: T.medium });
   await viewer.goto(origin + downloadPath).catch(() => undefined);
   await (await saved).cancel();
   await viewer.waitForTimeout(500);
  } finally { await viewer.close(); }
  expect(ran, payload.name).toEqual([]);
 }
});
