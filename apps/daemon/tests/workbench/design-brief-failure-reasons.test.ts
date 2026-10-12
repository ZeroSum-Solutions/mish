import { afterEach, describe, expect, it } from 'vitest';
import { BriefGeneratorError, createClaudeMaxBriefGenerator } from '../../src/workbench/brief/generator.js';
import { createSelectableBriefGenerator } from '../../src/workbench/brief/generator-select.js';
import { createDesignBriefService } from '../../src/workbench/brief/service.js';
import { fakeGenerator, tempDir } from './design-brief-fixture.js';

// R15 Improve prompt on a machine where the brief cannot be written: the user
// must learn WHY (Claude signed out, CLI too old, no OpenRouter key) and what
// fixes it. "Try Improve prompt again" never fixes a signed-out CLI.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });
const ctx = { principalId: 'local-daemon', projectId: 'p1' };

async function claudeGenerator(result: { exitCode: number | null; stdout: string; stderr: string }) {
  const { dir, cleanup } = await tempDir(); cleanups.push(cleanup);
  return createClaudeMaxBriefGenerator({ workDir: dir, transientWorkRoot: dir, resolveBin: () => '/fixture/claude', env: { PATH: '/usr/bin' }, run: async () => result });
}
async function generationError(generator: Awaited<ReturnType<typeof claudeGenerator>>): Promise<BriefGeneratorError> {
  const error = await generator.generate({ system: 's', user: 'u' }, new AbortController().signal).then(() => null, (err: unknown) => err);
  expect(error).toBeInstanceOf(BriefGeneratorError);
  return error as BriefGeneratorError;
}

describe('Claude brief lane failure reasons', () => {
  it('names a signed-out Claude Code CLI and how to sign in', async () => {
    const error = await generationError(await claudeGenerator({
      exitCode: 1,
      stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' })}\n`,
      stderr: '',
    }));
    expect(error.message).toMatch(/not signed in/i);
    expect(error.recovery).toMatch(/claude auth login/);
  });

  it('names a signed-out CLI that printed no result frame', async () => {
    const error = await generationError(await claudeGenerator({ exitCode: 1, stdout: '', stderr: 'Not logged in · Please run /login' }));
    expect(error.message).toMatch(/not signed in/i);
  });

  it('names a Claude Code CLI too old for the no-tool brief flags', async () => {
    const error = await generationError(await claudeGenerator({ exitCode: 1, stdout: '', stderr: "error: unknown option '--json-schema'" }));
    expect(error.recovery).toMatch(/update claude code/i);
  });
});

describe('the service carries the lane reason to the user', () => {
  it('preview errors carry the lane message and recovery, not a generic retry hint', async () => {
    const { dir, cleanup } = await tempDir(); cleanups.push(cleanup);
    const generator = fakeGenerator([new BriefGeneratorError('The Claude Code CLI is not signed in', 'Run `claude auth login`, then try again.')]);
    const svc = createDesignBriefService({ dataDir: dir, generator });
    const error = await svc.preview({ originalText: 'A bakery site' }, new AbortController().signal).then(() => null, (err: unknown) => err as Error & { code: string });
    expect(error?.code).toBe('transformer-failed');
    expect(error?.message).toContain('The Claude Code CLI is not signed in');
    expect(error?.message).toContain('claude auth login');
  });

  it('a failed project brief stores the reason and the recovery once each', async () => {
    const { dir, cleanup } = await tempDir(); cleanups.push(cleanup);
    const generator = fakeGenerator([new BriefGeneratorError('The Claude Code CLI is not signed in', 'Run `claude auth login`, then try again.')]);
    const svc = createDesignBriefService({ dataDir: dir, generator });
    const pending = await svc.create({ projectId: 'p1', originalText: 'A bakery site' }, ctx);
    const view = await svc.settled(pending.id);
    expect(view.status).toBe('failed');
    expect(view.failure).toEqual({ code: 'transformer-failed', message: 'The Claude Code CLI is not signed in', recovery: 'Run `claude auth login`, then try again.' });
  });

  it('an unavailable lane stores its reason and recovery without repeating the recovery in the message', async () => {
    const { dir, cleanup } = await tempDir(); cleanups.push(cleanup);
    const generator = { ...fakeGenerator([]), async available() { return { available: false as const, reason: 'The Claude Code CLI is not installed', recovery: 'Install Claude Code.' }; } };
    const svc = createDesignBriefService({ dataDir: dir, generator });
    const view = await svc.settled((await svc.create({ projectId: 'p1', originalText: 'A bakery site' }, ctx)).id);
    expect(view.failure).toEqual({ code: 'transformer-unavailable', message: 'The Claude Code CLI is not installed', recovery: 'Install Claude Code.' });
  });
});

describe('selectable lane with neither Terra nor Claude', () => {
  it('tells a Terra-lane user that an OpenRouter key is the other way in', async () => {
    const terra = { ...fakeGenerator([]), async available() { return { available: false as const, reason: 'No OpenRouter key is configured', recovery: 'Add an OpenRouter key.' }; } };
    const claude = { ...fakeGenerator([]), async available() { return { available: false as const, reason: 'The Claude Code CLI is not installed or not on the daemon PATH', recovery: 'Install Claude Code and sign in with the Max subscription, or use your original prompt.' }; } };
    const terraLane = createSelectableBriefGenerator({ readLane: async () => 'terra', terra, claude });
    const availability = await terraLane.available();
    expect(availability.available).toBe(false);
    if (!availability.available) expect(availability.recovery).toMatch(/OpenRouter key/);
    const claudeLane = createSelectableBriefGenerator({ readLane: async () => 'claude', terra, claude });
    const claudeOnly = await claudeLane.available();
    if (!claudeOnly.available) expect(claudeOnly.recovery).not.toMatch(/OpenRouter/);
  });
});
