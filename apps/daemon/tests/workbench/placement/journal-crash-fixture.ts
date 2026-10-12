import Database from 'better-sqlite3';
import path from 'node:path';

// Node 24 executes the actual erasable-TypeScript source in an owned child.
const { PlacementJournal, migratePlacementJournal } = await import(new URL('../../../src/workbench/placement/journal.ts', import.meta.url).href);
const [databaseFile, root] = process.argv.slice(2);
if (!databaseFile || !root) throw new Error('Owned fixture arguments required');
const db = new Database(databaseFile);
db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
migratePlacementJournal(db);
const journal = new PlacementJournal({ db, incarnationId: 'crashing-process' });
const digest = 'a'.repeat(64);
journal.createOperation({ operationId: 'crashed', principalId: 'principal', projectId: 'project', projectRoot: path.join(root, 'project'), kind: 'apply', idempotencyKey: 'crash-key', inputDigest: digest, planDigest: digest,
  movements: [{ movementId: 'publish', kind: 'publish', source: path.join(root, 'staged'), destination: path.join(root, 'project', 'entry.tsx'), expectedSource: { device: '1', inode: '2', sha256: digest, byteLength: 3 }, snapshot: { snapshotId: 'after', sha256: digest, byteLength: 3 } }] });
journal.startOperation('crashed', 0);
journal.recordMovementIntent('crashed', 1, 'publish');
journal.recordLaunchIntent({ launchId: 'unobserved-helper', kind: 'helper', operationId: 'crashed', projectRoots: [path.join(root, 'project')], intentDigest: digest });
await new Promise<void>((resolve, reject) => process.stdout.write('durable-intents-committed\n', error => error ? reject(error) : resolve()));
process.kill(process.pid, 'SIGKILL');
