import { beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDarwinPlacementHelper } from '../../../src/workbench/placement/build.js';
import { inspectPlacementParents, prepareExclusiveMove, type Helper, type MoveRequest } from '../../../src/workbench/placement/driver.js';
const run = promisify(execFile);
const supported = process.platform === 'darwin' && process.arch === 'arm64' && release() === '25.5.0';
const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/workbench/placement/native.c');
let root: string, helper: Helper;
// Retain owned fixtures: conflicts and unknown outcomes are evidence, never cleaned by the primitive.
describe.skipIf(!supported)('qualified Darwin exclusive placement', () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(process.env.OD_PLACEMENT_TEST_EVIDENCE ?? tmpdir(), 'placement-')));
    helper = await buildDarwinPlacementHelper({ sourcePath, outputPath: join(root, 'helper'), arch: 'arm64' });
    await writeFile(join(root, 'build.json'), JSON.stringify(helper));
  });
  async function fixture(name: string, type: 'file' | 'directory' = 'file', executable = helper): Promise<MoveRequest> {
    const base = join(root, name); await mkdir(base); const source = join(base, 'source'), target = join(base, 'retained');
    await mkdir(source); await mkdir(target);
    if (type === 'file') await writeFile(join(source, 'item'), 'independent preimage');
    else { await mkdir(join(source, 'item')); await writeFile(join(source, 'item', 'content'), 'tree preimage'); }
    const pair = await inspectPlacementParents({ helper: executable, sourceParentPath: source, targetParentPath: target });
    expect(pair.kind).toBe('qualified'); if (pair.kind !== 'qualified') throw new Error(JSON.stringify(pair));
    const st = await lstat(join(source, 'item'), { bigint: true });
    return { helper: executable, source: { parent: { path: source, identity: pair.sourceParent }, name: 'item' }, target: { parent: { path: target, identity: pair.targetParent }, name: 'item' }, expectedSource: { device: st.dev.toString(), inode: st.ino.toString(), kind: type } };
  }
  async function execute(request: MoveRequest, intent: (value: { invocationId: string }) => Promise<void> = async () => {}) {
    const ready = await prepareExclusiveMove(request); expect(ready.kind).toBe('ready');
    if (ready.kind !== 'ready') throw new Error(JSON.stringify(ready));
    try { return await ready.execute(intent); } finally { await ready.close(); }
  }
  it.each(['file', 'directory'] as const)('moves and separately restores a %s with a new intent', async type => {
    const request = await fixture(`roundtrip-${type}`, type); const intents: string[] = [];
    const record = async (i: { invocationId: string }) => { intents.push(i.invocationId); };
    const moved = await execute(request, record); expect(moved.kind).toBe('observed-move');
    if (moved.kind !== 'observed-move') throw new Error(JSON.stringify(moved));
    expect(moved.contentVerification).toBe('required'); expect(moved.observation.sourceAfter).toBeNull();
    expect(await readFile(join(request.target.parent.path, 'item', ...(type === 'directory' ? ['content'] : [])), 'utf8')).toContain('preimage');
    expect((await execute({ ...request, source: request.target, target: request.source }, record)).kind).toBe('observed-move');
    expect(intents).toHaveLength(2); expect(intents[0]).not.toBe(intents[1]);
  });
  it.each(['file', 'directory', 'symlink'] as const)('preserves an occupied %s destination', async type => {
    const req = await fixture(`collision-${type}`), target = join(req.target.parent.path, 'item');
    if (type === 'file') await writeFile(target, 'foreign bytes');
    else if (type === 'directory') await mkdir(target);
    else await symlink('/nonexistent-owned-fixture', target);
    expect(await prepareExclusiveMove(req)).toMatchObject({ kind: 'conflict', reason: 'occupied', mutation: 'none' });
    expect(await readFile(join(req.source.parent.path, 'item'), 'utf8')).toBe('independent preimage');
    expect((await lstat(target)).isSymbolicLink()).toBe(type === 'symlink');
  });
  it('declines same-entry case and Unicode aliases rather than accepting rename rc0', async () => {
    for (const [from, to] of [['Résumé', 'résumé'], ['é', 'e\u0301']]) {
      const req = await fixture(`alias-${from}`); await rename(join(req.source.parent.path, 'item'), join(req.source.parent.path, from!));
      expect(await prepareExclusiveMove({ ...req, source: { ...req.source, name: from! }, target: { parent: req.source.parent, name: to! } })).toMatchObject({ kind: 'conflict', reason: 'alias' });
    }
  });
  it('rejects hard links and symlink parent components', async () => {
    const req = await fixture('links'); await link(join(req.source.parent.path, 'item'), join(req.source.parent.path, 'alias'));
    expect(await prepareExclusiveMove(req)).toMatchObject({ kind: 'conflict', reason: 'source' });
    const pointer = join(root, 'parent-link'); await symlink(req.source.parent.path, pointer);
    expect(await prepareExclusiveMove({ ...req, source: { ...req.source, parent: { ...req.source.parent, path: pointer } } })).toMatchObject({ kind: 'conflict', reason: 'parent-path' });
  });
  it('preserves a destination raced into place during the durable-intent callback', async () => {
    const req = await fixture('intent-collision');
    expect(await execute(req, async () => { await writeFile(join(req.target.parent.path, 'item'), 'raced foreign'); })).toMatchObject({ kind: 'conflict', reason: 'occupied', mutation: 'none' });
    expect(await readFile(join(req.target.parent.path, 'item'), 'utf8')).toBe('raced foreign');
    expect(await readFile(join(req.source.parent.path, 'item'), 'utf8')).toBe('independent preimage');
  });
  it('re-resolves the final named parent after intent and preserves replacement source', async () => {
    const req = await fixture('parent-race');
    expect(await execute(req, async () => { await rename(req.target.parent.path, `${req.target.parent.path}-old`); await mkdir(req.target.parent.path); })).toMatchObject({ kind: 'conflict', reason: 'helper-or-parent-changed-after-intent', mutation: 'none' });
    expect(await readFile(join(req.source.parent.path, 'item'), 'utf8')).toBe('independent preimage');
    const replaced = await fixture('source-race');
    expect(await execute(replaced, async () => { await rename(join(replaced.source.parent.path, 'item'), join(replaced.source.parent.path, 'original')); await writeFile(join(replaced.source.parent.path, 'item'), 'foreign source'); })).toMatchObject({ kind: 'conflict', reason: 'source', mutation: 'none' });
    expect(await readFile(join(replaced.source.parent.path, 'original'), 'utf8')).toBe('independent preimage');
  });
  it('holds descriptors through intent, is one-shot, and leaves objects untouched on failed intent', async () => {
    const req = await fixture('one-shot'), ready = await prepareExclusiveMove(req);
    expect(ready.kind).toBe('ready'); if (ready.kind !== 'ready') throw new Error('prepare');
    try {
      expect(await ready.execute(async () => { throw new Error('journal failure'); })).toMatchObject({ kind: 'conflict', reason: 'intent-failed', mutation: 'none', child: null });
      await expect(ready.execute(async () => {})).rejects.toThrow('one-shot');
    } finally { await ready.close(); await ready.close(); }
    expect(await readFile(join(req.source.parent.path, 'item'), 'utf8')).toBe('independent preimage');
  });
  it.each([false, true])('preserves a post-retire substitution and uses a new inverse intent only if the live name stays absent (recreated=%s)', async recreated => {
    const req = await fixture(`retire-substitution-${recreated}`), wrapper = join(root, `retire-substitution-${recreated}.c`);
    // Controlled external-actor schedule between native observation and the actual syscall.
    await writeFile(wrapper, `#define renameatx_np raced_move\n#define main placement_main\n#include ${JSON.stringify(sourcePath)}\n#undef main\n#undef renameatx_np\nextern int renameatx_np(int,const char*,int,const char*,unsigned int);\nint raced_move(int s,const char *from,int t,const char *to,unsigned int flags) { if(renameat(s,from,s,"independent-original")) return -1; int fd=openat(s,from,O_CREAT|O_EXCL|O_WRONLY,0600); if(fd<0) return -1; if(write(fd,"foreign raced object",20)!=20) {close(fd);return -1;} close(fd); return renameatx_np(s,from,t,to,flags); }\nint main(int argc,char **argv) { return placement_main(argc,argv); }\n`);
    const raced = await buildDarwinPlacementHelper({ sourcePath: wrapper, outputPath: join(root, `retire-substitution-helper-${recreated}`), arch: 'arm64' });
    const intents: string[] = [], record = async (i: { invocationId: string }) => { intents.push(i.invocationId); };
    const result = await execute({ ...req, helper: raced }, record);
    expect(result).toMatchObject({ kind: 'conflict', reason: 'post-move-identity-or-binding', mutation: 'possible', observation: { sourceAfter: null } });
    if (result.kind !== 'conflict' || !result.observation?.targetAfter || result.observation.targetAfter.kind !== 'file') throw new Error('No supported moved observation');
    expect(await readFile(join(req.source.parent.path, 'independent-original'), 'utf8')).toBe('independent preimage');
    expect(await readFile(join(req.target.parent.path, 'item'), 'utf8')).toBe('foreign raced object');
    if (recreated) await writeFile(join(req.source.parent.path, 'item'), 'recreated live name');
    const moved = result.observation.targetAfter;
    const inverse = { ...req, source: req.target, target: req.source, expectedSource: { device: moved.device, inode: moved.inode, kind: 'file' as const } };
    if (recreated) {
      expect(await prepareExclusiveMove(inverse)).toMatchObject({ kind: 'conflict', reason: 'occupied', mutation: 'none' });
      expect(await readFile(join(req.source.parent.path, 'item'), 'utf8')).toBe('recreated live name');
      expect(await readFile(join(req.target.parent.path, 'item'), 'utf8')).toBe('foreign raced object');
      expect(intents).toHaveLength(1);
    } else {
      expect(await execute(inverse, record)).toMatchObject({ kind: 'observed-move' });
      expect(await readFile(join(req.source.parent.path, 'item'), 'utf8')).toBe('foreign raced object');
      expect(intents).toHaveLength(2); expect(intents[0]).not.toBe(intents[1]);
    }
  });
  it('validates native protocol names, fd numbers and identities before the syscall', async () => {
    const req = await fixture('argv'), fd1 = await open(req.source.parent.path, constants.O_RDONLY | constants.O_DIRECTORY), fd2 = await open(req.target.parent.path, constants.O_RDONLY | constants.O_DIRECTORY);
    const base = ['inspect', '1', '12345678-1234-4234-8234-123456789abc', String(process.pid), '3', '4', 'item', 'item'];
    try {
      const move = ['move', ...base.slice(1), req.source.parent.identity.device, req.source.parent.identity.inode, req.source.parent.identity.volumeUUID, req.target.parent.identity.device, req.target.parent.identity.inode, req.target.parent.identity.volumeUUID, req.expectedSource.device, req.expectedSource.inode, req.expectedSource.kind];
      const cases: string[][] = [];
      for (const [index, value] of [[1, '2'], [4, '-2'], [4, '3junk'], [6, '../item'], [6, 'x\ny']] as const) { const args = [...base]; args[index] = value; cases.push(args); }
      for (const [index, value] of [[8, '18446744073709551616'], [9, '-1'], [10, 'invalid'], [15, '01'], [16, 'symlink']] as const) { const args = [...move]; args[index] = value; cases.push(args); }
      for (const args of cases) {
        const result = await new Promise<string>(res => { const child = spawn(helper.path, args, { stdio: ['ignore', 'pipe', 'ignore', fd1.fd, fd2.fd] }); let body = ''; child.stdout?.on('data', b => { body += String(b); }); child.once('close', () => res(body)); });
        expect(JSON.parse(result)).toMatchObject({ status: 'conflict', reason: 'protocol' });
      }
      const extra = await new Promise<string>(res => { const child = spawn(helper.path, base, { stdio: ['ignore', 'pipe', 'ignore', fd1.fd, fd2.fd, fd1.fd] }); let body = ''; child.stdout?.on('data', b => { body += String(b); }); child.once('close', () => res(body)); });
      expect(JSON.parse(extra)).toMatchObject({ status: 'conflict', reason: 'descriptor' });
    } finally { await fd1.close(); await fd2.close(); }
    expect(await readFile(join(req.source.parent.path, 'item'), 'utf8')).toBe('independent preimage');
  });
  it('reports lost successful output as unknown and preserves the actual moved object', async () => {
    const wrapper = join(root, 'lost-output.c');
    await writeFile(wrapper, `#define main placement_main\n#include ${JSON.stringify(sourcePath)}\n#undef main\nint main(int argc,char **argv) { if(argc>1&&!strcmp(argv[1],"move")) freopen("/dev/null","w",stdout); return placement_main(argc,argv); }\n`);
    const lost = await buildDarwinPlacementHelper({ sourcePath: wrapper, outputPath: join(root, 'lost-output'), arch: 'arm64' });
    const req = await fixture('unknown', 'file', lost);
    expect(await execute(req)).toMatchObject({ kind: 'unknown-result', mutation: 'possible', child: { exited: true, exitCode: 0 } });
    expect(await readFile(join(req.target.parent.path, 'item'), 'utf8')).toBe('independent preimage');
    await expect(lstat(join(req.source.parent.path, 'item'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('returns partial observations when the named final parent changes after movement', async () => {
    const req = await fixture('post-parent-race');
    const wrapper = join(root, 'post-parent.c');
    await writeFile(wrapper, `#define main placement_main\n#include ${JSON.stringify(sourcePath)}\n#undef main\nint main(int argc,char **argv) { int rc=placement_main(argc,argv); if(argc>1&&!strcmp(argv[1],"move")) { rename(${JSON.stringify(req.target.parent.path)},${JSON.stringify(`${req.target.parent.path}-old`)}); mkdir(${JSON.stringify(req.target.parent.path)},0700); } return rc; }\n`);
    const raced = await buildDarwinPlacementHelper({ sourcePath: wrapper, outputPath: join(root, 'post-parent'), arch: 'arm64' });
    expect(await execute({ ...req, helper: raced })).toMatchObject({ kind: 'conflict', reason: 'post-move-identity-or-binding', mutation: 'possible', observation: { sourceAfter: null } });
    expect(await readFile(join(`${req.target.parent.path}-old`, 'item'), 'utf8')).toBe('independent preimage');
  });
  it.skipIf(!process.env.OD_PLACEMENT_OWNER_PROBE)('excludes a held daemon owner descriptor in normal and lost-output helpers', async () => {
    // Reuse the separately qualified F3 NAPI probe; this module does not implement flock.
    interface OwnerProbe { acquire(path: string): { ok: boolean; fd: number }; close(fd: number): unknown; info(fd: number): { dev: number; ino: string }; setCloexec(fd: number, value: boolean): unknown }
    const ownerPath = process.env.OD_PLACEMENT_OWNER_PROBE!;
    const owner = createRequire(import.meta.url)(ownerPath) as OwnerProbe;
    const lock = join(root, 'owner.lock'), held = owner.acquire(lock); expect(held.ok).toBe(true);
    owner.setCloexec(held.fd, false); // Stronger test: spawn must still omit this unrelated fd.
    const info = owner.info(held.fd);
    const contender = async () => JSON.parse((await run(process.execPath, ['-e', 'const a=require(process.argv[1]);const r=a.acquire(process.argv[2]);if(r.ok)a.close(r.fd);process.stdout.write(JSON.stringify(r));', ownerPath, lock])).stdout) as { ok: boolean };
    try {
      for (const lose of ['normal', 'lost-output', 'killed'] as const) {
        const wrapper = join(root, `owner-check-${lose}.c`);
        await writeFile(wrapper, `#define main placement_main\n#include ${JSON.stringify(sourcePath)}\n#undef main\n#include <signal.h>\nint main(int argc,char **argv) { struct stat st; for(int fd=0;fd<256;fd++) if(!fstat(fd,&st)&&(unsigned long long)st.st_dev==${info.dev}ULL&&(unsigned long long)st.st_ino==${info.ino}ULL) return 77; ${lose !== 'normal' ? 'if(argc>1&&!strcmp(argv[1],"move")) freopen("/dev/null","w",stdout);' : ''} int rc=placement_main(argc,argv); ${lose === 'killed' ? 'if(argc>1&&!strcmp(argv[1],"move")) raise(SIGKILL);' : ''} return rc; }\n`);
        const executable = await buildDarwinPlacementHelper({ sourcePath: wrapper, outputPath: join(root, `owner-check-${lose}`), arch: 'arm64' });
        const req = await fixture(`owner-${lose}`, 'file', executable);
        expect(await execute(req)).toMatchObject({ kind: lose === 'normal' ? 'observed-move' : 'unknown-result', child: { exited: true, exitCode: lose === 'killed' ? null : 0, signal: lose === 'killed' ? 'SIGKILL' : null } });
        expect((await contender()).ok).toBe(false);
        expect(await readFile(join(req.target.parent.path, 'item'), 'utf8')).toBe('independent preimage');
      }
    } finally { owner.close(held.fd); }
    expect((await contender()).ok).toBe(true);
  });
  it.skipIf(!process.env.OD_PLACEMENT_UNSUPPORTED_PARENT)('declines an owned unqualified volume and cross-device pair without moving bytes', async () => {
    const req = await fixture('unsupported-volume');
    const foreign = await mkdtemp(join(process.env.OD_PLACEMENT_UNSUPPORTED_PARENT!, 'placement-owned-'));
    await writeFile(join(foreign, 'item'), 'unqualified-volume preimage');
    expect(await inspectPlacementParents({ helper, sourceParentPath: foreign, targetParentPath: foreign })).toMatchObject({ kind: 'unsupported', reason: 'volume', mutation: 'none' });
    expect(await inspectPlacementParents({ helper, sourceParentPath: req.source.parent.path, targetParentPath: foreign })).toMatchObject({ kind: 'unsupported', reason: 'volume', mutation: 'none' });
    expect(await prepareExclusiveMove({ ...req, target: { ...req.target, parent: { ...req.target.parent, path: foreign } } })).toMatchObject({ kind: 'unsupported', reason: 'volume', mutation: 'none' });
    expect(await readFile(join(foreign, 'item'), 'utf8')).toBe('unqualified-volume preimage');
    expect(await readFile(join(req.source.parent.path, 'item'), 'utf8')).toBe('independent preimage');
  });
  it('compiles Intel without admitting that unqualified runtime', async () => {
    const receipt = await buildDarwinPlacementHelper({ sourcePath, outputPath: join(root, 'intel-helper'), arch: 'x86_64' });
    expect(receipt.arch).toBe('x86_64'); expect(receipt.activation).toBe('inactive');
    expect((await run('/usr/bin/lipo', ['-archs', receipt.path])).stdout.trim()).toBe('x86_64');
  });
});
