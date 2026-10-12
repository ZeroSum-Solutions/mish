import { expect, it } from 'vitest';
import type { ResourceCandidate } from '@mish/contracts';
import { rankContextualResources } from '../../src/workbench/context-ranking.js';
import { candidate, savedContext, booking } from './context-ranking-fixture.js';
const ids = (items: readonly ResourceCandidate[]) => items.map(item => item.ref.itemId);
it('retrieves long dentistry requests from actual saved spine and section taxonomy without changing grants', () => {
  const saved = savedContext({ spineCode: 'SM', conversions: [booking] });
  const items = [candidate('calendar', { sectionKind: 'booking-availability' }), candidate('hero', { spineAffinities: ['SM'] }), candidate('broad', { spineAffinities: 'any' }), candidate('unknown', { spineAffinities: 'unclassified', sectionKind: 'unclassified' })];
  const original = structuredClone(items);
  const ranked = rankContextualResources(items, 'Build a calm premium dentistry landing page where patients book their first appointment', saved);
  expect(ranked).toMatchObject({ rankable: true, timedOut: false }); expect(ids(ranked.items)).toEqual(['hero', 'calendar']);
  expect(ranked.items[0]?.fitReasons.join(' ')).toContain('spineAffinities'); expect(ranked.items[0]?.fitReasons.join(' ')).toContain('SM');
  expect(ranked.items[1]?.fitReasons.join(' ')).toContain('booking-availability'); expect(ranked.items[1]?.fitReasons.join(' ')).toContain('booking');
  for (const item of ranked.items) { const { fitReasons: _reasons, ...fields } = item; const { fitReasons: _old, ...input } = original.find(entry => entry.ref.itemId === item.ref.itemId)!; expect(fields).toEqual(input); }
  expect(items).toEqual(original);
});
it('preserves all-token lowercase substring literal matching over the exact existing metadata fields', () => {
  const items = [candidate('needle-id', { title: 'ALPHA', category: 'component', sourceAttribution: { title: 'Provider' }, styleTags: ['beta'] }), candidate('wrong', { title: 'Alpha only' })];
  expect(ids(rankContextualResources(items, '  alp\nCOMP  needle prov bet ', savedContext()).items)).toEqual(['needle-id']);
  expect(ids(rankContextualResources(items, 'alpha absent', savedContext()).items)).toEqual([]);
  expect(ids(rankContextualResources(items, '', savedContext()).items)).toEqual(['needle-id', 'wrong']);
});
it('pins +30 spine, +20 primary, +10 total secondary and +15 literal through score ties and boundaries', () => {
  const context = savedContext({ spineCode: 'SM', conversions: [booking, { id: 'call', kind: 'call', role: 'secondary', label: 'Call' }, { id: 'contact', kind: 'contact', role: 'secondary', label: 'Contact' }, { id: 'download', kind: 'download', role: 'secondary', label: 'Download' }] });
  const items = [
    candidate('all', { title: 'D all', styleTags: ['needle'], spineAffinities: ['SM'], sectionKind: 'cta-band' }), //75
    candidate('spine-primary', { title: 'C combined', spineAffinities: ['SM'], sectionKind: 'booking-availability' }), //50
    candidate('spine-literal', { title: 'A tie', spineAffinities: ['SM'], styleTags: ['needle'] }), //45
    candidate('primary-secondary-literal', { title: 'B tie', sectionKind: 'cta-band', styleTags: ['needle'] }), //45
    candidate('spine-secondary', { spineAffinities: ['SM'], sectionKind: 'contact-form' }), //40
    candidate('primary-literal', { sectionKind: 'booking-availability', styleTags: ['needle'] }), //35
    candidate('primary-secondary', { title: 'A thirty', sectionKind: 'cta-band' }), //30 even three secondaries
    candidate('spine', { title: 'B thirty', spineAffinities: ['SM'] }), //30
    candidate('primary', { sectionKind: 'booking-availability' }), //20
    candidate('literal', { styleTags: ['needle'] }), //15
    candidate('secondary', { sectionKind: 'contact-form' }), //10 despite call+contact
  ];
  expect(ids(rankContextualResources(items.reverse(), 'needle', context).items)).toEqual(['all','spine-primary','spine-literal','primary-secondary-literal','spine-secondary','primary-literal','primary-secondary','spine','primary','literal','secondary']);
});
it.each([
  ['signup', ['newsletter-waitlist','cta-band']], ['subscribe', ['newsletter-waitlist','cta-band']],
  ['call', ['contact-form','cta-band','location-map-hours']], ['contact', ['contact-form','cta-band','location-map-hours']],
  ['booking', ['booking-availability','cta-band']], ['purchase', ['product-grid','pricing','cta-band']], ['download', ['cta-band']],
] as const)('maps saved %s only to its declared sectionKind taxonomy', (kind, kinds) => {
  const saved = savedContext({ conversions: [{ ...booking, kind }] });
  const items = [...kinds.map(sectionKind => candidate(sectionKind, { sectionKind })), candidate('not-fit', { sectionKind: 'hero' })];
  expect(new Set(ids(rankContextualResources(items, 'long unmatched query', saved).items))).toEqual(new Set(kinds));
});
it('keeps supported zero-fit contexts applied but does not infer from prose, brand, any or unclassified', () => {
  const items = [candidate('Dental Premium React', { spineAffinities: 'any', sectionKind: 'unclassified' })];
  expect(rankContextualResources(items, 'different tokens', savedContext({ spineCode: 'SM' }))).toMatchObject({ rankable: true, items: [] });
  const unsupported = savedContext({ purpose: 'Dentistry call to action in React', styleDirection: 'windows95', brandDirection: 'Premium', conversions: [{ ...booking, kind: 'other' }] });
  expect(rankContextualResources(items, 'dental', unsupported)).toMatchObject({ rankable: false });
  expect(ids(rankContextualResources(items, 'dental', unsupported).items)).toEqual(['Dental Premium React']);
});
it('excludes explicit animation for motion none without admitting irrelevant nonliteral candidates', () => {
  const motion = (state: 'animated'|'reduced-compatible'|'static'|'unknown') => ({ state, basis: 'declared' as const, sourceRevisionOrDigest: 'v1', field: 'manifest.motion' });
  const items = [candidate('needle-motion', { category: 'motion' }), candidate('needle-animated', { motionMetadata: motion('animated') }), candidate('needle-reduced', { motionMetadata: motion('reduced-compatible') }), candidate('needle-static', { motionMetadata: motion('static') }), candidate('needle-unknown'), candidate('irrelevant')];
  const ranked = rankContextualResources(items, 'needle', savedContext({ constraints: [{ id: 'no-motion', kind: 'motion', value: 'none' }] }));
  expect(ranked.rankable).toBe(true); expect(ids(ranked.items)).toEqual(['needle-static','needle-unknown']);
  expect(ranked.excluded).toEqual([{ reason: 'motion-constraint', constraintId: 'no-motion', count: 3 }]);
  expect(ranked.items[1]?.fitReasons.join(' ').toLowerCase()).toContain('unknown'); expect(ranked.items[1]?.motionMetadata).toBeUndefined();
});
it('keeps reduced-compatible declarations advisory and excludes only animated motion under reduced', () => {
  const item = candidate('reduced', { motionMetadata: { state: 'reduced-compatible', basis: 'declared', sourceRevisionOrDigest: 'v1', field: 'manifest.motion' } });
  const ranked = rankContextualResources([item,candidate('unknown',{category:'motion'}),candidate('animated',{motionMetadata:{state:'animated',basis:'observed',sourceRevisionOrDigest:'v1',field:'probe.motion',evidenceRef:'probe1'}})], '', savedContext({ constraints: [{ id: 'reduced', kind: 'motion', value: 'reduced' }] }));
  expect(ids(ranked.items)).toEqual(['reduced','unknown']); expect(ranked.items[0]?.fitReasons.join(' ')).toContain('advisory');
  expect(ranked.excluded).toEqual([{ reason: 'motion-constraint', constraintId: 'reduced', count: 1 }]);
});
it('deduplicates exact refs and uses variant title collation then bytewise encoded ref keys', () => {
  const items = [candidate('z', { title: 'Same' }), candidate('a', { title: 'Same' }), candidate('a', { title: 'Same' }), candidate('upper', { title: 'Alpha' }), candidate('lower', { title: 'alpha' })];
  const keys = (id: string) => Buffer.from(JSON.stringify([1,'section','sections',id,'v1'])).toString('base64url');
  const tied = ['z','a'].sort((a,b) => Buffer.compare(Buffer.from(keys(a)),Buffer.from(keys(b))));
  const result = rankContextualResources(items, '', savedContext({ spineCode: 'SM' }));
  expect(ids(result.items)).toEqual(['lower','upper',...tied]); expect(rankContextualResources([...items].reverse(), '', savedContext({ spineCode: 'SM' })).items).toEqual(result.items);
});
it('discards contextual rankings on deadline expiry after sorting and retains literal motion exclusions', () => {
  const items = [candidate('contextual',{spineAffinities:['SM']}),candidate('needle-z'),candidate('needle-a'),candidate('needle-animation',{category:'motion'})];
  const ticks = [0,0,0,251]; let index = 0;
  const result = rankContextualResources(items, 'needle', savedContext({ spineCode: 'SM', constraints: [{ id:'no-motion',kind:'motion',value:'none' }] }), { now: () => ticks[index++] ?? 251 });
  expect(result).toMatchObject({ rankable: true, timedOut: true }); expect(ids(result.items)).toEqual(['needle-a','needle-z']);
  expect(result.excluded).toEqual([{reason:'motion-constraint',constraintId:'no-motion',count:1}]);
  expect(result.items.flatMap(item=>item.fitReasons).join(' ')).not.toContain('spineAffinities');
});

it('checks the deadline between bounded batches and includes late literal fallback candidates', () => {
  const observed = new Set<string>();
  const items = Array.from({length:65},(_,index)=>{
    const item = candidate(`context-${index}`,{spineAffinities:['SM']});
    Object.defineProperty(item,'spineAffinities',{get(){observed.add(item.ref.itemId);return ['SM'];}});
    return item;
  });
  items.push(candidate('needle-a'),candidate('needle-b'));
  const ticks=[0,0,251]; let index=0;
  const ranked=rankContextualResources(items,'needle',savedContext({spineCode:'SM'}),{now:()=>ticks[index++]??251});
  expect(ranked.timedOut).toBe(true); expect(ids(ranked.items)).toEqual(['needle-a','needle-b']);
  expect(observed.size).toBeGreaterThan(0); expect(observed.size).toBeLessThan(65);
  expect(ranked.items.flatMap(item=>item.fitReasons).join(' ')).not.toContain('spineAffinities');
});
