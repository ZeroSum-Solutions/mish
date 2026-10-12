import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveCloudflarePagesAccess,
  resolveVercelLinkAccess,
  confirmAnonymousPageGet,
  pageMarkerFromHtml,
  deployLinkSentence,
  vercelLinkAccess,
  analyzeDeployPlan,
  buildDeployFilePlan,
  buildDeployFileSet,
  checkDeploymentUrl,
  chunkCloudflarePagesAssetUploads,
  CLOUDFLARE_PAGES_ASSET_MAX_BYTES,
  CLOUDFLARE_PAGES_PROVIDER_ID,
  cloudflarePagesAssetHash,
  cloudflarePagesProjectNameForProject,
  DEPLOY_PREFLIGHT_LARGE_ASSET_BYTES,
  DEPLOY_PREFLIGHT_LARGE_HTML_BYTES,
  deploymentUrlCandidates,
  deployToCloudflarePages,
  deployConfigPath,
  extractCssReferences,
  extractHtmlReferences,
  extractInlineCssReferences,
  injectDeployHookScript,
  isVercelProtectedResponse,
  listCloudflarePagesZones,
  normalizeDeployHookScriptUrl,
  prepareDeployPreflight,
  publicDeployConfig,
  readVercelConfig,
  resolveReferencedPath,
  rewriteCssReferences,
  rewriteEntryHtmlReferences,
  SAVED_CLOUDFLARE_TOKEN_MASK,
  SAVED_TOKEN_MASK,
  VERCEL_PROVIDER_ID,
  waitForReachableDeploymentUrl,
  writeCloudflarePagesConfig,
  writeVercelConfig,
} from '../src/deploy.js';
import { closeDatabase, getDeployment, insertProject, openDatabase, upsertDeployment } from '../src/db.js';
import { ensureProject } from '../src/projects.js';
import { checkCloudflarePagesDeploymentLinks } from '../src/deploy/cloudflare-pages-helpers.js';
import {
  createPinnedLookup,
  isForbiddenProbeAddress,
  MAX_BODY_BYTES,
  pinnedAddressOf,
  pinnedProbeDispatcher,
  readBodyCapped,
  sameDeploymentOwner,
} from '../src/deploy/public-page-probe.js';

async function setupProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-test-'));
  const projectId = 'p1';
  const dir = await ensureProject(path.join(root, 'projects'), projectId);
  return { projectsRoot: path.join(root, 'projects'), projectId, dir };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  closeDatabase();
});

describe('deploy config', () => {
  it('stores Vercel credentials in vercel.json and returns only the public mask', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-config-test-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const saved = await writeVercelConfig({
        token: 'vercel-token-secret',
        teamId: 'team_123',
        teamSlug: 'design-team',
      });

      expect(path.basename(deployConfigPath())).toBe('vercel.json');
      expect(saved).toEqual({
        providerId: VERCEL_PROVIDER_ID,
        configured: true,
        tokenMask: SAVED_TOKEN_MASK,
        teamId: 'team_123',
        teamSlug: 'design-team',
        target: 'preview',
      });
      expect(JSON.parse(await readFile(deployConfigPath(), 'utf8'))).toEqual({
        token: 'vercel-token-secret',
        teamId: 'team_123',
        teamSlug: 'design-team',
      });

      const maskedUpdate = await writeVercelConfig({
        token: SAVED_TOKEN_MASK,
        teamSlug: 'renamed-team',
      });

      expect(maskedUpdate.tokenMask).toBe(SAVED_TOKEN_MASK);
      expect(await readVercelConfig()).toEqual({
        token: 'vercel-token-secret',
        teamId: 'team_123',
        teamSlug: 'renamed-team',
      });
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('keeps Vercel public config provider metadata stable', () => {
    expect(publicDeployConfig({
      token: 'vercel-token-secret',
      teamId: '',
      teamSlug: '',
    })).toEqual({
      providerId: VERCEL_PROVIDER_ID,
      configured: true,
      tokenMask: SAVED_TOKEN_MASK,
      teamId: '',
      teamSlug: '',
      target: 'preview',
    });
  });

  it('stores Cloudflare Pages credentials separately from vercel.json', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-config-test-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      const saved = await writeCloudflarePagesConfig({
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
      });

      expect(path.basename(deployConfigPath(CLOUDFLARE_PAGES_PROVIDER_ID))).toBe('cloudflare-pages.json');
      expect(path.basename(deployConfigPath(VERCEL_PROVIDER_ID))).toBe('vercel.json');
      expect(saved).toEqual({
        providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
        configured: true,
        tokenMask: SAVED_CLOUDFLARE_TOKEN_MASK,
        teamId: '',
        teamSlug: '',
        accountId: 'account_123',
        projectName: '',
        target: 'preview',
      });
      expect(JSON.parse(await readFile(deployConfigPath(CLOUDFLARE_PAGES_PROVIDER_ID), 'utf8'))).toEqual({
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: '',
      });

      const maskedUpdate = await writeCloudflarePagesConfig({
        token: SAVED_CLOUDFLARE_TOKEN_MASK,
        accountId: 'account_456',
      });

      expect(maskedUpdate.tokenMask).toBe(SAVED_CLOUDFLARE_TOKEN_MASK);
      expect(maskedUpdate.accountId).toBe('account_456');
      expect(JSON.parse(await readFile(deployConfigPath(CLOUDFLARE_PAGES_PROVIDER_ID), 'utf8'))).toEqual({
        token: 'cloudflare-token-secret',
        accountId: 'account_456',
        projectName: '',
      });

      const withDomainHints = await writeCloudflarePagesConfig({
        token: SAVED_CLOUDFLARE_TOKEN_MASK,
        accountId: 'account_456',
        cloudflarePages: {
          lastZoneId: 'zone-1',
          lastZoneName: 'example.com',
          lastDomainPrefix: 'demo',
        },
      });
      expect((withDomainHints as any).cloudflarePages).toEqual({
        lastZoneId: 'zone-1',
        lastZoneName: 'example.com',
        lastDomainPrefix: 'demo',
      });

      const withoutDomainPrefix = await writeCloudflarePagesConfig({
        token: SAVED_CLOUDFLARE_TOKEN_MASK,
        accountId: 'account_456',
        cloudflarePages: {
          lastZoneId: 'zone-1',
          lastZoneName: 'example.com',
        },
      });
      expect((withoutDomainPrefix as any).cloudflarePages).toEqual({
        lastZoneId: 'zone-1',
        lastZoneName: 'example.com',
      });
      expect(JSON.parse(await readFile(deployConfigPath(CLOUDFLARE_PAGES_PROVIDER_ID), 'utf8'))).toMatchObject({
        cloudflarePages: {
          lastZoneId: 'zone-1',
          lastZoneName: 'example.com',
        },
      });
      expect(JSON.parse(await readFile(deployConfigPath(CLOUDFLARE_PAGES_PROVIDER_ID), 'utf8')).cloudflarePages).not.toHaveProperty(
        'lastDomainPrefix',
      );
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('requires Cloudflare Pages token and account id while deriving project names automatically', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-config-required-'));
    const priorStateRoot = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    try {
      await expect(writeCloudflarePagesConfig({
        token: 'cloudflare-token-secret',
      })).rejects.toThrow(/account ID is required/i);
      await expect(writeCloudflarePagesConfig({
        accountId: 'account_123',
      })).rejects.toThrow(/API token is required/i);
      expect(cloudflarePagesProjectNameForProject('project-123', 'AI 生图网站')).toBe(
        'od-ai-project-123',
      );
      expect(cloudflarePagesProjectNameForProject('12345678', '中文项目')).toBe(
        'od-project-12345678',
      );
    } finally {
      if (priorStateRoot === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = priorStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe('deploy file set', () => {
  it('deploys a single html file as index.html', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(path.join(dir, 'page.html'), '<!doctype html><h1>Hello</h1>');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'page.html');

    expect(files.map((f) => f.file)).toEqual(['index.html']);
  });

  it('excludes unreferenced files while keeping the selected entry at index.html', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'screens'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Launcher</h1>');
    await writeFile(path.join(dir, 'index-v1.html'), '<!doctype html><h1>V1</h1>');
    await writeFile(path.join(dir, 'screens', 'k1-waiting.html'), '<!doctype html><h1>K1</h1>');
    await writeFile(path.join(dir, 'index-v1.html.artifact.json'), '{}');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'index-v1.html');
    const index = files.find((item) => item.file === 'index.html');

    expect(files.map((f) => f.file).sort()).toEqual([
      'index.html',
    ]);
    expect(index?.sourcePath).toBe('index-v1.html');
    expect(index?.data.toString('utf8')).toContain('V1');
  });

  it('does not publish unreferenced files from linked-folder projects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-linked-test-'));
    const projectsRoot = path.join(root, 'projects');
    const linkedDir = path.join(root, 'linked');
    const projectId = 'linked-p1';
    const metadata = { baseDir: linkedDir };
    await mkdir(path.join(linkedDir, 'src'), { recursive: true });
    await writeFile(path.join(linkedDir, 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1>Linked</h1>');
    await writeFile(path.join(linkedDir, 'style.css'), 'body { color: black; }');
    await writeFile(path.join(linkedDir, 'README.md'), '# Private notes');
    await writeFile(path.join(linkedDir, 'src', 'app.ts'), 'export const secret = true;');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'index.html', {
      metadata,
    });

    expect(files.map((f) => f.file).sort()).toEqual([
      'index.html',
      'style.css',
    ]);
  });

  it('injects a closeable deploy hook script from cdn when configured', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(path.join(dir, 'page.html'), '<!doctype html><body><h1>Hello</h1></body>');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'page.html', {
      hookScriptUrl: 'https://cdn.example.com/mish-hook.js',
    });
    const html = files.find((f) => f.file === 'index.html')?.data.toString('utf8') ?? '';

    expect(html).toContain(
      '<script src="https://cdn.example.com/mish-hook.js" defer data-mish-deploy-hook="true" data-closeable="true"></script></body>',
    );
  });

  it('includes referenced html and css assets', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'assets'));
    await writeFile(
      path.join(dir, 'index.html'),
      '<link href="style.css" rel="stylesheet"><script src="app.js"></script><img src="assets/logo.png">',
    );
    await writeFile(path.join(dir, 'style.css'), '@import "./theme.css"; body{background:url("assets/bg.png")}');
    await writeFile(path.join(dir, 'theme.css'), '@font-face{src:url("font.woff2")}');
    await writeFile(path.join(dir, 'app.js'), 'console.log("ok")');
    await writeFile(path.join(dir, 'font.woff2'), 'font');
    await writeFile(path.join(dir, 'assets', 'logo.png'), 'logo');
    await writeFile(path.join(dir, 'assets', 'bg.png'), 'bg');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'index.html');

    expect(files.map((f) => f.file).sort()).toEqual([
      'app.js',
      'assets/bg.png',
      'assets/logo.png',
      'font.woff2',
      'index.html',
      'style.css',
      'theme.css',
    ]);
  });

  it('rewrites subdirectory html references to preserved project paths', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'sub', 'assets'), { recursive: true });
    await writeFile(
      path.join(dir, 'sub', 'page.html'),
      '<!doctype html><img src="assets/logo.png?cache=1#mark"><img src="/assets/root.png"><img srcset="assets/small.png 1x, assets/large.png 2x">',
    );
    await writeFile(path.join(dir, 'sub', 'assets', 'logo.png'), 'logo');
    await writeFile(path.join(dir, 'sub', 'assets', 'small.png'), 'small');
    await writeFile(path.join(dir, 'sub', 'assets', 'large.png'), 'large');
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'assets', 'root.png'), 'root');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'sub/page.html');
    const index = files.find((f) => f.file === 'index.html');

    expect(files.map((f) => f.file).sort()).toEqual([
      'assets/root.png',
      'index.html',
      'sub/assets/large.png',
      'sub/assets/logo.png',
      'sub/assets/small.png',
    ]);
    expect(index?.data.toString('utf8')).toContain('src="sub/assets/logo.png?cache=1#mark"');
    expect(index?.data.toString('utf8')).toContain('src="/assets/root.png"');
    expect(index?.data.toString('utf8')).toContain(
      'srcset="sub/assets/small.png 1x, sub/assets/large.png 2x"',
    );
  });

  it('keeps css content unchanged while deploying subdirectory css assets', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'sub', 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'sub', 'page.html'), '<link href="style.css" rel="stylesheet">');
    await writeFile(path.join(dir, 'sub', 'style.css'), 'body{background:url("assets/bg.png")}');
    await writeFile(path.join(dir, 'sub', 'assets', 'bg.png'), 'bg');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'sub/page.html');
    const index = files.find((f) => f.file === 'index.html');
    const css = files.find((f) => f.file === 'sub/style.css');

    expect(files.map((f) => f.file).sort()).toEqual([
      'index.html',
      'sub/assets/bg.png',
      'sub/style.css',
    ]);
    expect(index?.data.toString('utf8')).toContain('href="sub/style.css"');
    expect(css?.data.toString('utf8')).toBe('body{background:url("assets/bg.png")}');
  });

  it('rejects missing referenced local files', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(path.join(dir, 'index.html'), '<img src="missing.png">');

    await expect(buildDeployFileSet(projectsRoot, projectId, 'index.html')).rejects.toMatchObject({
      details: { missing: ['missing.png'] },
    });
  });

  it('does not treat navigation hrefs as deploy dependencies', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><a href="/pricing">Pricing</a><a href="contact">Contact</a>',
    );

    const files = await buildDeployFileSet(projectsRoot, projectId, 'index.html');
    const index = files.find((f) => f.file === 'index.html');

    expect(files.map((f) => f.file)).toEqual(['index.html']);
    expect(index?.data.toString('utf8')).toContain('href="/pricing"');
    expect(index?.data.toString('utf8')).toContain('href="contact"');
  });

  it('collects and rewrites unquoted asset attributes', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'sub', 'assets'), { recursive: true });
    await writeFile(
      path.join(dir, 'sub', 'page.html'),
      '<!doctype html><img src=assets/logo.png><video poster=assets/poster.png></video>',
    );
    await writeFile(path.join(dir, 'sub', 'assets', 'logo.png'), 'logo');
    await writeFile(path.join(dir, 'sub', 'assets', 'poster.png'), 'poster');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'sub/page.html');
    const index = files.find((f) => f.file === 'index.html');

    expect(files.map((f) => f.file).sort()).toEqual([
      'index.html',
      'sub/assets/logo.png',
      'sub/assets/poster.png',
    ]);
    expect(index?.data.toString('utf8')).toContain('src=sub/assets/logo.png');
    expect(index?.data.toString('utf8')).toContain('poster=sub/assets/poster.png');
  });

  it('ignores arbitrary URI schemes in html references', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(
      path.join(dir, 'index.html'),
      '<iframe src="about:blank"></iframe><a href="ftp://example.com/file">ftp</a><a href="sms:+15555550123">sms</a>',
    );

    const files = await buildDeployFileSet(projectsRoot, projectId, 'index.html');

    expect(files.map((f) => f.file)).toEqual(['index.html']);
  });

  it('ignores src-like text inside inline scripts', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><script>const text = \'<img src="missing.png">\';</script>',
    );

    const files = await buildDeployFileSet(projectsRoot, projectId, 'index.html');

    expect(files.map((f) => f.file)).toEqual(['index.html']);
  });

  it('collects and rewrites unquoted stylesheet links', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'sub', 'page.html'), '<link href=style.css rel=stylesheet>');
    await writeFile(path.join(dir, 'sub', 'style.css'), 'body{color:red}');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'sub/page.html');
    const index = files.find((f) => f.file === 'index.html');

    expect(files.map((f) => f.file).sort()).toEqual(['index.html', 'sub/style.css']);
    expect(index?.data.toString('utf8')).toContain('href=sub/style.css');
  });

  it('ignores remote, data, blob, mail, and anchor references', () => {
    const refs = extractHtmlReferences(
      '<a href="#x"></a><img src="https://x.test/a.png"><img src="data:image/png,abc"><script src="//cdn.test/a.js"></script><a href="mailto:a@test.com"></a>',
    )
      .map((ref) => resolveReferencedPath(ref, '.'))
      .filter(Boolean);

    expect(refs).toEqual([]);
  });

  it('extracts css imports and urls', () => {
    expect(extractCssReferences('@import "./theme.css"; body{background:url("img/bg.png")}')).toEqual([
      'img/bg.png',
      './theme.css',
    ]);
  });

  it('rewrites only local relative entry references', () => {
    expect(
      rewriteEntryHtmlReferences(
        '<a href="#x"></a><img src="https://x.test/a.png"><img src="data:image/png,abc"><script src="//cdn.test/a.js"></script><img src="asset.png">',
        'sub',
      ),
    ).toContain('src="sub/asset.png"');
  });

  it('ignores invalid deploy hook script urls', () => {
    expect(injectDeployHookScript('<body></body>', 'javascript:alert(1)')).toBe('<body></body>');
    expect(normalizeDeployHookScriptUrl('https://cdn.example.com/hook.js')).toBe(
      'https://cdn.example.com/hook.js',
    );
  });

  it('places the deploy hook at the real closing body tag', () => {
    // A prototype that builds an HTML document string writes `</body>` as
    // ordinary content. Splicing there ends the author's script with the hook
    // tag's own `</script>` and leaks the rest onto the deployed page
    // (upstream #7410).
    const authored = 'const doc = `<body>slip</body>`;';
    const html = '<!doctype html><html><head></head><body>'
      + `<script>${authored}<\/script><main>real</main></body></html>`;

    const out = injectDeployHookScript(html, 'https://cdn.example.com/hook.js');

    expect(out).toContain(authored);
    expect(out.indexOf('data-mish-deploy-hook')).toBeGreaterThan(out.indexOf('<main>real</main>'));
    expect(out.indexOf('data-mish-deploy-hook')).toBeLessThan(out.lastIndexOf('</body>'));
  });

  it('extracts url() and @import refs from inline <style> blocks', () => {
    const refs = extractInlineCssReferences(
      '<!doctype html><style>@import "theme.css";body{background:url("bg.png")}</style>',
    );
    expect(refs.sort()).toEqual(['bg.png', 'theme.css']);
  });

  it('extracts url() refs from style="" attributes', () => {
    const refs = extractInlineCssReferences(
      "<div style=\"background:url('bg.png')\"></div><span style=\"--bg:url(/abs.png)\"></span>",
    );
    expect(refs.sort()).toEqual(['/abs.png', 'bg.png']);
  });

  it('skips style-like text inside scripts and comments', () => {
    const refs = extractInlineCssReferences(
      '<!-- <style>body{background:url("ghost.png")}</style> -->' +
        '<script>const css = \'<style>body{background:url("missing.png")}</style>\';</script>',
    );
    expect(refs).toEqual([]);
  });

  it('rewrites url() and @import refs in css content relative to baseDir', () => {
    expect(
      rewriteCssReferences(
        '@import "theme.css";body{background:url("bg.png")}',
        'sub',
      ),
    ).toBe('@import "sub/theme.css";body{background:url("sub/bg.png")}');
  });

  it('keeps remote, data, and absolute css refs intact when rewriting', () => {
    expect(
      rewriteCssReferences(
        'body{background:url("https://cdn.test/a.png");--data:url(data:image/png,abc);--root:url("/abs.png")}',
        'sub',
      ),
    ).toBe(
      'body{background:url("https://cdn.test/a.png");--data:url(data:image/png,abc);--root:url("/abs.png")}',
    );
  });

  it('bundles assets referenced from inline <style> blocks', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'assets'));
    await mkdir(path.join(dir, 'fonts'));
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><style>' +
        '@import "theme.css";' +
        "body{background:url('assets/bg.png')}" +
        '@font-face{font-family:Custom;src:url("fonts/custom.woff2") format("woff2");}' +
        '</style>',
    );
    await writeFile(path.join(dir, 'theme.css'), 'body{color:red}');
    await writeFile(path.join(dir, 'assets', 'bg.png'), 'bg');
    await writeFile(path.join(dir, 'fonts', 'custom.woff2'), 'font');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'index.html');

    expect(files.map((f) => f.file).sort()).toEqual([
      'assets/bg.png',
      'fonts/custom.woff2',
      'index.html',
      'theme.css',
    ]);
  });

  it('bundles assets referenced from style="" attributes', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'assets'));
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><div style="background:url(\'assets/hero.png\')">x</div>',
    );
    await writeFile(path.join(dir, 'assets', 'hero.png'), 'hero');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'index.html');

    expect(files.map((f) => f.file).sort()).toEqual(['assets/hero.png', 'index.html']);
  });

  it('rewrites inline <style> url() refs when entry is in a subdirectory', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'sub', 'assets'), { recursive: true });
    await writeFile(
      path.join(dir, 'sub', 'page.html'),
      '<!doctype html><style>body{background:url("assets/bg.png")}</style>',
    );
    await writeFile(path.join(dir, 'sub', 'assets', 'bg.png'), 'bg');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'sub/page.html');
    const index = files.find((f) => f.file === 'index.html');

    expect(files.map((f) => f.file).sort()).toEqual(['index.html', 'sub/assets/bg.png']);
    expect(index?.data.toString('utf8')).toContain('url("sub/assets/bg.png")');
  });

  it('rewrites style="" url() refs when entry is in a subdirectory', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(
      path.join(dir, 'sub', 'page.html'),
      "<!doctype html><div style=\"background:url('hero.png')\">x</div>",
    );
    await writeFile(path.join(dir, 'sub', 'hero.png'), 'hero');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'sub/page.html');
    const index = files.find((f) => f.file === 'index.html');

    expect(files.map((f) => f.file).sort()).toEqual(['index.html', 'sub/hero.png']);
    expect(index?.data.toString('utf8')).toContain("url('sub/hero.png')");
  });

  it('reports inline <style> assets that are missing on disk', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><style>body{background:url("assets/missing.png")}</style>',
    );

    await expect(
      buildDeployFileSet(projectsRoot, projectId, 'index.html'),
    ).rejects.toMatchObject({
      details: { missing: ['assets/missing.png'] },
    });
  });

  it('extracts and rewrites url() refs from <style> inside <svg>', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'sub', 'assets'), { recursive: true });
    await writeFile(
      path.join(dir, 'sub', 'page.html'),
      '<!doctype html><svg><style>circle{fill:url("assets/icon.svg")}</style></svg>',
    );
    await writeFile(path.join(dir, 'sub', 'assets', 'icon.svg'), '<svg/>');

    const files = await buildDeployFileSet(projectsRoot, projectId, 'sub/page.html');
    const index = files.find((f) => f.file === 'index.html');

    expect(files.map((f) => f.file).sort()).toEqual(['index.html', 'sub/assets/icon.svg']);
    expect(index?.data.toString('utf8')).toContain('url("sub/assets/icon.svg")');
  });

  it('does not rewrite <style>-like text inside <script> string literals', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    const html =
      '<!doctype html><script>const tpl = \'<style>body{background:url("assets/bg.png")}</style>\';</script>';
    await writeFile(path.join(dir, 'sub', 'page.html'), html);

    const files = await buildDeployFileSet(projectsRoot, projectId, 'sub/page.html');
    const index = files.find((f) => f.file === 'index.html');

    // The fake <style> lives inside a JS string literal, so it must not
    // be processed as inline CSS: no asset is bundled and the script
    // body is preserved byte-for-byte.
    expect(files.map((f) => f.file)).toEqual(['index.html']);
    expect(index?.data.toString('utf8')).toContain(
      "const tpl = '<style>body{background:url(\"assets/bg.png\")}</style>';",
    );
  });

  it('does not rewrite <style>-like text inside HTML comments', () => {
    const html =
      '<!doctype html><!-- <style>body{background:url("ghost.png")}</style> --><h1>x</h1>';
    expect(rewriteEntryHtmlReferences(html, 'sub')).toBe(html);
  });

  it('runs in linear time on pathological unclosed url(', () => {
    const huge = '('.repeat(100_000);
    const input = `body{background:url${huge}}`;
    const startExtract = Date.now();
    expect(() => extractCssReferences(input)).toThrow();
    expect(Date.now() - startExtract).toBeLessThan(500);

    const startRewrite = Date.now();
    expect(rewriteCssReferences(input, 'sub')).toBe(input);
    expect(Date.now() - startRewrite).toBeLessThan(500);
  });
});

describe('deploy plan and analyzer', () => {
  async function setupProject() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-deploy-plan-test-'));
    const projectId = 'p1';
    const dir = await ensureProject(path.join(root, 'projects'), projectId);
    return { projectsRoot: path.join(root, 'projects'), projectId, dir };
  }

  it('returns the file set plus missing and invalid lists without throwing', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><meta name="viewport" content="width=device-width"><img src="missing.png">',
    );

    const plan = await buildDeployFilePlan(projectsRoot, projectId, 'index.html');
    expect(plan.entryPath).toBe('index.html');
    expect(plan.files.map((f) => f.file)).toEqual(['index.html']);
    expect(plan.missing).toEqual(['missing.png']);
    expect(plan.invalid).toEqual([]);
  });

  it('reports missing landing image variants from srcset and CSS backgrounds', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(
      path.join(dir, 'index.html'),
      [
        '<!doctype html>',
        '<meta name="viewport" content="width=device-width">',
        '<link rel="stylesheet" href="styles.css">',
        '<picture>',
        '<source srcset="assets/hero.png 1x, assets/hero@2x.png 2x">',
        '<img src="assets/fallback.png" alt="">',
        '</picture>',
      ].join(''),
    );
    await writeFile(path.join(dir, 'styles.css'), 'body{background:url("assets/bg.png")}');
    await writeFile(path.join(dir, 'assets/hero.png'), 'hero');
    await writeFile(path.join(dir, 'assets/fallback.png'), 'fallback');

    const plan = await buildDeployFilePlan(projectsRoot, projectId, 'index.html');
    expect(plan.files.map((f) => f.file).sort()).toEqual([
      'assets/fallback.png',
      'assets/hero.png',
      'index.html',
      'styles.css',
    ]);
    expect(plan.missing.sort()).toEqual(['assets/bg.png', 'assets/hero@2x.png']);

    const { warnings } = analyzeDeployPlan(plan);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'broken-reference', path: 'assets/bg.png' }),
        expect.objectContaining({ code: 'broken-reference', path: 'assets/hero@2x.png' }),
      ]),
    );
  });

  it('flags missing assets as broken-reference warnings', () => {
    const { warnings } = analyzeDeployPlan({
      entryPath: 'index.html',
      html: '<!doctype html><meta name="viewport" content="width=device-width">',
      files: [
        { file: 'index.html', data: Buffer.from('<!doctype html>'), contentType: 'text/html', sourcePath: 'index.html' },
      ],
      missing: ['logo.png'],
      invalid: [],
    });
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'broken-reference', path: 'logo.png' }),
    );
  });

  it('flags invalid references separately from missing ones', () => {
    const { warnings } = analyzeDeployPlan({
      entryPath: 'index.html',
      html: '<!doctype html><meta name="viewport" content="width=device-width">',
      files: [],
      missing: [],
      invalid: ['../escape.png'],
    });
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'invalid-reference', path: '../escape.png' }),
    );
  });

  it('flags missing doctype and viewport', () => {
    const { warnings } = analyzeDeployPlan({
      entryPath: 'index.html',
      html: '<html><body><h1>hi</h1></body></html>',
      files: [],
    });
    const codes = warnings.map((w) => w.code).sort();
    expect(codes).toEqual(['no-doctype', 'no-viewport']);
  });

  it('flags missing doctype even when a fake doctype lives inside a <script> string', () => {
    const html =
      '<html>' +
      '<head><meta name="viewport" content="width=device-width">' +
      '<script>const tpl = `<!doctype html><html></html>`;</script>' +
      '</head><body><h1>hi</h1></body></html>';
    const { warnings } = analyzeDeployPlan({ entryPath: 'index.html', html, files: [] });
    expect(warnings.map((w: any) => w.code)).toContain('no-doctype');
  });

  it('accepts a doctype that follows a leading HTML comment and BOM', () => {
    const html =
      '﻿<!-- generated 2026-05-02 -->\n<!doctype html>' +
      '<meta name="viewport" content="width=device-width">' +
      '<h1>hi</h1>';
    const { warnings } = analyzeDeployPlan({ entryPath: 'index.html', html, files: [] });
    expect(warnings.map((w: any) => w.code)).not.toContain('no-doctype');
  });

  it('checks the doctype prolog without catastrophic backtracking on a comment-only entry', () => {
    // Regression: the prolog check's comment-run group used a lazy `[\s\S]*?`
    // body inside `(?:...)*`, so a comment-only entry with no doctype forced
    // 2^n backtracking — a ~250-byte HTML could hang the single-threaded
    // daemon for minutes (event-loop DoS on POST /deploy/preflight). The
    // tempered comment body makes each comment match deterministically.
    const html = '<!---->'.repeat(28) + '<html><body></body></html>';
    const start = performance.now();
    const { warnings } = analyzeDeployPlan({ entryPath: 'index.html', html, files: [] });
    const elapsedMs = performance.now() - start;
    // Correctness is preserved (no doctype -> still flagged) and the check is
    // linear: the tempered regex handles this in well under 1ms, whereas the
    // old lazy-body regex grew ~2x per added comment (seconds here, minutes
    // with a few more). The 500ms budget sits far above the fixed path (~100x
    // headroom, no false failures) yet well below the vulnerable time, so any
    // regression blows it.
    expect(warnings.map((w) => w.code)).toContain('no-doctype');
    expect(elapsedMs).toBeLessThan(500);
  });

  it('flags external scripts and stylesheets', () => {
    const { warnings } = analyzeDeployPlan({
      entryPath: 'index.html',
      html:
        '<!doctype html><meta name="viewport" content="width=device-width">' +
        '<link rel="stylesheet" href="https://cdn.test/x.css">' +
        '<script src="https://cdn.test/x.js"></script>',
      files: [],
    });
    const codes = warnings.map((w) => w.code).sort();
    expect(codes).toEqual(['external-script', 'external-stylesheet']);
    const ext = warnings.find((w) => w.code === 'external-script');
    expect(ext?.url).toBe('https://cdn.test/x.js');
  });

  it('does not flag protocol-relative scripts as external when they are in fact external', () => {
    const { warnings } = analyzeDeployPlan({
      entryPath: 'index.html',
      html:
        '<!doctype html><meta name="viewport" content="width=device-width">' +
        '<script src="//cdn.test/x.js"></script>',
      files: [],
    });
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'external-script', url: '//cdn.test/x.js' }),
    );
  });

  it('flags large per-file assets but not the entry HTML', () => {
    const big = Buffer.alloc(DEPLOY_PREFLIGHT_LARGE_ASSET_BYTES + 1);
    const { warnings } = analyzeDeployPlan({
      entryPath: 'index.html',
      html: '<!doctype html><meta name="viewport" content="width=device-width">',
      files: [
        { file: 'index.html', data: Buffer.alloc(50), contentType: 'text/html', sourcePath: 'index.html' },
        { file: 'hero.jpg', data: big, contentType: 'image/jpeg', sourcePath: 'hero.jpg' },
      ],
    });
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'large-asset', path: 'hero.jpg' }),
    );
    expect(warnings.some((w) => w.code === 'large-html')).toBe(false);
  });

  it('flags large entry HTML', () => {
    const huge = Buffer.alloc(DEPLOY_PREFLIGHT_LARGE_HTML_BYTES + 1);
    const { warnings } = analyzeDeployPlan({
      entryPath: 'index.html',
      html: '<!doctype html><meta name="viewport" content="width=device-width">',
      files: [
        { file: 'index.html', data: huge, contentType: 'text/html', sourcePath: 'index.html' },
      ],
    });
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'large-html', path: 'index.html' }),
    );
  });

  it('reports large-html against the source entry path, not the renamed deploy file', () => {
    const huge = Buffer.alloc(DEPLOY_PREFLIGHT_LARGE_HTML_BYTES + 1);
    const { warnings } = analyzeDeployPlan({
      entryPath: 'pages/landing.html',
      html: '<!doctype html><meta name="viewport" content="width=device-width">',
      files: [
        { file: 'index.html', data: huge, contentType: 'text/html', sourcePath: 'pages/landing.html' },
      ],
    });
    const found = warnings.find((w: any) => w.code === 'large-html');
    expect(found?.path).toBe('pages/landing.html');
  });

  it('returns no warnings on a healthy entry HTML', () => {
    const { warnings, totalFiles, totalBytes } = analyzeDeployPlan({
      entryPath: 'index.html',
      html: '<!doctype html><meta name="viewport" content="width=device-width"><h1>Hello</h1>',
      files: [
        { file: 'index.html', data: Buffer.from('<!doctype html><h1>Hello</h1>'), contentType: 'text/html', sourcePath: 'index.html' },
      ],
    });
    expect(warnings).toEqual([]);
    expect(totalFiles).toBe(1);
    expect(totalBytes).toBeGreaterThan(0);
  });

  it('preflight payload includes provider, entry, file list, totals and warnings', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await mkdir(path.join(dir, 'assets'));
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><meta name="viewport" content="width=device-width">' +
        '<script src="https://cdn.test/x.js"></script>' +
        '<img src="assets/logo.png">',
    );
    await writeFile(path.join(dir, 'assets', 'logo.png'), 'logo');

    const result = await prepareDeployPreflight(projectsRoot, projectId, 'index.html');
    expect(result.providerId).toBe('vercel-self');
    expect(result.entry).toBe('index.html');
    expect(result.totalFiles).toBe(2);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.files.map((f) => f.path).sort()).toEqual(['assets/logo.png', 'index.html']);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('external-script');
    expect(codes).not.toContain('broken-reference');
  });

  it('preflight preserves provider identity when requested', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><h1>Hello</h1>');

    const result = await prepareDeployPreflight(projectsRoot, projectId, 'index.html', {
      providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
    });
    expect(result.providerId).toBe(CLOUDFLARE_PAGES_PROVIDER_ID);
  });

  it('preflight reports broken references instead of throwing', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><meta name="viewport" content="width=device-width"><img src="missing.png">',
    );

    const result = await prepareDeployPreflight(projectsRoot, projectId, 'index.html');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'broken-reference', path: 'missing.png' }),
    );
    expect(result.totalFiles).toBe(1);
  });

  it('preflight rejects non-html entry names', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(path.join(dir, 'data.json'), '{}');
    await expect(
      prepareDeployPreflight(projectsRoot, projectId, 'data.json'),
    ).rejects.toThrow(/HTML/);
  });

  it('buildDeployFileSet still throws when missing or invalid refs exist', async () => {
    const { projectsRoot, projectId, dir } = await setupProject();
    await writeFile(path.join(dir, 'index.html'), '<img src="missing.png">');
    await expect(
      buildDeployFileSet(projectsRoot, projectId, 'index.html'),
    ).rejects.toMatchObject({ details: { missing: ['missing.png'] } });
  });
});

describe('cloudflare pages deploys', () => {
  function customDomainRequestInfo(input: string | URL | Request, init?: RequestInit) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
    const method =
      init?.method || (input instanceof Request ? input.method : 'GET');
    return { url, method };
  }

  function createCustomDomainDeployMock(options: {
    dnsRecords?: Array<Record<string, unknown>>;
    dnsRecordsAfterDuplicate?: Array<Record<string, unknown>>;
    dnsCreateAlreadyExists?: boolean;
    dnsCreateRejectsComment?: boolean;
    pagesDomains?: Array<Record<string, unknown>>;
    customHeadStatus?: number;
    /** Answer anonymous GETs: 'page' serves HTML, 'access' ends on a Cloudflare Access login. */
    anonymousGet?: { pagesDev?: 'page' | 'access'; custom?: 'page' | 'access' };
  } = {}) {
    const indexHash = cloudflarePagesAssetHash({
      file: 'index.html',
      data: Buffer.from('hello index'),
    });
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    let dnsCreateCount = 0;
    let dnsLookupCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const { url, method } = customDomainRequestInfo(input, init);
      calls.push({ url, method, body: init?.body });

      if (url.endsWith('/pages/projects/demo-pages') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { name: 'demo-pages' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/upload-token') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/check-missing') && method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/upsert-hashes') && method === 'POST') {
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ hashes: [indexHash] });
        return new Response(JSON.stringify({ success: true, result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/deployments') && method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'dep_custom', url: 'https://d34527d9.demo-pages.pages.dev' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://demo-pages.pages.dev' && method === 'HEAD') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/zones/zone-1') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'zone-1', name: 'example.com', status: 'active', type: 'full' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/zones/zone-1/dns_records?') && method === 'GET') {
        dnsLookupCount += 1;
        const result = options.dnsRecordsAfterDuplicate && dnsLookupCount > 1
          ? options.dnsRecordsAfterDuplicate
          : options.dnsRecords ?? [];
        return new Response(JSON.stringify({ success: true, result }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/zones/zone-1/dns_records') && method === 'POST') {
        dnsCreateCount += 1;
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (options.dnsCreateRejectsComment && dnsCreateCount === 1) {
          expect(body).toHaveProperty('comment');
          return new Response(JSON.stringify({
            success: false,
            errors: [{ message: 'comment is not allowed for this token' }],
          }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (options.dnsCreateAlreadyExists && dnsCreateCount === 1) {
          return new Response(JSON.stringify({
            success: false,
            errors: [{ message: 'DNS record already exists' }],
          }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, result: { id: 'dns-1', ...body } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/zones/zone-1/dns_records/dns-1') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return new Response(JSON.stringify({ success: true, result: { id: 'dns-1', ...body } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/domains/demo.example.com') && method === 'GET') {
        const result = (options.pagesDomains ?? [])
          .find((domain) => domain.name === 'demo.example.com');
        if (!result) {
          return new Response(JSON.stringify({
            success: false,
            errors: [{ message: 'Custom domain not found' }],
          }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          success: true,
          result,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/domains') && method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          result: { name: 'demo.example.com', status: 'active' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://demo.example.com' && method === 'HEAD') {
        return new Response('', { status: options.customHeadStatus ?? 200 });
      }
      const getAnswer = method === 'GET'
        ? url === 'https://demo-pages.pages.dev' ? options.anonymousGet?.pagesDev
          : url === 'https://demo.example.com' ? options.anonymousGet?.custom
            : undefined
        : undefined;
      if (getAnswer === 'page') {
        // The deployed index.html itself ('hello index').
        return new Response('<!doctype html><html><body>hello index</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (getAnswer === 'access') {
        return new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/demo.example.com' } });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    return { calls, fetchMock };
  }

  async function deployWithCustomDomain(options: {
    priorMetadata?: Record<string, unknown>;
  } = {}) {
    return deployToCloudflarePages({
      config: {
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: 'demo-pages',
      },
      projectId: 'project-1',
      cloudflarePages: {
        zoneId: 'zone-1',
        zoneName: 'example.com',
        domainPrefix: 'demo',
      },
      priorMetadata: options.priorMetadata,
      files: [
        {
          file: 'index.html',
          data: Buffer.from('hello index'),
          contentType: 'text/html',
          sourcePath: 'index.html',
        },
      ],
    });
  }

  it('keeps a custom domain behind Cloudflare Access unknown while pages.dev is public', async () => {
    const { fetchMock } = createCustomDomainDeployMock({
      customHeadStatus: 302,
      anonymousGet: { pagesDev: 'page', custom: 'access' },
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await deployWithCustomDomain();
      expect(result.access).toBe('public');
      expect(result.cloudflarePages.pagesDev.access).toBe('public');
      expect(result.cloudflarePages.customDomain).toMatchObject({ status: 'ready', access: 'unknown' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('calls a custom domain public only after its own anonymous GET reaches the page', async () => {
    const { fetchMock } = createCustomDomainDeployMock({ anonymousGet: { pagesDev: 'page', custom: 'page' } });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await deployWithCustomDomain();
      expect(result.cloudflarePages.customDomain).toMatchObject({ status: 'ready', access: 'public' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('chunks asset uploads before posting to Cloudflare Pages', () => {
    const chunks = chunkCloudflarePagesAssetUploads(
      [
        { hash: 'a'.repeat(32), data: Buffer.from('one'), contentType: 'text/plain' },
        { hash: 'b'.repeat(32), data: Buffer.from('two'), contentType: 'text/plain' },
        { hash: 'c'.repeat(32), data: Buffer.from('three'), contentType: 'text/plain' },
      ],
      { maxFiles: 2, maxBytes: 10_000 },
    );

    expect(chunks.map((chunk) => chunk.map((file) => file.hash))).toEqual([
      ['a'.repeat(32), 'b'.repeat(32)],
      ['c'.repeat(32)],
    ]);
  });

  it('rejects Cloudflare Pages assets above the per-file upload limit', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method =
        init?.method || (input instanceof Request ? input.method : 'GET');

      if (url.endsWith('/pages/projects/demo-pages') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { name: 'demo-pages' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/upload-token') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(deployToCloudflarePages({
      config: {
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: 'demo-pages',
      },
      files: [
        {
          file: 'huge.bin',
          data: Buffer.alloc(CLOUDFLARE_PAGES_ASSET_MAX_BYTES + 1),
          contentType: 'application/octet-stream',
          sourcePath: 'huge.bin',
        },
      ],
    })).rejects.toThrow(/25\.00 MiB or smaller/);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('creates missing projects and uploads assets before submitting a manifest', async () => {
    const requests: Array<{ url: string; method: string; body?: any; headers: Headers }> = [];
    const indexHash = cloudflarePagesAssetHash({
      file: 'index.html',
      data: Buffer.from('hello index'),
    });
    const assetHash = cloudflarePagesAssetHash({
      file: 'assets/style.css',
      data: Buffer.from('body { color: red; }'),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method =
        init?.method || (input instanceof Request ? input.method : 'GET');
      const headers = new Headers(
        init?.headers || (input instanceof Request ? input.headers : undefined),
      );
      requests.push({ url, method, body: init?.body, headers });

      if (url.endsWith('/pages/projects/demo-pages') && method === 'GET') {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/pages/projects') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({
          name: 'demo-pages',
          production_branch: 'main',
        });
        return new Response(JSON.stringify({ success: true, result: { name: body.name } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/pages/projects/demo-pages/upload-token') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/pages/assets/check-missing') && method === 'POST') {
        expect(headers.get('authorization')).toBe('Bearer pages-upload-jwt');
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({
          hashes: [indexHash, assetHash],
        });
        return new Response(JSON.stringify({ success: true, result: [indexHash, assetHash] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/pages/assets/upload') && method === 'POST') {
        expect(headers.get('authorization')).toBe('Bearer pages-upload-jwt');
        expect(JSON.parse(String(init?.body ?? '[]'))).toEqual([
          {
            key: indexHash,
            value: Buffer.from('hello index').toString('base64'),
            metadata: { contentType: 'text/html' },
            base64: true,
          },
          {
            key: assetHash,
            value: Buffer.from('body { color: red; }').toString('base64'),
            metadata: { contentType: 'text/css' },
            base64: true,
          },
        ]);
        return new Response(JSON.stringify({ success: true, result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/pages/assets/upsert-hashes') && method === 'POST') {
        expect(headers.get('authorization')).toBe('Bearer pages-upload-jwt');
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({
          hashes: [indexHash, assetHash],
        });
        return new Response(JSON.stringify({ success: true, result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/pages/projects/demo-pages/deployments') && method === 'POST') {
        const form = init?.body as FormData;
        expect(form).toBeInstanceOf(FormData);
        const manifest = JSON.parse(String(form?.get('manifest') ?? '{}')) as Record<string, string>;
        expect(form.get('branch')).toBe('main');
        expect(form.get('pages_build_output_dir')).toBeNull();
        expect(manifest).toEqual({
          '/index.html': indexHash,
          '/assets/style.css': assetHash,
        });
        expect(form.get(indexHash)).toBeNull();
        expect(form.get(assetHash)).toBeNull();
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'dep_123', url: 'https://d34527d9.demo-pages.pages.dev' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === 'https://demo-pages.pages.dev' && method === 'HEAD') {
        return new Response('', { status: 200 });
      }
      if (url === 'https://demo-pages.pages.dev' && method === 'GET') {
        return new Response('<!doctype html><html><body>hello index</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url.endsWith('/zones/zone-1') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'zone-1', name: 'example.com', status: 'active', type: 'full' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployToCloudflarePages({
      config: {
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: 'demo-pages',
      },
      files: [
        {
          file: 'index.html',
          data: Buffer.from('hello index'),
          contentType: 'text/html',
          sourcePath: 'index.html',
        },
        {
          file: 'assets/style.css',
          data: Buffer.from('body { color: red; }'),
          contentType: 'text/css',
          sourcePath: 'assets/style.css',
        },
      ],
    });

    expect(result).toMatchObject({
      providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
      deploymentId: 'dep_123',
      url: 'https://demo-pages.pages.dev',
      status: 'ready',
      access: 'public',
    });
    // The eighth request is the HEAD probe; the ninth is the anonymous GET
    // that confirms the page before the link is called public.
    expect(requests).toHaveLength(9);
    expect(requests[8]).toMatchObject({ url: 'https://demo-pages.pages.dev', method: 'GET' });
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer cloudflare-token-secret');
  });

  it('treats concurrent Cloudflare Pages project creation races as already satisfied', async () => {
    const indexHash = cloudflarePagesAssetHash({
      file: 'index.html',
      data: Buffer.from('hello index'),
    });
    let projectLookupCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method =
        init?.method || (input instanceof Request ? input.method : 'GET');

      if (url.endsWith('/pages/projects/demo-pages') && method === 'GET') {
        projectLookupCount += 1;
        if (projectLookupCount === 1) {
          return new Response(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, result: { name: 'demo-pages' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/pages/projects') && method === 'POST') {
        return new Response(
          JSON.stringify({ success: false, errors: [{ message: 'Project already exists' }] }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.endsWith('/pages/projects/demo-pages/upload-token') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/pages/assets/check-missing') && method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/pages/assets/upsert-hashes') && method === 'POST') {
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ hashes: [indexHash] });
        return new Response(JSON.stringify({ success: true, result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/pages/projects/demo-pages/deployments') && method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'dep_123', url: 'https://d34527d9.demo-pages.pages.dev' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === 'https://demo-pages.pages.dev' && method === 'HEAD') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/zones/zone-1') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'zone-1', name: 'example.com', status: 'active', type: 'full' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployToCloudflarePages({
      config: {
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: 'demo-pages',
      },
      files: [
        {
          file: 'index.html',
          data: Buffer.from('hello index'),
          contentType: 'text/html',
          sourcePath: 'index.html',
        },
      ],
    });

    expect(result).toMatchObject({
      providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
      deploymentId: 'dep_123',
      url: 'https://demo-pages.pages.dev',
      status: 'ready',
    });
    expect(projectLookupCount).toBe(2);
  });

  it('rejects invalid custom-domain prefix before creating a Pages deployment', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(deployToCloudflarePages({
      config: {
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: 'demo-pages',
      },
      projectId: 'project-1',
      cloudflarePages: {
        zoneId: 'zone-1',
        zoneName: 'example.com',
        domainPrefix: 'bad.prefix',
      },
      files: [],
    })).rejects.toThrow(/valid subdomain prefix/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects stale Cloudflare zone selections before creating a Pages deployment', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method =
        init?.method || (input instanceof Request ? input.method : 'GET');
      if (url.endsWith('/zones/zone-1') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'zone-1', name: 'other.example', status: 'active', type: 'full' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(deployToCloudflarePages({
      config: {
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: 'demo-pages',
      },
      projectId: 'project-1',
      cloudflarePages: {
        zoneId: 'zone-1',
        zoneName: 'example.com',
        domainPrefix: 'demo',
      },
      files: [],
    })).rejects.toThrow(/zone selection/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('paginates Cloudflare Pages zones for large accounts', async () => {
    const pagesSeen: number[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const requestUrl = new URL(url);
      expect(requestUrl.pathname).toBe('/client/v4/zones');
      expect(requestUrl.searchParams.get('account.id')).toBe('account_123');
      expect(requestUrl.searchParams.get('per_page')).toBe('100');
      const page = Number(requestUrl.searchParams.get('page') || '1');
      pagesSeen.push(page);
      const result = page === 1
        ? [{ id: 'zone-1', name: 'example.com', status: 'active', type: 'full' }]
        : [{ id: 'zone-2', name: 'example.org', status: 'active', type: 'full' }];
      return new Response(JSON.stringify({
        success: true,
        result,
        result_info: { page, per_page: 100, total_pages: 2 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listCloudflarePagesZones({
      token: 'cloudflare-token-secret',
      accountId: 'account_123',
      cloudflarePages: { lastZoneId: 'zone-2' },
    })).resolves.toEqual({
      zones: [
        { id: 'zone-1', name: 'example.com', status: 'active', type: 'full' },
        { id: 'zone-2', name: 'example.org', status: 'active', type: 'full' },
      ],
      cloudflarePages: { lastZoneId: 'zone-2' },
    });
    expect(pagesSeen).toEqual([1, 2]);
  });

  it('round-trips typed Cloudflare info while keeping provider metadata internal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-deployment-db-test-'));
    try {
      const db = openDatabase(root, { dataDir: path.join(root, '.od') });
      insertProject(db, {
        id: 'project-1',
        name: 'Project 1',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      });
      const saved = upsertDeployment(db, {
        id: 'deployment-1',
        projectId: 'project-1',
        fileName: 'index.html',
        providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
        url: 'https://demo-pages.pages.dev',
        deploymentId: 'dep-1',
        deploymentCount: 1,
        target: 'preview',
        status: 'link-delayed',
        cloudflarePages: {
          projectName: 'demo-pages',
          pagesDev: {
            url: 'https://demo-pages.pages.dev',
            status: 'ready',
          },
          customDomain: {
            hostname: 'demo.example.com',
            url: 'https://demo.example.com',
            zoneId: 'zone-1',
            zoneName: 'example.com',
            domainPrefix: 'demo',
            status: 'pending',
            dnsStatus: 'created',
            dnsRecordId: 'dns-1',
            dnsOwnership: 'marked',
            domainStatus: 'pending',
          },
        },
        providerMetadata: {
          cloudflarePagesProjectName: 'demo-pages',
          cloudflarePagesCustomDomain: {
            projectId: 'project-1',
            pagesProjectName: 'demo-pages',
            hostname: 'demo.example.com',
            marker: 'od:cfp:aaaaaaaaaaaa:bbbbbbbbbbbb',
            dnsRecordId: 'dns-1',
          },
        },
        createdAt: 1,
        updatedAt: 2,
      });
      const loaded = getDeployment(db, 'project-1', 'index.html', CLOUDFLARE_PAGES_PROVIDER_ID);
      if (!saved || !loaded) throw new Error('expected deployment roundtrip to be saved');

      expect(saved).toMatchObject({
        cloudflarePages: {
          customDomain: {
            hostname: 'demo.example.com',
            dnsRecordId: 'dns-1',
          },
        },
        providerMetadata: {
          cloudflarePagesProjectName: 'demo-pages',
          cloudflarePagesCustomDomain: {
            marker: 'od:cfp:aaaaaaaaaaaa:bbbbbbbbbbbb',
          },
        },
      });
      expect(loaded).toMatchObject(saved);
    } finally {
      closeDatabase();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates a Cloudflare DNS CNAME and Pages custom domain while keeping pages.dev primary', async () => {
    const indexHash = cloudflarePagesAssetHash({
      file: 'index.html',
      data: Buffer.from('hello index'),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method =
        init?.method || (input instanceof Request ? input.method : 'GET');

      if (url.endsWith('/pages/projects/demo-pages') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { name: 'demo-pages' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/upload-token') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/check-missing') && method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/upsert-hashes') && method === 'POST') {
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ hashes: [indexHash] });
        return new Response(JSON.stringify({ success: true, result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/deployments') && method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'dep_custom', url: 'https://d34527d9.demo-pages.pages.dev' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://demo-pages.pages.dev' && method === 'HEAD') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/zones/zone-1') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'zone-1', name: 'example.com', status: 'active', type: 'full' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/zones/zone-1/dns_records?') && method === 'GET') {
        expect(url).toContain('name=demo.example.com');
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/zones/zone-1/dns_records') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toMatchObject({
          type: 'CNAME',
          name: 'demo.example.com',
          content: 'demo-pages.pages.dev',
          proxied: true,
          ttl: 1,
        });
        expect(body.comment).toMatch(/^od:cfp:[a-f0-9]{12}:[a-f0-9]{12}$/);
        return new Response(JSON.stringify({ success: true, result: { id: 'dns-1', ...body } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/domains/demo.example.com') && method === 'GET') {
        return new Response(JSON.stringify({
          success: false,
          errors: [{ message: 'Custom domain not found' }],
        }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/domains') && method === 'POST') {
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ name: 'demo.example.com' });
        return new Response(JSON.stringify({
          success: true,
          result: { name: 'demo.example.com', status: 'active' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://demo.example.com' && method === 'HEAD') {
        return new Response('', { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployToCloudflarePages({
      config: {
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: 'demo-pages',
      },
      projectId: 'project-1',
      cloudflarePages: {
        zoneId: 'zone-1',
        zoneName: 'example.com',
        domainPrefix: 'demo',
      },
      files: [
        {
          file: 'index.html',
          data: Buffer.from('hello index'),
          contentType: 'text/html',
          sourcePath: 'index.html',
        },
      ],
    });

    expect(result).toMatchObject({
      providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
      url: 'https://demo-pages.pages.dev',
      status: 'ready',
      cloudflarePages: {
        pagesDev: {
          url: 'https://demo-pages.pages.dev',
          status: 'ready',
        },
        customDomain: {
          hostname: 'demo.example.com',
          url: 'https://demo.example.com',
          status: 'ready',
          dnsStatus: 'created',
          dnsRecordId: 'dns-1',
          dnsOwnership: 'marked',
          domainStatus: 'active',
        },
      },
      providerMetadata: {
        cloudflarePagesProjectName: 'demo-pages',
        cloudflarePagesCustomDomain: {
          projectId: 'project-1',
          pagesProjectName: 'demo-pages',
          hostname: 'demo.example.com',
          dnsRecordId: 'dns-1',
        },
      },
    });
  });

  it('reuses an exact Cloudflare CNAME without mutating DNS', async () => {
    const { calls, fetchMock } = createCustomDomainDeployMock({
      dnsRecords: [{
        id: 'dns-existing',
        type: 'CNAME',
        name: 'demo.example.com',
        content: 'demo-pages.pages.dev',
      }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployWithCustomDomain();

    expect(result).toMatchObject({
      status: 'ready',
      cloudflarePages: {
        customDomain: {
          hostname: 'demo.example.com',
          status: 'ready',
          dnsStatus: 'reused',
          dnsRecordId: 'dns-existing',
          dnsOwnership: 'unmarked',
        },
      },
    });
    expect(calls.some((call) => (
      call.url.includes('/zones/zone-1/dns_records') &&
      (call.method === 'POST' || call.method === 'PATCH')
    ))).toBe(false);
  });

  it('reuses a concurrently created CNAME after Cloudflare reports a duplicate', async () => {
    const { calls, fetchMock } = createCustomDomainDeployMock({
      dnsRecords: [],
      dnsCreateAlreadyExists: true,
      dnsRecordsAfterDuplicate: [{
        id: 'dns-race',
        type: 'CNAME',
        name: 'demo.example.com',
        content: 'demo-pages.pages.dev',
      }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployWithCustomDomain();

    expect(result).toMatchObject({
      status: 'ready',
      cloudflarePages: {
        customDomain: {
          hostname: 'demo.example.com',
          status: 'ready',
          dnsStatus: 'reused',
          dnsRecordId: 'dns-race',
          dnsOwnership: 'unmarked',
        },
      },
    });
    expect(calls.filter((call) => call.url.includes('/zones/zone-1/dns_records?') && call.method === 'GET')).toHaveLength(2);
    expect(calls.filter((call) => call.url.endsWith('/zones/zone-1/dns_records') && call.method === 'POST')).toHaveLength(1);
  });

  it('reads an existing Cloudflare Pages custom domain without unsupported list pagination', async () => {
    const { calls, fetchMock } = createCustomDomainDeployMock({
      pagesDomains: [{ name: 'demo.example.com', status: 'active' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployWithCustomDomain();

    expect(result).toMatchObject({
      status: 'ready',
      cloudflarePages: {
        customDomain: {
          hostname: 'demo.example.com',
          status: 'ready',
          domainStatus: 'active',
        },
      },
    });
    const domainLookupUrls = calls
      .filter((call) => call.url.includes('/pages/projects/demo-pages/domains/') && call.method === 'GET')
      .map((call) => call.url);
    expect(domainLookupUrls).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/account_123/pages/projects/demo-pages/domains/demo.example.com',
    ]);
    expect(domainLookupUrls.every((url) => !url.includes('?'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/pages/projects/demo-pages/domains') && call.method === 'POST')).toBe(false);
  });

  it('retries DNS creation without a comment when Cloudflare rejects comments', async () => {
    const { calls, fetchMock } = createCustomDomainDeployMock({
      dnsCreateRejectsComment: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployWithCustomDomain();

    expect(result).toMatchObject({
      status: 'ready',
      cloudflarePages: {
        customDomain: {
          status: 'ready',
          dnsStatus: 'created',
          dnsRecordId: 'dns-1',
          dnsOwnership: 'unmarked',
        },
      },
    });
    const dnsCreateBodies = calls
      .filter((call) => call.url.endsWith('/zones/zone-1/dns_records') && call.method === 'POST')
      .map((call) => JSON.parse(String(call.body ?? '{}')));
    expect(dnsCreateBodies).toHaveLength(2);
    expect(dnsCreateBodies[0]).toHaveProperty('comment');
    expect(dnsCreateBodies[1]).not.toHaveProperty('comment');
  });

  it('does not patch an unowned different-target CNAME', async () => {
    const { calls, fetchMock } = createCustomDomainDeployMock({
      dnsRecords: [{
        id: 'dns-external',
        type: 'CNAME',
        name: 'demo.example.com',
        content: 'other.pages.dev',
      }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployWithCustomDomain();

    expect(result).toMatchObject({
      status: 'ready',
      cloudflarePages: {
        pagesDev: {
          url: 'https://demo-pages.pages.dev',
          status: 'ready',
        },
        customDomain: {
          hostname: 'demo.example.com',
          status: 'conflict',
          errorCode: 'cloudflare_dns_record_conflict',
          dnsStatus: 'conflict',
          dnsRecordId: 'dns-external',
          dnsOwnership: 'external',
          domainStatus: 'skipped',
        },
      },
    });
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/pages/projects/demo-pages/domains') && call.method === 'POST')).toBe(false);
  });

  it('patches only a previously owned CNAME with matching marker metadata', async () => {
    const initial = createCustomDomainDeployMock();
    vi.stubGlobal('fetch', initial.fetchMock);
    const first = await deployWithCustomDomain();
    const priorMetadata = first.providerMetadata as Record<string, unknown>;
    const priorCustom = priorMetadata.cloudflarePagesCustomDomain as Record<string, unknown>;
    vi.unstubAllGlobals();

    const { calls, fetchMock } = createCustomDomainDeployMock({
      dnsRecords: [{
        id: 'dns-1',
        type: 'CNAME',
        name: 'demo.example.com',
        content: 'old-demo-pages.pages.dev',
        comment: priorCustom.marker,
      }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployWithCustomDomain({ priorMetadata });

    expect(result).toMatchObject({
      status: 'ready',
      cloudflarePages: {
        customDomain: {
          hostname: 'demo.example.com',
          status: 'ready',
          dnsStatus: 'patched',
          dnsRecordId: 'dns-1',
          dnsOwnership: 'marked',
        },
      },
    });
    const patchBodies = calls
      .filter((call) => call.url.endsWith('/zones/zone-1/dns_records/dns-1') && call.method === 'PATCH')
      .map((call) => JSON.parse(String(call.body ?? '{}')));
    expect(patchBodies).toEqual([expect.objectContaining({
      type: 'CNAME',
      name: 'demo.example.com',
      content: 'demo-pages.pages.dev',
      comment: priorCustom.marker,
    })]);
  });

  it('returns partial success with pages.dev when DNS custom-domain setup conflicts', async () => {
    const indexHash = cloudflarePagesAssetHash({
      file: 'index.html',
      data: Buffer.from('hello index'),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method =
        init?.method || (input instanceof Request ? input.method : 'GET');

      if (url.endsWith('/pages/projects/demo-pages') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { name: 'demo-pages' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/upload-token') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/check-missing') && method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/upsert-hashes') && method === 'POST') {
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ hashes: [indexHash] });
        return new Response(JSON.stringify({ success: true, result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/deployments') && method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'dep_conflict', url: 'https://d34527d9.demo-pages.pages.dev' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://demo-pages.pages.dev' && method === 'HEAD') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/zones/zone-1') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'zone-1', name: 'example.com', status: 'active', type: 'full' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/zones/zone-1/dns_records?') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          result: [{
            id: 'dns-existing',
            type: 'A',
            name: 'demo.example.com',
            content: '192.0.2.10',
          }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployToCloudflarePages({
      config: {
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: 'demo-pages',
      },
      projectId: 'project-1',
      cloudflarePages: {
        zoneId: 'zone-1',
        zoneName: 'example.com',
        domainPrefix: 'demo',
      },
      files: [
        {
          file: 'index.html',
          data: Buffer.from('hello index'),
          contentType: 'text/html',
          sourcePath: 'index.html',
        },
      ],
    });

    expect(result).toMatchObject({
      providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
      url: 'https://demo-pages.pages.dev',
      status: 'ready',
      cloudflarePages: {
        pagesDev: {
          url: 'https://demo-pages.pages.dev',
          status: 'ready',
        },
        customDomain: {
          hostname: 'demo.example.com',
          status: 'conflict',
          errorCode: 'cloudflare_dns_record_conflict',
          dnsStatus: 'conflict',
          dnsRecordId: 'dns-existing',
          domainStatus: 'skipped',
        },
      },
    });
    expect(fetchMock.mock.calls.some(([input, init]) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      return url.endsWith('/pages/projects/demo-pages/domains') && method === 'POST';
    })).toBe(false);
  });

  it('returns partial success with pages.dev when Pages custom-domain binding conflicts', async () => {
    const indexHash = cloudflarePagesAssetHash({
      file: 'index.html',
      data: Buffer.from('hello index'),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method =
        init?.method || (input instanceof Request ? input.method : 'GET');

      if (url.endsWith('/pages/projects/demo-pages') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { name: 'demo-pages' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/upload-token') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/check-missing') && method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/upsert-hashes') && method === 'POST') {
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ hashes: [indexHash] });
        return new Response(JSON.stringify({ success: true, result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/deployments') && method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'dep_domain_conflict', url: 'https://d34527d9.demo-pages.pages.dev' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://demo-pages.pages.dev' && method === 'HEAD') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/zones/zone-1') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'zone-1', name: 'example.com', status: 'active', type: 'full' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/zones/zone-1/dns_records?') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/zones/zone-1/dns_records') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return new Response(JSON.stringify({ success: true, result: { id: 'dns-1', ...body } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/domains/demo.example.com') && method === 'GET') {
        return new Response(JSON.stringify({
          success: false,
          errors: [{ message: 'Custom domain not found' }],
        }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/domains') && method === 'POST') {
        return new Response(JSON.stringify({
          success: false,
          errors: [{ message: 'Custom domain already exists' }],
        }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployToCloudflarePages({
      config: {
        token: 'cloudflare-token-secret',
        accountId: 'account_123',
        projectName: 'demo-pages',
      },
      projectId: 'project-1',
      cloudflarePages: {
        zoneId: 'zone-1',
        zoneName: 'example.com',
        domainPrefix: 'demo',
      },
      files: [
        {
          file: 'index.html',
          data: Buffer.from('hello index'),
          contentType: 'text/html',
          sourcePath: 'index.html',
        },
      ],
    });

    expect(result).toMatchObject({
      providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
      url: 'https://demo-pages.pages.dev',
      status: 'ready',
      cloudflarePages: {
        pagesDev: {
          url: 'https://demo-pages.pages.dev',
          status: 'ready',
        },
        customDomain: {
          hostname: 'demo.example.com',
          status: 'conflict',
          errorCode: 'cloudflare_domain_already_bound',
          dnsStatus: 'created',
          dnsRecordId: 'dns-1',
          domainStatus: 'conflict',
        },
      },
    });
  });

  // --- target / branch derivation tests (issue #4483) ---

  function makeMinimalCloudflareFetchMock(options: {
    previewDeployUrl?: string;
  } = {}) {
    const previewDeployUrl = options.previewDeployUrl ?? 'https://abc123.demo-pages.pages.dev';
    const capturedFormData: { branch: string | undefined } = { branch: undefined };
    const indexHash = cloudflarePagesAssetHash({
      file: 'index.html',
      data: Buffer.from('hello'),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method =
        init?.method || (input instanceof Request ? input.method : 'GET');

      if (url.endsWith('/pages/projects/demo-pages') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { name: 'demo-pages' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/upload-token') && method === 'GET') {
        return new Response(JSON.stringify({ success: true, result: { jwt: 'pages-upload-jwt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/check-missing') && method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/assets/upsert-hashes') && method === 'POST') {
        return new Response(JSON.stringify({ success: true, result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/pages/projects/demo-pages/deployments') && method === 'POST') {
        const form = init?.body as FormData;
        capturedFormData.branch = form?.get('branch') as string | undefined ?? undefined;
        return new Response(JSON.stringify({
          success: true,
          result: { id: 'dep_preview_1', url: previewDeployUrl },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // HEAD check — respond 200 for any URL so waitForReachableDeploymentUrl resolves
      if (method === 'HEAD') {
        return new Response('', { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    return { fetchMock, capturedFormData, indexHash };
  }

  const minimalFiles = [
    {
      file: 'index.html',
      data: Buffer.from('hello'),
      contentType: 'text/html',
      sourcePath: 'index.html',
    },
  ] as const;

  const baseConfig = {
    token: 'cloudflare-token-secret',
    accountId: 'account_123',
    projectName: 'demo-pages',
  } as const;

  it('sends branch=preview to Cloudflare when target is preview', async () => {
    const { fetchMock, capturedFormData } = makeMinimalCloudflareFetchMock({
      previewDeployUrl: 'https://abc123.demo-pages.pages.dev',
    });
    vi.stubGlobal('fetch', fetchMock);

    await deployToCloudflarePages({
      config: { ...baseConfig },
      files: [...minimalFiles],
      target: 'preview',
    } as Parameters<typeof deployToCloudflarePages>[0]);

    // The deployment POST must carry branch='preview', not 'main'
    expect(capturedFormData.branch).toBe('preview');
  });

  it('sends branch=main to Cloudflare when target is production', async () => {
    const { fetchMock, capturedFormData } = makeMinimalCloudflareFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    await deployToCloudflarePages({
      config: { ...baseConfig },
      files: [...minimalFiles],
      target: 'production',
    } as Parameters<typeof deployToCloudflarePages>[0]);

    expect(capturedFormData.branch).toBe('main');
  });

  it('defaults to branch=main (production) when target is omitted', async () => {
    const { fetchMock, capturedFormData } = makeMinimalCloudflareFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    await deployToCloudflarePages({
      config: { ...baseConfig },
      files: [...minimalFiles],
    });

    expect(capturedFormData.branch).toBe('main');
  });

  it('returns the per-deploy preview URL (not the production root) for a preview deploy', async () => {
    const distinctPreviewUrl = 'https://abc123.demo-pages.pages.dev';
    const { fetchMock } = makeMinimalCloudflareFetchMock({ previewDeployUrl: distinctPreviewUrl });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployToCloudflarePages({
      config: { ...baseConfig },
      files: [...minimalFiles],
      target: 'preview',
    } as Parameters<typeof deployToCloudflarePages>[0]);

    // For a preview deploy the returned URL must be the per-deploy alias,
    // not the production root https://demo-pages.pages.dev
    expect(result.url).toBe(distinctPreviewUrl);
    expect(result.url).not.toBe('https://demo-pages.pages.dev');
  });

  it('still returns the production root URL for a production deploy', async () => {
    const { fetchMock } = makeMinimalCloudflareFetchMock({
      previewDeployUrl: 'https://abc123.demo-pages.pages.dev',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await deployToCloudflarePages({
      config: { ...baseConfig },
      files: [...minimalFiles],
      target: 'production',
    } as Parameters<typeof deployToCloudflarePages>[0]);

    expect(result.url).toBe('https://demo-pages.pages.dev');
  });
});

describe('deployment link readiness', () => {
  async function withServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (url: string) => Promise<void>,
  ) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    try {
      await run(url);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('marks a reachable public URL as ready', async () => {
    await withServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    }, async (url) => {
      await expect(checkDeploymentUrl(url)).resolves.toMatchObject({ reachable: true });
    });
  });

  it('keeps the URL when public link readiness times out', async () => {
    const result = await waitForReachableDeploymentUrl(['http://127.0.0.1:9'], {
      timeoutMs: 1,
      intervalMs: 1,
    });

    expect(result).toMatchObject({
      status: 'link-delayed',
      url: 'http://127.0.0.1:9',
    });
  });

  it('uses provider-specific copy for missing public URLs', async () => {
    const result = await waitForReachableDeploymentUrl([], {
      providerLabel: 'Cloudflare Pages',
    });

    expect(result).toMatchObject({
      status: 'link-delayed',
      statusMessage: 'Cloudflare Pages did not return a public deployment URL.',
    });
  });

  it('marks a Vercel authentication page as protected', async () => {
    await withServer((_req, res) => {
      res.writeHead(401, {
        server: 'Vercel',
        'set-cookie': '_vercel_sso_nonce=test; Path=/; HttpOnly',
        'content-type': 'text/html',
      });
      res.end('<title>Authentication Required</title><body>Vercel Authentication</body>');
    }, async (url) => {
      await expect(checkDeploymentUrl(url)).resolves.toMatchObject({
        reachable: false,
        status: 'protected',
      });
    });
  });

  it('does not mistake a same-site redirect that merely mentions vercel.com/login for the SSO wall', async () => {
    // A substring match on the raw Location header would flag this as
    // protected: the header contains "vercel.com/login" inside a "next="
    // deep link, but the redirect target's actual host is the deployed
    // site itself, not vercel.com.
    await withServer((_req, res) => {
      res.writeHead(302, {
        location: 'https://mysite.io/go?next=https://vercel.com/login',
      });
      res.end();
    }, async (url) => {
      await expect(checkDeploymentUrl(url)).resolves.toMatchObject({ reachable: true });
    });
  });

  it('returns protected without waiting for timeout', async () => {
    await withServer((_req, res) => {
      res.writeHead(401, { server: 'Vercel' });
      res.end('Authentication Required');
    }, async (url) => {
      const result = await waitForReachableDeploymentUrl([url], {
        timeoutMs: 5_000,
        intervalMs: 1_000,
      });

      expect(result).toMatchObject({
        status: 'protected',
        url,
      });
    });
  });

  it('uses the first reachable candidate URL', async () => {
    await withServer((_req, res) => {
      res.writeHead(204);
      res.end();
    }, async (url) => {
      const result = await waitForReachableDeploymentUrl(['http://127.0.0.1:9', url], {
        timeoutMs: 100,
        intervalMs: 1,
      });

      expect(result).toMatchObject({
        status: 'ready',
        url,
      });
    });
  });

  it('collects deployment URL aliases as candidates', () => {
    expect(
      deploymentUrlCandidates(
        { url: 'primary.vercel.app', alias: ['alias.vercel.app'] },
        { aliases: [{ domain: 'domain.vercel.app' }, 'plain.vercel.app'] },
      ),
    ).toEqual([
      'https://primary.vercel.app',
      'https://alias.vercel.app',
      'https://domain.vercel.app',
      'https://plain.vercel.app',
    ]);
  });

  it('recognizes Vercel protection signals', () => {
    const headers = new Headers({
      server: 'Vercel',
      'set-cookie': '_vercel_sso_nonce=test',
    });
    expect(isVercelProtectedResponse(new Response(null, { headers }), 'Authentication Required')).toBe(true);
  });

  // --- Vercel's Security Checkpoint (`x-vercel-mitigated: challenge`) ------
  //
  // Bot mitigation, not a wall: the request was refused, but a browser passes
  // the checkpoint and the same URL can answer normally moments later. Read as
  // a plain HTTP failure it became `link-delayed` with an HTTP number and no
  // hint of what to do; read as a wall it would have frozen a link that works.

  it('reports a checkpoint challenge as challenged rather than a plain HTTP failure', async () => {
    await withServer((_req, res) => {
      res.writeHead(403, { 'x-vercel-mitigated': 'challenge', 'content-type': 'text/html' });
      res.end('<html>checkpoint</html>');
    }, async (url) => {
      await expect(checkDeploymentUrl(url)).resolves.toMatchObject({
        reachable: false,
        status: 'challenged',
        statusCode: 403,
        statusMessage: "Vercel's Security Checkpoint challenged the request.",
      });
    });
  });

  it('reads the checkpoint header before every status branch, including the SSO redirect', async () => {
    // A redirect that carries the checkpoint header is the checkpoint, not the
    // login wall: reading the redirect first would freeze a link that a
    // browser can still pass as `protected`.
    await withServer((_req, res) => {
      res.writeHead(302, {
        location: 'https://vercel.com/sso-api?url=https%3A%2F%2Fchallenged.example',
        'x-vercel-mitigated': 'challenge',
      });
      res.end();
    }, async (url) => {
      await expect(checkDeploymentUrl(url)).resolves.toMatchObject({
        reachable: false,
        status: 'challenged',
        statusCode: 302,
      });
    });
  });

  it('reads the checkpoint header before the 2xx branch, so a challenged 200 is not reachable', async () => {
    // Vercel answers the checkpoint with 403 or 429 today, but the page it
    // serves is the checkpoint's, not the deployment's, whatever status it
    // carries. The header decides, not the status code.
    await withServer((_req, res) => {
      res.writeHead(200, { 'x-vercel-mitigated': 'challenge', 'content-type': 'text/html' });
      res.end('<html>checkpoint</html>');
    }, async (url) => {
      await expect(checkDeploymentUrl(url)).resolves.toMatchObject({
        reachable: false,
        status: 'challenged',
        statusCode: 200,
      });
    });
  });

  /** Answers per URL, so each candidate can be doing something different. */
  function perUrlProbe(answers: Record<string, 'ok' | 'challenge' | 'wall' | '503'>) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const answer = answers[url] ?? 'ok';
      if (answer === 'challenge') {
        return new Response('', { status: 429, headers: { 'x-vercel-mitigated': 'challenge' } });
      }
      if (answer === '503') return new Response('', { status: 503 });
      if (answer === 'wall') {
        return new Response(null, {
          status: 302,
          headers: { location: `https://vercel.com/sso-api?url=${encodeURIComponent(url)}` },
        });
      }
      return new Response('', { status: 200 });
    });
  }

  /**
   * Runs one probe window on a virtual clock. The loop's poll sleeps and the
   * abort timer each probe arms are fake timers, and every answer is mocked
   * and settles at once, so the window is proven by advancing the clock in
   * poll-sized steps instead of sleeping through it; the loop's own deadline
   * check ends the run. `steps` covers the window with room to spare, and the
   * clock is real again afterwards.
   */
  async function probeWindow<T>(
    start: () => Promise<T>,
    { intervalMs, steps }: { intervalMs: number; steps: number },
  ): Promise<T> {
    vi.useFakeTimers();
    try {
      const pending = start();
      for (let step = 0; step < steps; step += 1) {
        await vi.advanceTimersByTimeAsync(intervalMs);
      }
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  it('keeps probing a challenged candidate and reports ready once the checkpoint clears', async () => {
    let probes = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      probes += 1;
      if (probes <= 2) {
        return new Response('', { status: 429, headers: { 'x-vercel-mitigated': 'challenge' } });
      }
      return new Response('', { status: 200 });
    }));
    try {
      const result = await probeWindow(
        () => waitForReachableDeploymentUrl(['https://challenged.example'], {
          providerLabel: 'Vercel',
          intervalMs: 1_000,
          timeoutMs: 30_000,
        }),
        { intervalMs: 1_000, steps: 4 },
      );

      expect(result).toMatchObject({ status: 'ready', url: 'https://challenged.example' });
      expect(probes).toBeGreaterThan(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports challenged when every candidate is still challenged at the deadline', async () => {
    const probe = perUrlProbe({
      'https://dep.example': 'challenge',
      'https://alias.example': 'challenge',
    });
    vi.stubGlobal('fetch', probe);
    try {
      const result = await probeWindow(
        () => waitForReachableDeploymentUrl(['https://dep.example', 'https://alias.example'], {
          providerLabel: 'Vercel',
          intervalMs: 1_000,
          timeoutMs: 5_000,
        }),
        { intervalMs: 1_000, steps: 7 },
      );

      expect(result.status).toBe('challenged');
      expect(result.url).toBe('https://dep.example');
      expect(result.statusMessage).toMatch(/Security Checkpoint/);
      // A challenge is not a wall: the candidate was asked again and again.
      expect(probe.mock.calls.length).toBeGreaterThan(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports challenged, not protected, when one candidate is challenged and the other is walled', async () => {
    const probe = perUrlProbe({
      'https://dep.example': 'challenge',
      'https://alias.example': 'wall',
    });
    vi.stubGlobal('fetch', probe);
    try {
      const result = await probeWindow(
        () => waitForReachableDeploymentUrl(['https://dep.example', 'https://alias.example'], {
          providerLabel: 'Vercel',
          protectedGraceMs: 0,
          intervalMs: 1_000,
          timeoutMs: 5_000,
        }),
        { intervalMs: 1_000, steps: 7 },
      );

      // The walled alias is out of the running, and what the one candidate
      // still being probed last did was answer the checkpoint.
      expect(result.status).toBe('challenged');
      expect(result.url).toBe('https://dep.example');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the not-reachable-yet sentence when a challenged candidate answers last', async () => {
    // Mixed answers end `link-delayed`, and the sentence must describe that,
    // not the checkpoint one candidate happened to be behind — otherwise the
    // copy depended on which candidate the sweep asked last.
    const probe = perUrlProbe({
      'https://dep.example': '503',
      'https://alias.example': 'challenge',
    });
    vi.stubGlobal('fetch', probe);
    try {
      const result = await probeWindow(
        () => waitForReachableDeploymentUrl(['https://dep.example', 'https://alias.example'], {
          providerLabel: 'Vercel',
          intervalMs: 1_000,
          timeoutMs: 5_000,
        }),
        { intervalMs: 1_000, steps: 7 },
      );

      expect(result.status).toBe('link-delayed');
      expect(result.statusMessage).toMatch(/HTTP 503/);
      expect(result.statusMessage).not.toMatch(/Security Checkpoint/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still reports protected when every candidate is walled and none was challenged', async () => {
    const probe = perUrlProbe({
      'https://dep.example': 'wall',
      'https://alias.example': 'wall',
    });
    vi.stubGlobal('fetch', probe);
    try {
      const result = await probeWindow(
        () => waitForReachableDeploymentUrl(['https://dep.example', 'https://alias.example'], {
          providerLabel: 'Vercel',
          protectedGraceMs: 0,
          intervalMs: 1_000,
          timeoutMs: 30_000,
        }),
        // Every candidate is walled on the first sweep, so the answer is in
        // before the first poll interval is ever waited on.
        { intervalMs: 1_000, steps: 1 },
      );

      expect(result.status).toBe('protected');
      expect(result.url).toBe('https://dep.example');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('deploy link access', () => {
  it.each([
    ['public', 'ready', 'Public link is ready.'],
    ['unknown', 'ready', 'The site answered, but deployment protection could not be checked, so it is not confirmed public.'],
    ['protected', 'ready', "The site answered, but the project's deployment protection is on, so the link is not public."],
  ] as const)('says the %s/%s sentence', (access, status, sentence) => {
    expect(deployLinkSentence({ access, status })).toBe(sentence);
  });

  it('says "Public link is ready." only for access public', () => {
    for (const access of ['public', 'protected', 'unknown'] as const) {
      for (const status of ['ready', 'protected', 'link-delayed', 'challenged', 'failed']) {
        const sentence = deployLinkSentence({ access, status, fallback: 'Fallback.' });
        expect(sentence === 'Public link is ready.').toBe(access === 'public' && status === 'ready');
      }
    }
  });

  it('keeps the caller sentence for a link that did not answer', () => {
    expect(deployLinkSentence({ access: 'unknown', status: 'link-delayed', fallback: 'Still building.' })).toBe('Still building.');
  });

  it.each([
    [{ protection: { checked: true, sso: null, password: false }, linkStatus: 'ready', pageConfirmed: true }, 'public'],
    // Never public from a status alone: without the page GET it is unknown.
    [{ protection: { checked: true, sso: null, password: false }, linkStatus: 'ready' }, 'unknown'],
    [{ protection: { checked: true, sso: null, password: false }, linkStatus: 'ready', pageConfirmed: false }, 'unknown'],
    [{ protection: { checked: false, sso: null, password: false }, linkStatus: 'ready', pageConfirmed: true }, 'unknown'],
    [{ protection: { checked: true, sso: 'all', password: false }, linkStatus: 'ready', pageConfirmed: true }, 'protected'],
    [{ protection: { checked: true, sso: null, password: true }, linkStatus: 'ready', pageConfirmed: true }, 'protected'],
    [{ protection: { checked: true, sso: null, password: false }, linkStatus: 'protected' }, 'protected'],
    [{ protection: { checked: true, sso: null, password: false }, linkStatus: 'link-delayed' }, 'unknown'],
    // Settings first: an unread project is never public, but a probe that hit
    // a wall is protected with or without a read.
    [{ protection: { checked: false, sso: null, password: false }, linkStatus: 'protected' }, 'protected'],
    [{ linkStatus: 'protected' }, 'protected'],
    [{ protection: { checked: true, sso: 'all', password: false }, linkStatus: 'link-delayed' }, 'protected'],
    [{ protection: { checked: false, sso: 'all', password: true }, linkStatus: 'ready', pageConfirmed: true }, 'unknown'],
    [{}, 'unknown'],
  ] as const)('derives Vercel access %#', (input, access) => {
    expect(vercelLinkAccess(input)).toBe(access);
  });

  // The deployed page every probe below is checked against.
  const SITE = '<!doctype html><html><head><title>Demo site</title></head><body><main data-od-id="hero">Welcome to Demo</main><footer data-od-id="footer">Bye</footer></body></html>';
  const SITE_MARKER = pageMarkerFromHtml(SITE);
  const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

  // Retry link on Cloudflare Pages: a pages.dev answer that is only a
  // redirect into a Cloudflare Access login is reachable, not public.
  it.each([
    ['a Cloudflare Access login redirect', 'https://team.cloudflareaccess.com/cdn-cgi/access/login/demo.pages.dev', 'unknown'],
    ['a same-host redirect to the page', 'https://demo.pages.dev/home', 'public'],
  ] as const)('Retry link on pages.dev after %s is %s', async (_label, finalUrl, access) => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-cf-retry-'));
    const prior = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input) === finalUrl) return html(SITE);
      return redirect(finalUrl);
    }));
    try {
      const checked = await checkCloudflarePagesDeploymentLinks({
        providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
        url: 'https://demo.pages.dev',
        cloudflarePages: { projectName: 'demo', pagesDev: { url: 'https://demo.pages.dev' } },
        providerMetadata: { pageMarker: SITE_MARKER },
      });
      expect(checked.access).toBe(access);
      expect((checked.cloudflarePages as any).pagesDev.status).toBe('ready');
      if (access !== 'public') expect(String((checked.cloudflarePages as any).pagesDev.statusMessage)).not.toMatch(/Public link is ready/);
    } finally {
      vi.unstubAllGlobals();
      if (prior === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = prior;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('keeps Retry on a record with no stored page marker unknown', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-cf-retry-nomarker-'));
    const prior = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    vi.stubGlobal('fetch', vi.fn(async () => html(SITE)));
    try {
      const checked = await checkCloudflarePagesDeploymentLinks({
        providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
        url: 'https://demo.pages.dev',
        cloudflarePages: { projectName: 'demo', pagesDev: { url: 'https://demo.pages.dev' } },
      });
      expect(checked.access).toBe('unknown');
    } finally {
      vi.unstubAllGlobals();
      if (prior === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = prior;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('re-checks a custom domain on Retry with its own GET, not the pages.dev answer', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'od-cf-retry-custom-'));
    const prior = process.env.OD_USER_STATE_DIR;
    process.env.OD_USER_STATE_DIR = stateRoot;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'HEAD') return new Response('', { status: url.startsWith('https://demo.example.com') ? 302 : 200 });
      if (url.startsWith('https://demo.example.com')) {
        return redirect('https://team.cloudflareaccess.com/cdn-cgi/access/login/demo.example.com');
      }
      return html(SITE);
    }));
    try {
      const checked = await checkCloudflarePagesDeploymentLinks({
        providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
        url: 'https://demo.pages.dev',
        cloudflarePages: {
          projectName: 'demo',
          pagesDev: { url: 'https://demo.pages.dev' },
          customDomain: { url: 'https://demo.example.com', hostname: 'demo.example.com', status: 'ready', pagesDomainStatus: 'active', access: 'public' },
        },
        providerMetadata: { pageMarker: SITE_MARKER },
      });
      const pages = checked.cloudflarePages as any;
      expect(checked.access).toBe('public');
      expect(pages.pagesDev.access).toBe('public');
      expect(pages.customDomain).toMatchObject({ status: 'ready', access: 'unknown' });
    } finally {
      vi.unstubAllGlobals();
      if (prior === undefined) delete process.env.OD_USER_STATE_DIR;
      else process.env.OD_USER_STATE_DIR = prior;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  describe('resolveCloudflarePagesAccess', () => {
    afterEach(() => vi.unstubAllGlobals());
    /** Answers the GET for `https://x.pages.dev` with `first`, and any later hop with `SITE`. */
    const answer = (first: Response) => {
      const fetchMock = vi.fn(async (input: unknown) => (String(input) === 'https://x.pages.dev' ? first : html(SITE)));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };
    const resolve = (linkStatus = 'ready', marker: typeof SITE_MARKER = SITE_MARKER) =>
      resolveCloudflarePagesAccess({ url: 'https://x.pages.dev', linkStatus, marker });

    it('sends one manual-redirect anonymous GET and calls the deployed page public', async () => {
      const fetchMock = answer(html(SITE));
      expect(await resolve()).toBe('public');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]).toEqual([
        'https://x.pages.dev',
        expect.objectContaining({ method: 'GET', redirect: 'manual' }),
      ]);
    });

    it('never asks for a link the probe did not call ready', async () => {
      const fetchMock = answer(html(SITE));
      expect(await resolve('link-delayed')).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps a redirect to a Cloudflare Access login unknown without requesting it', async () => {
      const fetchMock = answer(redirect('https://team.cloudflareaccess.com/cdn-cgi/access/login/x.pages.dev'));
      expect(await resolve()).toBe('unknown');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps a same-host redirect into the Access path unknown', async () => {
      answer(redirect('/cdn-cgi/access/login'));
      expect(await resolve()).toBe('unknown');
    });

    it('calls a same-host redirect that ends in the deployed page public', async () => {
      const fetchMock = answer(redirect('/home', 308));
      expect(await resolve()).toBe('public');
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['https://x.pages.dev', 'https://x.pages.dev/home']);
    });

    it('keeps a final answer that is not 2xx unknown', async () => {
      answer(html(SITE, 401));
      expect(await resolve()).toBe('unknown');
    });

    it('keeps a 2xx that is not an HTML page unknown', async () => {
      answer(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
      expect(await resolve()).toBe('unknown');
    });

    it('keeps a record with no page marker unknown', async () => {
      answer(html(SITE));
      expect(await resolve('ready', null)).toBe('unknown');
    });

    it.each([
      ['a Vercel SSO page', '<!doctype html><html><title>Vercel Authentication</title></html>', {}],
      ['a Cloudflare challenge page', '<!doctype html><html><script src="https://challenges.cloudflare.com/x.js"></script></html>', {}],
      ['a Cloudflare challenge header', SITE, { 'cf-mitigated': 'challenge' }],
      ['a Vercel checkpoint header', SITE, { 'x-vercel-mitigated': 'challenge' }],
    ])('keeps a 2xx GET that serves %s unknown', async (_label, body, extra) => {
      answer(html(body, 200, extra));
      expect(await resolve()).toBe('unknown');
    });

    it('keeps a GET it cannot send unknown', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
      expect(await resolve()).toBe('unknown');
    });
  });

  describe('confirmAnonymousPageGet content match', () => {
    afterEach(() => vi.unstubAllGlobals());
    const confirm = (body: string) => {
      vi.stubGlobal('fetch', vi.fn(async () => html(body)));
      return confirmAnonymousPageGet('https://site.vercel.app', { marker: SITE_MARKER });
    };

    it('accepts the deployed page itself', async () => {
      expect(await confirm(SITE)).toBe(true);
    });

    it.each([
      // Same host, 2xx, HTML, none of the provider's wall strings, and the
      // project's own title: only the content match catches these.
      ['a wall that reuses the project title', '<!doctype html><html><head><title>Demo site</title></head><body><p>Please wait</p></body></html>'],
      ['a password form', '<!doctype html><html><head><title>Demo site</title></head><body><main data-od-id="hero">Welcome to Demo</main><form><input type="password" name="pw"></form><footer data-od-id="footer">Bye</footer></body></html>'],
      ['an "Authentication Required" title', '<!doctype html><html><head><title>Authentication Required</title></head><body><main data-od-id="hero">Welcome to Demo</main><footer data-od-id="footer">Bye</footer></body></html>'],
      ['a "Log in" title', '<!doctype html><html><head><title>Log in</title></head><body>Log in to continue</body></html>'],
      ['a generic 2xx HTML page', '<!doctype html><html><body>Site</body></html>'],
    ])('rejects %s', async (_label, body) => {
      expect(await confirm(body)).toBe(false);
    });

    it('accepts a deployed sign-in design: a password field the deployed page itself has is not a wall', async () => {
      const login = '<!doctype html><html><head><title>Acme</title></head><body><form data-od-id="login"><input type="password"></form></body></html>';
      vi.stubGlobal('fetch', vi.fn(async () => html(login)));
      expect(await confirmAnonymousPageGet('https://acme.vercel.app', { marker: pageMarkerFromHtml(login) })).toBe(true);
    });
  });

  describe('confirmAnonymousPageGet redirect validation', () => {
    const RESOLVER = Symbol.for('mish.daemon.publicProbeResolveHost');
    const slots = globalThis as unknown as Record<symbol, unknown>;
    const priorResolver = slots[RESOLVER];
    afterEach(() => {
      vi.unstubAllGlobals();
      slots[RESOLVER] = priorResolver;
    });
    /** The first GET redirects to `location`; anything later would serve the page. */
    const redirectTo = (location: string) => {
      const fetchMock = vi.fn(async (input: unknown) => (String(input) === 'https://site.vercel.app' ? redirect(location) : html(SITE)));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };

    it.each([
      ['loopback', 'http://127.0.0.1:7456/api/projects'],
      ['loopback over https', 'https://127.0.0.1/'],
      ['localhost', 'https://localhost/'],
      ['IPv6 loopback', 'https://[::1]/'],
      ['a private IP', 'https://10.0.0.5/'],
      ['a private IP (192.168)', 'https://192.168.1.1/admin'],
      ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
      ['another tenant on the provider host', 'https://attacker.vercel.app/'],
    ])('never requests a redirect to %s', async (_label, location) => {
      const fetchMock = redirectTo(location);
      expect(await confirmAnonymousPageGet('https://site.vercel.app', { marker: SITE_MARKER })).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never requests a same-site name that resolves to a private address', async () => {
      slots[RESOLVER] = async (host: string) => (host === 'internal.example.com' ? ['10.1.2.3'] : ['93.184.216.34']);
      const fetchMock = vi.fn(async (input: unknown) => (String(input) === 'https://demo.example.com' ? redirect('https://internal.example.com/') : html(SITE)));
      vi.stubGlobal('fetch', fetchMock);
      expect(await confirmAnonymousPageGet('https://demo.example.com', { marker: SITE_MARKER })).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never requests a first URL that resolves to loopback', async () => {
      slots[RESOLVER] = async () => ['127.0.0.1'];
      const fetchMock = vi.fn(async () => html(SITE));
      vi.stubGlobal('fetch', fetchMock);
      expect(await confirmAnonymousPageGet('https://rebound.example.com', { marker: SITE_MARKER })).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stops after five redirects', async () => {
      let n = 0;
      const fetchMock = vi.fn(async () => redirect(`/hop-${(n += 1)}`));
      vi.stubGlobal('fetch', fetchMock);
      expect(await confirmAnonymousPageGet('https://site.vercel.app', { marker: SITE_MARKER })).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('follows up to five validated same-host redirects to the page', async () => {
      const fetchMock = vi.fn(async (input: unknown) => {
        const hop = Number(/hop-(\d)/.exec(String(input))?.[1] ?? 0);
        return hop < 5 ? redirect(`/hop-${hop + 1}`) : html(SITE);
      });
      vi.stubGlobal('fetch', fetchMock);
      expect(await confirmAnonymousPageGet('https://site.vercel.app', { marker: SITE_MARKER })).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(6);
      for (const [, init] of fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>) expect(init.redirect).toBe('manual');
    });
  });

  describe('confirmAnonymousPageGet pinned connection (DNS rebinding)', () => {
    const RESOLVER = Symbol.for('mish.daemon.publicProbeResolveHost');
    const slots = globalThis as unknown as Record<symbol, unknown>;
    const priorResolver = slots[RESOLVER];
    afterEach(() => {
      vi.unstubAllGlobals();
      slots[RESOLVER] = priorResolver;
    });

    it('connects to the address it validated, not to a later private DNS answer', async () => {
      // Public while the probe checks the name, loopback for any later lookup:
      // the classic rebinding answer. A re-resolving fetch would hit 127.0.0.1.
      const lookups: string[] = [];
      slots[RESOLVER] = async (host: string) => {
        lookups.push(host);
        return lookups.length === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
      };
      const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => html(SITE));
      vi.stubGlobal('fetch', fetchMock);
      expect(await confirmAnonymousPageGet('https://rebind.example.com', { marker: SITE_MARKER })).toBe(true);
      expect(lookups).toEqual(['rebind.example.com']);
      const dispatcher = (fetchMock.mock.calls[0]![1] as { dispatcher?: unknown }).dispatcher;
      expect(pinnedAddressOf(dispatcher)).toEqual({ address: '93.184.216.34', family: 4 });
    });

    it('pins every redirect hop to that hop\'s own validated address', async () => {
      const answers = [['93.184.216.34'], ['93.184.216.35'], ['127.0.0.1']];
      slots[RESOLVER] = async () => answers.shift() ?? ['127.0.0.1'];
      const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => (String(input) === 'https://site.vercel.app' ? redirect('/home') : html(SITE)));
      vi.stubGlobal('fetch', fetchMock);
      expect(await confirmAnonymousPageGet('https://site.vercel.app', { marker: SITE_MARKER })).toBe(true);
      const pinned = fetchMock.mock.calls.map(([, init]) => pinnedAddressOf((init as { dispatcher?: unknown }).dispatcher)?.address);
      expect(pinned).toEqual(['93.184.216.34', '93.184.216.35']);
    });

    it('answers every name with the pinned address, in both lookup call shapes', () => {
      const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 }) as unknown as (
        host: string, options: unknown, cb?: (...args: unknown[]) => void) => void;
      const single = vi.fn();
      const all = vi.fn();
      const bare = vi.fn();
      lookup('rebind.example.com', { family: 0 }, single);
      lookup('rebind.example.com', { all: true }, all);
      lookup('rebind.example.com', bare);
      expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
      expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
      expect(bare).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    });

    it('opens its socket on the pinned address without resolving the URL host', async () => {
      // `.invalid` never resolves, so reaching this local listener proves the
      // dispatcher connected to the pinned address and did no DNS lookup.
      const connections: string[] = [];
      const server = net.createServer((socket) => {
        connections.push(String(socket.localAddress));
        socket.destroy();
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const { port } = server.address() as AddressInfo;
      const dispatcher = pinnedProbeDispatcher({ address: '127.0.0.1', family: 4 });
      try {
        await expect(fetch(`https://pinned-probe.invalid:${port}/`, {
          dispatcher: dispatcher as unknown as NonNullable<RequestInit['dispatcher']>,
        })).rejects.toThrow();
        expect(connections.length).toBeGreaterThan(0);
        expect(connections[0]).toMatch(/127\.0\.0\.1$/);
      } finally {
        await dispatcher.destroy().catch(() => {});
        await new Promise<void>((done) => server.close(() => done()));
      }
    });
  });

  describe('confirmAnonymousPageGet redirect owner', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('refuses a redirect to another owner under the same public suffix', async () => {
      const fetchMock = vi.fn(async (input: unknown) => (String(input) === 'https://victim.co.uk' ? redirect('https://attacker.co.uk/') : html(SITE)));
      vi.stubGlobal('fetch', fetchMock);
      expect(await confirmAnonymousPageGet('https://victim.co.uk', { marker: SITE_MARKER })).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['victim.co.uk', 'victim.co.uk', true],
      ['VICTIM.co.uk.', 'victim.co.uk', true],
      ['attacker.co.uk', 'victim.co.uk', false],
      ['www.victim.co.uk', 'victim.co.uk', false],
      ['cdn.example.com', 'demo.example.com', false],
      ['preview.site.vercel.app', 'site.vercel.app', true],
      ['attacker.vercel.app', 'site.vercel.app', false],
      ['a.x.pages.dev', 'x.pages.dev', true],
      ['y.pages.dev', 'x.pages.dev', false],
    ] as const)('same owner: %s from %s is %s', (host, deploymentHost, allowed) => {
      expect(sameDeploymentOwner(host, deploymentHost)).toBe(allowed);
    });
  });

  describe('confirmAnonymousPageGet body cap', () => {
    afterEach(() => vi.unstubAllGlobals());

    /** A body that never ends: 64 KiB chunks for as long as anyone reads. */
    const endless = () => {
      let pulled = 0;
      let cancelled = false;
      const chunk = new TextEncoder().encode(`<p>${'x'.repeat(65_529)}</p>`);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      return { stream, pulled: () => pulled, cancelled: () => cancelled };
    };

    it('stops reading an oversized body at the cap and reports it unconfirmed', async () => {
      const body = endless();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body.stream, { status: 200, headers: { 'content-type': 'text/html' } })));
      expect(await confirmAnonymousPageGet('https://site.vercel.app', { marker: SITE_MARKER })).toBe(false);
      expect(body.cancelled()).toBe(true);
      expect(body.pulled()).toBeLessThan(MAX_BODY_BYTES + 4 * 65_536);
    });

    it('reads a body up to the cap and refuses one byte more', async () => {
      expect(await readBodyCapped(new Response('abcd'), 4)).toBe('abcd');
      expect(await readBodyCapped(new Response('abcde'), 4)).toBeNull();
    });
  });

  describe('isForbiddenProbeAddress IPv6 forms', () => {
    it.each([
      '64:ff9b::7f00:1',
      '64:ff9b::127.0.0.1',
      '64:ff9b::808:808',
      '64:ff9b:1::a00:1',
      '::127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:127.0.0.1',
      '2002:7f00:1::1',
      '2002:a00:1::1',
      '2002:a9fe:a9fe::',
      '2001::1',
      '2001:db8::1',
      '100::1',
      'fd00:ec2::254',
      'fe80::1%lo0',
      '::',
      '::1',
    ])('forbids %s', (address) => {
      expect(isForbiddenProbeAddress(address)).toBe(true);
    });

    it.each(['2606:4700:4700::1111', '2002:5db8:d822::1', '::ffff:93.184.216.34', '2a00:1450:4001:80b::200e'])('allows %s', (address) => {
      expect(isForbiddenProbeAddress(address)).toBe(false);
    });

    it('never requests a name that resolves to a NAT64 address', async () => {
      const RESOLVER = Symbol.for('mish.daemon.publicProbeResolveHost');
      const slots = globalThis as unknown as Record<symbol, unknown>;
      const prior = slots[RESOLVER];
      slots[RESOLVER] = async () => ['64:ff9b::7f00:1'];
      const fetchMock = vi.fn(async () => html(SITE));
      vi.stubGlobal('fetch', fetchMock);
      try {
        expect(await confirmAnonymousPageGet('https://nat64.example.com', { marker: SITE_MARKER })).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        slots[RESOLVER] = prior;
        vi.unstubAllGlobals();
      }
    });
  });

  describe('bodyMatchesPageMarker anchors', () => {
    afterEach(() => vi.unstubAllGlobals());
    const confirm = (body: string) => {
      vi.stubGlobal('fetch', vi.fn(async () => html(body)));
      return confirmAnonymousPageGet('https://site.vercel.app', { marker: SITE_MARKER });
    };

    it('keeps a marker text anchor even when the page has data-od-id anchors', () => {
      expect(SITE_MARKER?.raw.length).toBeGreaterThan(0);
      expect(SITE_MARKER?.text).toBe('Welcome to Demo Bye');
    });

    it('rejects a wall that reuses the title and both raw anchors around a different body', async () => {
      expect(await confirm('<!doctype html><html><head><title>Demo site</title></head><body><main data-od-id="hero">Checking your browser</main><footer data-od-id="footer">Please wait</footer></body></html>')).toBe(false);
    });

    it('degrades a provider-suffixed title to unconfirmed (documented, safe direction)', async () => {
      expect(await confirm(SITE.replace('<title>Demo site</title>', '<title>Demo site | Preview</title>'))).toBe(false);
    });
  });

  describe('resolveVercelLinkAccess', () => {
    afterEach(() => vi.unstubAllGlobals());
    const OFF = { checked: true, sso: null, password: false };

    it('downgrades to unknown when HEAD answers 200 but the GET is a same-host wall', async () => {
      const methods: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
        methods.push(init?.method || 'GET');
        if (init?.method === 'HEAD') return new Response('', { status: 200 });
        return html('<!doctype html><html><head><title>Demo site</title></head><body>Checking your browser</body></html>');
      }));
      const probe = await checkDeploymentUrl('https://gated.vercel.app');
      expect(probe).toMatchObject({ reachable: true, statusCode: 200 });
      expect(await resolveVercelLinkAccess({ protection: OFF, linkStatus: 'ready', url: 'https://gated.vercel.app', marker: SITE_MARKER })).toBe('unknown');
      expect(methods).toEqual(['HEAD', 'GET']);
    });

    it('calls the deployed page public', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => html(SITE)));
      expect(await resolveVercelLinkAccess({ protection: OFF, linkStatus: 'ready', url: 'https://site.vercel.app', marker: SITE_MARKER })).toBe('public');
    });

    it('sends no GET unless the settings read off and the link answered', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      expect(await resolveVercelLinkAccess({ protection: { checked: true, sso: 'all', password: false }, linkStatus: 'ready', url: 'https://x.vercel.app', marker: SITE_MARKER })).toBe('protected');
      expect(await resolveVercelLinkAccess({ protection: { checked: false, sso: null, password: false }, linkStatus: 'ready', url: 'https://x.vercel.app', marker: SITE_MARKER })).toBe('unknown');
      expect(await resolveVercelLinkAccess({ protection: OFF, linkStatus: 'link-delayed', url: 'https://x.vercel.app', marker: SITE_MARKER })).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
