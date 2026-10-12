import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

const homeHeroSource = read('../../src/components/HomeHero.tsx');
const entryNavRailSource = read('../../src/components/EntryNavRail.tsx');
const appLayoutSource = read('../../app/layout.tsx');
const logoSvg = read('../../public/logo.svg');
const brandIconSvg = read('../../public/brand-icon.svg');
// #5517: the home hero header shows the full logotype instead of
// the small glyph + name pair; the asset must ship with the app.
const heroLogotypeSvg = read('../../public/logo-03.svg');
// Round 7: the animated logotype is driven by the particle wordmark renderer
// (see home-hero/pixel-scan/engine.ts), which samples this SVG's alpha channel
// as the glyph mask it assembles from canvas particles.
const heroPixelScanSvg = read('../../public/logo-scan.svg');
const homeHeroCss = read('../../src/styles/home/home-hero.css');
const appIconSvg = read('../../public/app-icon.svg');

const masterMark = read('../../../../assets/brand/mishh-mashh-mark.svg');
const markPaths = [...masterMark.matchAll(/ d="([^"]+)"/g)].map(match => match[1]);
const RETIRED_OPEN_DESIGN_MARKERS = ['M41 0.726562', 'M212.059', 'clip0_1389_574'];

describe('Home logo assets', () => {
  it('ships the Mishh Mashh monogram without the retired upstream glyph', () => {
    expect(markPaths).toHaveLength(5);
    for (const source of [logoSvg, brandIconSvg, appIconSvg]) {
      for (const markPath of markPaths) expect(source).toContain(markPath);
    }
    for (const marker of RETIRED_OPEN_DESIGN_MARKERS) {
      expect(logoSvg).not.toContain(marker);
      expect(brandIconSvg).not.toContain(marker);
      expect(appIconSvg).not.toContain(marker);
    }
  });

  it('ships the approved app icon and metadata links', () => {
    expect(brandIconSvg).toContain('viewBox="0 0 1024 1024"');
    expect(brandIconSvg).toContain('#FF674F');
    expect(appLayoutSource).toContain("icon: '/app-icon.svg'");
    expect(appLayoutSource).toContain("apple: '/app-icon.svg'");
    expect(appLayoutSource).not.toContain('/app-icon.png');
  });

  it('renders the brand mark on the Home hero', () => {
    // #5517: the hero renders the shipped logotype image (not the glyph pair).
    expect(heroLogotypeSvg).toContain('<svg');
    // Round 7: the hero mounts the animated PixelScanLogo component instead of
    // a plain <img>; the logotype now ships as the particle engine's sample
    // source (logo-scan.svg) rather than an inline `src="/logo-03.svg"`.
    expect(heroPixelScanSvg).toContain('<svg');
    expect(heroLogotypeSvg).toContain('Mishh Mashh');
    expect(heroPixelScanSvg).toContain('Mishh Mashh');
    expect(heroLogotypeSvg).not.toContain('<text');
    expect(heroPixelScanSvg).not.toContain('<text');
    expect(heroPixelScanSvg).toContain('data-typeface="Griggs Flare SemiBold"');
    expect(heroPixelScanSvg).toContain('viewBox="0 0 6345 725"');
    expect(homeHeroCss).toContain('aspect-ratio: 6345 / 725');
    expect(heroPixelScanSvg).not.toContain('clip0_1389_574');
    expect(homeHeroSource).toContain('<PixelScanLogo');
    expect(homeHeroSource).not.toContain('src="/logo-03.svg"');
    expect(homeHeroSource).not.toContain('src="/app-icon.svg"');

    // #6156 cut the rail's signed-out brand header entirely — with no cloud
    // identity the rail now starts at the search box, and expand/collapse moved
    // to the workspace tabs bar's pinned Home toggle. So the rail carries no
    // brand mark at all; what still matters is that it never falls back to the
    // retired raster app icon.
    expect(entryNavRailSource).not.toContain('src="/app-icon.svg"');
  });
});
