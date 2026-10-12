import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { registerDesignSystemToolRoutes } from '../src/routes/design-system-tool.js';

let server: http.Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error?: Error) => error ? reject(error) : resolve());
  });
  server = undefined;
});

const fontBytes = Buffer.from([0x00, 0x01, 0xff, 0x80, 0x42, 0x0a]);

function fixture(
  options: { symlinkDesign?: boolean; symlinkFont?: boolean; unsafeUsage?: boolean } = {},
  root = mkdtempSync(path.join(tmpdir(), 'design-system-pull-')),
) {
  mkdirSync(root, { recursive: true });
  const brandRoot = path.join(root, 'installed-kit');
  mkdirSync(brandRoot);
  mkdirSync(path.join(brandRoot, 'fonts'));
  const files = {
    'DESIGN.md': '# Installed kit\n',
    'tokens.css': ':root { --accent: red; }',
    'components.html': '<button>Apply</button>',
    'USAGE.md': '# Use this kit\n',
    'components.manifest.json': '{"schemaVersion":1}',
    'private.txt': 'private file',
  };
  for (const [name, content] of Object.entries(files)) {
    if (options.symlinkDesign && name === 'DESIGN.md') continue;
    writeFileSync(path.join(brandRoot, name), content);
  }
  if (options.symlinkDesign) {
    writeFileSync(path.join(root, 'outside.md'), 'outside content');
    symlinkSync(path.join(root, 'outside.md'), path.join(brandRoot, 'DESIGN.md'));
  }
  if (options.symlinkFont) {
    writeFileSync(path.join(root, 'outside.woff2'), fontBytes);
    symlinkSync(path.join(root, 'outside.woff2'), path.join(brandRoot, 'fonts', 'declared.woff2'));
  } else {
    writeFileSync(path.join(brandRoot, 'fonts', 'declared.woff2'), fontBytes);
  }
  writeFileSync(path.join(brandRoot, 'fonts', 'undeclared.woff2'), fontBytes);
  writeFileSync(path.join(brandRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 'od-design-system-project/v1',
    id: 'installed-kit',
    name: 'Installed kit',
    category: 'Test',
    source: { type: 'bundled' },
    files: { design: 'DESIGN.md', tokens: 'tokens.css', components: 'components.html' },
    usage: options.unsafeUsage ? 'sub/../private.txt' : 'USAGE.md',
    componentsManifest: 'components.manifest.json',
    fonts: [{ family: 'Fixture Sans', file: 'fonts/declared.woff2' }],
  }));
  return root;
}

function linkedFixture(): string {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'design-system-linked-pull-'));
  const registryRoot = path.join(dataRoot, 'design-systems');
  const backingRoot = path.join(dataRoot, 'imported-source-bundles', 'design-systems-v4', 'design-systems');
  mkdirSync(registryRoot);
  fixture({}, backingRoot);
  symlinkSync(path.join(backingRoot, 'installed-kit'), path.join(registryRoot, 'installed-kit'), 'dir');
  return registryRoot;
}

async function route(root: string): Promise<string> {
  const app = express();
  app.use(express.json());
  registerDesignSystemToolRoutes(app, {
    auth: {
      authorizeToolRequest: (_req, _res, operation) => {
        expect(operation).toBe('design-systems:read');
        return {
          token: 'fixture-token', runId: 'fixture-run', projectId: 'fixture-project',
          allowedEndpoints: ['/api/tools/design-systems/read'],
          allowedOperations: ['design-systems:read'],
          issuedAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString(),
        };
      },
    },
    http: { sendApiError: (res, status, code, message) => {
      res.status(status).json({ error: { code, message } });
    } },
    paths: { DESIGN_SYSTEMS_DIR: root, USER_DESIGN_SYSTEMS_DIR: root },
    projects: { getProject: () => ({ id: 'fixture-project', designSystemId: 'installed-kit' }) },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unexpected listen address');
  return `http://127.0.0.1:${address.port}`;
}

async function read(baseUrl: string, filePath: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/tools/design-systems/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-token' },
    body: JSON.stringify({ path: filePath }),
  });
  return { status: response.status, body: await response.json() };
}

describe('scoped design-system pull', () => {
  it('reads a declared file from a registered kit symlink to its installed package', async () => {
    const baseUrl = await route(linkedFixture());
    const design = await read(baseUrl, 'DESIGN.md');
    expect(design.status).toBe(200);
    expect(design.body.file).toMatchObject({
      path: 'DESIGN.md',
      encoding: 'utf8',
      content: '# Installed kit\n',
    });

    const font = await read(baseUrl, 'fonts/declared.woff2');
    expect(font.status).toBe(200);
    expect(font.body.file.encoding).toBe('base64');
    expect(Buffer.from(font.body.file.content, 'base64')).toEqual(fontBytes);
    expect((await read(baseUrl, 'private.txt')).status).toBe(404);
  });

  it('delivers declared core, usage, and component manifest files', async () => {
    const baseUrl = await route(fixture());
    for (const [filePath, content] of [
      ['DESIGN.md', '# Installed kit\n'],
      ['tokens.css', ':root { --accent: red; }'],
      ['components.html', '<button>Apply</button>'],
      ['USAGE.md', '# Use this kit\n'],
      ['components.manifest.json', '{"schemaVersion":1}'],
    ] as const) {
      const result = await read(baseUrl, filePath);
      expect(result.status, filePath).toBe(200);
      expect(result.body.file).toMatchObject({ path: filePath, encoding: 'utf8', content });
    }
  });

  it('refuses undeclared and traversal paths', async () => {
    const baseUrl = await route(fixture());
    for (const filePath of ['private.txt', '../outside.md']) {
      const result = await read(baseUrl, filePath);
      expect(result.status, filePath).toBe(404);
      expect(result.body.error.code).toBe('DESIGN_SYSTEM_FILE_NOT_FOUND');
    }
  });

  it('refuses a declared core file symlink that escapes its kit', async () => {
    const baseUrl = await route(fixture({ symlinkDesign: true }));
    const result = await read(baseUrl, 'DESIGN.md');
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('DESIGN_SYSTEM_FILE_NOT_FOUND');
  });

  it('refuses unsafe manifest usage declarations', async () => {
    const baseUrl = await route(fixture({ unsafeUsage: true }));
    const result = await read(baseUrl, 'private.txt');
    expect(result.status).toBe(404);
  });

  it('preserves bytes of an explicitly declared font through the scoped JSON read', async () => {
    const baseUrl = await route(fixture());
    const result = await read(baseUrl, 'fonts/declared.woff2');
    expect(result.status).toBe(200);
    expect(result.body.file).toMatchObject({
      path: 'fonts/declared.woff2',
      encoding: 'base64',
      size: fontBytes.length,
    });
    const pulledBytes = Buffer.from(result.body.file.content, 'base64');
    expect(createHash('sha256').update(pulledBytes).digest('hex')).toBe(
      createHash('sha256').update(fontBytes).digest('hex'),
    );
  });

  it('refuses an undeclared font in the same directory', async () => {
    const baseUrl = await route(fixture());
    const result = await read(baseUrl, 'fonts/undeclared.woff2');
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('DESIGN_SYSTEM_FILE_NOT_FOUND');
  });

  it('refuses a declared font symlink that escapes its kit', async () => {
    const baseUrl = await route(fixture({ symlinkFont: true }));
    const result = await read(baseUrl, 'fonts/declared.woff2');
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('DESIGN_SYSTEM_FILE_NOT_FOUND');
  });
});
