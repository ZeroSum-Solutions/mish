import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  clickDeckNextSlide,
  clickDeckPreviousSlide,
  clickPreviewToolbarAction,
} from '@/playwright/workspace';

const LOSING_ROUTE_TIMEOUT = 150;

describe('preview toolbar actions', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  test('uses More when the inline action moves after route observation', async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(LOSING_ROUTE_TIMEOUT);

    try {
      await page.setContent(toolbarFixture);
      await installToolbarBehavior(page);

      await clickPreviewToolbarAction(
        moveInlineActionAfterObservation(page, 'board-mode-toggle'),
        'board-mode-toggle',
        /^Comment$/,
      );

      await expect(page.locator('body').getAttribute('data-clicks')).resolves.toBe(
        'more,overflow',
      );
    } finally {
      await page.close();
    }
  });

  test('deck navigation targets only the active retained viewer', async () => {
    const page = await browser.newPage();

    try {
      await page.setContent(deckNavigationFixture);
      const visibleNextButtons = page.locator('button[aria-label="Next slide"]:visible');
      const visiblePreviousButtons = page.locator('button[aria-label="Previous slide"]:visible');
      await expect(visibleNextButtons.count()).resolves.toBe(2);
      await expect(visiblePreviousButtons.count()).resolves.toBe(2);

      await clickDeckNextSlide(page);
      await clickDeckPreviousSlide(page);

      await expect(page.locator('body').getAttribute('data-clicks')).resolves.toBe(
        'active-next,active-previous',
      );
    } finally {
      await page.close();
    }
  });
});

async function installToolbarBehavior(page: Page): Promise<void> {
  await page.locator('.viewer-toolbar-more > button').evaluate((button) => {
    button.addEventListener('click', () => {
      const menu = document.querySelector<HTMLElement>('.viewer-toolbar-more-menu');
      if (menu) menu.hidden = false;
      const clicks = document.body.dataset.clicks;
      document.body.dataset.clicks = clicks ? `${clicks},more` : 'more';
    });
  });
  await page.locator('[role="menuitem"]').evaluate((button) => {
    button.addEventListener('click', () => {
      const clicks = document.body.dataset.clicks;
      document.body.dataset.clicks = clicks ? `${clicks},overflow` : 'overflow';
    });
  });
  await page.getByTestId('board-mode-toggle').evaluate((button) => {
    button.addEventListener('click', () => {
      const clicks = document.body.dataset.clicks;
      document.body.dataset.clicks = clicks ? `${clicks},inline` : 'inline';
    });
  });
}

function moveInlineActionAfterObservation(page: Page, inlineTestId: string): Page {
  const inlineSelector = `[data-testid="${inlineTestId}"]:visible`;
  let didMoveAction = false;

  const wrapInlineAction = (locator: Locator): Locator => {
    const wrapped = new Proxy(locator, {
      get(target, property) {
        if (property === 'first') return () => wrapInlineAction(target.first());
        if (property === 'isVisible') {
          return async () => {
            const isVisible = await target.isVisible();
            if (isVisible && !didMoveAction) {
              didMoveAction = true;
              await page.evaluate(() => {
                const inlineActions = document.querySelector<HTMLElement>(
                  '.viewer-toolbar-inline-actions',
                );
                const more = document.querySelector<HTMLElement>('.viewer-toolbar-more');
                if (inlineActions) inlineActions.hidden = true;
                if (more) more.hidden = false;
              });
            }
            return isVisible;
          };
        }
        if (property === 'click') {
          return (options?: Parameters<Locator['click']>[0]) =>
            target.click({ ...options, timeout: LOSING_ROUTE_TIMEOUT });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return wrapped;
  };

  const wrapWorkspace = (locator: Locator): Locator => {
    const wrapped = new Proxy(locator, {
      get(target, property) {
        if (property === 'first') return () => wrapWorkspace(target.first());
        if (property === 'locator') {
          return (selector: string) => {
            const nested = target.locator(selector);
            return selector === inlineSelector ? wrapInlineAction(nested) : nested;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return wrapped;
  };

  return new Proxy(page, {
    get(target, property) {
      if (property === 'locator') {
        return (selector: string) => {
          const locator = target.locator(selector);
          return selector === '[data-testid="file-workspace"]:visible'
            ? wrapWorkspace(locator)
            : locator;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const toolbarFixture = `<!doctype html>
<html>
  <body data-clicks="">
    <main data-testid="file-workspace">
      <div class="viewer-toolbar">
        <div class="viewer-toolbar-inline-actions">
          <button data-testid="board-mode-toggle" type="button">Comment</button>
        </div>
        <div class="viewer-toolbar-more" hidden>
          <button type="button">More</button>
          <div class="viewer-toolbar-more-menu" role="menu" hidden>
            <button role="menuitem" type="button">Comment</button>
          </div>
        </div>
      </div>
    </main>
  </body>
</html>`;

const deckNavigationFixture = `<!doctype html>
<html>
  <body data-clicks="">
    <section data-testid="retained-file-viewer" aria-hidden="true" style="display:flex;opacity:0;pointer-events:none">
      <button type="button" aria-label="Previous slide" onclick="document.body.dataset.clicks += 'inactive-previous'">Previous</button>
      <button type="button" aria-label="Next slide" onclick="document.body.dataset.clicks += 'inactive-next'">Next</button>
    </section>
    <section data-testid="retained-file-viewer" style="display:flex">
      <button type="button" aria-label="Previous slide" onclick="document.body.dataset.clicks += (document.body.dataset.clicks ? ',' : '') + 'active-previous'">Previous</button>
      <button type="button" aria-label="Next slide" onclick="document.body.dataset.clicks += (document.body.dataset.clicks ? ',' : '') + 'active-next'">Next</button>
    </section>
  </body>
</html>`;
