// RED SPEC (C1-B, "Build on brand", docs/plans/2026-10-09-build-on-brand/spec.md).
//
// The daemon HTTP acceptance gate for `POST /api/build-on-brand`. Until C2 adds the route this
// file fails on its first request: Express answers the unknown POST with 404, so every
// `expect(response.status)` below reads 404. Until C2 adds the contract module, the
// `@mish/contracts` import of `buildOnBrandResultSchema` is undefined and the first
// schema assertion throws `Cannot read properties of undefined`.
//
// What it pins:
// - The request is validated with the shared contract (400), an unknown or draft design system
//   is refused with 422 `DESIGN_SYSTEM_NOT_INSTALLED` (a draft kit with `details.reason: 'draft'`,
//   because the prompt composer would otherwise drop it silently), and a non-public or unreadable
//   reference is refused with 4xx `REFERENCE_URL_REFUSED`: all before any project, fetch or run.
// - A valid request answers 202 with `{ projectId, conversationId, runId, plan }`, creates a project
//   bound to the kit with `metadata.intent: 'build-on-brand'` (never `web-clone`, which drops the
//   kit), and starts exactly one agent run through `internalRunCreation` (the run-start choke point).
// - The composed prompt (captured from the fake agent's stdin) names the bound kit, every
//   planned page and the structure digest, and never carries copy, image references or the
//   source host from the reference page.
//
// Hermetic by construction: recon reads the recorded fixture through the daemon-owned
// `buildOnBrandReferenceFetcher` start option (no network), and the agent is a fake `opencode`
// on PATH that records its stdin (no live model). The seam replaces only the network read: the
// public-address guard (`assertPublicBrandUrl`) still runs before it, so loopback and private
// literals are refused without reaching the fetcher.
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as contracts from '@mish/contracts';

// Record every run that enters the run-start choke point, whichever entry (`start` or
// `startAdmitted`) the route uses. The wrapper keeps the real service behaviour.
const choke = vi.hoisted(() => ({ started: [] as Array<{ runId: string; analytics: unknown }> }));
// Discovery is outside this seam: use only the fake runtime, never probe real CLI accounts.
vi.mock('../src/agents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agents.js')>();
  return { ...actual, detectAgents: async () => [{ ...actual.getAgentDef('opencode'), id: 'opencode', name: 'OpenCode', available: true, models: [] }] };
});
vi.mock('../src/services/internal-run-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/internal-run-service.js')>();
  return {
    ...actual,
    createInternalRunCreationService: ((deps: Parameters<typeof actual.createInternalRunCreationService>[0]) => {
      const service = actual.createInternalRunCreationService(deps);
      const start = service.start.bind(service);
      const startAdmitted = service.startAdmitted.bind(service);
      service.start = ((run, analytics, ...rest) => {
        choke.started.push({ runId: run.id, analytics });
        return start(run, analytics, ...rest);
      }) as typeof service.start;
      service.startAdmitted = ((run, analytics, ...rest) => {
        choke.started.push({ runId: run.id, analytics });
        return startAdmitted(run, analytics, ...rest);
      }) as typeof service.startAdmitted;
      return service;
    }) as typeof actual.createInternalRunCreationService,
  };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'build-on-brand');
const KIT = 'neutral-product';
const BRIEF = 'A two-person physiotherapy clinic in Leeds that treats running injuries. Warm, plain, trustworthy.';

type Canaries = { referenceUrl: string; copy: string[]; images: string[]; source: string[] };
type Plan = {
  pageCount: number;
  useLibrary: boolean;
  designSystem: { id: string; binding: { tokensStylesheet: string } };
  pages: Array<{ file: string; role: string; sections: Array<{ role: string; source: string; ref?: string }> }>;
  libraryInserts: Array<{ itemId: string; page: string; role: string }>;
  reference?: { digest: { schema: string; pages: Array<{ role: string; sections: Array<{ role: string }> }> } };
};
type Started = { projectId: string; conversationId: string; runId: string; plan: Plan };
type ReferenceFetch = (url: URL) => Promise<{ status: number; contentType: string; body: string }>;

describe('POST /api/build-on-brand', () => {
  let server: http.Server;
  let baseUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;
  let binDir: string;
  let capturePath: string;
  let canaries: Canaries;
  let referenceHtml: string;
  const fetched: string[] = [];
  const originalPath = process.env.PATH;
  const originalCapture = process.env.OD_CAPTURE_PROMPT_PATH;

  const referenceFetcher: ReferenceFetch = async (url) => {
    fetched.push(url.href);
    if (url.href !== canaries.referenceUrl) return { status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' };
    return { status: 200, contentType: 'text/html; charset=utf-8', body: referenceHtml };
  };

  beforeAll(async () => {
    canaries = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'reference-site.canaries.json'), 'utf8')) as Canaries;
    referenceHtml = await readFile(path.join(FIXTURE_DIR, 'reference-site.html'), 'utf8');

    binDir = await mkdtemp(path.join(tmpdir(), 'od-build-on-brand-'));
    capturePath = path.join(binDir, 'prompt.txt');
    process.env.OD_CAPTURE_PROMPT_PATH = capturePath;
    const bin = path.join(binDir, 'opencode');
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.OD_CAPTURE_PROMPT_PATH, input, 'utf8');
  console.log(JSON.stringify({ type: 'text', part: { text: 'Done.' } }));
});
`,
      'utf8',
    );
    await chmod(bin, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;

    const { startServer } = await import('../src/server.js');
    // `buildOnBrandReferenceFetcher` is the daemon-owned recon seam C2 adds to
    // StartServerOptions; production wires the guarded network fetch there.
    const options = { port: 0, returnServer: true, buildOnBrandReferenceFetcher: referenceFetcher };
    const started = (await startServer(options as Parameters<typeof startServer>[0])) as {
      url: string; server: http.Server; shutdown?: () => Promise<void> | void;
    };
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;

    const config = await fetch(`${baseUrl}/api/app-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'opencode', onboardingCompleted: true }),
    });
    expect(config.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(binDir, { recursive: true, force: true });
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCapture == null) delete process.env.OD_CAPTURE_PROMPT_PATH;
    else process.env.OD_CAPTURE_PROMPT_PATH = originalCapture;
  });

  beforeEach(async () => {
    fetched.length = 0;
    choke.started.length = 0;
    await rm(capturePath, { force: true });
  });

  async function post(body: unknown): Promise<{ status: number; json: any }> {
    const response = await fetch(`${baseUrl}/api/build-on-brand`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: response.status, json };
  }

  async function projectCount(): Promise<number> {
    const response = await fetch(`${baseUrl}/api/projects`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: unknown[] };
    return body.projects.length;
  }

  async function approveFixture(id: string): Promise<void> {
    expect((await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(id)}/workspace`, { method: 'POST' })).status).toBe(201);
    const { designSystem } = await (await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(id)}`)).json() as { designSystem: { approval: { revision: string } } };
    const response = await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(id)}/approval`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true, expectedRevision: designSystem.approval.revision }),
    });
    expect(response.status, await response.text()).toBe(200);
  }

  /** The fake agent writes its stdin on close; wait for that, then for the run to end. */
  async function capturedPrompt(runId: string): Promise<string> {
    const deadline = Date.now() + 30_000;
    while (!existsSync(capturePath)) {
      if (Date.now() > deadline) throw new Error(`run ${runId} never reached the agent: ${await (await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`)).text()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    while (Date.now() < deadline) {
      const run = (await (await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`)).json()) as { status: string };
      if (['succeeded', 'failed', 'canceled'].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return readFile(capturePath, 'utf8');
  }

  function expectNoReferenceLeak(text: string, where: string) {
    for (const phrase of [...canaries.copy, ...canaries.images, ...canaries.source]) {
      expect(text.includes(phrase), `${where} carries "${phrase}" from the reference site`).toBe(false);
    }
  }

  it('accepts an approved Atlas kit over HTTP and refuses unapproved or edited revisions before creating anything', async () => {
    const id = 'user:atlas-round2';
    const dir = path.join(process.env.OD_DATA_DIR!, 'design-systems', 'atlas-round2');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'DESIGN.md'), '# Atlas round 2\n\nApproved design contract.');
    await writeFile(path.join(dir, 'tokens.css'), ':root { --bg: #fff; --accent: #1e5a78; }');
    await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ status: 'published' }));
    // Supported inspection materializes derived review files before their revision is vetted.
    expect((await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(id)}/workspace`, { method: 'POST' })).status).toBe(201);
    const detail = async () => ((await (await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(id)}`)).json()) as { designSystem: { approval: { revision: string } } }).designSystem;
    const approval = async (approved: boolean) => {
      const kit = await detail();
      const response = await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(id)}/approval`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved, expectedRevision: kit.approval.revision }),
      });
      expect(response.status).toBe(200);
    };
    const refuse = async () => {
      const before = await projectCount();
      for (const endpoint of ['/api/build-on-brand', '/api/build-on-brand/plan', '/api/build-on-brand/project']) {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brief: BRIEF, designSystemId: id }),
        });
        const body = await response.json() as { error: { details: { reason: string }; message: string } };
        expect(response.status, JSON.stringify(body)).toBe(422);
        expect(body.error.details.reason).toBe('unreviewed');
        expect(body.error.message).toMatch(/[Aa]pprove|[Uu]nreviewed/);
      }
      expect(await projectCount()).toBe(before);
      expect(choke.started).toEqual([]);
    };
    await refuse();
    await approval(true);
    const accepted = await post({ brief: BRIEF, designSystemId: id });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(202);
    await capturedPrompt(accepted.json.runId);
    choke.started.length = 0;
    await approval(false);
    await refuse();
    await approval(true);
    // Warm the catalogue while approved, then edit without going through a kit API.
    await detail();
    await writeFile(path.join(dir, 'DESIGN.md'), '# Atlas edited after approval');
    await refuse();
  }, 60_000);

  describe('validation', () => {
    it.each([
      ['neither brief nor URL', { designSystemId: KIT }],
      ['no design system', { brief: BRIEF }],
      ['a non-http(s) URL', { referenceUrl: 'ftp://harbor-and-pine.example/', designSystemId: KIT }],
      ['a javascript: URL', { referenceUrl: 'javascript:alert(1)', designSystemId: KIT }],
      ['a URL with credentials', { referenceUrl: 'https://u:p@harbor-and-pine.example/', designSystemId: KIT }],
      ['six pages', { brief: BRIEF, designSystemId: KIT, pageCount: 6 }],
      ['two pages', { brief: BRIEF, designSystemId: KIT, pageCount: 2 }],
    ])('answers 400 for %s, and fetches and starts nothing', async (_label, body) => {
      const before = await projectCount();
      const response = await post(body);
      expect(response.status, JSON.stringify(response.json)).toBe(400);
      expect(response.json?.error?.code).toEqual(expect.any(String));
      expect(fetched).toEqual([]);
      expect(choke.started).toEqual([]);
      expect(await projectCount()).toBe(before);
    });

    it('refuses an unknown design system with 422 DESIGN_SYSTEM_NOT_INSTALLED before recon or any project', async () => {
      const before = await projectCount();
      const response = await post({ brief: BRIEF, referenceUrl: canaries.referenceUrl, designSystemId: 'no-such-kit-0d1f' });
      expect(response.status, JSON.stringify(response.json)).toBe(422);
      expect(response.json?.error?.code).toBe('DESIGN_SYSTEM_NOT_INSTALLED');
      expect(fetched).toEqual([]);
      expect(choke.started).toEqual([]);
      expect(await projectCount()).toBe(before);
    });

    it('refuses a draft kit with 422 DESIGN_SYSTEM_NOT_INSTALLED and reason draft', async () => {
      const created = await fetch(`${baseUrl}/api/design-systems`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `Draft clinic kit ${randomUUID().slice(0, 8)}`, summary: 'Not published yet.', status: 'draft' }),
      });
      expect(created.status).toBe(201);
      const { designSystem } = (await created.json()) as { designSystem: { id: string; status: string } };
      expect(designSystem.status).toBe('draft');
      await approveFixture(designSystem.id);
      expect((await fetch(`${baseUrl}/api/design-systems/${encodeURIComponent(designSystem.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'draft' }),
      })).status).toBe(200);

      const before = await projectCount();
      const response = await post({ brief: BRIEF, designSystemId: designSystem.id });
      expect(response.status, JSON.stringify(response.json)).toBe(422);
      expect(response.json?.error?.code).toBe('DESIGN_SYSTEM_NOT_INSTALLED');
      expect(response.json?.error?.details).toMatchObject({ reason: 'draft' });
      expect(choke.started).toEqual([]);
      expect(await projectCount()).toBe(before);
    });

    it.each(['http://127.0.0.1:7456/', 'http://localhost/', 'http://10.0.0.8/', 'http://[::1]/'])(
      'refuses the non-public reference %s with REFERENCE_URL_REFUSED and never fetches it',
      async (referenceUrl) => {
        const before = await projectCount();
        const response = await post({ brief: BRIEF, referenceUrl, designSystemId: KIT });
        expect(response.status, JSON.stringify(response.json)).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        expect(response.json?.error?.code).toBe('REFERENCE_URL_REFUSED');
        expect(fetched).toEqual([]);
        expect(choke.started).toEqual([]);
        expect(await projectCount()).toBe(before);
      },
    );
  });

  describe('a brief and an installed kit', () => {
    it('answers 202 with a contract-valid result and starts one run through the choke point', async () => {
      const response = await post({ brief: BRIEF, designSystemId: KIT, pageCount: 3 });
      expect(response.status, JSON.stringify(response.json)).toBe(202);
      const result = contracts.buildOnBrandResultSchema.parse(response.json) as Started;

      expect(result.plan.designSystem.id).toBe(KIT);
      expect(result.plan.pageCount).toBe(3);
      expect(result.plan.pages).toHaveLength(3);
      expect(result.plan.reference).toBeUndefined();
      expect(choke.started.map((entry) => entry.runId)).toEqual([result.runId]);

      // The project is bound to the kit, so preview and export pick up the same binding.
      const project = (await (await fetch(`${baseUrl}/api/projects/${result.projectId}`)).json()) as {
        project: { designSystemId: string | null; metadata?: { intent?: string } };
      };
      expect(project.project.designSystemId).toBe(KIT);
      expect(project.project.metadata?.intent).toBe('build-on-brand');

      const prompt = await capturedPrompt(result.runId);
      expect(prompt).toContain(BRIEF);
      expect(prompt).toContain(KIT);
      expect(prompt).toContain('--accent'); // a token the kit's own tokens.css declares
      for (const page of result.plan.pages) expect(prompt, page.file).toContain(page.file);
      expect(prompt).not.toContain(contracts.BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA);
    }, 60_000);

    it('builds on a kit made by the brand importer, which keeps its tokens in system/variables.css', async () => {
      // The brand importer (J3: a teammate pastes their client's DESIGN.md) writes DESIGN.md,
      // brand.json, metadata.json and system/ — never tokens.css. Such a kit must carry a build.
      const dirId = `brand-kit-${randomUUID().slice(0, 8)}`;
      const kitRoot = path.join(process.env.OD_DATA_DIR!, 'design-systems', dirId);
      await mkdir(path.join(kitRoot, 'system'), { recursive: true });
      await writeFile(path.join(kitRoot, 'DESIGN.md'), '# Linden Dental Studio\n\nWarm wellness-retail dental language.\n', 'utf8');
      await writeFile(path.join(kitRoot, 'brand.json'), JSON.stringify({ name: 'Linden Dental Studio' }), 'utf8');
      await writeFile(
        path.join(kitRoot, 'metadata.json'),
        JSON.stringify({ title: 'Linden Dental Studio kit', category: 'Brands', surface: 'web', status: 'published' }),
        'utf8',
      );
      await writeFile(
        path.join(kitRoot, 'system', 'variables.css'),
        ':root { --brand-canary-accent: #2f7d6d; --brand-color-primary: #2f7d6d; --brand-color-bg-container: #fbf7f2; }\n.dark { --brand-color-bg-container: #14110f; }\n',
        'utf8',
      );
      const designSystemId = `user:${dirId}`;
      await approveFixture(designSystemId);

      const response = await post({ brief: BRIEF, designSystemId, pageCount: 3 });
      expect(response.status, JSON.stringify(response.json)).toBe(202);
      const result = contracts.buildOnBrandResultSchema.parse(response.json) as Started;
      expect(result.plan.designSystem.id).toBe(designSystemId);
      const prompt = await capturedPrompt(result.runId);
      expect(prompt).toContain('--brand-canary-accent');
      // The staged role map binds the catalogue's roles to the kit's own tokens, not to defaults.
      const roles = await readFile(path.join(process.env.OD_DATA_DIR!, 'projects', result.projectId, '_brand-build', 'roles.css'), 'utf8');
      expect(roles).toContain('--role-accent: var(--brand-color-primary,');
      expect(roles).toContain('--role-background: var(--brand-color-bg-container,');
    }, 60_000);

    it('builds on a kit pasted as DESIGN.md through POST /api/brands', async () => {
      const pasted = await fetch(`${baseUrl}/api/brands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          designMd: `# Harbour clinic kit ${randomUUID().slice(0, 8)}\n\n| Role | Value |\n|---|---|\n| Background | #f3eee4 |\n| Text | #4b1611 |\n| Accent | #2f7d6d |\n\n## Typography\n\n| Role | Face | Use |\n|---|---|---|\n| Display | Fraunces | headlines |\n| Body | Inter | paragraphs |\n`,
        }),
      });
      expect(pasted.status).toBe(200);
      const { id: brandId, designSystemId } = (await pasted.json()) as { id: string; designSystemId?: string };
      if (!designSystemId) throw new Error('POST /api/brands returned no designSystemId');
      const kitRoot = path.join(process.env.OD_DATA_DIR!, 'design-systems', designSystemId.replace(/^user:/, ''));
      // variables.css appears before the importer finishes syncing the project and
      // linking its workspace. Approving that partial revision races those writes.
      // Wait for the public terminal state; keep approval's revision guard intact.
      await expect.poll(async () => {
        const response = await fetch(`${baseUrl}/api/brands/${encodeURIComponent(brandId)}`);
        expect(response.status).toBe(200);
        const detail = await response.json() as { meta: { status: string } };
        return detail.meta.status;
      }, { timeout: 10_000, interval: 100 }).toBe('ready');
      await approveFixture(designSystemId);
      expect(existsSync(path.join(kitRoot, 'tokens.css'))).toBe(false);
      const summary = (await (await fetch(`${baseUrl}/api/design-systems`)).json()) as {
        designSystems: Array<{ id: string; status?: string }>;
      };
      expect(summary.designSystems.find((kit) => kit.id === designSystemId)?.status).not.toBe('draft');

      const response = await post({ brief: BRIEF, designSystemId, pageCount: 3 });
      expect(response.status, JSON.stringify(response.json)).toBe(202);
      const result = contracts.buildOnBrandResultSchema.parse(response.json) as Started;
      expect(result.plan.designSystem.id).toBe(designSystemId);
      expect(await capturedPrompt(result.runId)).toContain('--brand-');
      const roles = await readFile(path.join(process.env.OD_DATA_DIR!, 'projects', result.projectId, '_brand-build', 'roles.css'), 'utf8');
      expect(roles).toContain('--role-accent: var(--brand-color-primary,');
      expect(roles).toContain('--role-foreground: var(--brand-color-text,');
    }, 60_000);

    it('plans no library inserts and no library sections when useLibrary is off', async () => {
      const response = await post({ brief: BRIEF, designSystemId: KIT, useLibrary: false });
      expect(response.status, JSON.stringify(response.json)).toBe(202);
      const result = contracts.buildOnBrandResultSchema.parse(response.json) as Started;
      expect(result.plan.useLibrary).toBe(false);
      expect(result.plan.libraryInserts).toEqual([]);
      expect(result.plan.pages.flatMap((page) => page.sections).filter((section) => section.source === 'library')).toEqual([]);
      await capturedPrompt(result.runId);
    }, 60_000);

    it('names every planned library insert in the prompt when useLibrary is on', async () => {
      const response = await post({ brief: BRIEF, designSystemId: KIT, useLibrary: true, pageCount: 4 });
      expect(response.status, JSON.stringify(response.json)).toBe(202);
      const result = contracts.buildOnBrandResultSchema.parse(response.json) as Started;
      expect(result.plan.pages).toHaveLength(4);
      const prompt = await capturedPrompt(result.runId);
      for (const insert of result.plan.libraryInserts) expect(prompt, insert.itemId).toContain(insert.itemId);
    }, 60_000);
  });

  describe('a reference URL', () => {
    it('reads structure only: the digest and the prompt carry no copy, image or source host', async () => {
      const response = await post({ brief: BRIEF, referenceUrl: canaries.referenceUrl, designSystemId: KIT, pageCount: 4 });
      expect(response.status, JSON.stringify(response.json)).toBe(202);
      expect(fetched).toEqual([canaries.referenceUrl]);
      const result = contracts.buildOnBrandResultSchema.parse(response.json) as Started;

      const digest = result.plan.reference?.digest;
      expect(digest?.schema).toBe(contracts.BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA);
      const roles = new Set(digest!.pages.flatMap((page) => page.sections.map((section) => section.role)));
      for (const role of ['hero', 'testimonials', 'pricing', 'faq', 'footer']) expect(roles.has(role), role).toBe(true);
      expectNoReferenceLeak(JSON.stringify(result.plan), 'the plan');

      const prompt = await capturedPrompt(result.runId);
      expect(prompt).toContain(BRIEF);
      expect(prompt).toContain(KIT);
      expect(prompt).toContain(contracts.BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA);
      expect(prompt).toContain('pricing');
      expect(prompt).toContain('faq');
      // The agent never gets the URL, so it cannot fetch the page and copy it itself.
      expect(prompt).not.toContain(canaries.referenceUrl);
      expectNoReferenceLeak(prompt, 'the composed prompt');
      expect(choke.started.map((entry) => entry.runId)).toEqual([result.runId]);
    }, 60_000);

    it('works from a URL alone, with no brief', async () => {
      const response = await post({ referenceUrl: canaries.referenceUrl, designSystemId: KIT });
      expect(response.status, JSON.stringify(response.json)).toBe(202);
      const result = contracts.buildOnBrandResultSchema.parse(response.json) as Started;
      expect(result.plan.reference?.digest.schema).toBe(contracts.BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA);
      expectNoReferenceLeak(await capturedPrompt(result.runId), 'the composed prompt');
    }, 60_000);

    it('fails clearly, without starting a run, when the reference cannot be read', async () => {
      const before = await projectCount();
      const response = await post({ brief: BRIEF, referenceUrl: `https://harbor-and-pine.example/missing-${randomUUID()}`, designSystemId: KIT });
      expect(response.status, JSON.stringify(response.json)).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(response.json?.error?.code).toBe('REFERENCE_URL_REFUSED');
      expect(choke.started).toEqual([]);
      expect(await projectCount()).toBe(before);
    });
  });
});
