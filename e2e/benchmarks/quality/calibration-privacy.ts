import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
/** Private calibration outputs inside a checkout must already be ignored. */
export async function assertPrivateOutput(output: string) {
  const target = resolve(output);
  const parent = await realpath(dirname(target));
  let canonical = join(parent, basename(target));
  try { canonical = await realpath(target); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  if (canonical.split('/').includes('.git')) throw new Error('Private evidence cannot write repository metadata');
  let root: string;
  try { root = (await promisify(execFile)('git', ['-C', dirname(canonical), 'rev-parse', '--show-toplevel'], { timeout: 5000 })).stdout.trim(); }
  catch (error) { if ((error as { code?: number }).code === 128 && /not a git repository/u.test((error as { stderr?: string }).stderr ?? '')) return; throw error; }
  const path = relative(root, canonical);
  if (path.split('/').includes('.git')) throw new Error('Private evidence cannot write repository metadata');
  try { await promisify(execFile)('git', ['-C', root, 'check-ignore', '-q', '--', path], { timeout: 5000 }); }
  catch { throw new Error('Calibration output inside a checkout must be git-ignored; use ignored .tmp or a private external directory'); }
}
