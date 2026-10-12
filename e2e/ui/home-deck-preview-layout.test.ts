import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { clusterTest as test, expect } from '@/playwright/suite';
import { homeDeckPreviewFixture } from '../resources/home-deck-preview.ts';

// Browser layout only: clusterTest omits the unused daemon/web fixture. These
// assertions consume real CSS, rather than mandating a particular width/height
// declaration. Stored-record routing remains with Home's application tests.
for (const viewportWidth of [1280, 800, 500]) {
  test(`[P0] Home deck poster and authored slide cover their frame at ${viewportWidth}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewportWidth, height: 600 });
    await page.setContent(homeDeckPreviewFixture());
    await page.locator('img').evaluateAll((images) => Promise.all(images.map((img) => (img as HTMLImageElement).decode())));
    // Supply the measured scale contract from useDeckPreviewScale; its actual
    // cover calculation is tested in the owning web suite.
    const height = viewportWidth > 900 ? 149 : viewportWidth > 560 ? 135 : 125;
    const width = viewportWidth > 900 ? 246 : viewportWidth > 560 ? 222 : 206;
    await page.locator('[data-kind="html"] .media').evaluate((frame, scale) => {
      (frame as HTMLElement).style.setProperty('--deck-preview-scale', String(scale));
    }, height / 720);
    const geometry = await readGeometry(page);
    for (const kind of ['media', 'html'] as const) {
      const { frame, content } = geometry[kind];
      expect(frame.width).toBe(width);
      expect(frame.height).toBe(height);
      expect(content.width).toBeGreaterThanOrEqual(frame.width - 0.1);
      expect(content.height).toBeGreaterThanOrEqual(frame.height - 0.1);
      expect(content.width / content.height).toBeCloseTo(16 / 9, 2);
      expect(content.x + content.width / 2).toBeCloseTo(frame.x + frame.width / 2, 1);
      expect(content.y + content.height / 2).toBeCloseTo(frame.y + frame.height / 2, 1);
    }
    expect(geometry.html.logicalViewport).toEqual({ width: 1280, height: 720 });
    expect(geometry.media.imageFit).toBe('cover');
    expect(geometry.media.videoFit).toBe('cover');
    expect(geometry.media.imagePosition).toBe('50% 50%');
    expect(geometry.media.videoPosition).toBe('50% 50%');
    expect(geometry.media.image).toEqual(geometry.media.content);
    expect(geometry.media.video).toEqual(geometry.media.content);
    // Sample actual painted pixels just inside the top/bottom and left/right
    // edges: every point must show the slide, never the baked black letterbox
    // or the frame's dark background. Corners belong to the card's radius.
    await expectSlideAtEdges(page, '[data-kind="media"] .media');
    await expectSlideAtEdges(page, '[data-kind="html"] .media');
    for (const kind of ['media', 'html'] as const) {
      await page.locator(`[data-kind="${kind}"]`).hover();
      await settleHover(page);
      expect(await readGeometry(page)).toEqual(geometry);
    }
  });

  test(`[P0] recvpYDfW12NBu Home website posters fill the frame and retain top detail at ${viewportWidth}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewportWidth, height: 600 });
    await page.setContent(homeDeckPreviewFixture());
    const card = page.locator('[data-kind="website"]');
    const image = card.locator('img');
    await image.evaluate((img: HTMLImageElement) => img.decode());
    await card.scrollIntoViewIfNeeded();
    const before = await readWebsiteGeometry(page);
    for (const content of [before.image, before.video]) {
      expect(content).toEqual(before.frame);
    }
    // At every supported size the 100px authored heading is about 16–19px
    // tall. Check its top-detail marker in the actual painted thumbnail;
    // blanket zoom crops this marker instead of improving legibility.
    const png = PNG.sync.read(await card.locator('.media').screenshot());
    const marker = Math.round(65 * before.frame.width / 1310);
    const offset = (marker * png.width + marker) * 4;
    expect(png.data[offset]).toBeGreaterThan(220);
    expect(png.data[offset + 1]).toBeLessThan(30);
    expect(png.data[offset + 2]).toBeLessThan(30);
    await card.hover();
    await settleHover(page);
    // Removing hover zoom is a visual contract, not a ban on one selector.
    expect(await readWebsiteGeometry(page)).toEqual(before);
  });
}

async function settleHover(page: Page) {
  // Flush a painted hover frame, then include pending CSS transitions before
  // asserting. A single matching sample at animation start proves nothing.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
}

async function readWebsiteGeometry(page: Page) {
  return page.locator('[data-kind="website"]').evaluate((card) => {
    const frame = card.querySelector('.media')!;
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      frame: { ...rect(frame), height: frame.clientHeight },
      image: rect(card.querySelector('img')!),
      video: rect(card.querySelector('video')!),
    };
  });
}

async function readGeometry(page: Page) {
  return page.evaluate(() => {
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const mediaFrame = document.querySelector('[data-kind="media"] .media')!;
    const htmlFrame = document.querySelector('[data-kind="html"] .media')!;
    const iframe = document.querySelector('iframe')!;
    const image = document.querySelector('img')!;
    const video = document.querySelector('video')!;
    return {
      media: {
        frame: { ...rect(mediaFrame), height: mediaFrame.clientHeight },
        content: rect(document.querySelector('.plugins-home__media')!),
        image: rect(image),
        video: rect(video),
        imageFit: getComputedStyle(image).objectFit,
        videoFit: getComputedStyle(video).objectFit,
        imagePosition: getComputedStyle(image).objectPosition,
        videoPosition: getComputedStyle(video).objectPosition,
      },
      html: {
        frame: { ...rect(htmlFrame), height: htmlFrame.clientHeight },
        content: rect(iframe),
        logicalViewport: { width: iframe.clientWidth, height: iframe.clientHeight },
      },
    };
  });
}

async function expectSlideAtEdges(page: Page, selector: string) {
  const png = PNG.sync.read(await page.locator(selector).screenshot());
  const points = [
    [Math.floor(png.width / 2), 2],
    [Math.floor(png.width / 2), png.height - 3],
    [2, Math.floor(png.height / 2)],
    [png.width - 3, Math.floor(png.height / 2)],
  ];
  for (const [x, y] of points) {
    const offset = ((y! * png.width) + x!) * 4;
    // The slide is green; no thresholds near either fixture background.
    expect(png.data[offset + 1]).toBeGreaterThan(150);
    expect(png.data[offset]).toBeLessThan(120);
    expect(png.data[offset + 2]).toBeLessThan(150);
  }
}
