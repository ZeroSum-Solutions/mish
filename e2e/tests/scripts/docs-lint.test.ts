// Behavior contract for scripts/docs-lint.mjs (`pnpm docs:lint`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'vitest';

const LINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/docs-lint.mjs');
const FENCE = '```';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

/** A throwaway repo root with a package.json that has only the `docs:lint` and `guard` scripts. */
function fixture(files: Record<string, string>): string {
  root = mkdtempSync(path.join(tmpdir(), 'docs-lint-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'docs:lint': 'x', guard: 'x' } }));
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'scripts', 'real.mjs'), '');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}

type Finding = { file: string; check: string; line: number | null; message: string };

function lint(args: string[] = []): { code: number | null; findings: Finding[]; stderr: string } {
  const result = spawnSync(process.execPath, [LINT, '--root', root, '--json', ...args], { encoding: 'utf8' });
  const findings: Finding[] = result.stdout ? JSON.parse(result.stdout).findings : [];
  return { code: result.status, findings, stderr: result.stderr };
}

const shell = (...lines: string[]): string => `# Doc\n\n${FENCE}sh\n${lines.join('\n')}\n${FENCE}\n`;

test('a clean fixture exits 0', () => {
  fixture({ 'README.md': shell('pnpm install', 'mise exec -- pnpm docs:lint', 'node scripts/real.mjs', 'pnpm --filter @x/y build') });
  const { code, findings } = lint();
  assert.deepEqual(findings, []);
  assert.equal(code, 0);
});

test('a bad script on a later line of the fence exits 1', () => {
  fixture({ 'README.md': shell('pnpm install', 'pnpm docs:lint', 'pnpm nope') });
  const { code, findings } = lint();
  assert.equal(code, 1);
  assert.deepEqual(findings.map((f) => [f.check, f.line]), [['unknown-pnpm-script', 6]]);
});

test('mise exec, env assignments, && chains and run forms are all checked', () => {
  fixture({
    'README.md': shell(
      'mise exec -- pnpm docs:lnt',
      'cd app && FOO=1 pnpm run missing-script',
      'pnpm guard; pnpm also-missing',
    ),
  });
  const { code, findings } = lint();
  assert.equal(code, 1);
  assert.deepEqual(findings.map((f) => f.message.match(/"([^"]+)" is not a script/)?.[1]), ['docs:lnt', 'missing-script', 'also-missing']);
});

test('a missing scripts/ file of any script extension exits 1', () => {
  fixture({ 'README.md': shell('node scripts/missing.mjs', 'node --experimental-strip-types scripts/gone.ts --check', 'bash ./scripts/none.sh') });
  const { code, findings } = lint();
  assert.equal(code, 1);
  assert.equal(findings.filter((f) => f.check === 'unknown-script-file').length, 3);
});

test('a continued command is checked as one command', () => {
  fixture({ 'README.md': shell('mise exec -- \\', '  pnpm missing') });
  assert.equal(lint().code, 1);
});

test('the default set covers docs/*.md, docs/evals/*.md and evals/genui/README.md', () => {
  fixture({
    'README.md': '# Readme\n',
    'docs/guide.md': '# Guide\n\n[gone](nowhere.md)\n',
    'docs/evals/report.md': shell('pnpm missing'),
    'evals/genui/README.md': '# Evals\n\nMish\n',
  });
  const { code, findings } = lint();
  assert.equal(code, 1);
  assert.deepEqual(findings.map((f) => [f.file, f.check]).sort(), [
    ['docs/evals/report.md', 'unknown-pnpm-script'],
    ['docs/guide.md', 'broken-link'],
    ['evals/genui/README.md', 'old-name-mention'],
  ]);
});

test('a --require target that is not linted positionally still gets every check', () => {
  fixture({ 'README.md': '# Readme\n', 'docs/other.md': '# Other\n\n[gone](nowhere.md)\n' });
  const { code, findings } = lint(['README.md', '--require', 'docs/other.md:Other']);
  assert.equal(code, 1);
  assert.deepEqual(findings.map((f) => f.check), ['broken-link']);
});

test('a missing required heading exits 1', () => {
  fixture({ 'README.md': '# Readme\n' });
  assert.equal(lint(['--require', 'README.md:Team setup']).code, 1);
});
