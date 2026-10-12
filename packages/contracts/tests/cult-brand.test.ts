import { describe, expect, it } from 'vitest';

import {
  assignCultSlugs,
  cultBrandFreeLabel,
  cultBrandRun,
  cultNameTokens,
  cultBrandFreeIdentifier,
  cultBrandFreePath,
  cultBrandFreeSegment,
  cultPublicSlugBase,
  cultSlugify,
  isCultBrandFree,
  isCultBrandFreeLabel,
} from '../src/api/cult-brand';

const ROW_SLUGS = new Map([['marketing-about-vite', 'about-series-vt']]);

describe('cult public slugs', () => {
  it('slugifies the brand-free display title', () => {
    expect(cultPublicSlugBase('Marketing Pricing Vercel')).toBe('pricing-series-v');
    expect(cultPublicSlugBase('Stripe Subscription')).toBe('card-payment-subscription');
    expect(cultPublicSlugBase('apple-keyboard-demo')).toBe('keyboard-demo-series-a');
    expect(cultSlugify('Web App + Forms')).toBe('web-app-forms');
  });

  it('is deterministic whatever the row order', () => {
    const rows = [
      { id: 'cult:b', name: 'b', title: 'Marketing Hero Vite' },
      { id: 'cult:a', name: 'a', title: 'Hero Vite' },
    ];
    expect(assignCultSlugs(rows)).toEqual(assignCultSlugs([...rows].reverse()));
    expect(assignCultSlugs(rows)).toEqual({ 'cult:a': 'hero-series-vt', 'cult:b': 'hero-series-vt-2' });
  });

  it('keeps a previous numbered slug from -2 through -19 and beyond', () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `cult:r${String(i).padStart(2, '0')}`, name: `r${i}`, title: 'Hero Vite' }));
    const fresh = assignCultSlugs(rows);
    expect(fresh['cult:r10']).toBe('hero-series-vt-11');
    expect(fresh['cult:r20']).toBe('hero-series-vt-21');
    // Regenerating with the committed slugs changes nothing, the two-digit ones included.
    expect(assignCultSlugs(rows, fresh)).toEqual(fresh);
    // A row that held `-15` keeps it even when the rows before it change.
    const shuffled = assignCultSlugs(rows.slice(5), fresh);
    expect(shuffled['cult:r14']).toBe('hero-series-vt-15');
    expect(shuffled['cult:r19']).toBe('hero-series-vt-20');
  });

  it('drops a stale or foreign previous slug', () => {
    const rows = [{ id: 'cult:a', name: 'a', title: 'Hero Vite' }];
    expect(assignCultSlugs(rows, { 'cult:a': 'marketing-hero-vite' })).toEqual({ 'cult:a': 'hero-series-vt' });
    expect(assignCultSlugs(rows, { 'cult:a': 'footer-series-v' })).toEqual({ 'cult:a': 'hero-series-vt' });
    expect(assignCultSlugs(rows, { 'cult:a': 'hero-series-vt-1' })).toEqual({ 'cult:a': 'hero-series-vt' });
    expect(assignCultSlugs(rows, { 'cult:a': 'hero-series-vt-07' })).toEqual({ 'cult:a': 'hero-series-vt' });
  });
});

describe('brand-free file and folder names', () => {
  it.each([
    ['pricing-vite.tsx', 'pricing-series-vt.tsx'],
    ['apple-keyboard.tsx', 'keyboard-series-a.tsx'],
    ['stripe.ts', 'card-payment.ts'],
    ['redis.ts', 'cache.ts'],
    ['polar.ts', 'payments-service.ts'],
    ['i-phone-frame.tsx', 'phone-frame-series-a.tsx'],
    // A camelCase name is split first, so no brand hides inside one lower-cased word.
    ['postgresGradient', 'database-gradient'],
    ['marketing-about-vite', 'about-series-vt'],
    ['button.tsx', 'button.tsx'],
    ['globals.css', 'globals.css'],
  ])('%s → %s', (segment, expected) => {
    expect(cultBrandFreeSegment(segment, ROW_SLUGS)).toBe(expected);
  });

  it('renames every segment of a path or import specifier, and leaves scopes and dots alone', () => {
    expect(cultBrandFreePath('sections/marketing-about-vite/page.tsx', ROW_SLUGS)).toBe('sections/about-series-vt/page.tsx');
    expect(cultBrandFreePath('../lib/stripe', ROW_SLUGS)).toBe('../lib/card-payment');
    expect(cultBrandFreePath('@/components/hero-vite', ROW_SLUGS)).toBe('@/components/hero-series-vt');
  });

  it('renames a directory segment that is a row\'s own internal name even when it names no brand (G11)', () => {
    // "marketing-cta-hex" carries no denied brand, so `isCultBrandFree` alone would leave it
    // unchanged; a directory segment must still take the row's public slug.
    const rowSlugs = new Map([...ROW_SLUGS, ['marketing-cta-hex', 'cta-hex']]);
    expect(isCultBrandFree('marketing-cta-hex')).toBe(true);
    expect(cultBrandFreeSegment('marketing-cta-hex', rowSlugs)).toBe('marketing-cta-hex');
    expect(cultBrandFreePath('sections/marketing-cta-hex/page.tsx', rowSlugs)).toBe('sections/cta-hex/page.tsx');
    expect(cultBrandFreePath('sections/marketing-cta-hex/layout.tsx', rowSlugs)).toBe('sections/cta-hex/layout.tsx');
    // Only a directory segment is retargeted this way: a file named exactly like the row (its last
    // path segment) is still named by `cultBrandFreeSegment` alone.
    expect(cultBrandFreePath('components/marketing-cta-hex.tsx', rowSlugs)).toBe('components/marketing-cta-hex.tsx');
  });
});

describe('brand-free export names', () => {
  it.each([
    ['VercelPricing', 'PricingSeriesV'],
    ['useStatsVite', 'useStatsSeriesVT'],
    ['STRIPE_SUB_CACHE', 'CARD_PAYMENT_SUB_CACHE'],
    ['AppleIphone17Pro', 'PhoneSeriesA'],
    ['RedditLogo', 'ForumLogo'],
    ['Polar', 'PaymentsService'],
    // A hump splitter cuts these names apart ("I Phone", "Open AI"); joined runs still catch them.
    ['IPhone17ProMax', 'PhoneSeriesA'],
    ['IPhoneProps', 'PhonePropsSeriesA'],
    ['AppleIPhone17ProDemo', 'PhoneDemoSeriesA'],
    ['IPadPro', 'TabletSeriesA'],
    ['OpenAIIconWhite', 'HostedModelIconWhite'],
    ['GitHubIcon', 'Icon'],
    ['TriggerDevLogo', 'BackgroundJobLogo'],
    // A context-only name counts in an integration mark.
    ['LinearIcon', 'Icon'],
  ])('%s → %s', (name, expected) => {
    const next = cultBrandFreeIdentifier(name);
    expect(next).toBe(expected);
    expect(isCultBrandFree(next!)).toBe(true);
  });

  it('leaves a brand-free name alone', () => {
    expect(cultBrandFreeIdentifier('HeroSimple')).toBeNull();
    expect(cultBrandFreeIdentifier('useTier')).toBeNull();
  });

  it.each(['IPhone17ProMax', 'IPhoneProps', 'IPadPro', 'OpenAIIconWhite', 'GitHubIcon', 'trigger-dev-actions', 'LinearIcon'])(
    'reads %s as branded', (name) => {
      expect(isCultBrandFree(name)).toBe(false);
    },
  );

  it.each(['MachineCard', 'InviteForm', 'LinearGradient', 'NotionalValue', 'PadLeft', 'OpenIcon'])(
    'does not read %s as branded (a whole run must be the name)', (name) => {
      expect(isCultBrandFree(name)).toBe(true);
    },
  );

  it('finds the shortest brand run of joined words', () => {
    expect(cultNameTokens('OpenAIIconWhite')).toEqual(['Open', 'AI', 'Icon', 'White']);
    expect(cultBrandRun(cultNameTokens('IPhone17ProMax'))).toMatchObject({ start: 0, end: 2 });
    expect(cultBrandRun(cultNameTokens('OpenAIIconWhite'))).toMatchObject({ start: 0, end: 2 });
    expect(cultBrandRun(cultNameTokens('LinearGradient'))).toBeNull();
  });
});

describe('brand-free labels', () => {
  it.each([
    ['Discord', 'A third-party service'],
    ['GitHub', 'A code host'],
    ['Visit us on GitHub', 'Visit us on a code host'],
    ['Follow us on Slack', 'Follow us on a third-party service'],
  ])('%s → %s', (label, expected) => {
    expect(isCultBrandFreeLabel(label)).toBe(false);
    expect(cultBrandFreeLabel(label)).toBe(expected);
    expect(isCultBrandFreeLabel(expected)).toBe(true);
  });

  it('reads a context-only name as the brand in a label, unlike in running text', () => {
    expect(isCultBrandFree('Discord')).toBe(true);
    expect(isCultBrandFreeLabel('Discord')).toBe(false);
    expect(isCultBrandFreeLabel('Newsletter')).toBe(true);
  });
});
