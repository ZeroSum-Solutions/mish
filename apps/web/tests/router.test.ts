/**
 * URL router round-trip tests (issue #1505).
 *
 * Pins the deep-link shape for the project route:
 *
 *   /                                                 home
 *   /projects/:id                                     project root
 *   /projects/:id/files/:path                         file view
 *   /projects/:id/conversations/:cid                  specific conversation
 *   /projects/:id/conversations/:cid/files/:path      conversation + file
 *
 * The conversation segment was added to unblock the Routines history
 * row: clicking "Open project" on a parallel run's row needs to land
 * the user on that run's own conversation, not on whatever the
 * project happens to default to.
 */

import { describe, expect, it } from 'vitest';

import { buildPath, parseRoute, type Route } from '../src/router';

function roundTrip(route: Route): Route {
  return parseRoute(buildPath(route));
}

describe('parseRoute / buildPath (issue #1505)', () => {
  it('round-trips the selected Settings section', () => {
    const route = { kind: 'home', view: 'settings', settingsSection: 'licensedPacks' } as const;
    expect(buildPath(route)).toBe('/settings/licensedPacks');
    expect(roundTrip(route)).toEqual(route);
    expect(parseRoute('/settings/unknown')).toEqual({ kind: 'home', view: 'settings' });
    expect(parseRoute('/settings/library')).toEqual({ kind: 'home', view: 'settings' });
  });

  it('parses the home route' , () => {
    expect(parseRoute('/')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('')).toEqual({ kind: 'home', view: 'home' });
  });

  it('round-trips a bare project route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: null,
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1');
  });

  it('round-trips a project + file route (no conversation)', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: 'src/index.tsx',
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/files/src/index.tsx');
  });

  it('round-trips a project + conversation route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'conv-abc',
      fileName: null,
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/conversations/conv-abc');
  });

  it('round-trips a project + conversation + file route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'conv-abc',
      fileName: 'index.html',
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/conversations/conv-abc/files/index.html');
  });

  it('percent-encodes ids and file names with reserved characters', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p/1 with space',
      conversationId: 'conv/abc with space',
      fileName: 'dir/file name.tsx',
    };
    const built = buildPath(route);
    expect(built).toContain('p%2F1%20with%20space');
    expect(built).toContain('conv%2Fabc%20with%20space');
    // File path components are percent-encoded individually so the
    // slash between segments survives.
    expect(built.endsWith('/dir/file%20name.tsx')).toBe(true);
    expect(roundTrip(route)).toEqual(route);
  });

  it('parses a legacy project + file URL with no conversation segment', () => {
    expect(parseRoute('/projects/p-1/files/README.md')).toEqual({
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: 'README.md',
    });
  });

  it('parses a project + conversation URL with no file segment', () => {
    expect(parseRoute('/projects/p-1/conversations/c-2')).toEqual({
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'c-2',
      fileName: null,
    });
  });

  it('falls back to home when the URL is unrecognized', () => {
    expect(parseRoute('/something/else')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('/community')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('/projects')).toEqual({ kind: 'home', view: 'projects' });
  });

  // Design index (contract 2026-09-19 §7): its own top-level path so a facet
  // search can be shared as a link.
  it('parses and round-trips the design index route', () => {
    const route: Route = { kind: 'home', view: 'design-index' };
    expect(parseRoute('/design-index')).toEqual(route);
    expect(parseRoute('/design-index/')).toEqual(route);
    expect(buildPath(route)).toBe('/design-index');
    expect(roundTrip(route)).toEqual(route);
    // Only the bare path is the view; anything deeper is not a design-index
    // URL and falls back to home rather than opening an empty index.
    expect(parseRoute('/design-index/digest-one')).toEqual({ kind: 'home', view: 'home' });
  });

  // GenUI catalog (catalog-design.md §E): its own top-level path.
  it('parses and round-trips the catalog route', () => {
    const route: Route = { kind: 'home', view: 'catalog' };
    expect(parseRoute('/catalog')).toEqual(route);
    expect(parseRoute('/catalog/')).toEqual(route);
    expect(buildPath(route)).toBe('/catalog');
    expect(roundTrip(route)).toEqual(route);
    expect(parseRoute('/catalog/glare-hover')).toEqual({ kind: 'home', view: 'home' });
  });

  it('parses the collab demo route with and without a project id', () => {
    expect(parseRoute('/collab-demo')).toEqual({ kind: 'collab-demo', projectId: null });
    expect(parseRoute('/collab-demo/p%201')).toEqual({ kind: 'collab-demo', projectId: 'p 1' });
  });

  it('round-trips the collab demo route', () => {
    expect(roundTrip({ kind: 'collab-demo', projectId: null })).toEqual({ kind: 'collab-demo', projectId: null });
    expect(roundTrip({ kind: 'collab-demo', projectId: 'p-9' })).toEqual({ kind: 'collab-demo', projectId: 'p-9' });
  });
});

describe('parseRoute malformed percent-encoding', () => {
  it('does not throw on malformed segments', () => {
    expect(() => parseRoute('/projects/%E0%A4%A')).not.toThrow();
    expect(parseRoute('/projects/%E0%A4%A')).toMatchObject({ kind: 'project', projectId: '%E0%A4%A' });
  });
});
