import type { Page } from '@playwright/test';
import { CAPTURE_SETTINGS } from './settings.ts';
import type { Conversion, ConversionMatch, FormObservation, KeyboardStep, MotionSample, Observation, ResourceEvidence } from './types.ts';

export async function observe<T>(probe: () => Promise<T>): Promise<Observation<T>> {
  try { return { status: 'complete', value: await probe() }; }
  catch (error) { return { status: 'failed', reason: error instanceof Error ? error.message : 'Probe failed' }; }
}

/** DOM paths identify even unnamed controls without adding attributes to the site. */
export async function conversionProbe(page: Page, conversion: Conversion, files: string[], destinationFiles: string[]) {
  return page.evaluate(({ conversion, files, destinationFiles }) => {
    const helpers = { words(text: string) { return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }, selector(element: Element): string {
      const parts: string[] = [];
      for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
        const siblings = [...(node.parentElement?.children ?? [])].filter(sibling => sibling.tagName === node!.tagName);
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
      }
      return `html>${parts.join('>')}`;
    } };
    const matches: ConversionMatch[] = [];
    for (const element of document.querySelectorAll('a,button,input[type="submit"],[role="button"]')) {
      if (element.matches(':disabled') || element.closest('[inert],[aria-disabled="true"]') || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const label = (element.getAttribute('aria-label') ?? (element instanceof HTMLInputElement ? element.value : element.textContent) ?? '').trim();
      const labelWords = helpers.words(label);
      if (!conversion.labels.some(term => {
        const actionWords = helpers.words(term);
        return actionWords.length > 0 && labelWords.some((_, index) => actionWords.every((word, offset) => labelWords[index + offset] === word));
      })) continue;
      const form = element.closest('form');
      const href = element.getAttribute('href');
      let resolves = false; let reason = 'No declared local destination';
      let target = href;
      if (href) {
        try {
          const url = new URL(href, document.baseURI);
          const path = decodeURIComponent(url.pathname.slice(1));
          if (url.origin !== location.origin) reason = 'Destination is not served local inventory';
          else if (path === decodeURIComponent(location.pathname.slice(1)) && url.hash) {
            resolves = !!document.getElementById(decodeURIComponent(url.hash.slice(1)));
            reason = resolves ? '' : 'In-page target missing';
          } else if (files.includes(path) && /\.html?$/iu.test(path)) {
            resolves = !destinationFiles.length || destinationFiles.includes(path);
            reason = resolves ? '' : 'Served file is not a declared conversion destination';
            if (resolves && url.hash) reason = 'Destination fragment needs verification';
          } else reason = 'Destination absent from served page inventory';
        } catch { reason = 'Invalid destination'; }
      } else if (form && (element instanceof HTMLButtonElement && element.type === 'submit' || element instanceof HTMLInputElement && element.type === 'submit')) {
        target = helpers.selector(form); resolves = true; reason = '';
      }
      matches.push({ selector: helpers.selector(element), label, target, resolves, ...(reason ? { reason } : {}) });
    }
    return { matches, exists: matches.length > 0, resolves: matches.length > 0 && matches.every(match => match.resolves) };
  }, { conversion, files, destinationFiles });
}

export async function keyboardProbe(page: Page, primarySelectors: string[]) {
  const reset = () => page.evaluate(() => {
    // Blurring alone preserves Chromium's sequential navigation starting point.
    const previous = document.body.getAttribute('tabindex');
    document.body.tabIndex = -1; document.body.focus(); document.body.blur();
    if (previous === null) document.body.removeAttribute('tabindex'); else document.body.setAttribute('tabindex', previous);
    window.scrollTo(0, 0);
  });
  await reset();
  const unfocusedPaint = await page.evaluateHandle(() => new WeakMap([...document.querySelectorAll('*')].map(element => {
    const css = getComputedStyle(element);
    return [element, { outline: [css.outlineStyle, css.outlineWidth, css.outlineColor, css.outlineOffset].join('/'), shadow: css.boxShadow }] as const;
  })));
  try {
    const readStep = () => page.evaluate(({ primarySelectors, unfocusedPaint }) => {
      const element = document.activeElement;
      if (!element || element === document.body || element === document.documentElement) return { selector: null, label: '', visibleFocus: null, primary: false, internalTabStopsUnmeasured: false };
      const parts: string[] = [];
      for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
        const siblings = [...(node.parentElement?.children ?? [])].filter(sibling => sibling.tagName === node!.tagName);
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
      }
      const path = `html>${parts.join('>')}`;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      const outlined = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)';
      const shadowed = style.boxShadow !== 'none';
      const before = unfocusedPaint.get(element);
      const outline = [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset].join('/');
      // Only changed outline/shadow paint substantiates this focus indicator.
      // Other treatments remain unknown, including :focus-visible without paint.
      const changed = before && (outlined && outline !== before.outline || shadowed && style.boxShadow !== before.shadow);
      return { selector: path, label: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim(), visibleFocus: visible && changed ? true : null, primary: primarySelectors.includes(path), internalTabStopsUnmeasured: !!element.shadowRoot || element.tagName === 'IFRAME' || element.tagName.includes('-') };
    }, { primarySelectors, unfocusedPaint });

    // Count real native sequential stops, independently of site key/focus handlers.
    // Chromium owns radio grouping, tabindex ordering, hidden and inert controls.
    const nativeTabOrder: string[] = [];
    let tabStopCountComplete = false;
    let nativeExitObserved = false;
    let reason: string | undefined;
    const session = await page.context().newCDPSession(page);
    try {
      for (let i = 0; i < CAPTURE_SETTINGS.keyboardStepLimit; i += 1) {
        await session.send('Emulation.setScriptExecutionDisabled', { value: true });
        try { await page.keyboard.press('Tab'); }
        finally { await session.send('Emulation.setScriptExecutionDisabled', { value: false }); }
        const step = await readStep();
        if (step.internalTabStopsUnmeasured) { reason = 'Native traversal entered a shadow host, custom element or frame; internal tab stops unmeasured'; break; }
        if (!step.selector || nativeTabOrder.includes(step.selector)) {
          tabStopCountComplete = true; nativeExitObserved = step.selector === null; break;
        }
        nativeTabOrder.push(step.selector);
      }
    } finally {
      await session.send('Emulation.setScriptExecutionDisabled', { value: false });
      await session.detach();
    }
    if (!tabStopCountComplete && !reason) reason = 'Native Tab walk reached the step limit; trap detection is inconclusive';
    await reset();
    const tabStopCount = nativeTabOrder.length;
    const visited = new Set<string>(); const steps: KeyboardStep[] = [];
    let trapDetected = false; let completed = false;
    for (let i = 0; i < CAPTURE_SETTINGS.keyboardStepLimit; i += 1) {
      await page.keyboard.press('Tab');
      const step = await readStep();
      steps.push(step);
      if (step.internalTabStopsUnmeasured) { reason ??= 'Normal traversal entered a shadow host, custom element or frame; internal tab stops unmeasured'; break; }
      if (step.selector) {
        if (visited.has(step.selector)) {
          trapDetected = tabStopCountComplete && (nativeExitObserved || nativeTabOrder.some(selector => !visited.has(selector)));
          completed = tabStopCountComplete && !trapDetected;
          break;
        }
        visited.add(step.selector);
      } else { completed = tabStopCountComplete && nativeTabOrder.every(selector => visited.has(selector)); break; }
    }
    const exhausted = !completed && !trapDetected;
    if (exhausted && !reason) reason = 'Normal Tab walk incomplete; trap detection is inconclusive';
    return { tabStopCount, tabStopCountComplete, nativeExitObserved, nativeTabOrder, steps, trapDetected, primaryReachable: primarySelectors.length > 0 && primarySelectors.every(selector => visited.has(selector)), exhausted, ...(reason ? { reason } : {}) };
  } finally { await unfocusedPaint.dispose(); }
}

export async function formProbe(page: Page, attempts: Array<{ url: string; method: string; blocked: boolean }>): Promise<FormObservation[]> {
  const forms = await page.locator('form').count(); const observations: FormObservation[] = [];
  for (let index = 0; index < forms; index += 1) {
    const form = page.locator('form').nth(index);
    const metadata = await form.evaluate(element => ({ action: (element as HTMLFormElement).action, method: (element as HTMLFormElement).method.toUpperCase() }));
    const before = attempts.length;
    const record: FormObservation = { selector: `form[index=${index}]`, ...metadata, exercised: false, requests: [], settling: { windowMs: CAPTURE_SETTINGS.formSettleWindowMs, durationMs: 0, complete: false } };
    try {
      const inputs = form.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select');
      for (let j = 0; j < await inputs.count(); j += 1) {
        const input = inputs.nth(j);
        if (!await input.isVisible() || !await input.isEnabled()) continue;
        const kind = await input.evaluate(element => element.tagName === 'SELECT' ? 'select' : element.getAttribute('type') ?? 'text');
        if (kind === 'select') {
          const option = await input.locator('option:not([value=""])').first().getAttribute('value');
          if (option !== null) await input.selectOption(option);
        } else if (['checkbox', 'radio'].includes(kind)) await input.check();
        else if (!['file', 'range', 'color'].includes(kind)) await input.fill(kind === 'email' ? 'benchmark@example.invalid' : kind === 'number' ? '1' : kind === 'date' ? '2026-01-01' : kind === 'time' ? '12:00' : 'Benchmark demo');
      }
      const submit = form.locator('button[type="submit"],button:not([type]),input[type="submit"]').first();
      if (!await submit.count() || !await submit.isVisible() || !await submit.isEnabled()) record.reason = 'No reachable enabled submit control';
      else {
        const valid = await form.evaluate(element => (element as HTMLFormElement).checkValidity());
        await submit.click({ timeout: 3000, noWaitAfter: true });
        record.exercised = valid;
        const start = performance.now();
        try {
          // Observe the full window even if an immediate request already arrived.
          // Node owns the clock, so page navigation cannot cancel the timer.
          while (performance.now() - start < CAPTURE_SETTINGS.formSettleWindowMs) {
            await new Promise(resolve => setTimeout(resolve, CAPTURE_SETTINGS.formSettleWindowMs - (performance.now() - start)));
          }
          if (page.isClosed()) throw new Error('Page closed during form observation');
          record.settling.complete = true;
        } finally { record.settling.durationMs = performance.now() - start; }
        if (!record.exercised) record.reason = 'Form validation prevented submit; behaviour unobserved';
      }
    } catch (error) { record.exercised = false; record.reason = error instanceof Error ? error.message : 'Form exercise failed'; }
    record.requests = attempts.slice(before); observations.push(record);
  }
  return observations;
}

/** Installed before site script: observed layout shift is measured over explicit render frames. */
export async function installMotionObserver(page: Page) {
  await page.addInitScript(() => {
    const state = { shifts: 0, supported: PerformanceObserver.supportedEntryTypes.includes('layout-shift') };
    (window as unknown as { __qualityMotion: typeof state }).__qualityMotion = state;
    if (state.supported) new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.shifts += (entry as PerformanceEntry & { value: number }).value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
}
export async function motionProbe(page: Page): Promise<MotionSample> {
  return page.evaluate(async frames => {
    const state = (window as unknown as { __qualityMotion?: { supported: boolean; shifts: number } }).__qualityMotion;
    if (!state?.supported) throw new Error('Layout shift observer unavailable');
    const elements = [...document.querySelectorAll('*')];
    const before = elements.map(element => element.getBoundingClientRect());
    const start = state.shifts;
    const animationCount = document.getAnimations().filter(animation => animation.playState === 'running').length;
    for (let i = 0; i < frames; i += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const movedElements = elements.filter((element, index) => {
      const now = element.getBoundingClientRect(), prior = before[index]!;
      return Math.abs(now.x - prior.x) > 0.5 || Math.abs(now.y - prior.y) > 0.5 || Math.abs(now.width - prior.width) > 0.5 || Math.abs(now.height - prior.height) > 0.5;
    }).length;
    return { animationCount, layoutShift: state.shifts - start, movedElements, sampleFrames: frames };
  }, CAPTURE_SETTINGS.motionSampleFrames);
}

export async function resourceProbe(page: Page, requests: ResourceEvidence['requests']): Promise<ResourceEvidence> {
  const observed = await page.evaluate(() => {
    const fontFaces = [...document.fonts].map(face => ({ family: face.family.replace(/^['"]|['"]$/gu, ''), weight: face.weight, style: face.style, status: face.status }));
    const requested = new Map<string, { family: string; weight: string; style: string; available: boolean | null }>();
    for (const element of document.querySelectorAll('body *')) {
      if (![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) continue;
      const css = getComputedStyle(element);
      const family = css.fontFamily;
      const declared = fontFaces.filter(face => family.split(',').some(name => name.trim().replace(/^['"]|['"]$/gu, '') === face.family));
      // The browser matches the CSS request's weight/style (including synthesis,
      // variable ranges and unicode coverage); unused family variants do not count.
      const available = declared.length ? document.fonts.check(`${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${family}`, element.textContent ?? '') : null;
      requested.set(`${family}/${css.fontWeight}/${css.fontStyle}`, { family, weight: css.fontWeight, style: css.fontStyle, available });
    }
    return { fontFaces, requestedFonts: [...requested.values()], images: [...document.images].map(image => {
      const box = image.getBoundingClientRect();
      return { src: image.currentSrc || image.src, rendered: { width: box.width, height: box.height }, natural: { width: image.naturalWidth, height: image.naturalHeight } };
    }) };
  });
  return { ...observed, requests: structuredClone(requests), imageBytes: requests.filter(request => request.type === 'image' && request.status === 200).reduce((total, request) => total + (request.bytes ?? 0), 0), fontBytes: requests.filter(request => request.type === 'font' && request.status === 200).reduce((total, request) => total + (request.bytes ?? 0), 0) };
}
