// Child process for lock tests: take the lock in argv[2], hold it argv[3] ms, print the interval.
import { acquireRunLock } from '../../src/lock.ts';

const [, , dir, holdMs] = process.argv;
const release = await acquireRunLock('cerebras', { dir, pollMs: 5 });
const start = Date.now();
await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
const end = Date.now();
release();
console.log(JSON.stringify({ pid: process.pid, start, end }));
