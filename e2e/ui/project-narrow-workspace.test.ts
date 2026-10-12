import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

test('[P1] project workspace gives preview full width on phone and keeps the desktop split', async ({ page }) => {
  await applyStandardMocks(page);
  const projectId = `narrow-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const project = await page.request.post('/api/projects', {
    data: {
      id: projectId,
      name: 'Narrow workspace QA',
      skillId: null,
      designSystemId: null,
      metadata: { kind: 'prototype' },
    },
  });
  expect(project.ok(), `create project: ${await project.text()}`).toBeTruthy();
  const file = await page.request.post(`/api/projects/${projectId}/files`, {
    data: {
      name: 'index.html',
      content: '<!doctype html><html><body><h1>Phone preview</h1></body></html>',
      artifactManifest: {
        version: 1,
        kind: 'html',
        title: 'Phone preview',
        entry: 'index.html',
        renderer: 'html',
        exports: ['html'],
      },
    },
  });
  expect(file.ok(), `seed preview: ${await file.text()}`).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${projectId}/files/index.html`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('file-workspace')).toBeAttached({ timeout: T.medium });

  const switcher = page.getByRole('radiogroup', { name: 'Workspace view' });
  const chat = switcher.getByRole('radio', { name: 'Chat' });
  const preview = switcher.getByRole('radio', { name: 'Preview / Files' });
  await expect(switcher).toBeVisible();
  await expect(chat).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('file-workspace')).toBeHidden();

  await chat.press('ArrowRight');
  await expect(preview).toBeFocused();
  await expect(preview).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await expect.poll(async () => (await page.getByTestId('file-workspace').boundingBox())?.width ?? 0).toBeGreaterThan(320);
  await expect(page.getByRole('tab', { name: /index\.html/i })).toBeVisible();
  await expect(page.locator('.split-chat-slot')).toBeHidden();

  await preview.press('ArrowLeft');
  await expect(chat).toBeFocused();
  await expect(page.getByTestId('chat-composer')).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(switcher).toBeHidden();
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await expect(page.locator('.split-chat-slot')).toBeVisible();
  await expect.poll(async () => (await page.getByTestId('file-workspace').boundingBox())?.width ?? 0).toBeGreaterThan(400);
  await expect.poll(async () => (await page.locator('.split-chat-slot').boundingBox())?.width ?? 0).toBeGreaterThan(300);

  const catalogTitle = '3D cards Slider with a long descriptive heading';
  const catalogAuthor = 'a-very-long-author-name-that-must-stay-within-the-card-at-phone-width';
  await page.route('**/api/cult/21st', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ catalog: { profile: 'https://21st.dev/@someone', items: [{
      id: '21st:phone-card', slug: 'phone-card', name: catalogTitle, author: catalogAuthor,
      authorProfileUrl: 'https://21st.dev/@someone', itemUrl: 'https://21st.dev/@someone/components/phone-card',
      rights: 'reference-only', licenseLabel: null, licenseUrl: null, licenseNotice: null,
      copyable: false, preview: { kind: 'none' },
    }] } }),
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/catalog', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('catalog-segment-21st').click();
  const catalogCard = page.getByTestId('catalog-21st-card-21st:phone-card');
  await expect(catalogCard).toBeVisible({ timeout: T.medium });
  const cardBounds = await catalogCard.boundingBox();
  for (const text of [catalogTitle, `Author: ${catalogAuthor}`]) {
    const line = catalogCard.getByText(text, { exact: true });
    await expect(line).toHaveCSS('text-overflow', 'ellipsis');
    const lineBounds = await line.boundingBox();
    expect(lineBounds?.x ?? -Infinity).toBeGreaterThanOrEqual((cardBounds?.x ?? 0) - 1);
    expect((lineBounds?.x ?? Infinity) + (lineBounds?.width ?? Infinity)).toBeLessThanOrEqual((cardBounds?.x ?? 0) + (cardBounds?.width ?? 0) + 1);
  }
});
