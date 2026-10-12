import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Regression for a daemon-error-contract PR that mechanically inserted
// `import { readApiErrorMessage } from '@mish/contracts';` as the
// literal first line of every touched web module, including
// XaiOAuthControl.tsx — which starts with a doc comment and then `'use
// client';`. Next's SWC loader requires `'use client'` to be the first
// statement in the file (only comments may precede it); a leading `import`
// turns every client component that uses it into a hard webpack build
// error ("GET / 500" in dev — surfaced as a cluster-wide page load failure
// in e2e, not a typecheck or lint failure, since `pnpm typecheck` does not
// parse directive prologues). Guard the invariant statically instead.

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function filesUnder(dir: string): string[] {
  const entries = readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return filesUnder(path);
    return path;
  });
  return entries.filter((path) => /\.(ts|tsx)$/.test(path));
}

/** Strip `/* ... *\/` and `// ...` comments and blank lines, the way a directive prologue check must. */
function firstNonCommentStatement(source: string): string | null {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const line of stripped.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

describe('"use client" directive placement', () => {
  it('keeps "use client" as the first statement (comments aside) wherever it appears', () => {
    const candidates = filesUnder(join(webRoot, 'src'));
    const offenders = candidates.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      if (!/^\s*['"]use client['"];?\s*$/m.test(source)) return [];
      const first = firstNonCommentStatement(source);
      if (first === `'use client';` || first === `"use client";` || first === `'use client'` || first === `"use client"`) {
        return [];
      }
      return [`${path.replace(`${webRoot}/`, '')}: "use client" is not the first statement (found ${JSON.stringify(first)} first)`];
    });
    expect(offenders).toEqual([]);
  });
});
