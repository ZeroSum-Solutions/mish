// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TasksView } from '../../src/components/TasksView';
import { RoutinesSection } from '../../src/components/RoutinesSection';

const routine = { id: 'routine', name: 'Test routine', prompt: 'Do work', schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, target: { mode: 'create_each_run' }, skillId: null, agentId: null, enabled: true, nextRunAt: null, lastRun: null, createdAt: 1, updatedAt: 1 };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([['tasks', TasksView], ['routines', RoutinesSection]] as const)('%s displays the daemon contract reason after a failed run', async (_name, Component) => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'safe failure reason' } }), { status: 500 });
    const url = String(input);
    const body = url === '/api/routines' ? { routines: [routine] }
      : url === '/api/projects' ? { projects: [] }
      : { templates: [], proposals: [], packets: [], runs: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(<Component />);
  await screen.findByText('Test routine');
  fireEvent.click(screen.getByRole('button', { name: _name === 'tasks' ? /^Run$/i : /Run now/i }));
  expect(await screen.findByText('safe failure reason')).toBeTruthy();
});
