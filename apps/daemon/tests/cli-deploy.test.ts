// Contract test for the `od deploy` CLI surface. Verifies that the subcommand
// is registered in SUBCOMMAND_MAP, that flags are parsed correctly, and that
// exactly the right HTTP body is sent to POST /api/projects/:id/deploy.
//
// Mirrors the stub-server + runCli pattern from cli-templates.test.ts so the
// harness is familiar to reviewers and consistent with the repo standard.
//
// ASSUMPTION (Cloudflare flags): The CLI is expected to accept three flags to
// populate the `cloudflarePages` body field (matching CloudflarePagesDeploySelection
// from packages/contracts):
//   --cf-zone-id <id>        → cloudflarePages.zoneId
//   --cf-zone-name <name>    → cloudflarePages.zoneName
//   --cf-domain-prefix <p>   → cloudflarePages.domainPrefix
// The implementer should honor this assumption; if the flag names change, update
// the case 7 assertions accordingly.

import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  setResponder: (
    fn: (req: CapturedRequest) => { status: number; body: unknown } | null,
  ) => void;
  close: () => Promise<void>;
}

async function startStubServer(): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let responder:
    | ((req: CapturedRequest) => { status: number; body: unknown } | null)
    | null = null;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw,
      };
      requests.push(captured);
      const response = responder?.(captured) ?? { status: 200, body: { ok: true } };
      res.statusCode = response.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response.body));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub server has no address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    requests,
    setResponder: (fn) => {
      responder = fn;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
  };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [TSX_CLI, CLI_SRC, ...args],
      {
        cwd: DAEMON_ROOT,
        env,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
      code: failed.code ?? 1,
    };
  }
}

// A minimal DeploymentInfo response that the stub returns for success cases.
// Fields match DeploymentInfo + DeployProjectFileResponse from packages/contracts.
const STUB_DEPLOYMENT = {
  id: 'deploy-abc',
  projectId: 'proj-1',
  fileName: 'index.html',
  providerId: 'vercel-self',
  url: 'https://example.vercel.app',
  deploymentCount: 1,
  target: 'production' as const,
  status: 'ready' as const,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
};

describe('od deploy CLI', () => {
  let stub: StubServer;

  beforeAll(async () => {
    stub = await startStubServer();
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    stub.requests.length = 0;
    stub.setResponder(() => ({ status: 200, body: STUB_DEPLOYMENT }));
  });

  afterEach(() => {
    stub.setResponder(() => ({ status: 200, body: STUB_DEPLOYMENT }));
  });

  it('passes --vercel-name through the same HTTP selection as the UI', async () => {
    const result = await runCli(['deploy', 'proj-1', '--file', 'index.html', '--vercel-name', 'bobs-bakery', '--json', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(0);
    expect(JSON.parse(stub.requests[0]!.body)).toMatchObject({ vercel: { projectName: 'bobs-bakery' } });
  });
  it('checks a name without a file or project and preserves advisory JSON', async () => {
    const answer = { name: 'bobs-bakery', valid: true, available: true, advisory: true };
    stub.setResponder(() => ({ status: 200, body: answer }));
    const result = await runCli(['deploy', 'name-check', 'bobs-bakery', '--json', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(0);
    expect(stub.requests[0]).toMatchObject({ method: 'GET', url: '/api/deploy/vercel/name-check?name=bobs-bakery' });
    expect(JSON.parse(result.stdout)).toEqual(answer);
  });
  it('returns nonzero for a taken name and keeps the suggestion', async () => {
    stub.setResponder(() => ({ status: 200, body: { name: 'bobs-bakery', valid: true, available: false, advisory: true, reason: 'taken', suggestion: 'bobs-bakery-2' } }));
    const result = await runCli(['deploy', 'name-check', 'bobs-bakery', '--json', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).suggestion).toBe('bobs-bakery-2');
  });
  it('can check a name for an existing OD project', async () => {
    stub.setResponder(() => ({ status: 200, body: { name: 'bobs-bakery', valid: true, available: true, advisory: true } }));
    const result = await runCli(['deploy', 'name-check', 'bobs-bakery', '--project', 'proj-1', '--json', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(0);
    expect(stub.requests[0]?.url).toBe('/api/deploy/vercel/name-check?name=bobs-bakery&projectId=proj-1');
  });
  it('refuses a missing --project value rather than dropping ownership scope', async () => {
    const result = await runCli(['deploy', 'name-check', 'bobs-bakery', '--project', '--json', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(2); expect(stub.requests).toHaveLength(0);
  });
  it('still deploys an OD project literally named name-check with --file', async () => {
    const result = await runCli(['deploy', 'name-check', '--file', 'index.html', '--vercel-name', 'bakery', '--json', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(0);
    expect(stub.requests[0]?.url).toBe('/api/projects/name-check/deploy');
  });

  // Case 1: --target preview → body.target === 'preview', exit 0
  it('POSTs to /api/projects/:id/deploy with target=preview when --target preview is given', async () => {
    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--target',
      'preview',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    const req = stub.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/projects/proj-1/deploy');
    const body = JSON.parse(req.body);
    expect(body.target).toBe('preview');
    expect(body.fileName).toBe('index.html');
  });

  // Case 2: --target production → body.target === 'production', exit 0
  it('POSTs with target=production when --target production is given', async () => {
    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--target',
      'production',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    const body = JSON.parse(stub.requests[0]!.body);
    expect(body.target).toBe('production');
  });

  // Case 3: omitted --target → body must NOT contain a `target` key at all
  // (so the endpoint applies its own production default server-side)
  it('omits the target key entirely from the POST body when --target is not supplied', async () => {
    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    const body = JSON.parse(stub.requests[0]!.body);
    expect('target' in body).toBe(false);
    expect(body.fileName).toBe('index.html');
  });

  // Case 4: invalid --target value → CLI rejects locally (no HTTP request made)
  it('rejects --target staging locally and makes no HTTP request', async () => {
    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--target',
      'staging',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    expect(stub.requests).toHaveLength(0);
    // stderr should mention the invalid value so the user understands what went wrong
    expect(result.stderr).toMatch(/staging/);
  });

  // Case 5: --json → stdout is the raw parseable JSON from the daemon
  it('outputs the raw daemon JSON response to stdout under --json', async () => {
    const warnings = [{ code: 'broken-reference', path: 'old.html', message: 'Skipped missing navigation target: old.html' }];
    const stubResponse = { ...STUB_DEPLOYMENT, url: 'https://example-json.vercel.app', warnings };
    stub.setResponder(() => ({ status: 200, body: stubResponse }));

    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).warnings).toEqual(warnings);
    expect(stub.requests).toHaveLength(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      id: stubResponse.id,
      url: stubResponse.url,
      target: stubResponse.target,
      status: stubResponse.status,
    });
  });

  // Case 6a: daemon returns 400 → CLI exits non-zero and surfaces the error message
  it('exits non-zero and surfaces the error message when the daemon returns 400', async () => {
    stub.setResponder(() => ({
      status: 400,
      body: { error: 'fileName required' },
    }));

    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/fileName required/);
  });

  // Case 6b: daemon returns 500 → CLI exits non-zero
  it('exits non-zero when the daemon returns 500', async () => {
    stub.setResponder(() => ({
      status: 500,
      body: { error: 'internal error' },
    }));

    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
  });

  // Case 7: --provider cloudflare-pages with CF flags → body includes providerId and cloudflarePages
  // ASSUMPTION: Cloudflare-specific flags are --cf-zone-id, --cf-zone-name, --cf-domain-prefix
  // matching CloudflarePagesDeploySelection { zoneId, zoneName, domainPrefix }
  it('sends providerId=cloudflare-pages and cloudflarePages object when --provider cloudflare-pages is given with CF flags', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: { ...STUB_DEPLOYMENT, providerId: 'cloudflare-pages' },
    }));

    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--provider',
      'cloudflare-pages',
      '--cf-zone-id',
      'zone-abc',
      '--cf-zone-name',
      'example.com',
      '--cf-domain-prefix',
      'my-project',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    const body = JSON.parse(stub.requests[0]!.body);
    expect(body.providerId).toBe('cloudflare-pages');
    expect(body.cloudflarePages).toMatchObject({
      zoneId: 'zone-abc',
      zoneName: 'example.com',
      domainPrefix: 'my-project',
    });
  });

  // Default provider is vercel-self when --provider is omitted
  it('defaults to providerId=vercel-self when --provider is not given', async () => {
    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    const body = JSON.parse(stub.requests[0]!.body);
    expect(body.providerId).toBe('vercel-self');
  });

  // --public: "make preview public" is a real deploy outcome, so the CLI has to
  // be able to ask for it — otherwise an external agent driving `od deploy`
  // can only produce the walled preview the web UI can now avoid.
  it('sends publicAccess: true when --public is given', async () => {
    stub.setResponder(() => ({ status: 200, body: { ...STUB_DEPLOYMENT, access: 'public', publicAccess: true, publicAccessOutcome: 'ready' } }));
    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--public',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    const body = JSON.parse(stub.requests[0]!.body);
    expect(body.publicAccess).toBe(true);
  });

  it('omits publicAccess entirely when --public is not given', async () => {
    const result = await runCli([
      'deploy',
      'proj-1',
      '--file',
      'index.html',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    const body = JSON.parse(stub.requests[0]!.body);
    expect(body).not.toHaveProperty('publicAccess');
  });

  it('documents --public in the deploy help text', async () => {
    const result = await runCli(['deploy', '--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/--public/);
  });

  // A 200 whose deployment is `protected` is not a success for someone who
  // asked for a public preview: printing only the walled URL and exiting 0
  // tells an automation the opposite of what happened.
  it('prints the status message and exits non-zero when --public did not produce a public link', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        ...STUB_DEPLOYMENT,
        status: 'protected',
        statusMessage: 'Vercel refused to turn deployment protection off for this project.',
        publicAccess: true,
        publicAccessOutcome: 'patch-rejected',
      },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--public', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/refused to turn deployment protection off/i);
    expect(output).toMatch(/patch-rejected/);
  });

  it('still exits zero for a protected deploy that never asked to be public, but says so', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        ...STUB_DEPLOYMENT,
        status: 'protected',
        statusMessage: 'Preview is behind Vercel Authentication.',
      },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/behind Vercel Authentication/i);
  });

  it('keeps --json machine-readable while still failing a refused --public deploy', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        ...STUB_DEPLOYMENT,
        status: 'protected',
        statusMessage: 'Vercel refused to turn deployment protection off for this project.',
        publicAccess: true,
        publicAccessOutcome: 'patch-rejected',
      },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--public', '--json', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ publicAccessOutcome: 'patch-rejected' });
  });

  // `process.exit()` does not wait for a pending stdout write, so a large
  // --json payload down a pipe was truncated exactly on the failure path a
  // caller most needs to parse.
  it('writes the whole --json payload to a pipe before exiting non-zero', async () => {
    const bigMessage = 'x'.repeat(256 * 1024);
    stub.setResponder(() => ({
      status: 200,
      body: {
        ...STUB_DEPLOYMENT,
        status: 'protected',
        statusMessage: bigMessage,
        publicAccess: true,
        publicAccessOutcome: 'patch-rejected',
      },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--public', '--json', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.statusMessage).toHaveLength(bigMessage.length);
    expect(parsed.publicAccessOutcome).toBe('patch-rejected');
  });

  // A `failed` deploy is a failure for every caller, not only one that asked
  // for a public link: an automation reading the exit code alone would
  // otherwise treat a deployment that never came up as a success.
  it('exits non-zero on a failed deploy that never asked to be public', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        ...STUB_DEPLOYMENT,
        status: 'failed',
        statusMessage: 'Cloudflare Pages deployment failed.',
      },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/status: failed/);
    expect(output).toMatch(/Cloudflare Pages deployment failed\./);
  });

  // --json takes a different flush path, so the exit code and the payload are
  // asserted together rather than assumed from the human case.
  it('keeps the --json payload unchanged while failing a failed deploy', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        ...STUB_DEPLOYMENT,
        status: 'failed',
        statusMessage: 'Cloudflare Pages deployment failed.',
      },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--json', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    // The daemon's payload, plus the validated `access` it did not send.
    expect(JSON.parse(result.stdout.trim())).toEqual({
      ...STUB_DEPLOYMENT,
      status: 'failed',
      statusMessage: 'Cloudflare Pages deployment failed.',
      access: 'unknown',
    });
  });

  // Vercel's Security Checkpoint is not a public link: a recipient meets the
  // checkpoint instead of the page. `--public` asked for a link anyone can
  // open, so this is a refused request with a sentence saying what to do.
  it('fails a --public deploy that ended at the Security Checkpoint and says to open it in a browser', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        ...STUB_DEPLOYMENT,
        status: 'challenged',
        statusMessage: "Vercel's Security Checkpoint is challenging visitors. Open the link in a browser.",
        publicAccess: true,
        publicAccessOutcome: 'challenged',
      },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--public', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/Security Checkpoint/);
    expect(output).toMatch(/open the link in a browser/i);
  });

  // The other half of F1's rule: only `failed` fails a plain deploy. A
  // challenged link is a link that exists, and the deploy did what it said.
  it('still exits zero for a challenged deploy that never asked to be public', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        ...STUB_DEPLOYMENT,
        status: 'challenged',
        statusMessage: "Vercel's Security Checkpoint is challenging visitors. Open the link in a browser.",
      },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Security Checkpoint/);
  });

  // `public` is the only access that satisfies `--public`: a `ready` link whose
  // protection could not be read (`unknown`) is not a link anyone can rely on.
  it('prints the access line and fails --public when access is unknown even though status is ready', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        ...STUB_DEPLOYMENT,
        status: 'ready',
        access: 'unknown',
        statusMessage: 'The site answered, but deployment protection could not be checked, so it is not confirmed public.',
        publicAccess: true,
        publicAccessOutcome: 'pending',
      },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--public', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/\[deploy\] access: unknown/);
    expect(result.stderr).toMatch(/not confirmed public/);
  });

  it('exits zero for --public when access is public, and prints the access line', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: { ...STUB_DEPLOYMENT, status: 'ready', access: 'public', statusMessage: 'Public link is ready.', publicAccess: true, publicAccessOutcome: 'ready' },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--public', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/\[deploy\] access: public/);
    expect(result.stderr).not.toMatch(/Public link is ready/);
  });

  it('fails --public against a daemon that sends no access field, reading it as unknown', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: { ...STUB_DEPLOYMENT, status: 'ready', statusMessage: 'Public link is ready.', publicAccess: true, publicAccessOutcome: 'ready' },
    }));

    const result = await runCli([
      'deploy', 'proj-1', '--file', 'index.html', '--public', '--json', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(1);
    // The JSON says why it failed: the missing field reads as `unknown`.
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ status: 'ready', access: 'unknown' });
  });

  it('puts the access of both Cloudflare Pages URLs in --json, each from its own field', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        ...STUB_DEPLOYMENT,
        status: 'ready',
        access: 'public',
        cloudflarePages: {
          projectName: 'demo',
          pagesDev: { url: 'https://demo.pages.dev', status: 'ready', access: 'public' },
          // No own access: never the pages.dev answer.
          customDomain: { url: 'https://demo.example.com', status: 'ready' },
        },
      },
    }));

    const json = await runCli(['deploy', 'proj-1', '--file', 'index.html', '--json', '--daemon-url', stub.baseUrl]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout.trim());
    expect(parsed.access).toBe('public');
    expect(parsed.cloudflarePages.pagesDev.access).toBe('public');
    expect(parsed.cloudflarePages.customDomain.access).toBe('unknown');

    const text = await runCli(['deploy', 'proj-1', '--file', 'index.html', '--daemon-url', stub.baseUrl]);
    expect(text.stdout).toMatch(/\[deploy\] access \(pages\.dev\): public/);
    expect(text.stdout).toMatch(/\[deploy\] access \(custom domain\): unknown/);
  });

  it('prints access: protected and keeps exit zero for a plain deploy', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: { ...STUB_DEPLOYMENT, status: 'protected', access: 'protected', statusMessage: 'Preview is behind Vercel Authentication.' },
    }));

    const result = await runCli(['deploy', 'proj-1', '--file', 'index.html', '--daemon-url', stub.baseUrl]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/\[deploy\] access: protected/);
  });

  // Missing required --file flag → CLI should reject locally without HTTP
  it('exits non-zero and emits no HTTP request when --file is missing', async () => {
    const result = await runCli([
      'deploy',
      'proj-1',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    expect(stub.requests).toHaveLength(0);
    expect(result.stderr).toMatch(/--file/i);
  });

  // Missing positional projectId → CLI should reject locally without HTTP
  it('exits non-zero and emits no HTTP request when projectId is missing', async () => {
    const result = await runCli([
      'deploy',
      '--file',
      'index.html',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    expect(stub.requests).toHaveLength(0);
  });
});
