// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { DEFAULT_CONFIG } from '../../src/state/config';

afterEach(() => {
  cleanup();
});

// Media provider edits flow through the dialog's autosave loop
// (`forceMediaProviderSync`); the dialog has no Save button. The detail card's
// copy must describe that, not point at a control that does not exist.
it('describes media provider saving the way the dialog actually saves', () => {
  render(
    <SettingsDialog
      initial={{ ...DEFAULT_CONFIG, agentId: 'codex' }}
      agents={[{ id: 'codex', name: 'Codex', bin: 'codex', available: true }]}
      daemonLive
      appVersionInfo={null}
      initialSection="media"
      onPersist={vi.fn()}
      onPersistComposioKey={vi.fn()}
      onClose={vi.fn()}
      onRefreshAgents={vi.fn()}
    />,
  );

  const detail = document.querySelector('.media-provider-detail');
  expect(detail).not.toBeNull();
  expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
  expect(detail?.textContent).not.toMatch(/until you select Save/i);
  expect(detail?.textContent).toContain('Changes save automatically.');
});
