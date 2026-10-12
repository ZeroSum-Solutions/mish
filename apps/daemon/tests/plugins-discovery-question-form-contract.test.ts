import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const discoveryAtomPath = fileURLToPath(
  new URL('../../../plugins/_official/atoms/discovery-question-form/SKILL.md', import.meta.url),
);
describe('bundled discovery-question-form atom prompt contract', () => {
  it('teaches agents to emit the wrapped question-form renderer contract', async () => {
    const body = await readFile(discoveryAtomPath, 'utf8');

    expect(body).toContain('<question-form id="discovery"');
    expect(body).toContain('"questions": [');
    expect(body).toContain('</question-form>');
    expect(body).toMatch(/Do not emit a bare question object by itself/);
  });

  it('does not present a bare keyed question JSON object as the canonical emission shape', async () => {
    const body = await readFile(discoveryAtomPath, 'utf8');
    const emissionShape = body.slice(
      body.indexOf('## Emission shape'),
      body.indexOf('## Question object shape'),
    );

    expect(emissionShape).not.toMatch(/```jsonc\s*\{\s*"id":/s);
    expect(body).not.toMatch(/```jsonc[\s\S]*"id": "audience"/);
  });
});
