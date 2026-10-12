import { randomUUID } from 'node:crypto';
import { expect, test } from '@/playwright/suite';
import { applyStandardMocks, routeAgents } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

// The viewport stays wide while the composer itself changes width. This is
// the browser witness for container queries; jsdom cannot evaluate them.
test('[P1] composer toolbar adapts to its container in both themes', async ({ page }, testInfo) => {
  test.setTimeout(T.xlong);
  await applyStandardMocks(page);
  await routeAgents(page, [{ id: 'mock', name: 'Claude', bin: 'mock-agent', available: true, version: 'test', models: [{ id: 'sonnet', label: 'Claude Sonnet 5.5 with extended thinking' }] }]);
  await page.addInitScript(() => { const config = JSON.parse(localStorage.getItem('open-design:config')!); config.agentModels = { mock: { model: 'sonnet', reasoning: 'default' } }; localStorage.setItem('open-design:config', JSON.stringify(config)); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const created = await page.request.post('/api/projects', { data: { id: randomUUID(), name: 'Responsive composer', skillId: null, designSystemId: null, metadata: { kind: 'prototype', nameSource: 'user' } } });
  expect(created.ok()).toBeTruthy();
  const { project, conversationId } = await created.json();
  await page.goto(`/projects/${project.id}/conversations/${conversationId}`);
  const composer = page.getByTestId('chat-composer');
  await expect(composer).toBeVisible({ timeout: T.long });
  const editor = composer.locator('[contenteditable="true"]');
  await editor.fill('Build a bakery website with a clear menu.');
  const improve = composer.getByTestId('improve-prompt-button');
  await expect(improve).toBeEnabled();
  const chip = composer.getByTestId('inline-model-switcher-chip');
  await expect(chip).toHaveAttribute('data-tooltip', /Model for the next turn:.*Claude Sonnet 5.5 with extended thinking/);
  const boxInset = await composer.evaluate(element => element.getBoundingClientRect().width - element.clientWidth + parseFloat(getComputedStyle(element).paddingLeft) + parseFloat(getComputedStyle(element).paddingRight));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.classList.toggle('dark', value === 'dark'); }, theme);
    for (const width of [320, 359, 360, 400, 520, 720]) {
      await composer.evaluate((element, value) => {
        element.style.width = `${value}px`;
        element.style.maxWidth = 'none';
        const layer = element.closest<HTMLElement>('.chat-composer-fixed-layer');
        if (layer) { layer.style.width = `${value}px`; layer.style.maxWidth = 'none'; layer.style.left = '40px'; layer.style.right = 'auto'; }
      }, width + boxInset);
      await expect.poll(() => composer.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(width + boxInset);
      const containerWidth = await composer.evaluate(element => element.clientWidth - parseFloat(getComputedStyle(element).paddingLeft) - parseFloat(getComputedStyle(element).paddingRight));
      const label = improve.locator('span').last();
      if (containerWidth < 520) {
        await expect(label).toBeHidden();
        await expect(chip.locator('.inline-switcher__chip-model-name')).toBeHidden();
      } else {
        await expect(label).toBeVisible();
        await expect(chip.locator('.inline-switcher__chip-model-name')).toBeVisible();
      }
      await expect(improve).toHaveAccessibleName('Improve prompt');
      await expect(improve).toHaveAttribute('data-tooltip', 'Improve prompt');
      const palette = composer.getByTestId('composer-design-system-trigger');
      if (containerWidth < 360) await expect(palette).toBeHidden();
      else await expect(palette).toBeVisible();
      const overflow = composer.getByTestId('chat-plus-trigger');
      await overflow.click();
      const menuPalette = page.getByTestId('composer-plus-design-system');
      if (containerWidth < 360) await expect(menuPalette).toBeVisible();
      else await expect(menuPalette).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(overflow).toBeFocused();
      const geometry = await composer.evaluate(element => {
        const row = element.querySelector('[data-testid="composer-toolbar"]')!;
        const send = element.querySelector('[data-testid="chat-send"]')!.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        const controls = [...row.querySelectorAll('button')].filter(button => button.getClientRects().length > 0 && getComputedStyle(button).visibility !== 'hidden').map(button => ({ name: button.getAttribute('aria-label'), rect: button.getBoundingClientRect().toJSON() }));
        return { send: send.toJSON(), bounds: bounds.toJSON(), controls, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth };
      });
      expect(geometry.send.width).toBe(32);
      expect(geometry.send.height).toBe(32);
      expect(geometry.send.right).toBeLessThanOrEqual(geometry.bounds.right + 1);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      for (const control of geometry.controls) {
        expect(control.rect.width, control.name ?? '').toBeGreaterThanOrEqual(28);
        expect(Math.abs(control.rect.y + control.rect.height / 2 - geometry.send.y - 16), control.name ?? '').toBeLessThanOrEqual(1);
      }
      await composer.screenshot({ path: testInfo.outputPath(`composer-${width}-${theme}.png`) });
    }
  }
  // The narrow overflow keeps both actions reachable with a keyboard and
  // returns focus when the nested picker closes.
  await composer.evaluate(element => { element.style.width = '320px'; });
  const overflow = composer.getByTestId('chat-plus-trigger');
  await overflow.focus();
  expect(await overflow.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
  expect(await overflow.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(2);
  await overflow.press('ArrowDown');
  await expect(page.getByTestId('composer-plus-attach')).toBeFocused();
  // Keep the menu open while crossing the breakpoint in both directions.
  await expect(page.getByTestId('composer-plus-design-system')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('composer-plus-design-system')).toBeFocused();
  await composer.evaluate(element => { element.style.width = '400px'; });
  await expect(page.getByTestId('composer-plus-design-system')).toBeHidden();
  await expect(page.getByTestId('composer-plus-attach')).toBeFocused();
  await composer.evaluate(element => { element.style.width = '320px'; });
  await expect(page.getByTestId('composer-plus-design-system')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('composer-plus-design-system')).toBeFocused();
  const items = page.getByRole('menu').getByRole('menuitem');
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('composer-plus-attach')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(overflow).toBeFocused();
  await overflow.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('composer-plus-design-system')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.project-ds-picker-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overflow).toBeFocused();
  await overflow.press('Enter');
  await expect(page.getByTestId('composer-plus-attach')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overflow).toBeFocused();
  await improve.hover();
  await page.mouse.down();
  await expect.poll(() => improve.evaluate(element => getComputedStyle(element).transform)).toMatch(/matrix\(0\.92/);
  await page.mouse.up();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(overflow).toBeVisible();
  await expect(improve).toBeEnabled();
});
