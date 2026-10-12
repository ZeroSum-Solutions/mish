import { expect, test } from 'vitest';
import { packet } from '../../lib/quality/packet-fixture.ts';
import { informationalLetters } from '../../benchmarks/quality/letters.ts';
test('informational letters keep known criterion caps and weak inner pages', () => {
  const rating = packet().judgments.cases[0]!;
  rating.samples = ['index.html','contact.html'].flatMap(page=>rating.samples.map(s=>({...structuredClone(s), page, grade:'A' as const,
    criteria:Object.fromEntries(Object.keys(s.criteria).map(id=>[id,page==='contact.html' && id==='imagery'?1:5])) })));
  expect(informationalLetters(rating,'pass').pages).toEqual([{page:'index.html',letter:'A',derivedLetters:0},{page:'contact.html',letter:'C',derivedLetters:0}]);
  expect(informationalLetters(rating).letter).toBe('C');
});

test('incomplete eligibility prevents an informational A',()=>{const r=packet().judgments.cases[0]!;for(const s of r.samples){s.grade='A';s.criteria=Object.fromEntries(Object.keys(s.criteria).map(id=>[id,5]));}expect(informationalLetters(r).letter).toBe('B');});
test('a missing optional overall letter does not discard substantiated criterion scores',()=>{
  const r=packet().judgments.cases[0]!;
  for(const s of r.samples){s.grade='C';s.criteria=Object.fromEntries(Object.keys(s.criteria).map(id=>[id,id==='craft'?null:3]));}
  r.samples[0]!.grade=null;
  expect(informationalLetters(r).letter).toBe('C');
  expect(informationalLetters(r).pages[0]!.derivedLetters).toBe(1);
});
test('six derived sample letters stay capped and leave raw nulls intact',()=>{
  const r=packet().judgments.cases[0]!;
  for(const s of r.samples){s.grade=null;s.criteria=Object.fromEntries(Object.keys(s.criteria).map(id=>[id,id==='craft'?null:5]));}
  const result=informationalLetters(r);
  expect(result.letter).toBe('B');expect(result.pages[0]!.derivedLetters).toBe(6);
  expect(r.samples.every(s=>s.grade===null&&s.criteria.craft===null)).toBe(true);
  r.samples[0]!.criteria.imagery=null;
  expect(informationalLetters(r).letter).toBeNull();
});
test('derived home-page letters cannot offset a weak inner page',()=>{
  const r=packet().judgments.cases[0]!;
  r.samples=['index.html','contact.html'].flatMap(page=>r.samples.map(s=>({...structuredClone(s),page,grade:null,
    criteria:Object.fromEntries(Object.keys(s.criteria).map(id=>[id,id==='craft'?null:page==='index.html'?5:2]))})));
  expect(informationalLetters(r).letter).toBe('D');
});
