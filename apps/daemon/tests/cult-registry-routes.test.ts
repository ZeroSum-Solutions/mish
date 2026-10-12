// Remix into project: GET /api/cult/r/<slug>.json and GET /api/cult/copy/:id.
//
// Mounted on a bare Express app with a throwaway source kit (tests/helpers/cult-kit-fixture.ts),
// plus one pass over the real inventory against the real kit when this machine has it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cultLocalOnlyRefusal, parseCultCopyResponse, parseCultRegistryItem } from '@mish/contracts';
import cultInventoryJson from '@mish/cult-ui-catalog/catalog.json' with { type: 'json' };
import { mainFileOf, repairRelativeImports, resolveCultKitDir, type CultRegistryRow } from '../src/cult-registry.js';
import { registerCultRegistryRoutes } from '../src/routes/cult-registry.js';
import { writeFixtureKit } from './helpers/cult-kit-fixture.js';

function sendApiError(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

let server: http.Server;
let port: number;
let baseUrl: string;
let kitDir: string;

async function mount(options: { rows?: CultRegistryRow[]; kitDir?: string | null; slugs?: ReadonlyMap<string, string> }) {
  const app = express();
  registerCultRegistryRoutes(app, { http: { sendApiError } } as never, options);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
}

/** A raw request, so the test controls Host and forwarding headers exactly. */
function rawGet(pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/cult/r/<name>.json', () => {
  beforeEach(async () => {
    const fixture = writeFixtureKit();
    kitDir = fixture.kitDir;
    await mount(fixture);
  });

  it('serves a catalogued item with its files and points catalogued dependencies back at itself', async () => {
    const resp = await fetch(`${baseUrl}/api/cult/r/pricing-shelf.json`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('cache-control')).toBe('no-store');
    const item = parseCultRegistryItem(await resp.json());
    expect(item.name).toBe('pricing-shelf');
    expect(item.dependencies).toEqual(['lucide-react', 'motion']);
    expect(item.registryDependencies).toEqual([`${baseUrl}/api/cult/r/glow-card.json`, 'button']);
    expect(item.files.map((file) => file.target)).toEqual(['components/pricing-shelf.tsx', 'hooks/use-tier.ts']);
    expect(item.files[0]!.content).toContain("from '@/registry/ui/button'");
    // A vendor-layout relative import is repointed at the one target it names.
    expect(item.files[0]!.content).toContain("export { GlowCard as Again } from '@/components/glow-card';");
  });

  it('leaves relative imports that resolve, or match nothing, exactly as they are', async () => {
    const item = parseCultRegistryItem(await (await fetch(`${baseUrl}/api/cult/r/shop.json`)).json());
    expect(item.files[0]!.content).toContain("from '../components/hero'");
    expect(item.files[0]!.content).toContain("from '../nowhere/missing'");
  });

  it('serves a derived section as its page item under its own name', async () => {
    const item = parseCultRegistryItem(await (await fetch(`${baseUrl}/api/cult/r/shop--hero.json`)).json());
    expect(item.name).toBe('shop--hero');
    expect(item.files.map((file) => file.target)).toEqual(['app/page.tsx', 'components/hero.tsx']);
  });

  it('answers 404 for a name the catalog does not have, even when the kit has the file', async () => {
    writeFileSync(path.join(kitDir, 'registry', 'stray.json'), '{"name":"stray","files":[]}');
    const resp = await fetch(`${baseUrl}/api/cult/r/stray.json`);
    expect(resp.status).toBe(404);
    expect(((await resp.json()) as { error: { code: string; message: string } }).error.code).toBe('NOT_FOUND');
    expect((await fetch(`${baseUrl}/api/cult/r/glow-card.txt`)).status).toBe(404);
  });

  it('refuses traversal and malformed names without reading outside registry/', async () => {
    for (const bad of ['..%2F..%2F..%2Fetc%2Fpasswd.json', '%2e%2e.json', '..%2Findex.json', 'Glow-Card.json', 'glow-card%00.json', '.hidden.json', `${'a'.repeat(200)}.json`]) {
      const resp = await rawGet(`/api/cult/r/${bad}`);
      expect([400, 404], bad).toContain(resp.status);
      expect(resp.body, bad).not.toContain('root:');
      expect(resp.body, bad).not.toContain('"files"');
    }
    const dotdot = await rawGet('/api/cult/r/../../catalog');
    expect(dotdot.body).not.toContain('"files"');
  });

  it('refuses a kit item whose bytes differ from the pinned sha256', async () => {
    const file = path.join(kitDir, 'registry', 'glow-card.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('GlowCard', 'Changed'));
    const resp = await fetch(`${baseUrl}/api/cult/r/glow-card.json`);
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: { code: string; message: string } }).error.code).toBe('KIT_DRIFT');
  });

  it('serves this machine only: a non-loopback Host, Origin or forwarded hop is refused', async () => {
    expect((await rawGet('/api/cult/r/glow-card.json', { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await rawGet('/api/cult/r/glow-card.json', { host: 'evil.example' })).status).toBe(403);
    expect((await rawGet('/api/cult/r/glow-card.json', { host: `127.0.0.1:${port}`, origin: 'https://evil.example' })).status).toBe(403);
    expect((await rawGet('/api/cult/r/glow-card.json', { host: `127.0.0.1:${port}`, 'x-forwarded-for': '203.0.113.7' })).status).toBe(403);
    expect((await rawGet('/api/cult/r/glow-card.json', { host: `127.0.0.1:${port}`, 'x-forwarded-host': 'mishh.example.com' })).status).toBe(403);
    expect((await rawGet('/api/cult/r/glow-card.json', { host: `127.0.0.1:${port}`, forwarded: 'for=198.51.100.2;host=a.example' })).status).toBe(403);
    // Exactly what the real web sidecar proxy sends (apps/web/tests/sidecar-proxy-forwarded-for.test.ts):
    // the daemon's own Host and Origin, and X-Forwarded-For naming the browser it accepted.
    const sidecar = (client: string) => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'x-forwarded-for': client });
    expect((await rawGet('/api/cult/copy/cult:glow-card', sidecar('127.0.0.1'))).status).toBe(200);
    expect((await rawGet('/api/cult/copy/cult:glow-card', sidecar('::1'))).status).toBe(200);
    // Next's dev rewrite proxy with a spoofed Host and a spoofed loopback X-Forwarded-For.
    const nextDev = await rawGet('/API/cult/r/glow-card.json', { host: `127.0.0.1:${port}`, 'x-forwarded-host': 'localhost:3000', 'x-forwarded-for': '127.0.0.1' });
    expect(nextDev.status).toBe(403);
    expect(nextDev.body).not.toContain('GlowCard');
    for (const client of ['192.168.50.99', '::ffff:192.168.50.99', '127.0.0.1, 192.168.50.99', 'unknown']) {
      const lan = await rawGet('/api/cult/r/glow-card.json', sidecar(client));
      expect(lan.status, client).toBe(403);
      expect(lan.body, client).not.toContain('GlowCard');
    }
  });
});

describe('cultLocalOnlyRefusal', () => {
  const at = (headers: Record<string, string>, peer = '127.0.0.1') =>
    cultLocalOnlyRefusal({ peer, header: (name) => ({ host: '127.0.0.1:7456', ...headers })[name.toLowerCase()] });
  it('serves this machine, directly or through the web sidecar', () => {
    expect(at({})).toBeNull();
    expect(at({}, '::ffff:127.0.0.1')).toBeNull();
    expect(at({ host: 'localhost:7456', origin: 'http://localhost:3000' })).toBeNull();
    expect(at({ 'x-forwarded-for': '127.0.0.1, ::1, ::ffff:127.0.0.1' })).toBeNull();
    expect(at({ forwarded: 'for="[::1]:4711"' })).toBeNull();
  });
  it('refuses a non-loopback peer, Host, Origin or forwarded client', () => {
    expect(at({}, '192.168.50.99')).toMatch(/peer/);
    expect(at({ host: 'evil.example' })).toMatch(/Host/);
    expect(at({ host: '127.0.0.1.evil.example' })).toMatch(/Host/);
    expect(at({ origin: 'https://evil.example' })).toMatch(/Origin/);
    expect(at({ 'x-forwarded-for': '127.0.0.1, 10.0.0.4' })).toMatch(/client/);
    expect(at({ forwarded: 'for=unknown' })).toMatch(/client/);
  });
  it('refuses any forwarded host, scheme or port, even next to a loopback X-Forwarded-For', () => {
    // The shape of Next's dev rewrite proxy: X-Forwarded-Host copied from a client-chosen Host, and
    // a client-sent X-Forwarded-For passed through untouched.
    expect(at({ 'x-forwarded-host': 'localhost:3000', 'x-forwarded-for': '127.0.0.1' })).toMatch(/x-forwarded-host/);
    expect(at({ 'x-forwarded-host': '192.168.50.99:3000' })).toMatch(/x-forwarded-host/);
    expect(at({ 'x-forwarded-proto': 'http' })).toMatch(/x-forwarded-proto/);
    expect(at({ 'x-forwarded-port': '3000', 'x-forwarded-for': '::1' })).toMatch(/x-forwarded-port/);
    expect(at({ forwarded: 'for=127.0.0.1;host=localhost:3000' })).toMatch(/host=/);
  });
});

describe('GET /api/cult/copy/:id', () => {
  beforeEach(async () => {
    await mount(writeFixtureKit());
  });

  it('answers the install URL, packages and main file for a row', async () => {
    const { copy } = parseCultCopyResponse(await (await fetch(`${baseUrl}/api/cult/copy/cult:pricing-shelf`)).json());
    expect(copy).toMatchObject({
      id: 'cult:pricing-shelf',
      registryUrl: `${baseUrl}/api/cult/r/pricing-shelf.json`,
      dependencies: ['lucide-react', 'motion'],
    });
    expect(copy.mainFile.target).toBe('components/pricing-shelf.tsx');
    const derived = parseCultCopyResponse(await (await fetch(`${baseUrl}/api/cult/copy/cult:shop--hero`)).json());
    expect(derived.copy.mainFile.target).toBe('components/hero.tsx');
  });

  it('returns the file with imports on the default aliases, and picks another with ?file=', async () => {
    const { copy } = parseCultCopyResponse(await (await fetch(`${baseUrl}/api/cult/copy/cult:pricing-shelf`)).json());
    expect(copy.mainFile.content).toContain("from '@/components/ui/button'");
    expect(copy.mainFile.content).not.toContain('@/registry/');
    expect(copy.files.map((file) => file.target)).toEqual(['components/pricing-shelf.tsx', 'hooks/use-tier.ts']);
    const picked = parseCultCopyResponse(await (await fetch(`${baseUrl}/api/cult/copy/cult:pricing-shelf?file=hooks/use-tier.ts`)).json());
    expect(picked.copy.mainFile.target).toBe('hooks/use-tier.ts');
    expect((await fetch(`${baseUrl}/api/cult/copy/cult:pricing-shelf?file=nope.ts`)).status).toBe(404);
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    expect((await fetch(`${baseUrl}/api/cult/copy/cult:nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/cult/copy/${encodeURIComponent('cult:../x')}`)).status).toBe(400);
  });
});

describe('repairRelativeImports', () => {
  const f = (p: string, target: string, content = '') => ({ path: p, target, content });

  it('repoints an import by the vendor path, never at the file itself', () => {
    const demo = f('registry/components/example/board-demo.tsx', 'components/board-demo.tsx', "import { Board } from '../board';\n");
    const board = f('registry/components/board.tsx', 'components/board.tsx');
    expect(repairRelativeImports(demo, [demo, board])).toBe("import { Board } from '@/components/board';\n");
    const self = f('registry/x/a/self.tsx', 'components/self.tsx', "import './self';\n");
    expect(repairRelativeImports(self, [self])).toBe("import './self';\n");
  });

  it('tail-matches only a tail with a directory segment, and only when unambiguous', () => {
    const page = f('registry/p/app/page.tsx', 'app/page.tsx', "import a from '../lib/hooks/use-x';\nimport b from './types';\nimport c from '../widgets/card';\n");
    const files = [page, f('registry/p/hooks/use-x.ts', 'hooks/use-x.ts'), f('registry/p/types.ts', 'lib/types.ts'),
      f('registry/p/a/card.tsx', 'components/a/widgets/card.tsx'), f('registry/p/b/card.tsx', 'components/b/widgets/card.tsx')];
    expect(repairRelativeImports(page, files)).toBe("import a from '../lib/hooks/use-x';\nimport b from './types';\nimport c from '../widgets/card';\n");
    const dirTail = f('registry/p/app/page.tsx', 'app/page.tsx', "import a from '../../hooks/use-x';\n");
    expect(repairRelativeImports(dirTail, [dirTail, f('registry/q/use-x.ts', 'src/hooks/use-x.ts')])).toBe("import a from '@/src/hooks/use-x';\n");
  });

  it('never touches a stylesheet: the globals.css @import that used to point at itself', () => {
    const css = f('registry/sections/marketing-hero-heerich/app/globals.css', 'sections/marketing-hero-heerich/globals.css', '@import "../../../../globals.css";\n');
    const other = f('registry/globals.css', 'app/globals.css');
    expect(repairRelativeImports(css, [css, other])).toBe(css.content);
  });
});

describe('a renamed item folder (G11: folderAliases)', () => {
  it('serves the item under its slug folder, keeps relative imports resolving, and reports the old folder as an alias', async () => {
    const fixture = writeFixtureKit([
      {
        name: 'marketing-cta-hex',
        type: 'registry:block',
        files: [
          {
            path: 'registry/sections/marketing-cta-hex/page.tsx',
            type: 'registry:page',
            target: 'sections/marketing-cta-hex/page.tsx',
            content: "import Layout from './layout';\nexport default function Page() { return <Layout />; }\n",
          },
          {
            path: 'registry/sections/marketing-cta-hex/layout.tsx',
            type: 'registry:page',
            target: 'sections/marketing-cta-hex/layout.tsx',
            content: 'export default function Layout({ children }: { children: React.ReactNode }) { return children; }\n',
          },
        ],
      },
    ]);
    await mount({ rows: fixture.rows, kitDir: fixture.kitDir, slugs: new Map([['cult:marketing-cta-hex', 'cta-hex']]) });
    const resp = await fetch(`${baseUrl}/api/cult/r/cta-hex.json`);
    expect(resp.status).toBe(200);
    const item = parseCultRegistryItem(await resp.json());
    expect(item.name).toBe('cta-hex');
    expect(item.files.map((file) => [file.path, file.target])).toEqual([
      ['registry/sections/cta-hex/page.tsx', 'sections/cta-hex/page.tsx'],
      ['registry/sections/cta-hex/layout.tsx', 'sections/cta-hex/layout.tsx'],
    ]);
    // The internal name never survives anywhere the item is displayed or installed — only the
    // detection-only `folderAliases` field, checked below, names the old folder.
    const { folderAliases: _folderAliases, ...displayed } = item as typeof item & { folderAliases?: unknown };
    expect(JSON.stringify(displayed)).not.toContain('marketing-cta-hex');
    // A relative import within the item's own (renamed) folder still resolves.
    expect(item.files[0]!.content).toContain("from './layout'");
    expect(item.folderAliases).toEqual({ 'sections/cta-hex': 'sections/marketing-cta-hex' });
  });
});

describe('mainFileOf', () => {
  const file = (p: string, type = 'registry:component', content = 'x') => ({ path: p, type, target: p, content });
  it('prefers the section component over the page wrapper that renders it', () => {
    const files = [file('sections/x/page.tsx', 'registry:page'), file('components/diagonal-box.tsx'), file('components/cta-hex.tsx')];
    expect(mainFileOf({ name: 'marketing-cta-hex' }, files).path).toBe('components/cta-hex.tsx');
    expect(mainFileOf({ name: 'other' }, [file('a.tsx', 'registry:page'), file('b.tsx', 'registry:component', 'longer'), file('c.tsx')]).path).toBe('b.tsx');
  });
});

describe('without a configured kit', () => {
  it('answers 503 and names the setting', async () => {
    await mount({ rows: writeFixtureKit().rows, kitDir: null });
    const resp = await fetch(`${baseUrl}/api/cult/r/glow-card.json`);
    expect(resp.status).toBe(503);
    expect(((await resp.json()) as { error: { code: string; message: string } }).error.message).toContain('CULT_KIT_DIR');
  });
});

const realKit = resolveCultKitDir() ?? path.join(process.env.HOME ?? '', 'projects', 'mm-source-kits', 'cult-ui-pro');
describe.skipIf(!existsSync(path.join(realKit, 'registry', 'index.json')))('the shipped inventory against the real kit', () => {
  it('leaves the six globals.css @imports alone (they used to be rewritten to import themselves)', async () => {
    await mount({ kitDir: realKit });
    for (const name of ['marketing-cta-heerich', 'marketing-features-heerich', 'marketing-gallery-heerich', 'marketing-hero-heerich', 'marketing-process-heerich', 'marketing-hero-gradient']) {
      const raw = JSON.parse(readFileSync(path.join(realKit, 'registry', `${name}.json`), 'utf8')) as { files: Array<{ target: string; content: string }> };
      const served = parseCultRegistryItem(await (await fetch(`${baseUrl}/api/cult/r/${name}.json`)).json());
      // Served files keep the kit's order; their targets may carry brand-free folder names.
      const index = served.files.findIndex((file) => file.target.endsWith('globals.css'));
      const css = served.files[index]!;
      expect(css.content, name).toBe(raw.files[index]!.content);
      expect(css.content, name).toContain('@import "../../../../globals.css"');
    }
  });

  it('never repoints a served file at itself, and only rewrites script files', async () => {
    await mount({ kitDir: realKit });
    const rows = (cultInventoryJson as unknown as { rows: CultRegistryRow[] }).rows;
    for (const row of rows) {
      const served = parseCultRegistryItem(await (await fetch(`${baseUrl}/api/cult/r/${row.name}.json`)).json());
      for (const file of served.files) {
        const own = `@/${file.target.replace(/\.(?:tsx?|jsx?)$/, '')}`;
        expect(file.content.includes(`'${own}'`) || file.content.includes(`"${own}"`), `${row.name} ${file.target}`).toBe(false);
      }
    }
  });

  it('serves every catalogued row with pinned bytes and a main file', async () => {
    await mount({ kitDir: realKit });
    const rows = (cultInventoryJson as unknown as { rows: CultRegistryRow[] }).rows;
    for (const row of rows) {
      const resp = await fetch(`${baseUrl}/api/cult/copy/${encodeURIComponent(row.id)}`);
      expect(resp.status, row.id).toBe(200);
      const { copy } = parseCultCopyResponse(await resp.json());
      expect(copy.mainFile.content.length, row.id).toBeGreaterThan(0);
    }
  });
});
