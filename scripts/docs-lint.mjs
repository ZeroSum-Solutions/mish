#!/usr/bin/env node
/**
 * docs-lint.mjs — criterion C12. Checks the given markdown files (default: the prose set —
 * README.md, CONTEXT.md, QUICKSTART.md, CONTRIBUTING.md, docs/*.md, docs/evals/*.md and
 * evals/genui/README.md, each only when it exists) for:
 *
 *   (a) relative links (inline `[text](target)` form) to files that do not exist on disk.
 *       Reference-style links are not checked.
 *   (b) every simple command form (not a full shell parse) in a ```bash``` / ```sh``` / ```shell``` / ```zsh``` fence (joined across
 *       `\` continuations, split on `&&`, `||`, `;` and `|`, with leading `VAR=value`,
 *       `mise exec --` and `env` stripped) that names a repo script which does not exist: a root
 *       `pnpm run <script>` / `pnpm <script>` missing from `package.json` `scripts`, or a
 *       `scripts/<name>.{ts,mjs,js,sh}` path missing from disk.
 *   (c) the retired upstream product name (any spacing / case) in any file NOT on the legal-notice allowlist
 *       (`docs/FORK-PIN.md`, `NOTICE`, `LICENSE`, `docs/legal/*`, `docs/rebrand-audit-*`) — this repo is a fork that
 *       renamed itself, and every non-legal doc mentioning the old name by name is drift.
 *   (d) required headings: repeatable `--require "file:Heading"` — the named file must contain
 *       an ATX heading (`#`..`######`) whose text, after stripping the leading `#`s and
 *       surrounding whitespace, is exactly `Heading`.
 *
 * Usage:
 *   node docs-lint.mjs [file ...] [--root <repoRoot>] [--require "file:Heading"]... [--json]
 *
 * With no positional files, lints the default set above. `--require` targets get checks
 * (a)-(c) too, not only the heading check. `--root` is the repo root that
 * relative links, `scripts/*.ts` and `package.json` are resolved against (default: one
 * directory up from this script's own location, i.e. `<repoRoot>/scripts/docs-lint.mjs`; falls
 * back to `process.cwd()` if that guess doesn't contain a `package.json`).
 *
 * Exit 0 when every check is clean. Exit 1 with every finding printed (one per line, grouped by
 * file) when anything is found. Exit 2 on a usage error (e.g. a named file does not exist, or a
 * `--require` value isn't `file:Heading`).
 *
 * Node built-ins only.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_TOP_LEVEL = ['README.md', 'CONTEXT.md', 'QUICKSTART.md', 'CONTRIBUTING.md', 'evals/genui/README.md'];
const DEFAULT_DIRS = ['docs', 'docs/evals'];

/** The default prose set under `root`: the top-level files that exist plus every `*.md` directly
 * inside each default directory, sorted for a stable report. */
function defaultFiles(root) {
  const out = DEFAULT_TOP_LEVEL.filter((f) => existsSync(path.join(root, f)));
  for (const dir of DEFAULT_DIRS) {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) out.push(`${dir}/${entry.name}`);
    }
  }
  return [...new Set(out)].sort();
}

// Files (relative to --root) allowed to name the retired upstream product — this repo's own
// legal/fork-provenance notices, and the rebrand audit that lists the identifiers the rename
// kept on purpose, where the old name is the whole point of the file.
const LEGAL_ALLOWLIST_EXACT = new Set(['docs/FORK-PIN.md', 'NOTICE', 'LICENSE']);
const LEGAL_ALLOWLIST_PREFIX = ['docs/legal/', 'docs/rebrand-audit-'];

function isLegalAllowlisted(relPath) {
  const normalized = relPath.split(path.sep).join('/');
  if (LEGAL_ALLOWLIST_EXACT.has(normalized)) return true;
  return LEGAL_ALLOWLIST_PREFIX.some((prefix) => normalized.startsWith(prefix));
}

// pnpm subcommands that take a following word but that word is NOT a `scripts` entry — a
// command line built from one of these should never be checked against package.json scripts.
const PNPM_NON_SCRIPT_SUBCOMMANDS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'outdated', 'why', 'list', 'ls',
  'exec', 'dlx', 'create', 'init', 'publish', 'pack', 'store', 'config', 'env', 'patch',
  'patch-commit', 'audit', 'licenses', 'root', 'prune', 'rebuild', 'import', 'link', 'unlink',
  'setup', 'self-update', 'test', 'run', // 'run' itself is handled separately (pnpm run <x>)
  '--filter', '-r', '-w', '--workspace-root',
]);

function usageError(msg) {
  console.error(`error: ${msg}`);
  console.error('Usage: node docs-lint.mjs [file ...] [--root <repoRoot>] [--require "file:Heading"]... [--json]');
  process.exit(2);
}

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      require: { type: 'string', multiple: true, default: [] },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  }));
} catch (e) {
  usageError(String(e.message || e));
}

if (values.help) {
  console.log('Usage: node docs-lint.mjs [file ...] [--root <repoRoot>] [--require "file:Heading"]... [--json]');
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let ROOT = values.root ? path.resolve(values.root) : null;
if (!ROOT) {
  const guess = path.resolve(__dirname, '..');
  ROOT = existsSync(path.join(guess, 'package.json')) ? guess : process.cwd();
}
if (!existsSync(path.join(ROOT, 'package.json'))) {
  usageError(`--root ${ROOT} has no package.json at its top level — pass --root explicitly`);
}

const REQUIRE_SPECS = [];
for (const spec of values.require) {
  const idx = spec.indexOf(':');
  if (idx <= 0 || idx === spec.length - 1) usageError(`--require must be "file:Heading", got: ${spec}`);
  REQUIRE_SPECS.push({ file: spec.slice(0, idx), heading: spec.slice(idx + 1) });
}

const files = positionals.length > 0 ? positionals : defaultFiles(ROOT);
if (files.length === 0) usageError(`no markdown files to lint under --root ${ROOT}`);
for (const f of files) {
  if (!existsSync(path.join(ROOT, f))) usageError(`file does not exist under --root ${ROOT}: ${f}`);
}

let packageScripts = {};
try {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  packageScripts = pkg.scripts ?? {};
} catch (e) {
  usageError(`could not read/parse ${path.join(ROOT, 'package.json')}: ${String(e.message || e)}`);
}

const scriptFileExists = (name) => existsSync(path.join(ROOT, 'scripts', name));

/** All findings, as `{ file, check, line, message }`. `line` is 1-based, or null when the
 * finding isn't tied to one line (e.g. a missing --require target file). */
const findings = [];
function report(file, check, line, message) {
  findings.push({ file, check, line, message });
}

// ---- (a) relative links to files that do not exist -------------------------------------------

/** Matches the `(...)` target of both `[text](target)` links and `![alt](target)` images. Title
 * strings (`(target "title")`) are stripped by taking everything up to the first unescaped
 * space or closing paren — good enough for this repo's docs, which don't use link titles. */
const LINK_TARGET_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function checkLinks(file, absPath, text) {
  let match;
  LINK_TARGET_RE.lastIndex = 0;
  while ((match = LINK_TARGET_RE.exec(text))) {
    let target = match[1].trim();
    if (target === '') continue;
    if (/^([a-z][a-z0-9+.-]*:)/i.test(target)) continue; // scheme:... (http:, mailto:, data:, etc.)
    if (target.startsWith('#')) continue; // pure in-page anchor
    // Strip a trailing fragment/query; a link into a real file with an anchor still needs that
    // file to exist, the fragment itself is not checked.
    target = target.replace(/[?#].*$/, '');
    if (target === '') continue;
    const resolved = target.startsWith('/')
      ? path.join(ROOT, target.slice(1))
      : path.resolve(path.dirname(absPath), target);
    if (!existsSync(resolved)) {
      const line = 1 + text.slice(0, match.index).split('\n').length - 1;
      report(file, 'broken-link', line, `relative link target does not exist: ${match[1]} (resolved: ${path.relative(ROOT, resolved)})`);
    }
  }
}

// ---- (b) shell fenced blocks naming a repo script that does not exist -------------------------

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w-]+)?.*$/;
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console']);

/**
 * The shell fences of `text` as logical command lines: `{ line, command }`, where `line` is the
 * 1-based line the command starts on and `\`-continued lines are joined into one command.
 */
function shellCommandLines(text) {
  const lines = text.split('\n');
  const out = [];
  let fence = null; // { marker, shell }
  let pending = null; // { line, parts }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE);
    if (!fence && m) {
      fence = { marker: m[1], shell: SHELL_LANGS.has((m[2] || '').toLowerCase()) };
      continue;
    }
    if (fence && m && m[1][0] === fence.marker[0] && m[1].length >= fence.marker.length && !m[2]) {
      if (pending) out.push({ line: pending.line, command: pending.parts.join(' ') });
      pending = null;
      fence = null;
      continue;
    }
    if (!fence || !fence.shell) continue;
    let raw = lines[i].trim();
    if (!pending && (raw === '' || raw.startsWith('#'))) continue;
    if (!pending) raw = raw.replace(/^\$\s+/, ''); // a leading shell prompt
    const continued = raw.endsWith('\\');
    if (continued) raw = raw.slice(0, -1).trim();
    if (!pending) pending = { line: i + 1, parts: [] };
    pending.parts.push(raw);
    if (!continued) {
      out.push({ line: pending.line, command: pending.parts.join(' ') });
      pending = null;
    }
  }
  return out;
}

/** Splits one command line into simple commands and strips wrappers that run another command. */
function simpleCommands(command) {
  return command
    .replace(/\s+#.*$/, '') // trailing comment
    .split(/&&|\|\||;|\|/)
    .map((part) => {
      let cmd = part.trim().replace(/^[({]\s*/, '');
      for (;;) {
        const before = cmd;
        cmd = cmd
          .replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '') // VAR=value
          .replace(/^mise\s+exec(?:\s+-C\s+\S+)?\s+--\s+/, '')
          .replace(/^env\s+/, '')
          .replace(/^npx\s+/, '');
        if (cmd === before) break;
      }
      return cmd;
    })
    .filter(Boolean);
}

function checkFencedScriptRefs(file, text) {
  for (const { line: lineNo, command } of shellCommandLines(text)) {
    for (const cmd of simpleCommands(command)) {
      // Root `pnpm run <script>` / `pnpm <script>`. A `pnpm --filter …` / `-C` / `-r` command
      // runs a PACKAGE's script, not a root one, so it is not checked against the root scripts.
      const pnpmMatch = cmd.match(/^pnpm\s+(?:run\s+)?([A-Za-z0-9_:.\-]+)/);
      if (pnpmMatch && !pnpmMatch[1].startsWith('-')) {
        const token = pnpmMatch[1];
        const isRunForm = /^pnpm\s+run\s+/.test(cmd);
        if ((isRunForm || !PNPM_NON_SCRIPT_SUBCOMMANDS.has(token)) && !(token in packageScripts)) {
          report(file, 'unknown-pnpm-script', lineNo, `\`${cmd}\` — "${token}" is not a script in package.json`);
        }
      }
      // Any `scripts/<name>` reference, as the command itself or as an argument.
      const scriptPathRe = /(?:^|[\s/"'=])(?:\.\/)?scripts\/([\w.\-]+\.(?:ts|mjs|js|sh))\b/g;
      let sm;
      while ((sm = scriptPathRe.exec(cmd))) {
        // Only the repo-root scripts/ directory: `packages/x/scripts/y.ts` is preceded by `/`
        // after a path segment, so require the match to start the token.
        const start = sm.index + (sm[0].startsWith('scripts/') || sm[0].startsWith('./') ? 0 : 1);
        const prefix = cmd.slice(0, start);
        if (/[\w.\-]\/$/.test(prefix)) continue;
        if (!scriptFileExists(sm[1])) {
          report(file, 'unknown-script-file', lineNo, `\`${cmd}\` — scripts/${sm[1]} does not exist`);
        }
      }
    }
  }
}

// ---- (c) the retired upstream name outside the legal allowlist ------------------------------

// Built from parts so this file's own source never spells the retired name. Matches it with a
// space, `-`, `_`, `.` or nothing between the two words, in any case. "Mish" is current branding.
const OLD_NAME_RE = new RegExp(['Open', 'Design'].join('[ _.-]?'), 'gi');

function checkOldName(file, text) {
  if (isLegalAllowlisted(file)) return;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    OLD_NAME_RE.lastIndex = 0;
    let m;
    while ((m = OLD_NAME_RE.exec(lines[i]))) {
      report(file, 'old-name-mention', i + 1, `mentions "${m[0]}" outside the legal-notice allowlist: ${lines[i].trim().slice(0, 120)}`);
    }
  }
}

// ---- (d) required headings --------------------------------------------------------------------

function headingsOf(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) out.push(m[2].trim());
  }
  return out;
}

// ---- Run --------------------------------------------------------------------------------------

const textByFile = new Map();
for (const file of files) {
  const absPath = path.join(ROOT, file);
  const text = readFileSync(absPath, 'utf8');
  textByFile.set(file, text);
  checkLinks(file, absPath, text);
  checkFencedScriptRefs(file, text);
  checkOldName(file, text);
}

for (const { file, heading } of REQUIRE_SPECS) {
  if (!textByFile.has(file)) {
    const absPath = path.join(ROOT, file);
    if (!existsSync(absPath)) {
      report(file, 'missing-required-heading', null, `--require named "${file}" but that file does not exist under --root ${ROOT}`);
      continue;
    }
    const text = readFileSync(absPath, 'utf8');
    textByFile.set(file, text);
    checkLinks(file, absPath, text);
    checkFencedScriptRefs(file, text);
    checkOldName(file, text);
  }
  const headings = headingsOf(textByFile.get(file));
  if (!headings.includes(heading)) {
    report(file, 'missing-required-heading', null, `required heading not found: "${heading}" (file has: ${headings.slice(0, 8).map((h) => `"${h}"`).join(', ')}${headings.length > 8 ? ', ...' : ''})`);
  }
}

// ---- Report -------------------------------------------------------------------------------------

if (values.json) {
  console.log(JSON.stringify({ root: ROOT, files, findings }, null, 2));
} else if (findings.length === 0) {
  console.log(`docs-lint: clean (${files.length} file(s) checked: ${files.join(', ')})`);
} else {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  console.log(`docs-lint: ${findings.length} finding(s) across ${byFile.size} file(s)\n`);
  for (const [file, fs] of byFile) {
    console.log(`${file}:`);
    for (const f of fs) {
      console.log(`  ${f.line ? `line ${f.line}` : '-'}  [${f.check}]  ${f.message}`);
    }
  }
}

process.exit(findings.length === 0 ? 0 : 1);
