import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeProjectFile } from '../src/projects.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('writeProjectFile permissions', () => {
  it.skipIf(process.platform === 'win32')('keeps the existing file mode when overwriting', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-project-mode-'));
    tempRoots.push(root);
    const projectsRoot = path.join(root, 'projects');
    const projectDir = path.join(projectsRoot, 'project-1');
    await mkdir(projectDir, { recursive: true });
    const filePath = path.join(projectDir, 'run.sh');
    await writeFile(filePath, '#!/bin/sh\necho old\n');
    await chmod(filePath, 0o755);

    await writeProjectFile(projectsRoot, 'project-1', 'run.sh', '#!/bin/sh\necho new\n');

    expect(await readFile(filePath, 'utf8')).toBe('#!/bin/sh\necho new\n');
    expect((await stat(filePath)).mode & 0o7777).toBe(0o755);
  });
});
