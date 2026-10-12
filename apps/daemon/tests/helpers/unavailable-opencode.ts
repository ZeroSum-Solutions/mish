import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** A supported agent whose fixture execution fails locally; never runs a provider. */
export async function installUnavailableOpencode(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), 'od-unavailable-opencode-'));
  const oldPath = process.env.PATH;
  const script = `if (process.argv.includes('--version')) { console.log('opencode 1.0.0'); process.exit(0); }
if (process.argv[2] === 'models') { console.log('default'); process.exit(0); }
console.error('fixture agent unavailable'); process.exit(1);`;
  if (process.platform === 'win32') {
    const runner = join(dir, 'runner.cjs');
    await writeFile(runner, script);
    await writeFile(join(dir, 'opencode.cmd'), `@echo off\r\n"${process.execPath}" "${runner}" %*\r\n`);
  } else {
    const bin = join(dir, 'opencode');
    await writeFile(bin, `#!/usr/bin/env node\n${script}`);
    await chmod(bin, 0o755);
  }
  process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
  return async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  };
}
