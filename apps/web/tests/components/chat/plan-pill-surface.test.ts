import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(
  resolve(HERE, '../../../src/components/chat/PlanPill.module.css'),
  'utf8',
);

describe('PlanPill popover surface', () => {
  it('separates the expanded task list from transcript text underneath it', () => {
    const rule = /\.wrap \.pop\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';

    expect(rule).toContain('background: var(--chat-bg-panel)');
    expect(rule).toContain('border: var(--chat-stroke) solid var(--chat-border)');
  });
});
