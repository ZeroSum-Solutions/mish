import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../../..');

const promptPaths = [
  'packages/contracts/src/prompts/discovery.ts',
  'apps/daemon/src/prompts/discovery.ts',
] as const;

const languageMatchRule =
  "Match the user's chat language. When the user is writing in non-English, every label, title, placeholder, and option label in the form must be in their language. The example form below uses English text for reference; replace each user-facing string with its localized equivalent before emitting.";

const localizationBullet =
  '- Localize every user-facing string in the form (\\`title\\`, the per-question \\`label\\`, \\`placeholder\\`, and option \\`label\\`s) to the user\'s chat language — write what a native speaker would naturally say, never a word-for-word translation (the Chinese title is 快速确认 · 30秒, not the literal 快速简报). Set the top-level \\`"lang"\\` field to the BCP-47 tag of that language (e.g. \\`"zh-CN"\\`, \\`"ja"\\`) so the host renders its built-in controls (the "Other" chip, the custom-answer field) in the same language. \\`id\\`, \\`type\\`, option \\`value\\`, and the stable branch values (\\`pick_direction\\`, \\`brand_spec\\`, \\`reference_match\\`) MUST stay in English because later branch rules match against them.';

describe('discovery prompt localization rules', () => {
  it.each(promptPaths)('%s includes the localized form wording', (promptPath) => {
    const source = readFileSync(resolve(repoRoot, promptPath), 'utf8');

    expect(source).toContain(languageMatchRule);
    expect(source).toContain(localizationBullet);
  });
});

describe('task-type form ownership', () => {
  it.each(promptPaths)('%s does not duplicate the od-default task-type form', (path) => {
    const source = readFileSync(resolve(repoRoot, path), 'utf8');
    expect(source).not.toContain('<question-form id="task-type"');
  });

  it('keeps the single conditional task-type form in od-default', () => {
    const source = readFileSync(
      resolve(repoRoot, 'plugins/_official/scenarios/od-default/SKILL.md'),
      'utf8',
    );
    const formStart = source.indexOf('<question-form id="task-type"');
    expect(formStart).toBeGreaterThanOrEqual(0);
    const form = source.slice(formStart, source.indexOf('</question-form>', formStart));
    expect(form).toContain('"lang": "en"');
    expect(form).toContain('"id": "taskType"');
    expect(form).toContain('"allowCustom": false');
    expect(source).toContain('only when two or more routes remain materially plausible');
    expect(source).toContain('does not by itself require a question form');
  });
});

describe('active skill clarification policy', () => {
  it.each([
    {
      path: 'plugins/_official/atoms/direction-picker/SKILL.md',
      /* T69(2026-09-07):这个 atom 从「只在用户明确要求时才弹选择器」改成
         **完全不问**。本行守的仍是同一件事(别把澄清变成固定关卡),
         只是判据句跟着 atom 的新正文走。 */
      required: '**Do not ask the user to choose a visual direction.**',
      forbidden: ['lets the user choose before final generation'],
    },
  ])('$path does not restore a fixed clarification gate', ({ path, required, forbidden }) => {
    const source = readFileSync(resolve(repoRoot, path), 'utf8');
    expect(source).toContain(required);
    for (const phrase of forbidden) {
      expect(source).not.toContain(phrase);
    }
  });
});
