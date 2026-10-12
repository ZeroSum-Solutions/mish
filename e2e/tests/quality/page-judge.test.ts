import { expect, test } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as judge from '../../benchmarks/quality/judge.ts';
import { summarizeSamples } from '../../benchmarks/quality/samples.ts';
import { packet } from '../../lib/quality/packet-fixture.ts';
import type { CaseRun, CaptureFact } from '../../benchmarks/quality/types.ts';
import { baselineFiles } from '../../resources/quality-baseline-01.ts';
test('real five-width page evidence stays bounded and includes source without sibling images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-page-'));
  try {
    const saved = JSON.parse(Buffer.from(baselineFiles['packet.json']!, 'base64').toString()) as { case: CaseRun; facts: CaptureFact[]; brief: unknown };
    await mkdir(join(root, 'cases/dental/files'), { recursive: true });
    await mkdir(join(root, 'screenshots'));
    for (const name of saved.case.files.map(f => f.name).filter(name => ['contact.html', 'about.html'].includes(name) || /\.(css|js|mjs)$/.test(name))) {
      await mkdir(join(root, 'cases/dental/files', name, '..'), {recursive:true});
      await writeFile(join(root, 'cases/dental/files', name), Buffer.from(baselineFiles[/\.(js|mjs)$/.test(name) ? `${name}.txt` : name]!, 'base64'));
    }
    for (const fact of saved.facts.filter(f => [1440, 390].includes(f.viewport.width))) await writeFile(join(root, fact.screenshot), Buffer.from(baselineFiles[fact.screenshot.split('/').at(-1)!]!, 'base64'));
    const payload = await judge.buildPagePayload(root, saved.case, 'contact.html', saved.facts, saved.brief, false);
    expect(payload.images.length).toBeGreaterThan(2);
    expect(payload.images.every(i => i.label.includes('contact.html') && /at (1440|390)x/.test(i.label))).toBe(true);
    expect(payload.images.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(payload.content))).toBeLessThan(24_000_000);
    expect(payload.text).toContain('site.css'); expect(payload.text).toContain('site.js');
    expect(payload.text).toContain('320'); expect(payload.text).toContain('375'); expect(payload.text).toContain('768');
    expect(payload.text).not.toContain('<title>About');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('whole-site scores keep weak inner pages and optional null reasons visible', () => {
  const p = packet(); const rating = p.judgments.cases[0]!;
  rating.samples = ['index.html', 'about.html'].flatMap(page => rating.samples.map(s => ({ ...structuredClone(s), page,
    criteria: Object.fromEntries(p.judgments.rubric.criteria.map(c => [c.id, c.id === 'craft' ? null : page === 'index.html' ? 5 : 2])),
    evidence: { ...s.evidence, craft: 'Uncaptured carousel interaction; not assessable.' },
    inventory: { ...s.inventory, unreadEvidence: ['Carousel active state not captured'] },
  })));
  const summary = summarizeSamples(rating, p.judgments.rubric, p.judgments.reviewers);
  expect(summary.criteria.imagery).toBe(2);
  expect(summary.criteria.craft).toBeNull();
  expect(summary.pages.map(page => page.page)).toEqual(['index.html', 'about.html']);
  expect(summary.pages[1]!.criteria.imagery).toBe(2);
});
test('unread interaction states do not void evidence, but an unscored required visual criterion does', () => {
  const p = packet(); const sample = p.judgments.cases[0]!.samples[0]!;
  sample.criteria.craft = null;
  sample.evidence!.craft = 'Uncaptured carousel state; not assessable.';
  sample.inventory.unreadEvidence = ['Carousel state'];
  expect(judge.missingRequiredCriteria(sample, p.judgments.rubric)).toEqual([]);
  sample.criteria.imagery = null;
  expect(judge.missingRequiredCriteria(sample, p.judgments.rubric)).toEqual(['imagery']);
});
test('partial optional evidence retains an informational site letter without inventing criterion scores', async () => {
  const { scoreBenchmark } = await import('../../benchmarks/quality/score.ts');
  const p = packet();
  for (const sample of p.judgments.cases[0]!.samples) {
    sample.grade = 'C'; sample.criteria.craft = null;
    sample.evidence!.craft = 'Uncaptured menu state; not assessable.';
    sample.inventory.unreadEvidence = ['Menu active state'];
  }
  const score = scoreBenchmark(p.run, p.captures, p.judgments).cases[0]!;
  const { informationalLetters } = await import('../../benchmarks/quality/letters.ts');
  expect(informationalLetters(p.judgments.cases[0]!).letter).toBe('C'); expect(score.criteria.craft).toBeNull();
  expect(score.recommendation).toBeNull();
  expect(score.missingEvidence).not.toContain('Menu active state');
  p.judgments.cases[0]!.origin = 'missing-evidence'; p.judgments.cases[0]!.reason = 'Required visual evidence missing';
  expect(informationalLetters(p.judgments.cases[0]!).letter).toBeNull();
});
test('nested pages publish and resume page receipts without losing the model result', async () => {
  const { runBenchmark } = await import('../../benchmarks/quality/run.ts');
  const { startStub } = await import('../../benchmarks/quality/stub.ts');
  const { missingProbeEvidence } = await import('../../lib/quality/fixtures.ts');
  const { VIEWPORTS } = await import('../../benchmarks/quality/settings.ts');
  const { rename } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'quality-nested-')); const stub = await startStub();
  try {
    const out = join(root, 'run');
    const run = await runBenchmark({daemon:stub.url,out,agent:'stub',model:'stub',timeoutMs:1000,mode:'stub',caseId:'dental'});
    const item = run.cases[0]!; const page = item.files.find(f=>f.name==='index.html')!;
    await mkdir(join(out,'cases/dental/files/blog'),{recursive:true});
    await rename(join(out,'cases/dental/files/index.html'),join(out,'cases/dental/files/blog/post.html')); page.name='blog/post.html';
    item.files=item.files.filter(f=>!f.name.endsWith('.html')||f.name===page.name);
    const facts = VIEWPORTS.map(viewport=>({...missingProbeEvidence(`nested-${viewport.width}`),caseId:'dental',page:page.name,viewport,screenshot:'unused.png',horizontalOverflowPx:0,consoleErrors:[],brokenImages:[],blockedRequests:[]}));
    const captures = {schema:'quality-captures/2' as const,runId:run.runId,captureProtocolDigest:'fixture',browser:'stub',facts};
    const options = {rubricPath:new URL('../../../docs/quality/agency-bar.md',import.meta.url).pathname,model:'stub',stub:true,timeoutMs:1000};
    const result = await judge.judgeRun(out,run,captures,options);
    expect(result.cases[0]!.samples).toHaveLength(6);
    await rm(join(out,'judgments.json'));
    expect((await judge.judgeRun(out,run,captures,options)).cases).toEqual(result.cases);
  } finally { await stub.close(); await rm(root,{recursive:true,force:true}); }
});
