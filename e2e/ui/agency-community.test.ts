/** Portable community artifact interactions: no provider, backend or email is contacted. */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { clusterTest as test, expect } from '@/playwright/suite';
import { renderCommunity, validateCommunityRecipe } from '../../plugins/_official/examples/agency-community/compiler/scripts/families/community/render.ts';

const fixture = JSON.parse(readFileSync(new URL('../../plugins/_official/examples/agency-community/compiler/scripts/families/community/reference.fixture.json', import.meta.url), 'utf8'));
const recipient = 'makers#studio?enquiry%&team+join@example.com';
const encodedRecipient = 'mailto:makers%23studio%3Fenquiry%25%26team%2Bjoin@example.com';

async function openArtifact(page: Page, email = recipient) {
  const recipe = structuredClone(fixture);
  recipe.sections[8].text.email = email;
  const html = renderCommunity(validateCommunityRecipe(recipe), {});
  await page.route('http://community.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://community.test/');
}

for (const width of [390, 1280]) {
  test(`[P1] Community ${width}px tier selection focuses details and preserves an encoded email draft`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openArtifact(page);
    const tier = page.locator('[data-community-tier="Full Bench"]');
    await tier.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#community-name')).toBeFocused();
    await expect(page.locator('#community-tier')).toHaveValue('Full Bench');
    await page.locator('#community-name').fill('Taylor Example');
    await page.locator('#community-email').fill('taylor@example.com');
    await page.locator('#community-message').fill('Ceramics & print work.\nTwo days a week.');
    await page.getByRole('button', { name: 'Review application' }).click();
    await expect(page.locator('[data-community-review] h3')).toBeFocused();
    const href = await page.locator('[data-community-draft]').getAttribute('href');
    expect(href).toMatch(new RegExp(`^${encodedRecipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?subject=`));
    const url = new URL(href!);
    expect(decodeURIComponent(url.pathname)).toBe(recipient);
    expect(url.hash).toBe('');
    expect(url.searchParams.get('body')).toContain('Ceramics & print work.\nTwo days a week.');
    await page.locator('[data-community-edit]').click();
    await expect(page.locator('#community-name')).toHaveValue('Taylor Example');
    await expect(page.locator('#community-message')).toHaveValue('Ceramics & print work.\nTwo days a week.');
    await page.getByRole('button', { name: 'Review application' }).click();
    await page.getByRole('button', { name: 'Copy details manually' }).click();
    await expect(page.locator('#community-copy')).toBeFocused();
    expect(await page.locator('#community-copy').inputValue()).toContain(`To: ${recipient}\nSubject:`);
    expect(await page.locator('#community-copy').evaluate(node => (node as HTMLTextAreaElement).selectionEnd)).toBeGreaterThan(0);
    await expect(page.locator('[data-community-status]')).toContainText('Nothing has been sent');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(errors).toEqual([]);
  });
}

test('[P1] Community long Unicode application uses the complete manual email fallback', async ({ page }) => {
  await openArtifact(page);
  await page.locator('[data-community-start]').click();
  await page.locator('#community-name').fill('Taylor Example');
  await page.locator('#community-email').fill('taylor@example.com');
  const message = '陶芸の共同制作 '.repeat(200);
  expect(message.length).toBeLessThanOrEqual(2000);
  await page.locator('#community-message').fill(message);
  await page.getByRole('button', { name: 'Review application' }).click();
  await expect(page.locator('[data-community-draft]')).toBeHidden();
  expect(await page.locator('[data-community-draft]').getAttribute('href')).toBe(encodedRecipient);
  await expect(page.locator('#community-copy')).toBeVisible();
  expect(await page.locator('#community-copy').inputValue()).toContain(message);
  await expect(page.locator('[data-community-status]')).toContainText('too long for a reliable email link');
  await expect(page.locator('[data-community-status]')).toContainText('Nothing has been sent');
  await page.locator('[data-community-edit]').click();
  await expect(page.locator('#community-message')).toHaveValue(message);
});

test('[P1] Community without JavaScript keeps encoded native email and FAQ controls', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await openArtifact(page);
    await expect(page.locator('[data-community-start]')).toHaveAttribute('href', encodedRecipient);
    await expect(page.locator('[data-community-application]')).toBeHidden();
    await page.getByText('Do I need my own tools?', { exact: true }).click();
    await expect(page.getByText('No. Shared hand tools and machines are included; bring your own only if you prefer.')).toBeVisible();
  } finally { await context.close(); }
});
