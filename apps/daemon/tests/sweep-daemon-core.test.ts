import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeAppConfig } from '../src/app-config.js';
import { parseDaemonCliStartupArgs } from '../src/daemon-startup.js';
import { listFiles, sanitizePath, writeProjectFile } from '../src/projects.js';

const roots: string[] = [];
async function tmp() {
  const d = await mkdtemp(path.join(tmpdir(), 'od-sweep-'));
  roots.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('OD_PORT validation', () => {
  it.each(['70000', '-5', '7456.5'])('rejects %s', (v) => {
    expect(parseDaemonCliStartupArgs([], { OD_PORT: v })).toMatchObject({ ok: false, kind: 'error' });
  });
  it('accepts a valid port', () => {
    expect(parseDaemonCliStartupArgs([], { OD_PORT: '8000' })).toMatchObject({ ok: true });
  });
});

describe('writeProjectFile', () => {
  it('rejects bad names with a coded error', () => {
    for (const bad of ['../x', '/abs', '.']) {
      let code: string | undefined;
      try {
        sanitizePath(bad);
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      expect(code).toBe('EINVALIDNAME');
    }
  });

  it('lets exactly one concurrent overwrite:false write win', async () => {
    const root = await tmp();
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((n) => writeProjectFile(root, 'p', 'a.html', `v${n}`, { overwrite: false })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason.code).toBe('EEXIST');
    }
    expect((await readdir(path.join(root, 'p'))).sort()).toEqual(['a.html']);
  });

  it('overwrites atomically and leaves no temp files', async () => {
    const root = await tmp();
    await writeProjectFile(root, 'p', 'a.html', 'one');
    await writeProjectFile(root, 'p', 'a.html', 'two');
    expect(await readFile(path.join(root, 'p', 'a.html'), 'utf8')).toBe('two');
    expect(await readdir(path.join(root, 'p'))).toEqual(['a.html']);
  });

  it('verbatimName keeps the name; keepBuildDirs lists out/', async () => {
    const root = await tmp();
    await writeProjectFile(root, 'p', 'assets/My Photo (1).png', 'x', { verbatimName: true });
    await mkdir(path.join(root, 'p', 'out'), { recursive: true });
    await writeFile(path.join(root, 'p', 'out', 'r.html'), 'r');
    const names = (await listFiles(root, 'p', { keepBuildDirs: true })).map((f) => f.name).sort();
    expect(names).toEqual(['assets/My Photo (1).png', 'out/r.html']);
    expect((await listFiles(root, 'p')).map((f) => f.name)).not.toContain('out/r.html');
  });
});

describe('writeAppConfig with an unparsable file', () => {
  it('keeps a backup copy before replacing it', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'app-config.json'), '{ "agentCliEnv": broken');
    await writeAppConfig(dir, { onboardingCompleted: true });
    const backups = (await readdir(dir)).filter((n) => n.startsWith('app-config.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(dir, backups[0]!), 'utf8')).toContain('broken');
  });
});
