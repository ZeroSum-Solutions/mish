import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as draftStore from '../../src/workbench/capture/draft-store.js';
import { createCaptureService } from '../../src/workbench/capture/capture-service.js';
import { createCaptureDraftService, type CaptureDraftGenerator } from '../../src/workbench/capture/draft-service.js';
import { createUnitService } from '../../src/workbench/units/unit-service.js';
import { fileCaptureBytes, pngBytes, sha } from './capture-fixture.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const HTML = '<!doctype html><html><head><title>Draft</title><style>body{color:#111}#hero{padding:24px}</style></head><body><nav>Other region</nav><section id="hero"><h1>Hello</h1><button onclick="this.textContent=\'Booked\'">Book</button></section></body></html>';
async function setup(generate: CaptureDraftGenerator['generate'] = async () => ({ html: HTML, assumptions: ['The font cannot be identified from pixels.'] })) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'od-capture-draft-')); dirs.push(dataDir);
  const captures = createCaptureService({ dataDir, bytes: fileCaptureBytes(path.join(dataDir, 'bytes')) });
  const capture = (await captures.import({ metadata: { projectId: 'p1', captureMode: 'upload', frame: { width: 40, height: 30 } }, body: pngBytes(40, 30), mediaType: 'image/png', idempotencyKey: 'capture', surface: 'web' })).view.capture;
  const generator: CaptureDraftGenerator = { modelId: 'claude-sonnet-5-5', available: async () => true, generate };
  const drafts = createCaptureDraftService({ dataDir, captures, generator });
  return { dataDir, capture, captures, drafts, generator, request: { projectId: 'p1', captureId: capture.id, prompt: 'Reconstruct this. The Book button changes to Booked.' } };
}

describe('AC-R14.2-.3 capture to persisted draft to unit', () => {
  it.each(['request', 'saveKey'] as const)('keeps a poll during %s publication pending and retains the real result', async boundary => {
    const original = draftStore.createCaptureDraftStore;
    let drafts: ReturnType<typeof createCaptureDraftService>;
    let polled: string | undefined;
    vi.spyOn(draftStore, 'createCaptureDraftStore').mockImplementation(dataDir => {
      const store = original(dataDir);
      return { ...store, [boundary]: async (...args: Parameters<typeof store[typeof boundary]>) => {
        // Publish the actual on-disk request, then force a poll before registration.
        const result = await (store[boundary] as (...values: typeof args) => Promise<boolean>)(...args);
        polled = (await drafts.list('local-daemon', 'p1')).drafts[0]?.status;
        return result;
      } };
    });
    const fixture = await setup(); drafts = fixture.drafts;
    const created = await drafts.create('local-daemon', fixture.request, 'racing-poll');
    const ready = await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1);
    expect(polled).toBe('pending');
    expect(ready).toMatchObject({ status: 'ready', html: HTML });
  });

  it('limits each principal to three active drafts without blocking another principal', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { drafts, request } = await setup(async () => { await gate; return { html: HTML, assumptions: [] }; });
    const active = [];
    try {
      for (let i = 0; i < 3; i++) active.push({ principal: 'alice', ...(await drafts.create('alice', request, `a-${i}`)).draft });
      await expect(drafts.create('alice', request, 'fourth')).rejects.toMatchObject({ code: 'draft-capacity-reached' });
      active.push({ principal: 'bob', ...(await drafts.create('bob', request, 'b-1')).draft });
    } finally {
      release();
      await Promise.all(active.map(record => drafts.settled(record.principal, record.projectId, record.draftId, record.revision)));
    }
    const resumed = await drafts.create('alice', request, 'after-completion');
    expect(resumed.created).toBe(true);
    await drafts.settled('alice', 'p1', resumed.draft.draftId, resumed.draft.revision);
  });

  it.each([
    ['metadata: unchanged', 'ready'],
    ['<script>navigator.sendBeacon("/collect", "pixels")</script>', 'failed'],
    ['<script>window.open("/collect")</script>', 'failed'],
    ['<script>navigator.sendBeacon?.("/collect", "pixels")</script>', 'failed'],
    ['<script>window.open?.("/collect")</script>', 'failed'],
    ['<script>window["open"]("/collect")</script>', 'failed'],
    ['<button onclick=\'window["open"]("/collect")\'>Go</button>', 'failed'],
    ['<a href="javascript:alert(1)">Run</a>', 'failed'],
    ['<a href="javascript&#58;alert(1)">Run</a>', 'failed'],
    ['<a href="java&#x09;script:alert(1)">Run</a>', 'failed'],
    ['<a href="java&#x0a;script:alert(1)">Run</a>', 'failed'],
    ['<a href="java&#x0d;script:alert(1)">Run</a>', 'failed'],
  ])('checks output policy for %s', async (content, status) => {
    const { drafts, request } = await setup(async () => ({ html: HTML.replace('<h1>Hello</h1>', content), assumptions: [] }));
    const created = await drafts.create('local-daemon', request, 'policy');
    expect((await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1)).status).toBe(status);
  });

  it.each([
    '<script>location.href = "/collect"</script>',
    '<script>location.assign("/collect")</script>',
    '<script>location.replace("/collect")</script>',
    '<script>window.location = "/collect"</script>',
    '<script>window["location"] = "/collect"</script>',
    '<script>self["location"].href = "/collect"</script>',
    '<script>top["location"].assign("/collect")</script>',
    '<script>location["href"] = "/collect"</script>',
    '<script>location?.["assign"]("/collect")</script>',
    '<button onclick=\'location["replace"]("/collect")\'>Go</button>',
    '<script>top.open("/collect")</script>',
    '<script>self.open("/collect")</script>',
    '<script>parent.open("/collect")</script>',
    '<script>top?.open("/collect")</script>',
    '<script>self["open"]("/collect")</script>',
    '<button onclick=\'parent["open"]("/collect")\'>Go</button>',
    '<a href="//external.example/collect">Go</a>',
    '<a href=//external.example/collect>Go</a>',
    '<a href="&#47;&#47;external.example/collect">Go</a>',
    '<a href="&#1;//external.example/collect">Go</a>',
    '<script>const target = "//external.example/collect";</script>',
    '<style>@import "//external.example/theme.css";</style>',
    '<style>@import url(//external.example/theme.css);</style>',
    '<style>@IMPORT "//external.example/theme.css";</style>',
    '<style>body{background:url(//external.example/image.png)}</style>',
    '<style>body{background:URL(//external.example/image.png)}</style>',
    '<style>body{background:url("//external.example/image.png")}</style>',
    '<div style="background:url(//external.example/image.png)">Image</div>',
    String.raw`<a href="\\external.example/collect">Go</a>`,
    String.raw`<a href="/\external.example/collect">Go</a>`,
    String.raw`<style>@\69mport "\2f\2f external.example/theme.css";</style>`,
    String.raw`<style>body{background:url(\/\/external.example/image.png)}</style>`,
  ])('refuses export navigation or external loading: %s', async content => {
    const { drafts, request } = await setup(async () => ({ html: HTML.replace('<h1>Hello</h1>', content), assumptions: [] }));
    const created = await drafts.create('local-daemon', request, 'export-policy');
    expect(await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1)).toMatchObject({ status: 'failed', html: null, failure: { reason: 'draft-output-invalid' } });
    await expect(drafts.unitSource('local-daemon', created.draft.draftId, 1)).rejects.toMatchObject({ code: 'draft-not-ready' });
  });

  it.each([
    '<style>.parent.open>ul{display:block}.top .open{color:red}.nav-top .open{padding:0}</style>',
    '<div data-location="NYC">Place</div>',
    '<style>input.location[type=text]{color:red}</style>',
    '<script>const parts = "a//b".split("//");</script>',
    '<a href="#hero">Jump to hero</a>',
    '<style>body{filter:url(#shadow)}</style>',
  ])('preserves self-contained markup and local behavior: %s', async content => {
    const html = HTML.replace('<h1>Hello</h1>', content);
    const { drafts, request } = await setup(async () => ({ html, assumptions: [] }));
    const created = await drafts.create('local-daemon', request, 'local-policy');
    expect(await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1)).toMatchObject({ status: 'ready', html });
    expect((await drafts.unitSource('local-daemon', created.draft.draftId, 1)).files[0]!.bytes.toString()).toBe(html);
  });

  it('refuses detected prompt credentials before persistence or provider export', async () => {
    let providerCalls = 0;
    const { drafts, request } = await setup(async () => { providerCalls++; return { html: HTML, assumptions: [] }; });
    const credential = ['ghp_', 'a'.repeat(36)].join('');
    await expect(drafts.create('local-daemon', { ...request, prompt: `Use credential ${credential}` }, 'secret')).rejects.toMatchObject({ status: 422, code: 'draft-prompt-secret' });
    expect(providerCalls).toBe(0);
    expect((await drafts.list('local-daemon', 'p1')).drafts).toEqual([]);
  });

  it('refuses credentials in returned assumptions without persisting the matched value', async () => {
    const credential = ['ghp_', 'b'.repeat(36)].join('');
    const { drafts, request } = await setup(async () => ({ html: HTML, assumptions: [`Use ${credential}`] }));
    const created = await drafts.create('local-daemon', request, 'secret-assumption');
    const failed = await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1);
    expect(failed).toMatchObject({ status: 'failed', failure: { reason: 'draft-output-invalid' }, assumptions: [] });
    expect(JSON.stringify(failed)).not.toContain(credential);
  });

  it('persists capture before generation, resumes revisions after restart, and keeps previous outputs byte-identical', async () => {
    const inputs: Parameters<CaptureDraftGenerator['generate']>[0][] = [];
    const { dataDir, capture, captures, drafts, generator, request } = await setup(async input => { inputs.push(input); return { html: inputs.length === 1 ? HTML : HTML.replace('Hello', 'Welcome'), assumptions: ['Spacing is estimated.'] }; });
    const created = await drafts.create('local-daemon', request, 'first');
    expect(created.created).toBe(true);
    const first = await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1);
    expect(first).toMatchObject({ status: 'ready', captureId: capture.id, revision: 1, outputSha256: sha(HTML) });
    expect(inputs[0]!.image.equals(pngBytes(40, 30))).toBe(true);
    expect(inputs[0]!.capture.contentHash).toBe(capture.contentHash);
    const repeated = await drafts.create('local-daemon', request, 'first');
    expect(repeated.draft).toEqual(first); expect(inputs).toHaveLength(1);
    const next = await drafts.create('local-daemon', { ...request, prompt: 'Change heading to Welcome.', parent: { draftId: first.draftId, revision: 1 } }, 'second');
    const second = await drafts.settled('local-daemon', 'p1', next.draft.draftId, 2);
    expect(second.html).toContain('Welcome'); expect(inputs[1]!.currentHtml).toBe(HTML);
    const reopened = createCaptureDraftService({ dataDir, captures, generator });
    expect(await reopened.read('local-daemon', 'p1', first.draftId, 1)).toEqual(first);
    expect((await reopened.list('local-daemon', 'p1')).drafts).toHaveLength(2);
    await expect(reopened.read('other', 'p1', first.draftId, 1)).rejects.toMatchObject({ status: 404 });
    await expect(reopened.read('local-daemon', 'p2', first.draftId, 1)).rejects.toMatchObject({ status: 404 });
    await expect(drafts.create('local-daemon', { ...request, prompt: 'Different' }, 'first')).rejects.toMatchObject({ status: 409 });
    await expect(drafts.create('local-daemon', { ...request, parent: { draftId: first.draftId, revision: 1 } }, 'stale')).rejects.toMatchObject({ status: 409 });
  });

  it('retains failed draft requests and leaves ready output intact; restart interrupts an unfinished generation', async () => {
    let release!: () => void;
    const { dataDir, captures, drafts, generator, request } = await setup(async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error('provider secret payload'); });
    const created = await drafts.create('local-daemon', request, 'pending');
    expect(created.draft.status).toBe('pending');
    const reopened = createCaptureDraftService({ dataDir, captures, generator });
    const interrupted = await reopened.read('local-daemon', 'p1', created.draft.draftId, 1);
    expect(interrupted).toMatchObject({ status: 'failed', failure: { reason: 'draft-interrupted' } });
    release();
    const failed = await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1);
    expect(JSON.stringify(failed)).not.toContain('provider secret payload');
  });

  it('saves the selected immutable draft with rights, rendered thumbnail and exact capture/revision lineage', async () => {
    const { dataDir, captures, drafts, request, capture } = await setup();
    const created = await drafts.create('local-daemon', request, 'draft');
    const ready = await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1);
    const units = createUnitService({ dataDir, projectRoot: () => null, isCapturedBytes: async (project, hash) => captures.hasContentHash(project, hash), readCapture: captures.read,
      readDraft: (principal, id, revision) => drafts.unitSource(principal, id, revision), renderThumbnail: async () => ({ png: pngBytes(64, 40) }) });
    const unitRequest = { source: { kind: 'draft' as const, draftId: ready.draftId, revision: 1, rootSelector: '#hero' }, kind: 'section' as const, name: 'Hero', rightsDeclaration: { basis: 'model-authored' as const, evidenceRefs: [], notices: [], privateUseAttestation: 'I may adapt my reference privately.' } };
    const plan = await units.plan(unitRequest, 'local-daemon', 'web');
    expect(plan.blockers).toEqual([]);
    const saved = await units.save(unitRequest, 'local-daemon', 'save', 'web');
    expect(saved.manifest).toMatchObject({ kind: 'section', rootSelector: '#hero', provenance: { captureId: capture.id, draftRevisionId: `${ready.draftId}:1` }, thumbnail: { source: 'rendered' }, rights: { status: 'private-use-only' } });
    expect(saved.manifest.dependencies).toEqual([]);
    const file = await units.file('local-daemon', saved.manifest.unitId, 'index.html');
    expect(file.bytes.toString()).toContain('Hello');
    // The saved region must not include the unrelated nav as output content.
    expect(file.bytes.toString()).not.toContain('Other region');
    expect((await drafts.read('local-daemon', 'p1', ready.draftId, 1)).html).toBe(HTML);
    await expect(units.save(unitRequest, 'other', 'foreign')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses generated references and copied captured rasters instead of silently saving them', async () => {
    const { drafts, request } = await setup(async () => ({ html: HTML.replace('<h1>Hello</h1>', '<img src="https://proprietary.example/logo.png"><h1>Hello</h1>'), assumptions: [] }));
    const created = await drafts.create('local-daemon', request, 'remote');
    expect(await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1)).toMatchObject({ status: 'failed', failure: { reason: 'draft-output-invalid' } });
  });

  it('allows authored inline SVG but refuses encoded SVG/raster URLs including HTML-entity schemes', async () => {
    const outputs = [
      HTML.replace('<h1>Hello</h1>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg><h1>Hello</h1>'),
      HTML.replace('<h1>Hello</h1>', `<img src="data:image/svg+xml;base64,${Buffer.from(`<svg><image href="data:image/png;base64,${pngBytes(40, 30).toString('base64')}"/></svg>`).toString('base64')}">`),
      HTML.replace('<h1>Hello</h1>', '<img src="data&#58;image/png;base64,AAAA">'),
    ];
    const { drafts, request } = await setup(async () => ({ html: outputs.shift()!, assumptions: [] }));
    for (const [index, status] of ['ready', 'failed', 'failed'].entries()) {
      const created = await drafts.create('local-daemon', request, `svg-${index}`);
      expect((await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1)).status).toBe(status);
    }
  });

  it('retries failed iterations from the latest ready parent without changing either stored revision', async () => {
    let turn = 0;
    const { drafts, request } = await setup(async () => { if (++turn === 2) throw new Error('failed'); return { html: HTML, assumptions: [] }; });
    const first = await drafts.create('local-daemon', request, 'retry-first');
    await drafts.settled('local-daemon', 'p1', first.draft.draftId, 1);
    const parent = { draftId: first.draft.draftId, revision: 1 };
    await drafts.create('local-daemon', { ...request, parent }, 'retry-failed');
    const failed = await drafts.settled('local-daemon', 'p1', first.draft.draftId, 2);
    expect(failed.status).toBe('failed');
    const retried = await drafts.create('local-daemon', { ...request, prompt: 'Retry with a matching heading.', parent }, 'retry-third');
    expect(retried.draft.revision).toBe(3);
    expect((await drafts.settled('local-daemon', 'p1', first.draft.draftId, 3)).status).toBe('ready');
    expect(await drafts.read('local-daemon', 'p1', first.draft.draftId, 2)).toEqual(failed);
  });

  it('refuses region extraction with global scripts instead of silently breaking dependent actions', async () => {
    const html = HTML.replace('</body>', '<script>document.querySelector("nav").addEventListener("click",()=>{});document.querySelector("button").addEventListener("click",()=>{document.body.dataset.booked="yes";});</script></body>');
    const { dataDir, captures, drafts, request } = await setup(async () => ({ html, assumptions: [] }));
    const created = await drafts.create('local-daemon', request, 'global-script');
    const ready = await drafts.settled('local-daemon', 'p1', created.draft.draftId, 1);
    const units = createUnitService({ dataDir, projectRoot: () => null, isCapturedBytes: async () => false, readCapture: captures.read, readDraft: drafts.unitSource, renderThumbnail: async () => ({ unavailable: 'fixture' }) });
    const requestUnit = { source: { kind: 'draft' as const, draftId: ready.draftId, revision: 1, rootSelector: '#hero' }, kind: 'section' as const, name: 'Hero' };
    await expect(units.plan(requestUnit, 'local-daemon')).rejects.toMatchObject({ code: 'region-script-dependency', status: 422 });
    expect((await units.plan({ ...requestUnit, source: { ...requestUnit.source, rootSelector: 'body' } }, 'local-daemon')).rootFound).toBe(true);
    expect((await drafts.read('local-daemon', 'p1', ready.draftId, 1)).html).toBe(html);
  });
});
