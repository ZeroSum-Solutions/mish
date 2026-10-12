import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { constants, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDarwinPlacementOwner } from '../../../src/workbench/placement/owner-build.js';
import { acquireNativePlacementOwner, OWNER_FILE_NAME, type NativePlacementOwner } from '../../../src/workbench/placement/owner-binding.js';
import { buildDarwinPlacementHelper } from '../../../src/workbench/placement/build.js';
import { inspectPlacementParents, prepareExclusiveMove } from '../../../src/workbench/placement/driver.js';
const run = promisify(execFile);
const supported = process.platform === 'darwin' && process.arch === 'arm64' && release() === '25.5.0' && process.versions.node === '24.16.0';
const nodeIncludeDir = resolve(dirname(process.execPath), '../include/node');
const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/workbench/placement/owner-native.c');
describe.skipIf(!supported)('actual inactive daemon-held native owner', () => {
  let root: string, binding: { path: string; sha256: string };
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(process.env.OD_PLACEMENT_TEST_EVIDENCE ?? tmpdir(), 'native-owner-')));
    binding = await buildDarwinPlacementOwner({ sourcePath, outputPath: join(root, 'owner.node'), nodeIncludeDir, arch: 'arm64' });
    await writeFile(join(root, 'build.json'), JSON.stringify(binding));
  });
  async function fixture(name: string) { const path = join(root, name); await mkdir(path, { mode: 0o700 }); return path; }
  function acquire(path: string): NativePlacementOwner {
    const result = acquireNativePlacementOwner({ binding, canonicalDataRoot: path });
    expect(result.kind).toBe('held'); if (result.kind !== 'held') throw new Error(JSON.stringify(result)); return result.owner;
  }
  async function contender(path: string) {
    const code = `const a=require(process.argv[1]);const r=a.acquire(process.argv[2]);if(r.owner)r.owner.close();process.stdout.write(JSON.stringify({status:r.status,reason:r.reason}));`;
    return JSON.parse((await run(process.execPath, ['-e', code, binding.path, path], { env: {} })).stdout) as { status: string; reason: string };
  }
  it('holds a real lock without exporting an FD and explicit close preserves the inode', async () => {
    const path = await fixture('normal'), owner = acquire(path), inode = await lstat(join(path, OWNER_FILE_NAME), { bigint: true });
    const inspect = owner.inspect; expect(inspect()).toMatchObject({ held: true, qualified: true, reason: 'none' });
    expect(Object.getOwnPropertyNames(owner).sort()).toEqual(['canonicalDataRoot', 'close', 'inspect']);
    expect(await contender(path)).toEqual({ status: 'busy', reason: 'contended' });
    expect(acquireNativePlacementOwner({ binding, canonicalDataRoot: path })).toMatchObject({ kind: 'busy' });
    const close = owner.close; close(); close();
    expect(inspect()).toMatchObject({ held: false, qualified: false, reason: 'closed' });
    expect((await lstat(join(path, OWNER_FILE_NAME), { bigint: true })).ino).toBe(inode.ino);
    expect((await contender(path)).status).toBe('owned');
  });
  it.each(['root', 'owner'] as const)('latches unqualified after actual %s replacement while the old inode remains held', async kind => {
    const path = await fixture(`replacement-${kind}`), owner = acquire(path), original = owner.inspect();
    try {
      if (kind === 'root') { await rename(path, `${path}-original`); await mkdir(path, { mode: 0o700 }); }
      else { await rename(join(path, OWNER_FILE_NAME), join(path, 'original-owner')); await writeFile(join(path, OWNER_FILE_NAME), '', { mode: 0o600 }); }
      expect(owner.inspect()).toMatchObject({ held: true, qualified: false });
      if (kind === 'root') { await rename(path, `${path}-replacement`); await rename(`${path}-original`, path); }
      else { await rename(join(path, OWNER_FILE_NAME), join(path, 'replacement-owner')); await rename(join(path, 'original-owner'), join(path, OWNER_FILE_NAME)); }
      expect(owner.inspect()).toMatchObject({ held: true, qualified: false, reason: 'tainted', ownerIdentity: original.ownerIdentity });
      expect((await contender(path)).status).toBe('busy');
    } finally { owner.close(); }
    expect((await contender(path)).status).toBe('owned');
  });
  it.each(['root-mode', 'owner-mode', 'owner-link'] as const)('declines unsafe %s both before and after acquisition', async fault => {
    const path = await fixture(`unsafe-${fault}`), owner = acquire(path);
    try {
      if (fault === 'root-mode') await chmod(path, 0o755);
      else if (fault === 'owner-mode') await chmod(join(path, OWNER_FILE_NAME), 0o644);
      else await link(join(path, OWNER_FILE_NAME), join(path, 'owner-alias'));
      expect(owner.inspect()).toMatchObject({ held: true, qualified: false });
      expect(acquireNativePlacementOwner({ binding, canonicalDataRoot: path }).kind).toBe('conflict');
    } finally { owner.close(); }
  });
  it.each(['root', 'owner'] as const)('rejects actual allow ACL on %s before and after acquisition without changing it', async target => {
    const path = await fixture(`acl-${target}`), owner = acquire(path), aclPath = target === 'root' ? path : join(path, OWNER_FILE_NAME);
    try {
      await run('/bin/chmod', ['+a', target === 'root' ? 'everyone allow add_file,delete_child' : 'everyone allow read,write', aclPath]);
      expect(owner.inspect()).toMatchObject({ held: true, qualified: false, errno: constants.errno.EACCES });
      expect(acquireNativePlacementOwner({ binding, canonicalDataRoot: path })).toMatchObject({kind:'conflict',errno:constants.errno.EACCES});
      expect((await run('/bin/ls', ['-lde', aclPath])).stdout).toContain('allow');
    } finally { owner.close(); }
  });
  it('admits deny-only ACLs without replacing them', async () => {
    const path = await fixture('deny-acl'); await run('/bin/chmod', ['+a', 'everyone deny delete', path]);
    const owner=acquire(path); try { expect(owner.inspect()).toMatchObject({ held: true, qualified: true }); } finally { owner.close(); }
    expect((await run('/bin/ls', ['-lde', path])).stdout).toContain('deny delete');
  });
  it('refuses symlink parents and existing symlink owner names without changing either', async () => {
    const path = await fixture('symlinks'), alias = join(root, 'root-alias'); await symlink(path, alias);
    expect(acquireNativePlacementOwner({ binding, canonicalDataRoot: alias }).kind).toBe('conflict');
    await symlink('/nonexistent-owned-fixture', join(path, OWNER_FILE_NAME));
    expect(acquireNativePlacementOwner({ binding, canonicalDataRoot: path }).kind).toBe('conflict');
    expect((await lstat(join(path, OWNER_FILE_NAME))).isSymbolicLink()).toBe(true);
  });
  it('detects actual descriptor loss and does not close a reused foreign descriptor', async () => {
    const path = await fixture('descriptor-loss'), owner = acquire(path), inode = await lstat(join(path, OWNER_FILE_NAME), { bigint: true });
    let found = -1;
    // Test-only discovery; the binding exports no FD and the object is owned by this fixture.
    for (let fd = 3; fd < 256; fd++) { try { const st = fstatSync(fd, { bigint: true }); if (st.dev === inode.dev && st.ino === inode.ino) { found = fd; break; } } catch {} }
    expect(found).toBeGreaterThanOrEqual(3); closeSync(found);
    const foreignPath = join(path, 'foreign'); await writeFile(foreignPath, 'preserve foreign');
    const foreign = openSync(foreignPath, 'r');
    expect(foreign).toBe(found);
    try { expect(owner.inspect()).toMatchObject({ held: false, qualified: false }); owner.close(); expect(fstatSync(foreign).isFile()).toBe(true); }
    finally { closeSync(foreign); owner.close(); }
    expect(await readFile(foreignPath, 'utf8')).toBe('preserve foreign'); expect((await contender(path)).status).toBe('owned');
  });
  it('keeps the owner contended after normal F2 movement helpers exit', async () => {
    const path = await fixture('movement'), owner = acquire(path);
    const source = join(path, 'source'), retained = join(path, 'retained'); await mkdir(source); await mkdir(retained); await writeFile(join(source, 'item'), 'independent preimage');
    const helper = await buildDarwinPlacementHelper({ sourcePath: resolve(dirname(sourcePath), 'native.c'), outputPath: join(root, 'move-helper'), arch: 'arm64' });
    try {
      const parents = await inspectPlacementParents({ helper, sourceParentPath: source, targetParentPath: retained }); if (parents.kind !== 'qualified') throw new Error(JSON.stringify(parents));
      const st = await lstat(join(source, 'item'), { bigint: true });
      const ready = await prepareExclusiveMove({ helper, source: { parent: { path: source, identity: parents.sourceParent }, name: 'item' }, target: { parent: { path: retained, identity: parents.targetParent }, name: 'item' }, expectedSource: { device: st.dev.toString(), inode: st.ino.toString(), kind: 'file' } }); if (ready.kind !== 'ready') throw new Error(JSON.stringify(ready));
      try { expect((await ready.execute(async () => {})).kind).toBe('observed-move'); } finally { await ready.close(); }
      expect(owner.inspect()).toMatchObject({ held: true, qualified: true }); expect((await contender(path)).status).toBe('busy'); expect(await readFile(join(retained, 'item'), 'utf8')).toBe('independent preimage');
    } finally { owner.close(); }
    expect((await contender(path)).status).toBe('owned');
  });
  it('rejects a mismatched native method receiver without inspecting or closing another owner', async () => {
    interface Handle { inspect(): { held: boolean; qualified: boolean }; close(): void }
    const native = createRequire(import.meta.url)(binding.path) as { acquire(root: string): { owner: Handle } };
    const a = native.acquire(await fixture('receiver-a')).owner, b = native.acquire(await fixture('receiver-b')).owner;
    try {
      expect(a.inspect.call(b)).toMatchObject({ held: false, qualified: false });
      a.close.call(b); expect(a.inspect().held).toBe(true); expect(b.inspect().held).toBe(true);
    } finally { a.close(); b.close(); }
  });
  it('does not release ownership when the native wrapper is garbage collected', async () => {
    const path = await fixture('gc-retention');
    const code = `const a=require(process.argv[1]);let r=a.acquire(process.argv[2]);if(r.status!=="owned")throw Error(r.status);r=null;for(let i=0;i<8;i++)global.gc();const contender=a.acquire(process.argv[2]);process.stdout.write(JSON.stringify({status:contender.status}));`;
    const observed = JSON.parse((await run(process.execPath, ['--expose-gc', '-e', code, binding.path, path], { env: {} })).stdout) as { status: string };
    expect(observed.status).toBe('busy'); expect((await contender(path)).status).toBe('owned');
  });
  it('does not claim release on a refused native close, and explicit retry releases the owned inode', async () => {
    const path = await fixture('close-failure'), wrapper = join(root, 'close-refusal.c');
    await writeFile(wrapper, `#define close controlled_close\n#include ${JSON.stringify(sourcePath)}\n#undef close\nextern int close(int);\nstatic int refuse_once=1;\nint controlled_close(int fd) { struct stat st; if(refuse_once&&!fstat(fd,&st)&&S_ISREG(st.st_mode)) {refuse_once=0;errno=EINTR;return -1;} return close(fd); }\n`);
    const refusing = await buildDarwinPlacementOwner({ sourcePath: wrapper, outputPath: join(root, 'close-refusal.node'), nodeIncludeDir, arch: 'arm64' });
    const result = acquireNativePlacementOwner({ binding: refusing, canonicalDataRoot: path }); if(result.kind !== 'held') throw new Error(JSON.stringify(result));
    const owner=result.owner;
    try { owner.close(); expect(owner.inspect()).toMatchObject({ held: true, qualified: false }); expect((await contender(path)).status).toBe('busy'); owner.close(); expect(owner.inspect()).toMatchObject({ held: false, qualified: false }); }
    finally { owner.close(); }
    expect((await contender(path)).status).toBe('owned');
  });
  it('tracks a refused close after acquisition loses qualification and reports close uncertainty', async () => {
    const path = await fixture('factory-close-failure'), wrapper=join(root,'factory-close.c');
    await writeFile(wrapper, `#define close controlled_close\n#define flock controlled_flock\n#include ${JSON.stringify(sourcePath)}\n#undef close\n#undef flock\nextern int close(int);extern int flock(int,int);static int refuse_once=1;\nint controlled_close(int fd) {struct stat st;if(refuse_once&&!fstat(fd,&st)&&S_ISREG(st.st_mode)){refuse_once=0;errno=EINTR;return -1;}return close(fd);}\nint controlled_flock(int fd,int flags){int rc=flock(fd,flags);if(!rc)chmod(${JSON.stringify(path)},0755);return rc;}\n`);
    const failed=await buildDarwinPlacementOwner({sourcePath:wrapper,outputPath:join(root,'factory-close.node'),nodeIncludeDir,arch:'arm64'});
    const code=`const fs=require('node:fs');const a=require(process.argv[1]);const r=a.acquire(process.argv[3]);fs.chmodSync(process.argv[3],0o700);const b=require(process.argv[2]);const c=b.acquire(process.argv[3]);if(c.owner)c.owner.close();process.stdout.write(JSON.stringify({reason:r.reason,contender:c.status}));`;
    expect(JSON.parse((await run(process.execPath,['-e',code,failed.path,binding.path,path],{env:{}})).stdout)).toEqual({reason:'close-uncertain',contender:'busy'});
    expect((await contender(path)).status).toBe('owned');
  });
  it('reports the close errno when TypeScript initial inspection declines and cleanup remains held', async () => {
    const path=await fixture('initial-close-failure'),wrapper=join(root,'initial-close.c');
    await writeFile(wrapper,`#define open controlled_open\n#define close controlled_close\n#include ${JSON.stringify(sourcePath)}\n#undef open\n#undef close\nextern int open(const char *,int,...);extern int close(int);static int calls=0,refuse_once=1;\nint controlled_open(const char *path,int flags,...){if(++calls==3){errno=EMFILE;return -1;}return open(path,flags);}\nint controlled_close(int fd){struct stat st;if(refuse_once&&!fstat(fd,&st)&&S_ISREG(st.st_mode)){refuse_once=0;errno=EINTR;return -1;}return close(fd);}`);
    const fault=await buildDarwinPlacementOwner({sourcePath:wrapper,outputPath:join(root,'initial-close.node'),nodeIncludeDir,arch:'arm64'});
    expect(acquireNativePlacementOwner({binding:fault,canonicalDataRoot:path})).toMatchObject({kind:'conflict',reason:'close-uncertain',errno:constants.errno.EINTR});
    expect((await contender(path)).status).toBe('busy');
    // This deliberately retained failed-close owner remains in native state until environment exit.
  });
  it('sets private mode only on its newly created inode despite a restrictive umask', async () => {
    const path=await fixture('umask');
    const code=`const fs=require('node:fs');process.umask(0o777);const a=require(process.argv[1]);const r=a.acquire(process.argv[2]);if(r.owner)r.owner.close();process.stdout.write(JSON.stringify({status:r.status,mode:fs.statSync(process.argv[2]+'/'+process.argv[3]).mode&0o777}));`;
    expect(JSON.parse((await run(process.execPath,['-e',code,binding.path,path,OWNER_FILE_NAME],{env:{}})).stdout)).toEqual({status:'owned',mode:0o600});
  });
  it.each(['root', 'owner'] as const)('preserves errno and held state when %s observation becomes unavailable', async target => {
    const path=await fixture(`observation-${target}`), wrapper=join(root,`observation-${target}.c`);
    const injected=target==='root'
      ? `#define open controlled_open\n#include ${JSON.stringify(sourcePath)}\n#undef open\nextern int open(const char *,int,...);static int calls=0;\nint controlled_open(const char *path,int flags,...){if(++calls==4){errno=EMFILE;return -1;}return open(path,flags);}`
      : `#define fstatat controlled_fstatat\n#include ${JSON.stringify(sourcePath)}\n#undef fstatat\nextern int fstatat(int,const char *,struct stat *,int);static int calls=0;\nint controlled_fstatat(int fd,const char *path,struct stat *st,int flags){if(++calls==3){errno=EIO;return -1;}return fstatat(fd,path,st,flags);}`;
    await writeFile(wrapper,injected);
    const fault=await buildDarwinPlacementOwner({sourcePath:wrapper,outputPath:join(root,`observation-${target}.node`),nodeIncludeDir,arch:'arm64'});
    const result=acquireNativePlacementOwner({binding:fault,canonicalDataRoot:path});if(result.kind!=='held')throw new Error(JSON.stringify(result));
    try {expect(result.owner.inspect()).toMatchObject({held:true,qualified:false,reason:`${target}-unavailable`,errno:target==='root'?constants.errno.EMFILE:constants.errno.EIO});expect((await contender(path)).status).toBe('busy');}
    finally {result.owner.close();}
  });
  it('compiles an Intel binding without executing or admitting it', async () => {
    const receipt = await buildDarwinPlacementOwner({ sourcePath, outputPath: join(root, 'owner-intel.node'), nodeIncludeDir, arch: 'x86_64' });
    expect(receipt.activation).toBe('inactive'); expect((await run('/usr/bin/lipo', ['-archs', receipt.path])).stdout.trim()).toBe('x86_64');
    expect(acquireNativePlacementOwner({ binding: receipt, canonicalDataRoot: await fixture('intel-refusal') }).kind).toBe('unsupported');
  });
});
