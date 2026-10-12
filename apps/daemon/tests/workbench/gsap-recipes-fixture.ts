import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PlacementAdoptionExecutor } from '../../src/workbench/placement/adoption-executor.js';
import { AdoptionBlobStore } from '../../src/workbench/placement/adoption-files.js';
import type { AdoptionMover } from '../../src/workbench/placement/adoption-mover.js';
import { AdoptionStore, migratePlacementAdoption } from '../../src/workbench/placement/adoption-store.js';
import { migratePlacementJournal, PlacementJournal } from '../../src/workbench/placement/journal.js';
import { createFenceOnlyProjectWrites } from '../../src/workbench/placement/project-writes.js';

/** Project trees for the GSAP recipe chain: two React projects, an HTML-only site, a Vue app and a React app without GSAP. */
export const REACT_MANIFEST = { dependencies: { react: '18.3.1', 'react-dom': '18.3.1', gsap: '^3.15.0', '@gsap/react': '^2.1.2' }, devDependencies: { typescript: '5.9.3', vite: '7.3.3' } };
export const REACT_ENTRY = 'export default function App() {\n  return <main>original</main>;\n}\n';
export const HTML_ENTRY = '<!doctype html>\n<html lang="en"><head><title>Site</title></head><body><main>Booking</main></body></html>\n';
export const PROJECTS = {
  react1: { 'package.json': JSON.stringify(REACT_MANIFEST), 'src/App.tsx': REACT_ENTRY },
  react2: { 'package.json': JSON.stringify(REACT_MANIFEST), 'src/App.tsx': REACT_ENTRY },
  html: { 'index.html': HTML_ENTRY },
  vue: { 'package.json': JSON.stringify({ dependencies: { vue: '^3.5.0', gsap: '^3.15.0' } }), 'src/App.tsx': REACT_ENTRY },
  nogsap: { 'package.json': JSON.stringify({ dependencies: { react: '18.3.1', 'react-dom': '18.3.1' }, devDependencies: { typescript: '5.9.3' } }), 'src/App.tsx': REACT_ENTRY },
  // W2: the nearest package.json from the target directory decides, bounded by the project root.
  mono: { 'package.json': JSON.stringify({ private: true, devDependencies: { prettier: '3.0.0' } }), 'app/package.json': JSON.stringify(REACT_MANIFEST), 'app/src/App.tsx': REACT_ENTRY },
  monovue: { 'package.json': JSON.stringify(REACT_MANIFEST), 'site/package.json': JSON.stringify({ dependencies: { vue: '^3.5.0', gsap: '^3.15.0' } }), 'site/src/App.tsx': REACT_ENTRY },
  react19: { 'package.json': JSON.stringify({ dependencies: { ...REACT_MANIFEST.dependencies, react: '19.1.0', 'react-dom': '19.1.0' }, devDependencies: REACT_MANIFEST.devDependencies }), 'src/App.tsx': REACT_ENTRY },
  react17: { 'package.json': JSON.stringify({ dependencies: { ...REACT_MANIFEST.dependencies, react: '17.0.2', 'react-dom': '17.0.2' }, devDependencies: REACT_MANIFEST.devDependencies }), 'src/App.tsx': REACT_ENTRY },
  jsreact: { 'package.json': JSON.stringify({ dependencies: { react: '18.3.1', 'react-dom': '18.3.1', gsap: '^3.15.0', '@gsap/react': '^2.1.2' } }), 'src/App.tsx': REACT_ENTRY },
  // Sol B5/6 BLOCK: a range that spans majors is decided by the installed React, not the range's leading digits.
  rangereact19: { 'package.json': JSON.stringify({ dependencies: { ...REACT_MANIFEST.dependencies, react: '>=18.0.0', 'react-dom': '>=18.0.0' }, devDependencies: REACT_MANIFEST.devDependencies }), 'src/App.tsx': REACT_ENTRY },
  // Declares React 18 but has nothing installed: the resolved version is unknown.
  uninstalled: { 'package.json': JSON.stringify(REACT_MANIFEST), 'src/App.tsx': REACT_ENTRY },
  // node_modules/react is a symlink to a package outside the project root.
  escape: { 'package.json': JSON.stringify(REACT_MANIFEST), 'src/App.tsx': REACT_ENTRY },
  // Sol B5/6 WARN: gsap ^3.0.0 is the same major as the recipe's ^3.15.0 but allows (and here has) an older GSAP.
  oldgsap: { 'package.json': JSON.stringify({ dependencies: { ...REACT_MANIFEST.dependencies, gsap: '^3.0.0' }, devDependencies: REACT_MANIFEST.devDependencies }), 'src/App.tsx': REACT_ENTRY },
  loosegsap: { 'package.json': JSON.stringify({ dependencies: { ...REACT_MANIFEST.dependencies, gsap: '^3.0.0' }, devDependencies: REACT_MANIFEST.devDependencies }), 'src/App.tsx': REACT_ENTRY },
} as const;
export type FixtureProject = keyof typeof PROJECTS;

const REACT18_INSTALL = { react: '18.3.1', 'react-dom': '18.3.1', gsap: '3.15.0', '@gsap/react': '2.1.2' };
/**
 * Installed packages (`node_modules/<name>/package.json`) per project, keyed by
 * the directory that holds node_modules ('' is the project root). `mono` and
 * `monovue` hoist to the root, as a workspace install does.
 */
export const INSTALLED: Partial<Record<FixtureProject, Record<string, Record<string, string>>>> = {
  react1: { '': REACT18_INSTALL }, react2: { '': REACT18_INSTALL }, mono: { '': REACT18_INSTALL }, monovue: { '': REACT18_INSTALL },
  nogsap: { '': { react: '18.3.1', 'react-dom': '18.3.1' } }, jsreact: { '': REACT18_INSTALL },
  react19: { '': { ...REACT18_INSTALL, react: '19.1.0', 'react-dom': '19.1.0' } }, react17: { '': { ...REACT18_INSTALL, react: '17.0.2', 'react-dom': '17.0.2' } },
  rangereact19: { '': { ...REACT18_INSTALL, react: '19.1.0', 'react-dom': '19.1.0' } },
  escape: { '': { 'react-dom': '18.3.1', gsap: '3.15.0', '@gsap/react': '2.1.2' } },
  oldgsap: { '': { ...REACT18_INSTALL, gsap: '3.12.5' } }, loosegsap: { '': REACT18_INSTALL },
};
function install(dir: string, name: string, version: string): void {
  mkdirSync(join(dir, 'node_modules', ...name.split('/')), { recursive: true });
  writeFileSync(join(dir, 'node_modules', ...name.split('/'), 'package.json'), JSON.stringify({ name, version }));
}

/** The F5 executor over a portable test-double mover (the native move is proved by placement-adoption.test.ts). */
export function adoptionFixture<P extends string = FixtureProject>(
  roots: string[],
  trees: Readonly<Record<P, Readonly<Record<string, string>>>> = PROJECTS as unknown as Record<P, Record<string, string>>,
  installed: Partial<Record<P, Record<string, Record<string, string>>>> = INSTALLED as unknown as Partial<Record<P, Record<string, Record<string, string>>>>,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gsap-recipes-'))); roots.push(root);
  const projects = {} as Record<P, string>;
  for (const [id, files] of Object.entries(trees) as [P, Record<string, string>][]) {
    const project = join(root, 'projects', id); projects[id] = project;
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(project, path, '..'), { recursive: true });
      writeFileSync(join(project, path), content);
    }
  }
  for (const [id, dirs] of Object.entries(installed) as [P, Record<string, Record<string, string>>][]) {
    for (const [dir, packages] of Object.entries(dirs)) for (const [name, version] of Object.entries(packages)) install(join(projects[id], dir), name, version);
  }
  // `escape`: node_modules/react resolves outside the project root.
  const escape = (projects as Record<string, string>).escape;
  if (escape) {
    install(join(root, 'outside'), 'react', '18.3.1');
    symlinkSync(join(root, 'outside', 'node_modules', 'react'), join(escape, 'node_modules', 'react'), 'dir');
  }
  const db = new Database(join(root, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
  migratePlacementJournal(db); migratePlacementAdoption(db);
  const identity = { device: '1', inode: '2', volumeUUID: '11111111-2222-3333-4444-555555555555' };
  const mover: AdoptionMover = {
    inspectDirectory: async (dir: string) => existsSync(dir) && lstatSync(dir).isDirectory() ? { kind: 'qualified', identity } : { kind: 'unsupported', reason: 'missing' } as never,
    prepare: async ({ source, destination, expected }) => ({ kind: 'ready', move: {
      execute: async intent => {
        await intent();
        if (String(lstatSync(source, { bigint: true }).ino) !== expected.inode) return { kind: 'conflict', invocationId: randomUUID(), reason: 'source', mutation: 'none', observation: null, child: null };
        renameSync(source, destination);
        return { kind: 'observed-move', invocationId: randomUUID(), observation: {} as never, child: { pid: null, exited: true, exitCode: 0, signal: null }, contentVerification: 'required' };
      },
      close: async () => undefined,
    } }),
  };
  const executor = new PlacementAdoptionExecutor({
    journal: new PlacementJournal({ db, incarnationId: `incarnation-${randomUUID()}` }), store: new AdoptionStore(db),
    blobs: new AdoptionBlobStore(join(root, 'work', 'blobs')), mover, workRoot: join(root, 'work'), managedRoot: join(root, 'projects'),
    projectWrites: createFenceOnlyProjectWrites({ assertMutationAdmissible: () => undefined }),
    resolveTarget: projectId => ({ projectId, kind: 'managed', physicalRoot: projects[projectId as P]!, identity: null, gateKey: projectId }),
  });
  const tree = (id: P) => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { if (name === 'node_modules') continue; const full = join(dir, name); if (lstatSync(full).isDirectory()) walk(full); else out[relative(projects[id], full)] = readFileSync(full, 'utf8'); } };
    walk(projects[id]); return out;
  };
  const storedPlans = () => (db.prepare('SELECT COUNT(*) AS n FROM placement_adoption_plans').get() as { n: number }).n;
  return { root, projects, executor, tree, storedPlans, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
