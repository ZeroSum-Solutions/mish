import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const composioCss = readFileSync(
  new URL('../../src/styles/viewer/composio.css', import.meta.url),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments — this file's own
// removal note names the dead class by hand, which would otherwise self-match.

// `.chat-pinned-todo` decorated the pinned TodoWrite card that used to sit
// above the chat composer, with a `::before` gradient fade in raw
// `--bg-panel` (never the pane's `--chat-pane-ground`). That card was
// removed from ChatPane when the execution record shipped (see
// tests/components/chat-todo-autoscroll.test.tsx, which already asserts
// `.chat-pinned-todo` never renders). With nothing left to paint it on, the
// fade was dead CSS carrying a stale, un-migrated color — pin that it stays
// removed instead of letting it drift back in during a future merge.
describe('the dead pinned-todo composer fade stays removed', () => {
  it('has no .chat-pinned-todo rule left in composio.css', () => {
    expect(composioCss).not.toMatch(/\.chat-pinned-todo\b/);
  });
});
