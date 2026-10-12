// `od cult add` against a temp project dir: the real registry route (throwaway source kit) behind
// real HTTP, driven through `runCultAddCli` so nothing spawns the CLI or installs packages.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { chmodSync, readdirSync } from 'node:fs';

import { detectPackageManager, readProjectLayout, rerootVendorTarget, resolveTargetPath, rewriteImports, runCultAddCli, runCultShowCli, writeStaged, type CultAddSummary } from '../src/cult-add-cli.js';
import { registerCultRegistryRoutes } from '../src/routes/cult-registry.js';
import { writeFixtureKit } from './helpers/cult-kit-fixture.js';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  const sendApiError = (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });
  registerCultRegistryRoutes(app, { http: { sendApiError } } as never, writeFixtureKit());
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cult-add-'));
  for (const [file, content] of Object.entries({ 'package.json': '{"dependencies":{"motion":"^12.0.0"}}', ...files })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

async function add(args: string[], installs: Array<{ command: string; args: string[]; cwd: string }> = []) {
  return runCultAddCli(args, {
    resolveBaseUrl: async () => baseUrl,
    runInstall: (command, installArgs, cwd) => {
      installs.push({ command, args: installArgs, cwd });
      return 0;
    },
  });
}

function done(result: Awaited<ReturnType<typeof add>>) {
  if (result.kind !== 'done') throw new Error(`expected done, got ${result.kind}`);
  return result;
}

const read = (root: string, file: string) => readFileSync(path.join(root, file), 'utf8');

describe('od cult add', () => {
  it('without components.json: writes each file to its target, follows catalogued dependencies, lists packages', async () => {
    const root = project({ 'src/app/layout.tsx': 'x' });
    const result = done(await add(['cult:pricing-shelf', '--into', root, '--json']));
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as CultAddSummary;
    expect(summary.componentsJson).toBe(false);
    expect(summary.written).toBe(true);
    expect(summary.items.map((item) => [item.id, item.requestedBy])).toEqual([['cult:pricing-shelf', null], ['cult:glow-card', 'pricing-shelf']]);
    expect(summary.files.map((file) => [file.target, file.action])).toEqual([
      ['src/components/pricing-shelf.tsx', 'create'],
      ['src/hooks/use-tier.ts', 'create'],
      ['src/components/glow-card.tsx', 'create'],
    ]);
    expect(summary.dependencies).toEqual(['lucide-react', 'motion']);
    expect(summary.missingDependencies).toEqual(['lucide-react']);
    expect(summary.baseComponents).toEqual(['button']);
    expect(summary.installCommand).toBe('npm install lucide-react');
    expect(summary.installed).toBeNull();
    // The upstream `@/registry/ui/…` import lands on the ui alias.
    expect(read(root, 'src/components/pricing-shelf.tsx')).toContain("from '@/components/ui/button'");
    expect(read(root, 'src/components/glow-card.tsx')).toContain("from '@/lib/utils'");
  });

  it('with components.json: re-roots targets and imports on its aliases, and installs with the project package manager on --install', async () => {
    const root = project({
      'components.json': JSON.stringify({ aliases: { components: '~/kit', ui: '~/kit/base', lib: '~/support', hooks: '~/support/hooks', utils: '~/support/cn' } }),
      'tsconfig.json': '{ "compilerOptions": { "paths": { "~/*": ["./web/*"] } }, // comment\n }',
      'pnpm-lock.yaml': '',
    });
    const installs: Array<{ command: string; args: string[]; cwd: string }> = [];
    const result = done(await add(['pricing-shelf', '--into', root, '--install'], installs));
    expect(result.code).toBe(0);
    expect(existsSync(path.join(root, 'web/kit/pricing-shelf.tsx'))).toBe(true);
    expect(existsSync(path.join(root, 'web/support/hooks/use-tier.ts'))).toBe(true);
    const shelf = read(root, 'web/kit/pricing-shelf.tsx');
    expect(shelf).toContain("from '~/kit/glow-card'");
    expect(shelf).toContain("from '~/kit/base/button'");
    expect(shelf).toContain("from '~/support/hooks/use-tier'");
    expect(read(root, 'web/kit/glow-card.tsx')).toContain("from '~/support/cn'");
    expect(installs).toEqual([{ command: 'pnpm', args: ['add', 'lucide-react'], cwd: root }]);
    expect(result.stdout).toContain('Installed with: pnpm add lucide-react');
  });

  it('never overwrites your own differing file outside the item folder, even with --force, and writes nothing', async () => {
    const root = project({ 'components/glow-card.tsx': 'mine\n' });
    const result = done(await add(['cult:pricing-shelf', '--into', root]));
    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toContain('components/glow-card.tsx');
    expect(result.stdout).toContain('KEPT\tcomponents/glow-card.tsx');
    expect(read(root, 'components/glow-card.tsx')).toBe('mine\n');
    expect(existsSync(path.join(root, 'components/pricing-shelf.tsx'))).toBe(false);

    // components/glow-card.tsx is yours and outside the item's folder: --force never replaces it.
    const forced = done(await add(['cult:pricing-shelf', '--into', root, '--force', '--json']));
    expect(forced.code).toBe(1);
    const summary = JSON.parse(forced.stdout) as CultAddSummary;
    expect(summary.protected).toEqual(['components/glow-card.tsx']);
    expect(summary.files.find((file) => file.target === 'components/glow-card.tsx')?.action).toBe('protected');
    expect(forced.stderr.join('\n')).toContain('--force never replaces them');
    expect(read(root, 'components/glow-card.tsx')).toBe('mine\n');
    expect(existsSync(path.join(root, 'components/pricing-shelf.tsx'))).toBe(false);
  });

  it('--force replaces a differing file only inside the item\'s own folder', async () => {
    const root = project({ 'app/(cult)/shop/page.tsx': 'stale copy\n' });
    const plain = done(await add(['cult:shop', '--into', root]));
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain('CONFLICT\tapp/(cult)/shop/page.tsx');
    const forced = done(await add(['cult:shop', '--into', root, '--force']));
    expect(forced.code).toBe(0);
    expect(read(root, 'app/(cult)/shop/page.tsx')).toContain('export default function Page');
  });

  it('leaves an identical file alone and succeeds', async () => {
    const root = project();
    done(await add(['cult:glow-card', '--into', root]));
    const again = done(await add(['cult:glow-card', '--into', root, '--json']));
    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as CultAddSummary).files).toEqual([
      { item: 'glow-card', source: 'registry/components/glow-card.tsx', target: 'components/glow-card.tsx', action: 'unchanged' },
    ]);
  });

  it('--dry-run reports the plan and writes nothing, and never installs', async () => {
    const root = project();
    const installs: Array<{ command: string; args: string[]; cwd: string }> = [];
    const result = done(await add(['cult:shop--hero', '--into', root, '--dry-run', '--install', '--json'], installs));
    const summary = JSON.parse(result.stdout) as CultAddSummary;
    expect(summary.dryRun).toBe(true);
    expect(summary.written).toBe(false);
    expect(summary.files.map((file) => file.target)).toEqual(['app/(cult)/shop--hero/page.tsx', 'components/hero.tsx']);
    expect(existsSync(path.join(root, 'app'))).toBe(false);
    expect(existsSync(path.join(root, 'components'))).toBe(false);
    expect(installs).toEqual([]);
  });

  it('passes a daemon refusal through, and rejects bad arguments before any request', async () => {
    const root = project();
    const missing = await add(['cult:nope', '--into', root]);
    expect(missing.kind).toBe('http-failure');
    if (missing.kind === 'http-failure') expect(missing.response.status).toBe(404);
    expect((await add(['cult:../x', '--into', root])).kind).toBe('usage');
    expect((await add(['cult:glow-card'])).kind).toBe('usage');
    expect((await add(['cult:glow-card', '--into', path.join(root, 'nope')])).kind).toBe('usage');
    expect((await add(['cult:glow-card', '--into', root, '--bogus'])).kind).toBe('usage');
  });
});

describe('target resolution', () => {
  it('never resolves outside the project', () => {
    const layout = readProjectLayout(project());
    expect(() => resolveTargetPath({ path: 'a', type: 'registry:lib', target: '../../etc/passwd' }, layout)).toThrow(/unsafe target/);
    expect(() => resolveTargetPath({ path: 'a', type: 'registry:lib', target: '/etc/passwd' }, layout)).toThrow(/unsafe target/);
    expect(() => resolveTargetPath({ path: 'a', type: 'registry:lib', target: 'lib/../../x' }, layout)).toThrow(/unsafe target/);
    expect(resolveTargetPath({ path: 'registry/x/util.ts', type: 'registry:lib', target: '' }, layout)).toBe('lib/util.ts');
  });

  it('a file without a target takes shadcn\'s default placement, never a bare folder', () => {
    const layout = readProjectLayout(project({ 'src/app/layout.tsx': 'x' }));
    for (const target of ['', undefined]) {
      expect(rerootVendorTarget(target, 'x')).toBeNull();
      expect(resolveTargetPath({ path: 'registry/new-york/ui/button.tsx', type: 'registry:ui', target: target as string }, layout)).toBe('src/components/ui/button.tsx');
      expect(resolveTargetPath({ path: 'registry/x/ui/forms/field.tsx', type: 'registry:ui', target: target as string }, layout)).toBe('src/components/ui/forms/field.tsx');
      expect(resolveTargetPath({ path: 'registry/x/lib/format.ts', type: 'registry:lib', target: target as string }, layout)).toBe('src/lib/format.ts');
      expect(resolveTargetPath({ path: 'registry/x/hooks/use-x.ts', type: 'registry:hook', target: target as string }, layout)).toBe('src/hooks/use-x.ts');
      expect(resolveTargetPath({ path: 'registry/x/card.tsx', type: 'registry:component', target: target as string }, layout)).toBe('src/components/card.tsx');
    }
  });

  it('rewrites only @/ specifiers', () => {
    const aliases = { components: '@/c', ui: '@/c/ui', lib: '@/l', hooks: '@/h', utils: '@/l/cn' };
    expect(rewriteImports(`import a from "@/registry/blocks/x/lib/y";\nimport b from 'react';\nimport c from "@/lib/utils";`, aliases))
      .toBe(`import a from "@/l/y";\nimport b from 'react';\nimport c from "@/l/cn";`);
  });
});

describe('od cult add: pages never replace the project root page or layout', () => {
  it('re-roots page targets under app/(cult)/<item>/ and keeps their relative imports working', async () => {
    const root = project({ 'src/app/page.tsx': 'mine\n' });
    const result = done(await add(['cult:shop', '--into', root, '--force', '--json']));
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as CultAddSummary;
    expect(summary.files.map((file) => [file.target, file.action])).toEqual([
      ['src/app/(cult)/shop/page.tsx', 'create'],
      ['src/components/hero.tsx', 'create'],
    ]);
    expect(read(root, 'src/app/page.tsx')).toBe('mine\n');
    const page = read(root, 'src/app/(cult)/shop/page.tsx');
    expect(page).toContain("from '@/components/hero'");
    // An import that resolved to nothing before the move is left as it was.
    expect(page).toContain("from '../nowhere/missing'");
  });

  it('re-roots every app/** target and root-level file into the item\'s own folder', () => {
    expect(rerootVendorTarget('app/layout.tsx', 'x')).toBe('app/(cult)/x/layout.tsx');
    expect(rerootVendorTarget('app/success/page.tsx', 'x')).toBe('app/(cult)/x/success/page.tsx');
    expect(rerootVendorTarget('app/api/chat/route.ts', 'x')).toBe('app/(cult)/x/api/chat/route.ts');
    expect(rerootVendorTarget('app/demo.tsx', 'x')).toBe('app/(cult)/x/demo.tsx');
    expect(rerootVendorTarget('AGENT_FLOW.md', 'x')).toBe('docs/cult/x/AGENT_FLOW.md');
    expect(rerootVendorTarget('middleware.ts', 'x')).toBe('app/(cult)/x/middleware.ts');
    expect(rerootVendorTarget('sections/x/page.tsx', 'x')).toBeNull();
    expect(rerootVendorTarget('components/page.tsx', 'x')).toBeNull();
  });

  it('two items that ship the same app files each land in their own folder and import their own demo', async () => {
    const root = project({ 'src/app/page.tsx': 'mine\n', 'src/app/api/chat/route.ts': 'my route\n', 'AGENT_FLOW.md': 'mine\n' });
    const result = done(await add(['cult:alpha-app', 'cult:beta-app', '--into', root, '--force', '--json']));
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as CultAddSummary;
    expect(summary.files.every((file) => file.action === 'create')).toBe(true);
    expect(summary.warnings).toEqual([]);
    for (const name of ['alpha-app', 'beta-app']) {
      const page = read(root, `src/app/(cult)/${name}/page.tsx`);
      expect(page).toContain(`from '@/app/(cult)/${name}/demo'`);
      expect(page).toContain(`from '@/app/(cult)/${name}/actions'`);
      expect(read(root, `src/app/(cult)/${name}/demo.tsx`)).toContain(name);
      expect(read(root, `src/app/(cult)/${name}/api/chat/route.ts`)).toContain(name);
      expect(read(root, `docs/cult/${name}/AGENT_FLOW.md`)).toBe(`# ${name}\n`);
    }
    expect(read(root, 'src/app/page.tsx')).toBe('mine\n');
    expect(read(root, 'src/app/api/chat/route.ts')).toBe('my route\n');
    expect(read(root, 'AGENT_FLOW.md')).toBe('mine\n');
  });
});

describe('od cult add: a renamed item folder (G11)', () => {
  let ctaServer: http.Server;
  let ctaBaseUrl: string;

  beforeAll(async () => {
    const app = express();
    const sendApiError = (res: express.Response, status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message } });
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
    registerCultRegistryRoutes(app, { http: { sendApiError } } as never, {
      rows: fixture.rows,
      kitDir: fixture.kitDir,
      slugs: new Map([['cult:marketing-cta-hex', 'cta-hex']]),
    });
    ctaServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => ctaServer.once('listening', () => resolve()));
    ctaBaseUrl = `http://127.0.0.1:${(ctaServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => ctaServer.close(() => resolve()));
  });

  async function ctaAdd(args: string[]) {
    return runCultAddCli(args, { resolveBaseUrl: async () => ctaBaseUrl });
  }

  it('installs into the public-slug folder, not the internal row name', async () => {
    const root = project();
    const result = done(await ctaAdd(['cta-hex', '--into', root, '--json']));
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as CultAddSummary;
    expect(summary.files.map((file) => [file.target, file.action])).toEqual([
      ['sections/cta-hex/page.tsx', 'create'],
      ['sections/cta-hex/layout.tsx', 'create'],
    ]);
    expect(existsSync(path.join(root, 'sections/cta-hex/page.tsx'))).toBe(true);
    expect(existsSync(path.join(root, 'sections/marketing-cta-hex'))).toBe(false);
    expect(read(root, 'sections/cta-hex/page.tsx')).toContain("from './layout'");
  });

  it('CONFLICTs on a changed file inside the slug folder, and --force overwrites it', async () => {
    const root = project();
    done(await ctaAdd(['cta-hex', '--into', root]));
    writeFileSync(path.join(root, 'sections/cta-hex/page.tsx'), 'mine\n');
    const conflict = done(await ctaAdd(['cta-hex', '--into', root]));
    expect(conflict.code).toBe(1);
    expect(conflict.stdout).toContain('CONFLICT\tsections/cta-hex/page.tsx');
    expect(read(root, 'sections/cta-hex/page.tsx')).toBe('mine\n');
    const forced = done(await ctaAdd(['cta-hex', '--into', root, '--force']));
    expect(forced.code).toBe(0);
    expect(read(root, 'sections/cta-hex/page.tsx')).toContain('export default function Page');
  });

  it('reports an earlier copy left at the old folder name, and never touches it', async () => {
    const root = project({ 'sections/marketing-cta-hex/page.tsx': 'old copy\n' });
    const result = done(await ctaAdd(['cta-hex', '--into', root, '--json']));
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as CultAddSummary;
    expect(summary.earlierCopies).toEqual([
      'an earlier copy of cta-hex is at sections/marketing-cta-hex/ (its old folder name); it was left as it is.',
    ]);
    expect(result.stderr.join('\n')).toContain('[cult] note: an earlier copy of cta-hex is at sections/marketing-cta-hex/');
    // Detection only: the old copy is left exactly as it was, and every new file still gets written.
    expect(read(root, 'sections/marketing-cta-hex/page.tsx')).toBe('old copy\n');
    expect(existsSync(path.join(root, 'sections/cta-hex/page.tsx'))).toBe(true);
    expect(summary.files.every((file) => file.action === 'create')).toBe(true);
  });
});

describe('od cult add: package manager', () => {
  it('walks up to the nearest packageManager field or lockfile', () => {
    const workspace = project({ 'pnpm-lock.yaml': '', 'apps/web/package.json': '{}' });
    expect(detectPackageManager(path.join(workspace, 'apps/web'))).toBe('pnpm');
    const declared = project({ 'package.json': '{"packageManager":"yarn@4.1.0"}', 'apps/web/package.json': '{}' });
    expect(detectPackageManager(path.join(declared, 'apps/web'))).toBe('yarn');
    const nearest = project({ 'pnpm-lock.yaml': '', 'apps/web/bun.lock': '' });
    expect(detectPackageManager(path.join(nearest, 'apps/web'))).toBe('bun');
  });

  it('stops at the nearest workspace or git root, and never reaches the home directory', () => {
    // A lockfile above a git root decides nothing for the repo below it.
    const aboveGit = project({ 'yarn.lock': '', 'repo/.git/HEAD': 'ref\n', 'repo/app/package.json': '{}' });
    expect(detectPackageManager(path.join(aboveGit, 'repo/app'))).toBe('npm');
    // Nor above a workspace root that declares no manager of its own.
    const aboveWorkspace = project({ 'pnpm-lock.yaml': '', 'mono/package.json': '{"workspaces":["apps/*"]}', 'mono/apps/web/package.json': '{}' });
    expect(detectPackageManager(path.join(aboveWorkspace, 'mono/apps/web'))).toBe('npm');
    // A stray lockfile in the home directory never counts.
    const home = project({ 'pnpm-lock.yaml': '', 'code/site/package.json': '{}' });
    expect(detectPackageManager(path.join(home, 'code/site'), home)).toBe('npm');
  });

  it('--install in a workspace package uses the workspace manager', async () => {
    const workspace = project({ 'pnpm-workspace.yaml': 'packages: [apps/*]\n', 'apps/web/package.json': '{"dependencies":{}}' });
    const installs: Array<{ command: string; args: string[]; cwd: string }> = [];
    done(await add(['cult:glow-card', '--into', path.join(workspace, 'apps/web'), '--install'], installs));
    expect(installs).toEqual([{ command: 'pnpm', args: ['add', 'motion'], cwd: path.join(workspace, 'apps/web') }]);
  });
});

describe('od cult add: all or nothing', () => {
  it('reports a directory in the way as BLOCKED, even with --force, and writes nothing', async () => {
    const root = project();
    mkdirSync(path.join(root, 'components/glow-card.tsx'), { recursive: true });
    const result = done(await add(['cult:pricing-shelf', '--into', root, '--force']));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('BLOCKED\tcomponents/glow-card.tsx');
    expect(result.stderr.join('\n')).toContain('directories or unreadable');
    expect(existsSync(path.join(root, 'components/pricing-shelf.tsx'))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('rolls every file back when a write fails part-way', () => {
    const root = project({ 'lib/keep.ts': 'old\n' });
    mkdirSync(path.join(root, 'locked'));
    chmodSync(path.join(root, 'locked'), 0o555);
    try {
      const failure = writeStaged(root, [
        { target: 'lib/keep.ts', content: 'new\n' },
        { target: 'fresh/a.ts', content: 'a\n' },
        { target: 'locked/b.ts', content: 'b\n' },
      ]);
      expect(failure).toMatch(/could not write locked\/b\.ts \(EACCES\)/);
      expect(read(root, 'lib/keep.ts')).toBe('old\n');
      expect(existsSync(path.join(root, 'fresh'))).toBe(false);
      expect(readdirSync(path.join(root, 'lib'))).toEqual(['keep.ts']);
    } finally {
      chmodSync(path.join(root, 'locked'), 0o755);
    }
  });

  it('writes every staged file when nothing fails', () => {
    const root = project({ 'lib/keep.ts': 'old\n' });
    expect(writeStaged(root, [{ target: 'lib/keep.ts', content: 'new\n' }, { target: 'deep/er/a.ts', content: 'a\n' }])).toBeNull();
    expect(read(root, 'lib/keep.ts')).toBe('new\n');
    expect(read(root, 'deep/er/a.ts')).toBe('a\n');
    expect(readdirSync(path.join(root, 'lib'))).toEqual(['keep.ts']);
  });
});

describe('od cult show', () => {
  const show = (args: string[]) => runCultShowCli(args, { resolveBaseUrl: async () => baseUrl });

  it('prints the main file as "Copy code" copies it, with imports on the default aliases', async () => {
    const result = done(await show(['cult:pricing-shelf']));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("from '@/components/ui/button'");
    expect(result.stdout).not.toContain('@/registry/');
  });

  it('prints another file with --file, and the whole response with --json', async () => {
    expect(done(await show(['pricing-shelf', '--file', 'hooks/use-tier.ts'])).stdout).toBe('export function useTier() { return 1; }\n');
    const json = JSON.parse(done(await show(['cult:pricing-shelf', '--json'])).stdout) as { copy: { files: Array<{ target: string }> } };
    expect(json.copy.files.map((file) => file.target)).toEqual(['components/pricing-shelf.tsx', 'hooks/use-tier.ts']);
    const missing = await show(['cult:pricing-shelf', '--file', 'nope.ts']);
    expect(missing.kind).toBe('http-failure');
    expect((await show([])).kind).toBe('usage');
  });
});

describe('od cult add: one file per destination', () => {
  it('refuses two different files for one destination instead of keeping one, and writes nothing', async () => {
    const { kitDir, rows } = writeFixtureKit([
      { name: 'twin-a', files: [{ path: 'registry/a/ui/card.tsx', type: 'registry:ui', target: '', content: 'export const A = 1;\n' }] },
      { name: 'twin-b', files: [{ path: 'registry/b/ui/card.tsx', type: 'registry:ui', target: '', content: 'export const B = 1;\n' }] },
    ]);
    const app = express();
    const sendApiError = (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });
    registerCultRegistryRoutes(app, { http: { sendApiError } } as never, { kitDir, rows });
    const twin = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => twin.once('listening', () => resolve()));
    try {
      const root = project();
      const result = await runCultAddCli(['cult:twin-a', 'cult:twin-b', '--into', root], {
        resolveBaseUrl: async () => `http://127.0.0.1:${(twin.address() as AddressInfo).port}`,
      });
      expect(result.kind).toBe('done');
      if (result.kind !== 'done') return;
      expect(result.code).toBe(1);
      expect(result.stderr.join('\n')).toContain('two different files would be written to components/ui/card.tsx');
      expect(existsSync(path.join(root, 'components'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => twin.close(() => resolve()));
    }
  });
});
