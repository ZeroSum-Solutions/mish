import { expect, test } from '@/playwright/suite';
import { ensureRailOpen } from '@/playwright/rail';
import { configureVisualPage } from '@/playwright/visual';
import type { Locator, Page } from '@playwright/test';
import { T } from '@/timeouts';

const SENTINEL = '--od-design-kit-styles-ready';

test.describe.configure({ timeout: T.xlong });

async function installDelayedSentinelFixture(page: Page): Promise<void> {
  await page.addInitScript((sentinel) => {
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    let released = false;
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      const declaration = nativeGetComputedStyle(element, pseudo);
      if (released || !(element instanceof HTMLElement) || !element.dataset.testid?.startsWith('design-kit-view')) {
        return declaration;
      }
      return new Proxy(declaration, {
        get(target, property) {
          if (property === 'getPropertyValue') {
            return (name: string) => (name === sentinel ? '0' : target.getPropertyValue(name));
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof window.getComputedStyle;
    (window as unknown as { __odReleaseDesignKitStyles: () => void }).__odReleaseDesignKitStyles = () => {
      released = true;
    };
  }, SENTINEL);
}

async function openAgenticDetail(page: Page): Promise<Locator> {
  await page.getByText('Loading Mishh Mashh…').waitFor({ state: 'hidden', timeout: T.long });
  await page.getByRole('tab', { name: 'Official presets' }).click();
  await page.getByTestId('design-system-card-agentic').click();
  return page.getByTestId('design-kit-view-agentic');
}

async function expectHeldBehindLoading(detail: Locator): Promise<void> {
  await expect(detail).toHaveAttribute('data-style-ready', 'false');
  await expect(detail).toHaveCSS('visibility', 'hidden');
  await expect(detail).toHaveCSS('width', '1px');
  await expect(detail).toHaveCSS('height', '1px');
  await expect(detail.getByRole('figure', { name: 'System specimen' })).toBeHidden();
  await expect(detail.locator('xpath=following-sibling::*[@role="status"]')).toBeVisible();
}

async function releaseAndExpectStyled(page: Page, detail: Locator): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __odReleaseDesignKitStyles: () => void }).__odReleaseDesignKitStyles();
  });
  await expect(detail).toHaveAttribute('data-style-ready', 'true', { timeout: T.medium });
  await expect(detail).toHaveCSS('visibility', 'visible');
  await expect(detail.getByRole('figure', { name: 'System specimen' })).toBeVisible();
  const settled = await detail.evaluate((root, sentinel) => {
    const style = getComputedStyle(root);
    return {
      sentinel: style.getPropertyValue(sentinel).trim(),
      display: style.display,
      rowGap: style.rowGap,
      fontFamily: style.fontFamily,
    };
  }, SENTINEL);
  // The full system guide uses the gallery's 32px section rhythm.
  expect(settled).toMatchObject({ sentinel: '1', display: 'flex', rowGap: '32px' });
  expect(settled.fontFamily).toMatch(/Inter|system-ui|sans-serif/i);
}

test('[P1] design kit never paints raw detail across cold load, client navigation, and reload', async ({ page }) => {
  // The visual fixture supplies deterministic official systems. The sentinel
  // override models a route CSS chunk that has not become effective yet while
  // leaving the rest of the application styled and interactive.
  await configureVisualPage(page);
  await installDelayedSentinelFixture(page);

  await page.goto('/design-systems', { waitUntil: 'domcontentloaded' });
  let detail = await openAgenticDetail(page);
  await expectHeldBehindLoading(detail);
  await releaseAndExpectStyled(page, detail);

  await ensureRailOpen(page);
  await page.getByTestId('entry-nav-home').click();
  await expect(page).toHaveURL(/\/$/);
  await ensureRailOpen(page);
  await page.getByTestId('entry-nav-design-systems').click();
  await expect(page).toHaveURL(/\/design-systems$/);
  detail = await openAgenticDetail(page);
  await releaseAndExpectStyled(page, detail);

  await page.reload({ waitUntil: 'domcontentloaded' });
  detail = await openAgenticDetail(page);
  await expectHeldBehindLoading(detail);
  await releaseAndExpectStyled(page, detail);
});
