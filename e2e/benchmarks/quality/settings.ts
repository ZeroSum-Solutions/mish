export const VIEWPORTS = [
  { width: 320, height: 640 }, { width: 375, height: 812 }, { width: 390, height: 844 },
  { width: 768, height: 1024 }, { width: 1440, height: 900 },
] as const;
export const CAPTURE_SETTINGS = {
  schema: 'quality-captures/2', viewports: VIEWPORTS, deviceScaleFactor: 1,
  reducedMotion: 'reduce', comparisonMotion: 'no-preference', fullPage: true, viewportWidthClip: true,
  sectionSelector: 'header,nav,main,section,article,aside,footer,[role="banner"],[role="navigation"],[role="main"],[role="region"],[role="complementary"],[role="contentinfo"]',
  keyboardStepLimit: 200, formSettleWindowMs: 1000, motionSampleFrames: 12, serviceWorkers: 'block', remoteRequests: 'block',
} as const;
