// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../src/types';
import { ProjectReferenceModal } from '../../src/components/ProjectReferenceModal';
import { I18nProvider } from '../../src/i18n';
import type { Locale } from '../../src/i18n/types';
import { listProjects } from '../../src/state/projects';

vi.mock('../../src/state/projects', () => ({
  getProjectDetail: vi.fn(),
  listProjects: vi.fn(),
}));

const project: Project = {
  id: 'project-ref',
  name: 'Reference Project',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
  metadata: { kind: 'prototype' },
};

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <I18nProvider initial={'en' as Locale}>
      <button type="button" onClick={() => setOpen(true)}>
        Open picker
      </button>
      {open ? (
        <ProjectReferenceModal onClose={() => setOpen(false)} onSelect={vi.fn()} />
      ) : null}
    </I18nProvider>
  );
}

function dialogFocusables(): HTMLElement[] {
  const dialog = screen.getByRole('dialog');
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectReferenceModal focus management', () => {
  it('returns focus to the opener after Escape closes the dialog', async () => {
    vi.mocked(listProjects).mockResolvedValue([project]);
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open picker' });
    trigger.focus();
    fireEvent.click(trigger);

    await screen.findByText('Reference Project');
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Tab and Shift+Tab cycling inside the dialog', async () => {
    vi.mocked(listProjects).mockResolvedValue([project]);
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open picker' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByText('Reference Project');

    const focusables = dialogFocusables();
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    expect(focusables.length).toBeGreaterThan(1);

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('makes the page behind the dialog inert while it is open', async () => {
    vi.mocked(listProjects).mockResolvedValue([project]);
    const { container } = render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open picker' });
    fireEvent.click(trigger);
    await screen.findByText('Reference Project');

    expect(container.hasAttribute('inert')).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.hasAttribute('inert')).toBe(false);
  });
});
