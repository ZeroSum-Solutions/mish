// `od 21st list|get` — the CLI half of the dual-track rule for GET /api/21st (PRD
// Addendum 3 / G13). Spawn the real CLI against a stub HTTP
// server that answers the route's real envelope, and assert the request, output and exit code.

import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import originals from '@mish/21st-catalog/generated/21st-originals.json' with { type: 'json' };
import type { AddressInfo } from 'node:net';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import type { Twenty1stItem, Twenty1stListResponse } from '@mish/contracts';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

function item(overrides: Partial<Twenty1stItem> = {}): Twenty1stItem {
  return {
    id: '21st:example-item',
    slug: 'example-item',
    name: 'Example Item',
    author: 'example',
    authorProfileUrl: 'https://21st.dev/@example',
    itemUrl: 'https://21st.dev/@example/components/item',
    rights: 'reference-only',
    licenseLabel: null,
    licenseUrl: null,
    licenseNotice: null,
    copyable: false,
    preview: { kind: 'none' },
    ...overrides,
  };
}

const MIT_NOTICE = 'MIT License\n\nCopyright (c) 2026 uitripled\n\nPermission is hereby granted, free of charge...';

const ITEMS: Twenty1stItem[] = [
  item(),
  item({
    id: '21st:moumensoliman-glassmorphism-listen-app',
    slug: 'moumensoliman-glassmorphism-listen-app',
    name: 'Glassmorphism Listen App',
    author: 'moumensoliman',
    rights: 'mit',
    licenseLabel: 'MIT © uitripled',
    licenseUrl: 'https://github.com/moumen-soliman/uitripled/blob/master/LICENSE.md',
    licenseNotice: MIT_NOTICE,
    copyable: true,
  }),
];

function listBody(items: Twenty1stItem[]): Twenty1stListResponse {
  return { catalog: { profile: 'https://21st.dev/@example', items } };
}

let server: http.Server | null = null;
let requests: string[] = [];

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  requests = [];
});

async function startStub(listOverride?: unknown): Promise<string> {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://stub');
    if (url.pathname === '/api/21st') {
      return res.end(JSON.stringify(listOverride ?? listBody(ITEMS)));
    }
    const match = url.pathname.match(/^\/api\/21st\/(.+)$/);
    const found = match ? ITEMS.find((entry) => entry.id === decodeURIComponent(match[1]!) || entry.slug === decodeURIComponent(match[1]!)) : undefined;
    if (found) return res.end(JSON.stringify({ item: found }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no 21st.dev item with that id' } }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT, env, timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? 1 };
  }
}

describe('od 21st list', () => {
  it('GETs /api/21st and prints one line per item with rights', async () => {
    const base = await startStub();
    const result = await runCli(['21st', 'list', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(requests).toEqual(['GET /api/21st']);
    expect(result.stdout).toContain('21st:example-item\treference-only\tExample Item');
    expect(result.stdout).toContain('21st:moumensoliman-glassmorphism-listen-app\tmit\tGlassmorphism Listen App');
    expect(result.stdout).toContain('[21st] 2 items (1 mit, 1 reference-only)');
  });

  it('prints JSON with --json', async () => {
    const base = await startStub();
    const result = await runCli(['21st', 'list', '--json', '--daemon-url', base]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as Twenty1stListResponse;
    expect(body.catalog.items).toHaveLength(2);
    expect(body.catalog.items.map((entry) => entry.rights).sort()).toEqual(['mit', 'reference-only']);
  });

  it('sends query and facet flags to the list route and preserves the JSON envelope', async () => {
    const base = await startStub(listBody([ITEMS[1]!]));
    const result = await runCli(['21st', 'list', '--query', 'glass card', '--tag', 'card', '--rights', 'mit', '--json', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(requests).toEqual(['GET /api/21st?query=glass+card&tag=card&rights=mit']);
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(['catalog']);
  });

  it('exits 1 on a malformed response', async () => {
    const base = await startStub({ catalog: { items: [] } });
    const result = await runCli(['21st', 'list', '--daemon-url', base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[21st] malformed response from /api/21st:');
  });
});

describe('od 21st get', () => {
  it('prints one reference-only item with no licence and no notice', async () => {
    const base = await startStub();
    const result = await runCli(['21st', 'get', '21st:example-item', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(requests).toEqual(['GET /api/21st/21st%3Aexample-item']);
    expect(result.stdout).toContain('Rights\treference-only');
    expect(result.stdout).toContain('Copyable\tfalse');
    expect(result.stdout).not.toContain('Licence\t');
    expect(result.stdout).not.toContain('Licence notice:');
  });

  it('prints a mit item with its licence label and the FULL licence notice text (not just a summary)', async () => {
    const base = await startStub();
    const result = await runCli(['21st', 'get', 'moumensoliman-glassmorphism-listen-app', '--daemon-url', base]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Rights\tmit');
    expect(result.stdout).toContain('Copyable\ttrue');
    expect(result.stdout).toContain('Licence\tMIT © uitripled (https://github.com/moumen-soliman/uitripled/blob/master/LICENSE.md)');
    expect(result.stdout).toContain('Licence notice:');
    expect(result.stdout).toContain(MIT_NOTICE);
    expect(result.stdout).not.toMatch(/npx shadcn|api_key/i);
  });

  it('exits 2 with usage when no id is given', async () => {
    const base = await startStub();
    const result = await runCli(['21st', 'get', '--daemon-url', base]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage: od 21st get <id> [--json]');
    expect(requests).toEqual([]);
  });

  it('passes a daemon 404 through as a structured failure', async () => {
    const base = await startStub();
    const result = await runCli(['21st', 'get', '21st:nope', '--daemon-url', base]);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/404|NOT_FOUND/);
  });
});

describe('od 21st help', () => {
  it('prints usage and exits 0 on --help, exits 2 with no subcommand', async () => {
    const help = await runCli(['21st', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('od 21st list [--query <text>] [--tag <tag>] [--rights <mit|reference-only>] [--json]');
    expect(help.stdout).toContain('od 21st get <id> [--json]');
    const empty = await runCli(['21st']);
    expect(empty.code).toBe(2);
  });
});

describe('od cult 21st (moved to od 21st)', () => {
  it('prints the pointer to od 21st, exits 2 and sends no request', async () => {
    const base = await startStub();
    for (const args of [['cult', '21st'], ['cult', '21st', 'list', '--json', '--daemon-url', base]]) {
      const result = await runCli(args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stderr, args.join(' ')).toContain('moved: use `od 21st');
      expect(result.stdout, args.join(' ')).toBe('');
    }
    expect(requests).toEqual([]);
  });

  it('od cult --help no longer lists a 21st subcommand and still lists the Cult ones', async () => {
    const help = await runCli(['cult', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).not.toMatch(/od cult 21st/);
    expect(help.stdout).toMatch(/od cult list/);
  });
});


async function startOriginalStub(tamper = false, upstream = false): Promise<string> {
  const hash=(content:string)=>createHash('sha256').update(content).digest('hex');
  const files=[
    {path:'gallery/components/twentyfirst/example/demo.tsx',content:'export default function Demo(){return "Demo wrapper"}',sha256:''},
    {path:'gallery/components/twentyfirst/example/real-card.tsx',content:'export default function Card(){return "Upstream"}',sha256:''},
  ];
  for(const file of files) file.sha256=hash(file.content);
  const item = upstream ? {...originals.items[0]!,provenance:'upstream-private',sourceVerified:true,files,sourceSha256:hash(files.map(file=>`${file.path}\0${file.sha256}\n`).join(''))} : originals.items[0]!;
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url ?? '/', 'http://stub');
    if (url.pathname.endsWith('/preview')) {
      res.setHeader('content-type', 'text/html');
      return res.end(upstream ? '<html><head><link rel="stylesheet" href="/api/21st/saved/assets/styles.css"></head><body><script src="/api/21st/saved/assets/demo.js"></script></body></html>' : item.files.find(file => file.path === 'index.html')!.content);
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(tamper ? { ...item, files: item.files.map((file, i) => i ? file : { ...file, content: 'tampered' }) } : item));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('od 21st owned source and export', () => {
  it('prints actual upstream TSX and exports nested private source paths',async()=>{
    const base=await startOriginalStub(false,true),id=originals.items[0]!.id;
    const plain=await runCli(['21st', 'source',id,'--daemon-url',base]);
    expect(plain.code,plain.stderr).toBe(0);expect(plain.stdout).toContain('function Card');
    const temp=await mkdtemp(pathResolve(tmpdir(),'21st-private-export-')),target=pathResolve(temp,'source');
    try{
      const result=await runCli(['21st', 'export',id,'--out',target,'--json','--daemon-url',base]);
      expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout).provenance).toBe('upstream-private');
      expect(await readFile(pathResolve(target,'gallery/components/twentyfirst/example/real-card.tsx'),'utf8')).toContain('Upstream');
    }finally{await rm(temp,{recursive:true,force:true});}
  });
  it('keeps saved private preview assets linked to the running daemon',async()=>{
    const base=await startOriginalStub(false,true),id=originals.items[0]!.id;
    const temp=await mkdtemp(pathResolve(tmpdir(),'21st-preview-html-')),target=pathResolve(temp,'preview.html');
    try{
      const result=await runCli(['21st', 'preview',id,'--out',target,'--json','--daemon-url',base]);
      expect(result.code,result.stderr).toBe(0);
      const saved=await readFile(target,'utf8');expect(saved).toContain(`src="${base}/api/21st/saved/assets/demo.js"`);
      expect(saved).toContain(`href="${base}/api/21st/saved/assets/styles.css"`);
    }finally{await rm(temp,{recursive:true,force:true});}
  });
  it('reads the shared source endpoint and emits independently authored files with --json', async () => {
    const base = await startOriginalStub();
    const item = originals.items[0]!;
    const result = await runCli(['21st', 'source',item.id,'--json','--daemon-url',base]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).sourceSha256).toBe(item.sourceSha256);
    expect(requests).toEqual([`GET /api/21st/${encodeURIComponent(item.id)}/source`]);
  });
  it('exports all standalone files and refuses an existing directory without changing it', async () => {
    const base = await startOriginalStub();
    const temp = await mkdtemp(pathResolve(tmpdir(),'21st-export-'));
    const target = pathResolve(temp,'original');
    const item = originals.items[0]!;
    try {
      const args = ['21st', 'export',item.id,'--out',target,'--json','--daemon-url',base];
      const result = await runCli(args);
      expect(result.code,result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).files).toHaveLength(7);
      for(const file of item.files) expect(await readFile(pathResolve(target,file.path),'utf8')).toBe(file.content);
      expect((await runCli(args)).code).not.toBe(0);
      expect(await readFile(pathResolve(target,'NOTICE.txt'),'utf8')).toContain('INDEPENDENTLY AUTHORED');
    } finally { await rm(temp,{recursive:true,force:true}); }
  });
  it('reads the same executable preview HTML through the preview endpoint', async () => {
    const base = await startOriginalStub();
    const item = originals.items[0]!;
    const result = await runCli(['21st', 'preview',item.id,'--json','--daemon-url',base]);
    expect(result.code,result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).html).toBe(item.files.find(file=>file.path==='index.html')!.content);
  });
  it('rejects a corrupted source checksum before export', async () => {
    const base = await startOriginalStub(true);
    const result = await runCli(['21st', 'source',originals.items[0]!.id,'--json','--daemon-url',base]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('checksum mismatch');
  });
});
