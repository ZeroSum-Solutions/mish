// @vitest-environment jsdom
//
// `metadata.archived` hides ladder-run projects (packages/agency-fast-lane
// creates dozens of projects per overnight run) from every grid this
// component renders, with an Archived toggle where the full list has other
// filters, and an Archive/Unarchive card-menu action that calls the PATCH.

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecentProjectsStrip } from '../../src/components/RecentProjectsStrip';
import type { Project, ProjectMetadata } from '../../src/types';

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: vi.fn(async () => null),
  fetchProjectFiles: vi.fn(async () => []),
  projectFileUrl: (projectId: string, fileName: string) =>
    `/api/projects/${projectId}/files/${fileName}`,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function project(overrides: Partial<Project>): Project {
  return {
    id: 'project-1',
    name: 'Project',
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt: 2,
    status: { value: 'not_started' },
    ...overrides,
  };
}

const ACTIVE = project({ id: 'p-active', name: 'Active project', updatedAt: 2 });
const ARCHIVED = project({
  id: 'p-archived',
  name: 'Archived project',
  updatedAt: 1,
  metadata: { kind: 'prototype', archived: true },
});

function cardNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.recent-projects__card-name')].map(
    (node) => node.textContent ?? '',
  );
}

describe('RecentProjectsStrip archived filtering', () => {
  it('hides archived projects by default', () => {
    const { container } = render(
      <RecentProjectsStrip
        heading="All projects"
        projects={[ACTIVE, ARCHIVED]}
        onOpen={() => {}}
      />,
    );

    expect(cardNames(container)).toEqual(['Active project']);
  });

  it('shows only archived projects once the Archived toggle is on, and restores the default view when toggled off', () => {
    const { container } = render(
      <RecentProjectsStrip
        heading="All projects"
        projects={[ACTIVE, ARCHIVED]}
        onOpen={() => {}}
      />,
    );

    const toggle = screen.getByTestId('recent-projects-archived-toggle');
    fireEvent.click(toggle);
    expect(cardNames(container)).toEqual(['Archived project']);

    fireEvent.click(toggle);
    expect(cardNames(container)).toEqual(['Active project']);
  });

  it('clearing filters also resets the Archived toggle', () => {
    render(
      <RecentProjectsStrip
        heading="All projects"
        projects={[ACTIVE, ARCHIVED]}
        onOpen={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('recent-projects-archived-toggle'));
    expect(screen.queryByText('Active project')).toBeNull();

    fireEvent.click(screen.getByTestId('recent-projects-clear-filters'));
    expect(screen.getByText('Active project')).toBeTruthy();
    expect(screen.queryByTestId('recent-projects-clear-filters')).toBeNull();
  });
});

describe('RecentProjectsStrip Archive/Unarchive card action', () => {
  it('is absent from the card menu when the caller supplies no onArchiveToggle', () => {
    render(
      <RecentProjectsStrip
        projects={[ACTIVE]}
        onOpen={() => {}}
        onDelete={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
  });

  it('calls onArchiveToggle(id, true) for an active project the viewer owns', () => {
    const onArchiveToggle = vi.fn();
    render(
      <RecentProjectsStrip
        projects={[ACTIVE]}
        onOpen={() => {}}
        onArchiveToggle={onArchiveToggle}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByRole('menuitem', { name: 'Archive' });
    expect((item as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(item);
    expect(onArchiveToggle).toHaveBeenCalledWith('p-active', true);
  });

  it('offers Unarchive and calls onArchiveToggle(id, false) for an already-archived project', () => {
    const onArchiveToggle = vi.fn();
    render(
      <RecentProjectsStrip
        // The default filter hides archived projects; the Archived toggle
        // only renders in the full-page grid (heading or non-'recent'
        // space), so opt into that here to reach it.
        heading="All projects"
        projects={[ARCHIVED]}
        onOpen={() => {}}
        onArchiveToggle={onArchiveToggle}
      />,
    );

    fireEvent.click(screen.getByTestId('recent-projects-archived-toggle'));
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByRole('menuitem', { name: 'Unarchive' });

    fireEvent.click(item);
    expect(onArchiveToggle).toHaveBeenCalledWith('p-archived', false);
  });

  it('disables Archive for a project owned by another team member', () => {
    const onArchiveToggle = vi.fn();
    render(
      <RecentProjectsStrip
        projects={[ACTIVE]}
        onOpen={() => {}}
        onArchiveToggle={onArchiveToggle}
        projectOwnerMemberIds={new Map([['p-active', 'someone-else']])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByRole('menuitem', { name: 'Archive' });
    expect((item as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(item);
    expect(onArchiveToggle).not.toHaveBeenCalled();
  });
});

// `onArchiveToggle` implementations (App.tsx's `handleArchiveProject`) apply
// the archived flag optimistically, then send the PATCH. `patchProject`
// returns null on any failure (network error or non-2xx) — this harness
// mirrors that exact optimistic-update-then-rollback-on-null shape so the
// contract every `onArchiveToggle` caller must honor is exercised against
// the real card, not re-asserted against a mock.
function ArchiveRollbackHarness({
  initialProjects,
  patchProject,
}: {
  initialProjects: Project[];
  patchProject: (id: string, archived: boolean) => Promise<Project | null>;
}) {
  const [projects, setProjects] = useState(initialProjects);
  const applyMetadata = (metadata: ProjectMetadata | undefined, archived: boolean) => (
    { ...(metadata ?? { kind: 'other' as const }), archived }
  );
  const onArchiveToggle = (id: string, archived: boolean) => {
    const previous = projects.find((p) => p.id === id) ?? null;
    setProjects((curr) =>
      curr.map((p) => (p.id === id ? { ...p, metadata: applyMetadata(p.metadata, archived) } : p)));
    void patchProject(id, archived).then((persisted) => {
      if (persisted) return;
      setProjects((curr) => curr.map((p) => (p.id === id && previous ? previous : p)));
    });
  };
  return (
    <RecentProjectsStrip
      heading="All projects"
      projects={projects}
      onOpen={() => {}}
      onArchiveToggle={onArchiveToggle}
    />
  );
}

describe('Archive/Unarchive rollback on a failed PATCH', () => {
  it('reverts the card to its previous (unarchived) state after the PATCH fails', async () => {
    const patchProject = vi.fn(async () => null as Project | null);
    render(<ArchiveRollbackHarness initialProjects={[ACTIVE]} patchProject={patchProject} />);

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));

    // Optimistic update: the default view hides archived projects, so the
    // card disappears immediately, before the PATCH resolves.
    expect(screen.queryByText('Active project')).toBeNull();
    expect(patchProject).toHaveBeenCalledWith('p-active', true);

    // The PATCH resolves null (failure) — the card must come back exactly
    // as it was, not stay stuck in the optimistic archived state.
    await waitFor(() => {
      expect(screen.getByText('Active project')).toBeTruthy();
    });
  });

  it('keeps the card archived after a successful PATCH (no spurious rollback)', async () => {
    const patchProject = vi.fn(async (id: string, archived: boolean) => (
      { ...ACTIVE, id, metadata: { kind: 'other' as const, archived } }
    ));
    render(<ArchiveRollbackHarness initialProjects={[ACTIVE]} patchProject={patchProject} />);

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));

    await waitFor(() => {
      expect(patchProject).toHaveBeenCalledWith('p-active', true);
    });
    // No rollback: the card stays hidden from the default (unarchived) view.
    expect(screen.queryByText('Active project')).toBeNull();
  });
});
