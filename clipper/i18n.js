// Mishh Mashh Web Clipper i18n runtime.
//
// Standalone on purpose: the clipper is not part of the pnpm workspace, so the
// popup, content script, service worker, and injected design-system renderer all use
// this small browser/worker-safe dictionary instead of importing app code.

(function () {
  const LOCALES = ['en'];
  const RTL = new Set(['ar', 'fa']);

  const en = {
    extensionName: 'Mishh Mashh Web Clipper',
    extensionDescription: 'Clip pages, design systems, screenshots, images, and Figma import JSON into your Mishh Mashh Library.',
    webClipper: 'Web Clipper',
    openDesign: 'Mishh Mashh',
    statusConnected: 'Connected',
    statusOffline: 'Offline',
    infoLabel: 'What gets captured',
    infoTooltip: '"Capture page" saves a self-contained page copy. "Extract design system" saves a structured design-system HTML asset. Figma JSON must be imported with the OD Figma Import plugin, not dragged into Figma Drafts.',
    capturePageTitle: 'Capture page',
    capturePageSub: 'Full-fidelity snapshot -> Library',
    screenshot: 'Screenshot',
    region: 'Region',
    pickImages: 'Pick images',
    pickElement: 'Pick element',
    figmaJson: 'Figma JSON',
    extractDesignSystem: 'Extract design system',
    hintHtml: '<strong>Mishh Mashh</strong> is not running. Start the app, then reopen this popup - the clipper connects automatically.',
    advanced: 'Advanced',
    onPageBar: 'On-page bar',
    onPageBarSub: 'floating launcher on the page',
    imageHoverButton: 'Image hover button',
    imageHoverButtonSub: 'tiny save button on each image',
    inlineImages: 'Inline images',
    inlineImagesSub: 'higher fidelity, larger files',
    daemonUrl: 'Daemon URL',
    save: 'Save',
    refreshPage: 'Refresh page',
    refreshPageTitle: 'Reload this page so Mishh Mashh can attach',
    toggleOnPageBar: 'Toggle the on-page bar',
    toggleImageHover: 'Toggle the per-image hover capture button',
    close: 'Close',
    cancel: 'Cancel',
    clear: 'Clear',
    selectAll: 'Select all',
    unknown: 'unknown',
    noResponse: 'no response',
    failed: 'Failed: {error}',
    extensionErrorReload: 'Extension error - reload the page',
    openDesignNotRunning: 'Mishh Mashh is not running - start the app first.',
    savedConnected: 'Saved - connected.',
    savedNotDetected: 'Saved, but Mishh Mashh was not detected at that URL.',
    capturingPage: 'Capturing page...',
    pageAlreadyInLibrary: 'Page already in library.',
    largePagePartialLayout: 'large page - partial layout',
    figmaLayoutSkippedPageTooLarge: 'Figma layout skipped - page too large',
    resourcesLeftLinks: '{count} resource(s) left as links',
    imagesLeftLinks: '{count} image(s) left as links',
    savedPageWithFigma: 'Saved page + Figma capture{suffix} to library.',
    savedPage: 'Saved page{suffix} to library.',
    buildingFigma: 'Building Figma import JSON...',
    figmaDownloaded: 'Figma JSON downloaded. Open it with the OD Figma Import plugin (Figma -> Plugins -> Development) - do not drag the file into Figma. First time: install the plugin once from figma-plugin/ (see its README).',
    extractingDesignSystem: 'Extracting design system...',
    designSystemAlreadyInLibrary: 'Design system already in library{suffix}.',
    designSystemSaved: 'Design system saved to library{suffix}.',
    capturingScreenshot: 'Capturing screenshot...',
    alreadyInLibrary: 'Already in library.',
    screenshotSaved: 'Screenshot saved to library.',
    openNormalPage: 'Open a normal web page to use this.',
    openNormalPageForBar: 'Open a normal web page to use the on-page bar.',
    odNotAttached: 'Mishh Mashh has not attached to this page yet.',
    elementPickerUnavailable: 'The element picker is not available on this page - try a normal website.',
    imagePickerUnavailable: 'The image picker is not available on this page - try a normal website.',
    regionUnavailable: 'Region capture is not available on this page - try a normal website.',
    clickElement: 'Click an element on the page...',
    pickImagesOnPage: 'Pick images on the page...',
    dragRegionOnPage: 'Drag a region on the page...',
    onPageBarUnavailable: 'The on-page bar is not available on this page - try a normal website.',
    onPageBarShown: 'On-page bar shown.',
    onPageBarHidden: 'On-page bar hidden.',
    imageHoverOn: 'Image hover button on.',
    imageHoverOff: 'Image hover button off.',
    readyTryAgain: 'Ready - try again.',
    reloadingPage: 'Reloading the page...',
    reloadedReopen: 'Reloaded - reopen this popup to continue.',
    toolbarDrag: 'Drag to move',
    toolbarDragLabel: 'Drag the Mishh Mashh bar',
    toolbarHomeTip: 'Mishh Mashh',
    toolbarHomeLabel: 'Mishh Mashh home',
    toolbarCapturePage: 'Capture page -> Library',
    toolbarExtractDesignSystem: 'Extract design system',
    toolbarDownloadFigma: 'Download Figma import JSON',
    toolbarCaptureScreenshot: 'Capture screenshot',
    toolbarCaptureRegion: 'Capture a region',
    toolbarPickImages: 'Pick images to save',
    toolbarPickElement: 'Pick an element to capture',
    toolbarHide: 'Hide Mishh Mashh bar',
    openDesignStartApp: 'Mishh Mashh is not running - start the app',
    savedPageFigmaShort: 'Saved page + Figma',
    savedPageShort: 'Saved page',
    someImagesLeftLinks: 'some images left as links',
    savedDesignSystemShort: 'Saved design system',
    savedScreenshot: 'Saved screenshot',
    elementPickerTitle: 'Select an element',
    elementPickerHint: 'hover, then click to capture',
    capture: 'Capture',
    elementPickCancelled: 'Element pick cancelled',
    elementNoVisibleSize: 'That element has no visible size',
    elementAlreadyInLibrary: 'Element already in library',
    elementSaved: 'Saved element to library',
    noImagesFound: 'No images found on this page',
    selectImagesToSave: 'Select images to save',
    selectedCount: '{selected} / {total} selected',
    saveNToLibrary: 'Save {count} to Library',
    imageLabel: 'Image {index}',
    findOnPage: 'Find on page',
    saving: 'Saving...',
    savingImages: 'Saving {count} image(s)...',
    savedImagesCount: 'Saved {count}/{total} image(s) to library',
    // On-bar progress while a capture runs: a step counter, a rough ETA, and a
    // patience line once the wait runs past the expected budget.
    busyStepOf: 'Step {step} of {total}',
    busyAbout: 'about {sec}s',
    busyTakingLonger: 'Still working — thanks for your patience',
    busyPageSnapshot: 'Snapshotting the page…',
    busyPageInline: 'Inlining styles & images…',
    busyPageSaving: 'Saving to your Library…',
    busySystemReading: 'Reading page styles…',
    busySystemExtract: 'Extracting colors, type & components…',
    busySystemBuilding: 'Building the design-system asset…',
    busySystemSaving: 'Saving to your Library…',
    busyFigmaReading: 'Reading the page layout…',
    busyFigmaBuilding: 'Building Figma import JSON…',
    busyFigmaPreparing: 'Preparing the download…',
    busyShotCapturing: 'Capturing screenshot…',
    busyShotSaving: 'Saving to your Library…',
    busyRegionCapturing: 'Capturing the region…',
    busyRegionSaving: 'Saving to your Library…',
    busyElementCapturing: 'Capturing the element…',
    busyElementSaving: 'Saving to your Library…',
    busyImagesDownloading: 'Downloading {count} image(s)…',
    busyImagesSaving: 'Saving to your Library…',
    regionTooSmall: 'Region too small - drag a larger box',
    regionCancelled: 'Region capture cancelled',
    dragToSelectRegion: 'Drag',
    dragToSelectRegionTail: 'to select a region',
    regionAlreadyInLibrary: 'Region already in library',
    regionSaved: 'Saved region to library',
    saveImageToLibrary: 'Save image to Mishh Mashh Library',
    saveImageToOpenDesign: 'Save image to Mishh Mashh',
    savingImage: 'Saving image...',
    imageSaved: 'Saved image to library',
    imageSaveFailed: 'Could not save that image',
    errorCaptureTooLarge: 'Capture too large - try unchecking "Inline images" in Advanced',
    errorDesignSystemCaptureFailed: 'design system capture failed',
    brandFallbackTitle: 'Captured brand',
    brandFallbackDescription: 'Programmatically extracted from the live web page.',
    brandPageTitleSuffix: 'Design System Capture',
    brandFileTitle: '{title} Design System',
    brandExtracted: 'Extracted design system',
    brandAssetMap: 'Brand asset map',
    brandAssetMapSub: '6 extracted groups',
    brandLogo: 'Logo',
    brandImages: 'Images',
    brandTypography: 'Typography',
    brandPalette: 'Palette',
    brandVoice: 'Voice',
    brandComponents: 'Components',
    brandLogoCount: '{count} marks and app icons',
    brandImageCount: '{count} representative images',
    brandFontCount: '{count} font families',
    brandColorCount: '{count} observed colors',
    brandHeadingCount: '{count} heading samples',
    brandComponentSummary: 'Buttons, fields, cards and navigation',
    brandIdentity: 'Identity',
    brandLogoSub: 'Brand marks',
    brandTypographySub: 'Live computed styles',
    brandPaletteSub: 'Light and dark tokens',
    brandComponentKit: 'Component kit',
    brandComponentKitSub: 'Template filled from page tokens',
    brandImagesSub: 'Representative assets',
    brandVoiceContent: 'Voice & Content',
    brandVoiceContentSub: 'Detected headings',
    brandNoImages: 'No large page images were detected.',
    brandObservedColor: 'observed color',
    brandNoHeading: 'No heading sample was available.',
    brandKeywordFallback: 'captured brand',
    brandAssetAlt: 'Brand asset',
    brandLogoAsset: 'Logo asset',
    brandImageAlt: 'Brand image {index}',
    brandImageLabel: 'Image {index}',
    brandTheme: 'Theme',
    brandLight: 'Light',
    brandDark: 'Dark',
    brandPrimaryAction: 'Primary action',
    brandSecondaryAction: 'Secondary',
    brandFormField: 'Form field',
    brandFormFieldSample: 'Form field sample',
    brandSurfaceCard: 'Surface card',
    brandSurfaceCardText: 'Radius, border, color and type inherit from the extracted design system.',
    brandNavigationItem: 'Navigation item',
    brandDataNote: 'This file contains a structured JSON payload at <code>#od-design-system-data</code> for future automation.',
    swatchBackground: 'Background',
    swatchSurface: 'Surface',
    swatchForeground: 'Foreground',
    swatchMuted: 'Muted',
    swatchBorder: 'Border',
    swatchAccent: 'Accent',
    swatchSupport: 'Support',
    swatchHighlight: 'Highlight',
    swatchColor: 'Color {index}',
  };

  const overrides = {};

  const dicts = {};
  for (const locale of LOCALES) dicts[locale] = { ...en, ...(overrides[locale] || {}) };

  function normalizeLocale(raw) {
    const value = String(raw || '').trim().replace(/_/g, '-');
    if (!value) return '';
    const lower = value.toLowerCase();
    const exact = LOCALES.find((locale) => locale.toLowerCase() === lower);
    if (exact) return exact;
    const [language, regionOrScript] = lower.split('-');
    return LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === language) || '';
  }

  function resolveLocale(languages) {
    for (const raw of languages || []) {
      const locale = normalizeLocale(raw);
      if (locale) return locale;
    }
    return 'en';
  }

  function browserLanguages() {
    const values = [];
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') {
        values.push(chrome.i18n.getUILanguage());
      }
    } catch {
      // ignore
    }
    try {
      if (typeof navigator !== 'undefined') {
        if (navigator.languages) values.push(...navigator.languages);
        if (navigator.language) values.push(navigator.language);
      }
    } catch {
      // ignore
    }
    return values;
  }

  function currentLocale() {
    return resolveLocale(browserLanguages());
  }

  function interpolate(raw, vars) {
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, name) => (vars[name] == null ? `{${name}}` : String(vars[name])));
  }

  function t(key, vars, locale) {
    const resolved = normalizeLocale(locale) || currentLocale();
    const dict = dicts[resolved] || en;
    return interpolate(dict[key] || en[key] || key, vars);
  }

  function isRtl(locale) {
    return RTL.has(normalizeLocale(locale) || currentLocale());
  }

  function htmlLang(locale) {
    return normalizeLocale(locale) || currentLocale();
  }

  function translateDocument(root, locale) {
    const doc = root || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    const resolved = htmlLang(locale);
    const documentElement = doc.documentElement || doc.querySelector?.('html');
    if (documentElement) {
      documentElement.setAttribute('lang', resolved);
      documentElement.setAttribute('dir', isRtl(resolved) ? 'rtl' : 'ltr');
    }
    doc.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'), undefined, resolved);
    });
    doc.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'), undefined, resolved);
    });
    doc.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title'), undefined, resolved));
    });
    doc.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'), undefined, resolved));
    });
    doc.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'), undefined, resolved));
    });
    const title = doc.querySelector('title[data-i18n]');
    if (title) title.textContent = t(title.getAttribute('data-i18n'), undefined, resolved);
  }

  const api = {
    LOCALES,
    dictionaries: dicts,
    normalizeLocale,
    resolveLocale,
    currentLocale,
    htmlLang,
    isRtl,
    t,
    translateDocument,
  };

  globalThis.OD_CLIPPER_I18N = api;
})();
