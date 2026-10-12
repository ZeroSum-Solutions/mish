import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { openNewProjectModal } from '@/playwright/rail';
import type { Page } from '@playwright/test';
import { T } from '@/timeouts';

test.describe.configure({ timeout: T.xlong });

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
});

async function openBlankProject(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByText('Loading Mishh Mashh…').waitFor({ state: 'hidden', timeout: T.long });
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Mishh Mashh' });
  if (await privacyDialog.isVisible()) {
    await privacyDialog.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
  }
  await openNewProjectModal(page);
  await page.getByTestId('new-project-tab-prototype').click();
  await page.getByTestId('new-project-name').fill('Composer clearance regression');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('chat-composer')).toBeVisible();
}

async function composerGeometry(page: Page) {
  return page.evaluate(() => {
    const log = document.querySelector<HTMLElement>('.chat-log');
    const slot = document.querySelector<HTMLElement>('.chat-composer-slot');
    const layer = document.querySelector<HTMLElement>('.chat-composer-fixed-layer');
    const pane = slot?.closest<HTMLElement>('.pane');
    if (!log || !slot || !layer || !pane) throw new Error('Composer geometry nodes are missing');
    const logRect = log.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    return {
      logBottom: logRect.bottom,
      layerTop: layerRect.top,
      slotHeight: slotRect.height,
      layerHeight: layerRect.height,
      paneWidth: pane.getBoundingClientRect().width,
    };
  });
}

function expectCeiledSlotMatchesLayer(geometry: Awaited<ReturnType<typeof composerGeometry>>): void {
  expect(geometry.slotHeight).toBeGreaterThanOrEqual(geometry.layerHeight);
  expect(geometry.slotHeight - geometry.layerHeight).toBeLessThan(1);
}

async function setPaneWidth(page: Page, paneWidth: number): Promise<void> {
  // The first project grid track includes the pane's 8px left gutter.
  await page.locator('.split').evaluate((split, width) => {
    (split as HTMLElement).style.setProperty('--project-chat-panel-width', `${width + 8}px`);
  }, paneWidth);
  await expect.poll(async () => (await composerGeometry(page)).paneWidth).toBeCloseTo(paneWidth, 0);
}

test('[P1] portaled composer reserves transcript clearance while growing and resizing', async ({ page }) => {
  // The suite fixture boots an isolated tools-dev namespace and OD_DATA_DIR;
  // the full workspace route is intentional because it owns the body portal.
  await page.setViewportSize({ width: 900, height: 760 });
  await openBlankProject(page);

  let compactLayerHeight = 0;
  for (const paneWidth of [344, 320]) {
    await setPaneWidth(page, paneWidth);
    await expect.poll(() => composerGeometry(page)).toMatchObject({
      slotHeight: expect.any(Number),
      layerHeight: expect.any(Number),
    });
    const settled = await composerGeometry(page);
    expect(settled.paneWidth).toBeCloseTo(paneWidth, 0);
    expect(settled.logBottom).toBeLessThanOrEqual(settled.layerTop + 0.5);
    expectCeiledSlotMatchesLayer(settled);
    expect(settled.slotHeight).toBeGreaterThan(0);
    compactLayerHeight = settled.layerHeight;
  }

  await page.getByTestId('chat-composer-input').fill(
    'First line\nSecond line that grows the composer\nThird line keeps the transcript clear',
  );

  await expect.poll(async () => (await composerGeometry(page)).layerHeight).toBeGreaterThan(compactLayerHeight);
  const grown = await composerGeometry(page);
  expect(grown.logBottom).toBeLessThanOrEqual(grown.layerTop + 0.5);
  expectCeiledSlotMatchesLayer(grown);

  await setPaneWidth(page, 344);
  await expect.poll(async () => {
    const resized = await composerGeometry(page);
    return Math.abs(resized.paneWidth - 344) < 0.5
      && resized.logBottom <= resized.layerTop + 0.5
      && resized.slotHeight >= resized.layerHeight
      && resized.slotHeight - resized.layerHeight < 1;
  }).toBe(true);
});
