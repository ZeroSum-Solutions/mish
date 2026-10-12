/**
 * Every `plugins/_official/scenarios/<id>` path that the web app mentions in
 * source must exist in the bundled catalog. The clean-slate checkpoint deleted
 * scenarios; a UI action that still points an agent at a deleted scenario is a
 * visible button routing to a missing bundled scenario, which the checkpoint
 * acceptance contract forbids.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_SRC = resolve(__dirname, '../../src');
const SCENARIOS_DIR = resolve(__dirname, '../../../../plugins/_official/scenarios');
const SCENARIO_PATH_RE = /plugins\/_official\/scenarios\/([a-z0-9-]+)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('bundled scenario references in apps/web/src', () => {
  it('only name scenarios that exist under plugins/_official/scenarios', () => {
    const missing: string[] = [];
    for (const file of walk(WEB_SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(SCENARIO_PATH_RE)) {
        const id = match[1] ?? "";
        if (!existsSync(join(SCENARIOS_DIR, id))) {
          missing.push(`${file.slice(WEB_SRC.length + 1)} -> ${id}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
