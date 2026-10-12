import { expect, test } from 'vitest';
import { renderBlindSheet } from '../../benchmarks/quality/calibration-sheet.ts';
import { referenceProtocol } from '../../benchmarks/quality/reference-capture.ts';
test('blind sheet includes every anchored criterion, explicit submission and local persistence', () => {
  const html = renderBlindSheet({ schema: 'quality-calibration-set/1', setId: 'test', items: [{ id: 'P01', screenshots: [{ width: 1440, height: 900, file: 'a.png', sha256: 'a' }, { width: 390, height: 844, file: 'b.png', sha256: 'b' }], unavailable: ['briefFidelity', 'craft', 'accessibility'], limitation: '' }], rubricDigest: 'bar', protocolDigest: 'protocol' });
  expect(html).toContain('localStorage'); expect(html).toContain('Download JSON'); expect(html).toContain('submittedAt');
  expect(html).toContain('Distinctive and confident'); expect(html).toContain('not assessable');
  expect(html).not.toContain('https://'); expect(html).toContain('value="E"');
  expect(referenceProtocol.viewports.map(v => v.width)).toEqual([1440, 390]);
});
test('autosave identity includes screenshot digest and image links refuse remote prefixes', () => {
  const set = { schema:'quality-calibration-set/1' as const,setId:'same',rubricDigest:'bar',protocolDigest:'capture',items:[] };
  const first=renderBlindSheet(set);const second=renderBlindSheet({...set,protocolDigest:'changed'});
  expect(first.match(/const key=.*?;/u)?.[0]).not.toBe(second.match(/const key=.*?;/u)?.[0]);
  expect(first).toContain('saved.setDigest===');
  expect(()=>renderBlindSheet(set,'javascript:')).toThrow(/relative/);
});
