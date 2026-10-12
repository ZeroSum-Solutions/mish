import { describe, expect, it, vi } from 'vitest';
import { createInternalRunCreationService } from '../src/services/internal-run-service.js';
import { createChatRunService, ProjectDeletionInProgressError } from '../src/runtimes/runs.js';
function service() {
  return createChatRunService({ createSseResponse: () => ({ send: vi.fn(), end: vi.fn(), cleanup: vi.fn() }), createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }) });
}
describe('project deletion admission fence', () => {
  it('refuses a deletion lease for active work and blocks new or restarted work during cleanup', async () => {
    const runs = service();
    expect(runs.prepareRestart(null)).toBeNull();
    expect(runs.prepareRestart(undefined)).toBeNull();
    const existing = runs.create({ projectId: 'busy', clientRequestId: 'resume-id' });
    expect(runs.beginProjectDeletion('busy')).toBeNull();
    await runs.cancel(existing);
    const release = runs.beginProjectDeletion('busy');
    expect(release).toBeTypeOf('function');
    expect(runs.beginProjectDeletion('busy')).toBeNull();
    expect(() => runs.create({ projectId: 'busy' })).toThrow(ProjectDeletionInProgressError);
    expect(() => runs.createOrReuse({ projectId: 'busy', clientRequestId: 'resume-id' })).toThrow(ProjectDeletionInProgressError);
    const claimAssistantMessage = vi.fn(() => ({ ok: true }));
    const internal = createInternalRunCreationService({ runs, claimAssistantMessage, analyticsLifecycle: { install: vi.fn() } });
    expect(() => internal.prepare({ meta: { projectId: 'busy', clientRequestId: 'resume-id' }, resume: { requested: true, canResume: () => true } })).toThrow(ProjectDeletionInProgressError);
    expect(claimAssistantMessage).not.toHaveBeenCalled();
    expect(existing.status).toBe('canceled');
    expect(() => runs.prepareRestart(existing)).toThrow('deletion is in progress');
    expect(() => runs.start(existing, async () => {})).toThrow('deletion is in progress');
    expect(() => runs.create({ projectId: 'other' })).not.toThrow();
    release!();
    expect(() => runs.create({ projectId: 'busy' })).not.toThrow();
  });
});
