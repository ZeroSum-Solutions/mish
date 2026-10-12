#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadPlaywright, launchChromium } from "./lib/playwright-loader.mjs";
import { stitchPngsVertically } from "./lib/png-stitch.mjs";

// Full-page capture limits. One capture of a 12k-18k px photographic page is a
// huge GPU surface and a huge CDP message, so pages taller than one segment are
// captured segment by segment and stitched. The default height cap keeps the
// stitched image within a fixed pixel budget (1440 x 20000) and below the
// 32767 px canvas edge that visual-diff.mjs loads screenshots into.
const FULL_PAGE_SEGMENT_HEIGHT = 4000;
const FULL_PAGE_PIXEL_BUDGET = 1440 * 20000;
const FULL_PAGE_HARD_MAX_HEIGHT = 32000;

function usage() {
  console.log(`Usage:
  node scripts/recon-site.mjs --url <url> --out <RECON dir> [--label original|clone] [--widths 1440,768,390] [--wait 1200] [--navigation-timeout 45000] [--no-full-page] [--full-page-max-height <px>]

  --wait is an extra post-navigation stabilization delay. It does not change
  the navigation timeout; use --navigation-timeout for that.

  Screenshots are full-page by default. Pages taller than ${FULL_PAGE_SEGMENT_HEIGHT}px are
  captured in ${FULL_PAGE_SEGMENT_HEIGHT}px segments and stitched into one PNG, capped at
  --full-page-max-height (default: min(${FULL_PAGE_HARD_MAX_HEIGHT}, ${FULL_PAGE_PIXEL_BUDGET} / width) px).
  Captures are clipped to the viewport width; horizontal overflow is recorded
  as contentWidth / horizontalOverflow. --no-full-page writes only the first
  viewport. Each capture records its mode, capture width,
  page height, captured height, segment count, cap and truncation in
  captures[].screenshotCapture of the recon JSON.

Outputs:
  <out>/<label>-recon.json
  <out>/<label>-summary.md
  <out>/screenshots/<label>-<width>.png
`);
}

function parseArgs(argv) {
  const out = {
    url: "",
    outDir: "RECON",
    label: "site",
    widths: [1440, 768, 390],
    waitMs: 1200,
    navigationTimeoutMs: 45000,
    fullPage: true,
    fullPageMaxHeight: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--url") out.url = argv[++i] || "";
    else if (arg === "--out") out.outDir = argv[++i] || "";
    else if (arg === "--label") out.label = argv[++i] || "site";
    else if (arg === "--widths") out.widths = (argv[++i] || "").split(",").map((n) => Number(n.trim())).filter(Boolean);
    else if (arg === "--wait") out.waitMs = Number(argv[++i] || "1200");
    else if (arg === "--navigation-timeout") out.navigationTimeoutMs = Number(argv[++i] || "45000");
    else if (arg === "--no-full-page") out.fullPage = false;
    else if (arg === "--full-page-max-height") {
      out.fullPageMaxHeight = Number(argv[++i] || "");
      if (!Number.isInteger(out.fullPageMaxHeight) || out.fullPageMaxHeight < 1) {
        throw new Error("--full-page-max-height must be a positive integer");
      }
    }
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return out;
}

function summarizeFlags(signals) {
  return Object.entries(signals.frameworks || {})
    .filter(([, value]) => value)
    .map(([key]) => key);
}

function describeCapture(info) {
  if (!info) return "";
  if (info.mode === "viewport") return `viewport only, page ${info.pageHeight}px`;
  const truncated = info.truncated ? `, truncated at ${info.capturedHeight}px of ${info.pageHeight}px` : "";
  return `${info.mode}, ${info.capturedHeight}px, ${info.tileCount} segment(s)${truncated}`;
}

function writeSummary(file, data) {
  const first = data.captures[0]?.signals || {};
  const lines = [
    `# ${data.label} recon`,
    "",
    `- URL: ${data.url}`,
    `- Title: ${first.title || ""}`,
    `- Lang: ${first.lang || ""}`,
    `- Viewports: ${data.captures.map((c) => c.viewport.width).join(", ")}`,
    `- Framework signals: ${summarizeFlags(first).join(", ") || "none"}`,
    `- Canvas count: ${first.counts?.canvas ?? 0}`,
    `- Video count: ${first.counts?.video ?? 0}`,
    `- Image count: ${first.counts?.images ?? 0}`,
    `- Link count: ${first.counts?.links ?? 0}`,
    `- Console errors: ${data.console.errors.length}`,
    `- Page errors: ${data.console.pageErrors.length}`,
    `- Recovered navigation timeouts: ${(data.navigation || []).filter((entry) => entry.recovered).length}`,
    "",
    "## Palette (computed — 复刻必须照抄这些值，不许目测)",
    ...Object.entries(first.palette || {})
      .filter(([key, value]) => key !== "buttons" && value)
      .map(([key, value]) => `- ${key}: bg ${value.backgroundColor} · text ${value.color} · font ${value.fontFamily?.split(",")[0] || ""}`),
    "",
    "## Fonts (真字体自托管，禁止系统字体近似)",
    `- Loaded families: ${(first.fonts || []).join(", ") || "none"}`,
    `- @font-face rules: ${(first.fontFaces || []).length}; font files: ${(first.resources?.fonts || []).length}`,
    "",
    "## Assets",
    `- Image resources loaded: ${(first.resources?.images || []).length} (run asset-harvest to download ALL of them)`,
    "",
    "## Screenshots",
    ...data.captures.map((c) => `- ${c.viewport.width}: ${c.screenshot} (${describeCapture(c.screenshotCapture)})`),
    "",
  ];
  fs.writeFileSync(file, lines.join("\n"));
}

async function navigateForRecon(page, url, timeout) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    return { recovered: false, url: page.url(), readyState: await page.evaluate(() => document.readyState) };
  } catch (error) {
    const state = await page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      hasDocument: Boolean(document.documentElement),
      hasBody: Boolean(document.body),
      bodyTextChars: (document.body?.innerText || "").length,
    })).catch(() => null);
    const isTimeout = error?.name === "TimeoutError" || /timeout/i.test(error?.message || "");
    const hasUsableDocument = state?.hasDocument
      && state.hasBody
      && /^https?:/i.test(state.url);
    if (!isTimeout || !hasUsableDocument) throw error;
    return {
      recovered: true,
      url: state.url,
      readyState: state.readyState,
      bodyTextChars: state.bodyTextChars,
      warning: `Navigation did not reach DOMContentLoaded within ${timeout}ms; continuing with the committed document.`,
    };
  }
}

async function collectSignals(page) {
  return page.evaluate(() => {
    const bySelector = (selector) => Array.from(document.querySelectorAll(selector));
    const text = (node) => (node?.textContent || "").trim().replace(/\s+/g, " ");
    const win = window;
    const scripts = bySelector("script[src]").map((s) => s.src);
    const stylesheets = bySelector("link[rel='stylesheet']").map((s) => s.href);
    const headings = bySelector("h1,h2,h3").slice(0, 60).map((h) => ({
      tag: h.tagName.toLowerCase(),
      text: text(h).slice(0, 160),
    }));
    const sections = bySelector("header,nav,main,section,article,aside,footer").slice(0, 80).map((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        tag: node.tagName.toLowerCase(),
        id: node.id || "",
        className: String(node.className || "").slice(0, 160),
        text: text(node).slice(0, 240),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        style: {
          display: style.display,
          position: style.position,
          backgroundColor: style.backgroundColor,
          color: style.color,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
        },
      };
    });
    const cssVariables = Array.from(document.styleSheets).flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules || []);
      } catch {
        return [];
      }
    }).flatMap((rule) => {
      const style = rule.style;
      if (!style) return [];
      return Array.from(style)
        .filter((name) => name.startsWith("--"))
        .map((name) => [name, style.getPropertyValue(name).trim()]);
    }).slice(0, 200);
    const images = bySelector("img").slice(0, 120).map((img) => ({
      src: img.currentSrc || img.src || img.getAttribute("data-src") || "",
      srcset: img.srcset || img.getAttribute("data-srcset") || "",
      alt: img.alt || "",
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0,
    }));
    // @font-face 规则原文 + 解析出的 src url——复刻必须自托管这些真字体，
    // 禁止用系统字体近似(见 SKILL.md 保真门槛)。
    const fontFaces = Array.from(document.styleSheets).flatMap((sheet) => {
      let rules;
      try {
        rules = Array.from(sheet.cssRules || []);
      } catch {
        return [];
      }
      return rules
        .filter((rule) => rule instanceof CSSFontFaceRule)
        .map((rule) => {
          const src = rule.style.getPropertyValue("src");
          const srcUrls = Array.from(src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)).map((m) => m[1]);
          return {
            family: rule.style.getPropertyValue("font-family").replace(/['"]/g, "").trim(),
            weight: rule.style.getPropertyValue("font-weight") || "",
            style: rule.style.getPropertyValue("font-style") || "",
            srcUrls,
            cssText: rule.cssText,
            sheetHref: sheet.href || location.href,
          };
        });
    }).slice(0, 60);
    // 页面实际加载过的资源 URL(懒加载图、CSS 背景图、字体二进制都在这)——
    // 这是"真实用到的资产"全集，asset-harvest 以此下载。
    const resourceEntries = performance.getEntriesByType("resource");
    const resources = { images: [], fonts: [], media: [] };
    for (const entry of resourceEntries) {
      const url = entry.name;
      if (/\.(woff2?|ttf|otf|eot)(?:$|[?#])/i.test(url)) resources.fonts.push(url);
      else if (entry.initiatorType === "img" || /\.(png|jpe?g|gif|webp|avif|svg|ico)(?:$|[?#])/i.test(url)) resources.images.push(url);
      else if (/\.(mp4|webm|m4v|mp3|ogg)(?:$|[?#])/i.test(url)) resources.media.push(url);
    }
    resources.images = Array.from(new Set(resources.images)).slice(0, 300);
    resources.fonts = Array.from(new Set(resources.fonts)).slice(0, 60);
    resources.media = Array.from(new Set(resources.media)).slice(0, 40);
    // 关键区块的精确取色——复刻时颜色必须照抄这里的值，不许目测。
    const paletteOf = (node) => {
      if (!node) return null;
      const style = getComputedStyle(node);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderColor: style.borderTopColor,
        fontFamily: style.fontFamily,
        backgroundImage: style.backgroundImage !== "none" ? style.backgroundImage.slice(0, 300) : "",
      };
    };
    const palette = {
      body: paletteOf(document.body),
      header: paletteOf(document.querySelector("header")),
      nav: paletteOf(document.querySelector("nav")),
      main: paletteOf(document.querySelector("main")),
      footer: paletteOf(document.querySelector("footer")),
      buttons: bySelector("button,[role='button'],a[class*='btn' i],a[class*='button' i]")
        .slice(0, 12)
        .map((node) => ({ text: text(node).slice(0, 40), ...paletteOf(node) })),
    };
    // 滚动体感信号——复刻必须还原原站的滚动手感(平滑滚动库/snap/sticky)，
    // 配合 frameworks 里的 lenis/gsap 检测一起读。
    const motion = (() => {
      let scrollSnapRules = 0;
      let smoothScrollRules = 0;
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try {
          rules = Array.from(sheet.cssRules || []);
        } catch {
          continue;
        }
        for (const rule of rules) {
          const ruleText = rule.cssText || "";
          if (ruleText.includes("scroll-snap")) scrollSnapRules += 1;
          if (ruleText.includes("scroll-behavior") && ruleText.includes("smooth")) smoothScrollRules += 1;
        }
      }
      const stickyOrFixedCount = bySelector("header,nav,aside,section,div")
        .slice(0, 500)
        .filter((el) => {
          const position = getComputedStyle(el).position;
          return position === "sticky" || position === "fixed";
        }).length;
      return {
        htmlScrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        scrollSnapRules,
        smoothScrollRules,
        stickyOrFixedCount,
      };
    })();
    // :root 自定义属性的"计算后"值(声明值可能是 var() 链)。
    const rootStyle = getComputedStyle(document.documentElement);
    const rootVariables = cssVariables
      .map(([name]) => [name, rootStyle.getPropertyValue(name).trim()])
      .filter(([, value]) => value)
      .slice(0, 200);
    const canvases = bySelector("canvas").map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
      cssWidth: canvas.getBoundingClientRect().width,
      cssHeight: canvas.getBoundingClientRect().height,
    }));
    return {
      href: location.href,
      title: document.title,
      lang: document.documentElement.lang || "",
      bodyTextChars: (document.body?.innerText || "").length,
      scrollHeight: document.documentElement.scrollHeight,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      h1: bySelector("h1").map((h) => text(h)).filter(Boolean).slice(0, 10),
      headings,
      metaDescription: document.querySelector("meta[name='description']")?.content || "",
      counts: {
        links: bySelector("a[href]").length,
        images: bySelector("img").length,
        video: bySelector("video").length,
        canvas: bySelector("canvas").length,
        sections: sections.length,
        forms: bySelector("form").length,
        buttons: bySelector("button").length,
        inputs: bySelector("input,textarea,select").length,
        interactive: bySelector("a[href],button,input,textarea,select,summary,[role='button'],[tabindex]").length,
        scripts: scripts.length,
        stylesheets: stylesheets.length,
      },
      frameworks: {
        react: Boolean(win.__REACT_DEVTOOLS_GLOBAL_HOOK__) || Boolean(document.querySelector("#__next,[data-reactroot],[data-reactid]")),
        next: Boolean(document.querySelector("#__next")) || scripts.some((src) => src.includes("/_next/")),
        vue: Boolean(win.__VUE__) || Boolean(document.querySelector("[data-v-app]")),
        nuxt: Boolean(win.__NUXT__) || scripts.some((src) => src.includes("/_nuxt/")),
        svelte: Boolean(document.querySelector("[data-svelte-h]")),
        astro: Boolean(document.querySelector("[data-astro-cid]")) || scripts.some((src) => src.includes("astro")),
        three: Boolean(win.THREE) || scripts.some((src) => /three(\.module)?(\.min)?\.js/i.test(src)),
        gsap: Boolean(win.gsap) || scripts.some((src) => src.toLowerCase().includes("gsap")),
        lenis: Boolean(win.Lenis) || scripts.some((src) => src.toLowerCase().includes("lenis")),
      },
      scripts: scripts.slice(0, 120),
      stylesheets: stylesheets.slice(0, 80),
      sections,
      cssVariables,
      rootVariables,
      palette,
      motion,
      fonts: Array.from(document.fonts || []).map((font) => font.family).filter(Boolean).slice(0, 40),
      fontFaces,
      resources,
      images,
      canvases,
    };
  });
}

// 全程滚动一遍再采集: 懒加载图(loading=lazy / IntersectionObserver)只有滚到才
// 发请求; 不滚的话 images/resources 只覆盖首屏, 复刻必然缺图。
async function scrollThroughPage(page, stepPx = 700) {
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= total; y += stepPx) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
}

// The pixel budget is spent on the captured width, which is always the
// viewport width (see captureScreenshot), so width x maxHeight stays within
// FULL_PAGE_PIXEL_BUDGET whatever the page's horizontal overflow.
function defaultFullPageMaxHeight(width) {
  return Math.min(FULL_PAGE_HARD_MAX_HEIGHT, Math.floor(FULL_PAGE_PIXEL_BUDGET / width));
}

// Works with both the zero-dependency CDP page and a Playwright page: with
// `fullPage: true`, a `clip` is in page coordinates on both.
//
// Every capture is clipped to the viewport width. A recon screenshot documents
// the layout at that breakpoint; horizontal overflow (often a stray 5000px
// carousel track) would otherwise multiply the pixel count past the budget.
// The overflow is recorded as contentWidth / horizontalOverflow instead.
async function captureScreenshot(page, { outputPath, viewport, fullPage, maxHeight }) {
  const size = await page.evaluate(() => ({
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
  }));
  const pageHeight = Math.max(viewport.height, Math.ceil(size.height));
  const contentWidth = Math.ceil(size.width);
  const width = viewport.width;
  const info = {
    mode: "viewport",
    fullPage,
    pageHeight,
    capturedHeight: viewport.height,
    captureWidth: width,
    contentWidth,
    horizontalOverflow: contentWidth > width,
    tileCount: 1,
    tileHeight: FULL_PAGE_SEGMENT_HEIGHT,
    maxHeight,
    truncated: false,
  };
  if (!fullPage) {
    await page.screenshot({ path: outputPath });
    return { ...info, truncated: pageHeight > viewport.height };
  }
  const capturedHeight = Math.min(pageHeight, maxHeight);
  if (capturedHeight <= FULL_PAGE_SEGMENT_HEIGHT) {
    await page.screenshot({ path: outputPath, fullPage: true, clip: { x: 0, y: 0, width, height: capturedHeight } });
    return { ...info, mode: "single", capturedHeight, truncated: pageHeight > capturedHeight };
  }
  const segments = [];
  for (let y = 0; y < capturedHeight; y += FULL_PAGE_SEGMENT_HEIGHT) {
    const height = Math.min(FULL_PAGE_SEGMENT_HEIGHT, capturedHeight - y);
    segments.push(await page.screenshot({ fullPage: true, clip: { x: 0, y, width, height } }));
  }
  const stitched = stitchPngsVertically(segments, { maxHeight: capturedHeight });
  fs.writeFileSync(outputPath, stitched.png);
  return {
    ...info,
    mode: "tiled",
    capturedHeight: stitched.height,
    tileCount: segments.length,
    truncated: pageHeight > stitched.height,
  };
}

let browser = null;
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const { chromium } = loadPlaywright();
  const outDir = path.resolve(args.outDir);
  const screenshotsDir = path.join(outDir, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const consoleState = { errors: [], warnings: [], pageErrors: [] };
  browser = await launchChromium(chromium);
  const captures = [];
  const navigation = [];

  for (const width of args.widths) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    page.on("console", (message) => {
      const entry = { type: message.type(), text: message.text(), viewport: width };
      if (message.type() === "error") consoleState.errors.push(entry);
      if (message.type() === "warning") consoleState.warnings.push(entry);
    });
    page.on("pageerror", (error) => {
      consoleState.pageErrors.push({ message: error.message, viewport: width });
    });

    const navigationState = await navigateForRecon(page, args.url, args.navigationTimeoutMs);
    navigation.push({ viewport: width, ...navigationState });
    if (navigationState.warning) console.warn(`recon-site warning (${width}px): ${navigationState.warning}`);
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    if (args.waitMs > 0) await page.waitForTimeout(args.waitMs);
    await scrollThroughPage(page);

    const signals = await collectSignals(page);
    const screenshotName = `${args.label}-${width}.png`;
    const screenshotPath = path.join(screenshotsDir, screenshotName);
    const screenshotCapture = await captureScreenshot(page, {
      outputPath: screenshotPath,
      viewport: { width, height: 900 },
      fullPage: args.fullPage,
      maxHeight: args.fullPageMaxHeight ?? defaultFullPageMaxHeight(width),
    });
    if (screenshotCapture.truncated && screenshotCapture.mode !== "viewport") {
      console.warn(`recon-site warning (${width}px): full-page screenshot truncated at ${screenshotCapture.capturedHeight}px of ${screenshotCapture.pageHeight}px (--full-page-max-height).`);
    }
    captures.push({
      viewport: { width, height: 900 },
      screenshot: path.relative(outDir, screenshotPath),
      screenshotCapture,
      signals,
    });
    await page.close();
  }

  await browser.close();
  browser = null;

  const result = {
    label: args.label,
    url: args.url,
    capturedAt: new Date().toISOString(),
    console: consoleState,
    navigation,
    captures,
  };
  const jsonFile = path.join(outDir, `${args.label}-recon.json`);
  fs.writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`);
  writeSummary(path.join(outDir, `${args.label}-summary.md`), result);
  console.log(jsonFile);
} catch (error) {
  console.error(`recon-site failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
