import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createAgentRuntimeEnv,
  createAgentRuntimeToolPrompt,
  createDaemonDataDirConfiguredAgentEnv,
  createMishToolEnv,
  resolveMishNodeBin,
} from '../../src/server.js';
import { agentInheritedEnv } from '../../src/runtimes/inherited-env.js';
import * as runtimeEnvironment from '../../src/runtimes/env.js';
import { applyAgentLaunchEnv } from '../../src/runtimes/launch.js';
import {
  AGENT_NEUTRAL_GIT_IDENTITY,
  IDENTITY_ENV_DENYLIST,
  spawnEnvForAgent,
} from '../../src/runtimes/env.js';
import { withPlatform } from './helpers/test-helpers.js';

describe('agent runtime tool environment', () => {
  it('passes the pinned Workspace pair to dynamic Skill wrappers, clearing ambient identity for unbound runs', () => {
    const scoped = createMishToolEnv({
      daemonUrl: 'http://127.0.0.1:7456',
      projectId: 'project-a',
      workspaceScope: {
        schemaVersion: 1,
        projectId: 'project-a',
        workspaceId: 'workspace-a',
        workspaceMemberId: 'member-a',
        source: 'persisted_project_binding',
      },
    });
    expect(scoped).toMatchObject({
      OD_WORKSPACE_ID: 'workspace-a',
      OD_WORKSPACE_MEMBER_ID: 'member-a',
    });
    const unbound = {
      ...scoped,
      ...createMishToolEnv({
        daemonUrl: 'http://127.0.0.1:7456',
        projectId: 'unbound',
      }),
    };
    expect(unbound.OD_WORKSPACE_ID).toBe('');
    expect(unbound.OD_WORKSPACE_MEMBER_ID).toBe('');
    const historical = createMishToolEnv({
      daemonUrl: 'http://127.0.0.1:7456',
      projectId: 'project-a',
      workspaceScope: {
        schemaVersion: 1,
        projectId: 'project-a',
        workspaceId: 'workspace-a',
        source: 'persisted_project_binding',
      },
    });
    expect(historical.OD_WORKSPACE_ID).toBe('workspace-a');
    expect(historical.OD_WORKSPACE_MEMBER_ID).toBe('');
  });

  it.skipIf(process.platform === 'win32')('delivers the server runtime capability map to a real child and excludes stale nongrant tokens', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-runtime-seam-'));
    try {
      const recorder = path.join(root, 'od-runtime-recorder');
      fs.writeFileSync(recorder, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(Object.keys(process.env).sort()));\n', { mode: 0o700 });
      for (const grant of [{ token: 'synthetic-current-grant' }, null]) {
        const base = { PATH: [root, path.dirname(process.execPath)].join(path.delimiter), HOME: root, MM_ENV_CANARY_UNUSED: 'unused', OD_TOOL_TOKEN: 'synthetic-stale', od_tool_token_issuer_origin: 'http://127.0.0.1:1' };
        const runtimeEnv = createAgentRuntimeEnv(agentInheritedEnv(base), 'http://127.0.0.1:7456', grant, process.execPath, () => ({ OD_OPAQUE_CLIENT_CAPABILITY: 'synthetic-runtime' }));
        const env = runtimeEnvironment.spawnEnvForAgentRuntime('claude', { ...base, ...runtimeEnv }, { OD_TOOL_TOKEN: 'synthetic-settings-stale' }, {
          runtimeEnv, adapterEnv: { PROFILE_OPTION: 'yes', OD_TOOL_TOKEN: 'synthetic-profile-stale' },
        }, {});
        const names = JSON.parse(execFileSync('od-runtime-recorder', { cwd: root, env, encoding: 'utf8' })) as string[];
        expect(names).toContain('OD_OPAQUE_CLIENT_CAPABILITY');
        expect(names).toContain('PROFILE_OPTION');
        expect(names).toContain('GIT_CONFIG_GLOBAL');
        expect(names).not.toContain('MM_ENV_CANARY_UNUSED');
        expect(names).not.toContain('od_tool_token_issuer_origin');
        if (grant) {
          expect(names).toContain('OD_TOOL_TOKEN');
          expect(env.OD_TOOL_TOKEN).toBe(grant.token);
          expect(env.OD_TOOL_TOKEN_ISSUER_ORIGIN).toBe('http://127.0.0.1:7456');
        } else {
          expect(names).not.toContain('OD_TOOL_TOKEN');
          expect(names).not.toContain('OD_TOOL_TOKEN_ISSUER_ORIGIN');
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('filters raw runtime input while delivering an argument-reading opaque capability to a real child', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-runtime-callback-'));
    try {
      fs.writeFileSync(path.join(root, 'od-runtime-recorder'), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(Object.keys(process.env).sort()));\n', { mode: 0o700 });
      const base: NodeJS.ProcessEnv = { PATH: [root, path.dirname(process.execPath)].join(path.delimiter), HOME: root, OD_OPAQUE_CLIENT_CAPABILITY: 'synthetic-runtime', MM_ENV_CANARY_UNUSED: 'unused' };
      const inheritedEnvironment = vi.fn((env: NodeJS.ProcessEnv = {}) => typeof env.OD_OPAQUE_CLIENT_CAPABILITY === 'string' ? { OD_OPAQUE_CLIENT_CAPABILITY: env.OD_OPAQUE_CLIENT_CAPABILITY } : {});
      const runtimeEnv = createAgentRuntimeEnv(base, 'http://127.0.0.1:7456', { token: 'synthetic-current-grant' }, process.execPath, inheritedEnvironment);
      const env = runtimeEnvironment.spawnEnvForAgentRuntime('claude', base, {}, { runtimeEnv }, {});
      const names = JSON.parse(execFileSync('od-runtime-recorder', { cwd: root, env, encoding: 'utf8' })) as string[];
      expect(names).toContain('OD_OPAQUE_CLIENT_CAPABILITY');
      expect(names).toContain('OD_TOOL_TOKEN');
      expect(names).toContain('OD_TOOL_TOKEN_ISSUER_ORIGIN');
      expect(names).not.toContain('MM_ENV_CANARY_UNUSED');
      expect(inheritedEnvironment).toHaveBeenCalledExactlyOnceWith(base);
      expect(base.MM_ENV_CANARY_UNUSED).toBe('unused');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('prefers explicit OD_NODE_BIN over the process executable', () => {
    expect(resolveMishNodeBin({
      env: { OD_NODE_BIN: 'C:\\Mish\\resources\\mish\\bin\\node.exe' },
      execPath: 'C:\\Users\\Ada\\AppData\\Roaming\\Mish\\en\\hash\\Mish.exe',
      platform: 'win32',
      resourceRoot: null,
    })).toBe('C:\\Mish\\resources\\mish\\bin\\node.exe');
  });

  it('resolves the bundled resource node before falling back to process.execPath', () => {
    expect(resolveMishNodeBin({
      env: {},
      execPath: 'C:\\Users\\Ada\\AppData\\Roaming\\Mish\\en\\hash\\Mish.exe',
      platform: 'win32',
      resourceRoot: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Mish\\resources\\mish',
      exists: (candidate) => candidate.endsWith('\\resources\\mish\\bin\\node.exe'),
    })).toBe('C:\\Users\\Ada\\AppData\\Local\\Programs\\Mish\\resources\\mish\\bin\\node.exe');
  });

  it('injects daemon URL and run-scoped tool token into agent sessions', () => {
    const env = createAgentRuntimeEnv(
      { PATH: '/bin', OD_TOOL_TOKEN: 'stale-token' },
      'http://127.0.0.1:7456',
      { token: 'fresh-token' },
      '/opt/mish/bin/node',
    );

    expect(env).toMatchObject({
      PATH: `/opt/mish/bin${path.delimiter}/bin`,
      OD_DAEMON_URL: 'http://127.0.0.1:7456',
      OD_NODE_BIN: '/opt/mish/bin/node',
      OD_TOOL_TOKEN: 'fresh-token',
      OD_TOOL_TOKEN_ISSUER_ORIGIN: 'http://127.0.0.1:7456',
    });
  });

  it('merges an opaque environment supplied by the runtime integration seam', () => {
    const inheritedEnvironment = vi.fn(() => ({ OD_OPAQUE_CLIENT_CAPABILITY: 'capability' }));
    const baseEnv = { PATH: '/bin' };
    const env = createAgentRuntimeEnv(
      baseEnv,
      'http://127.0.0.1:7456',
      null,
      '/opt/mish/bin/node',
      inheritedEnvironment,
    );

    expect(inheritedEnvironment).toHaveBeenCalledWith(baseEnv);
    expect(env.OD_OPAQUE_CLIENT_CAPABILITY).toBe('capability');
  });

  it('prepends node binary directory to PATH when not already present', () => {
    const env = createAgentRuntimeEnv(
      { PATH: '/bin' },
      'http://127.0.0.1:7456',
      null,
      '/opt/node/node',
    );

    expect(env.PATH).toBe(`/opt/node${path.delimiter}/bin`);
  });

  it('does not duplicate node binary directory when already present in PATH', () => {
    const env = createAgentRuntimeEnv(
      { PATH: `/opt/node${path.delimiter}/bin` },
      'http://127.0.0.1:7456',
      null,
      '/opt/node/node',
    );

    expect(env.PATH).toBe(`/opt/node${path.delimiter}/bin`);
  });

  it('updates the existing path key in place when the base env uses Windows-style Path casing', () => {
    // Windows GUI launches commonly spread process.env where the search path is
    // stored under 'Path' rather than 'PATH'. The function must read and update
    // that same key so child_process.spawn (which de-duplicates env keys
    // case-insensitively on Windows) does not discard the inherited directories.
    const env = createAgentRuntimeEnv(
      { Path: `/usr/local/bin` },
      'http://127.0.0.1:7456',
      null,
      '/opt/node/node',
    );

    // The original 'Path' key must be updated with the prepended node dir.
    expect(env.Path).toBe(`/opt/node${path.delimiter}/usr/local/bin`);
    // A competing uppercase 'PATH' key must NOT be created alongside it.
    expect(env.PATH).toBeUndefined();
  });

  it('does not leak stale inherited tool tokens when no run token was minted', () => {
    const env = createAgentRuntimeEnv(
      { PATH: '/bin', OD_TOOL_TOKEN: 'stale-token' },
      'http://127.0.0.1:7456',
      null,
      '/opt/mish/bin/node',
    );

    expect(env.OD_DAEMON_URL).toBe('http://127.0.0.1:7456');
    expect(env.OD_NODE_BIN).toBe('/opt/mish/bin/node');
    expect(env.OD_TOOL_TOKEN).toBeUndefined();
    expect(env.OD_TOOL_TOKEN_ISSUER_ORIGIN).toBeUndefined();
  });

  it('does not expose the broad daemon API token to run-scoped agent sessions', () => {
    const env = createAgentRuntimeEnv(
      {
        PATH: '/bin',
        OD_API_TOKEN: 'broad-daemon-token',
        Od_Api_Token: 'windows-cased-broad-token',
      },
      'http://100.64.0.10:7456',
      { token: 'run-scoped-token' },
      '/opt/mish/bin/node',
    );

    expect(env.OD_TOOL_TOKEN).toBe('run-scoped-token');
    expect(Object.keys(env).some((key) => key.toUpperCase() === 'OD_API_TOKEN')).toBe(false);
  });

  it('normalizes a narrowed Windows PATHEXT so executable lookup still finds .EXE entries', () => {
    // A GUI-launched daemon can inherit a broken PATHEXT such as `.CPL` (issue
    // #6934). Without normalization, nested native commands lose stdout/stderr
    // or fail with ERROR_NO_DATA. The runtime must recover a usable extension
    // list so `.EXE` entries resolve again.
    const env = withPlatform('win32', () =>
      createAgentRuntimeEnv(
        { PATH: '/bin', PATHEXT: '.CPL' },
        'http://127.0.0.1:7456',
        null,
        '/opt/mish/bin/node',
      ),
    );

    expect(env.PATHEXT).toMatch(/\.exe/i);
  });

  it('preserves a valid Windows PATHEXT that already contains .EXE', () => {
    const env = withPlatform('win32', () =>
      createAgentRuntimeEnv(
        { PATH: '/bin', PATHEXT: '.CUSTOM;.EXE;.CMD' },
        'http://127.0.0.1:7456',
        null,
        '/opt/mish/bin/node',
      ),
    );

    expect(env.PATHEXT).toBe('.CUSTOM;.EXE;.CMD');
  });

  it('normalizes PATHEXT in place when the inherited env uses Windows-style lowercase casing', () => {
    // Node de-duplicates env keys case-insensitively on Windows, so writing a
    // fresh 'PATHEXT' alongside an existing 'pathext' would be ignored. The
    // existing differently-cased key must be updated instead.
    const env = withPlatform('win32', () =>
      createAgentRuntimeEnv(
        { PATH: '/bin', pathext: '.CPL' },
        'http://127.0.0.1:7456',
        null,
        '/opt/mish/bin/node',
      ),
    );

    expect(env.pathext).toMatch(/\.exe/i);
    expect(env.PATHEXT).toBeUndefined();
  });

  it('leaves PATHEXT untouched on non-Windows platforms', () => {
    const env = withPlatform('linux', () =>
      createAgentRuntimeEnv(
        { PATH: '/bin', PATHEXT: '.CPL' },
        'http://127.0.0.1:7456',
        null,
        '/opt/mish/bin/node',
      ),
    );

    expect(env.PATHEXT).toBe('.CPL');
  });

  it('pins the daemon runtime data dir into agent sessions', () => {
    const env = createAgentRuntimeEnv(
      { PATH: '/bin' },
      'http://127.0.0.1:7456',
      null,
      '/opt/mish/bin/node',
    );

    expect(env.OD_DATA_DIR).toBe(process.env.OD_DATA_DIR);
  });

  it('keeps wrapper media commands on the daemon data dir even when configured agent env is stale', () => {
    const base = createAgentRuntimeEnv(
      { PATH: '/bin', OD_DATA_DIR: '/stale/process/data' },
      'http://127.0.0.1:7456',
      null,
      '/opt/mish/bin/node',
    );
    const configuredAgentEnv = createDaemonDataDirConfiguredAgentEnv({
      OD_DATA_DIR: '/stale/configured/data',
    });

    const env = {
      ...spawnEnvForAgent(
        'amr',
        base,
        configuredAgentEnv,
      ),
      ...createMishToolEnv({
        daemonUrl: 'http://127.0.0.1:7456',
        hyperFramesBin: '/opt/mish/hyperframes/bin/hyperframes.mjs',
        projectDir: '/tmp/project',
        projectId: 'project-1',
      }),
    };

    expect(env.OD_DATA_DIR).toBe(process.env.OD_DATA_DIR);
    expect(env.OPENCODE_TEST_HOME).toBe(
      path.join(process.env.OD_DATA_DIR ?? '', 'amr', 'opencode-home'),
    );
    expect(env.OD_PROJECT_ID).toBe('project-1');
    expect(env.OD_PROJECT_DIR).toBe('/tmp/project');
    expect(env.OD_HYPERFRAMES_BIN).toBe('/opt/mish/hyperframes/bin/hyperframes.mjs');
  });

  it('names the codex rollout root so a complex Run can observe its native Children', () => {
    // `collectCodexChildEvidence` reads
    // `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` and deliberately
    // refuses a homedir fallback, so it can never attribute one install's
    // sessions to another. That leaves the caller owing it an explicit root,
    // and nothing supplied one: the collector's `CODEX_HOME` guard was false on
    // every default install, so a complex Run's native Children went
    // unobserved and certification failed for evidence never looked for.
    const env = spawnEnvForAgent('codex', { PATH: '/bin' });
    expect(env.CODEX_HOME).toBe(path.join(os.homedir(), '.codex'));
  });

  it('leaves an explicitly configured codex rollout root alone', () => {
    const env = spawnEnvForAgent('codex', { PATH: '/bin', CODEX_HOME: '/custom/codex' });
    expect(env.CODEX_HOME).toBe('/custom/codex');
  });

  it('keeps non-sandbox NO_PROXY behavior unchanged', () => {
    const env = createAgentRuntimeEnv(
      { PATH: '/bin', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' },
      'http://127.0.0.1:7456',
      { token: 'fresh-token' },
      '/opt/mish/bin/node',
    );

    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:9');
    expect(env.NO_PROXY).toBe('');
    expect(env.no_proxy).toBeUndefined();
  });

  it('describes daemon URL and token availability without exposing the token', () => {
    const prompt = createAgentRuntimeToolPrompt('http://127.0.0.1:7456', {
      token: 'secret-run-token',
    });

    expect(prompt).toContain('Daemon URL: `http://127.0.0.1:7456`');
    expect(prompt).toContain('`OD_DAEMON_URL`');
    expect(prompt).toContain('`OD_NODE_BIN`');
    expect(prompt).toContain('`OD_HYPERFRAMES_BIN`');
    expect(prompt).toContain('`"$OD_NODE_BIN" "$OD_BIN" tools ...`');
    expect(prompt).toContain('& $env:OD_NODE_BIN $env:OD_BIN tools ...');
    expect(prompt).toContain('`OD_TOOL_TOKEN` is available');
    expect(prompt).toContain('do not print, persist, or override it');
    expect(prompt).not.toContain('tools deliverable-syntax check --json');
    expect(prompt).not.toContain('Only when this run creates or updates a final Web deliverable');
    expect(prompt).not.toContain('secret-run-token');
  });

  it('describes missing token availability without exposing stale internals', () => {
    const prompt = createAgentRuntimeToolPrompt('http://127.0.0.1:7456', null);

    expect(prompt).toContain('Daemon URL: `http://127.0.0.1:7456`');
    expect(prompt).toContain('`OD_TOOL_TOKEN` is not available');
    expect(prompt).not.toContain('Bearer');
  });
});

describe('applyAgentLaunchEnv', () => {
  it('returns env unchanged when childPathPrepend is empty and no node dir is provided', () => {
    const base = { Path: ['/usr/local/bin', '/usr/bin'].join(path.delimiter), OTHER: 'val' };
    const result = applyAgentLaunchEnv(base, { childPathPrepend: [] }, '', []);
    expect(result).toBe(base);
  });

  it('prepends childPathPrepend entries to PATH when key is uppercase', () => {
    const base = { PATH: '/usr/bin' };
    const result = applyAgentLaunchEnv(base, { childPathPrepend: ['/opt/copilot'] }, '', []);
    expect(result.PATH).toBe(`/opt/copilot${path.delimiter}/usr/bin`);
    expect(result.Path).toBeUndefined();
  });

  it('uses the existing Windows-style Path key instead of adding a competing PATH key', () => {
    // This is the Windows GUI regression: env.PATH is undefined when the actual
    // key is 'Path'.  The old code created a fresh PATH = just childPathPrepend,
    // discarding the system paths and the node directory prepended by
    // createAgentRuntimeEnv, which caused '"node" is not recognized' errors.
    // Pure POSIX paths + path.delimiter keep the assertion correct on all platforms;
    // the real Windows C:\...;... shape is covered by winTest in launch.test.ts.
    const base = { Path: ['/opt/nodejs', '/usr/bin'].join(path.delimiter) };
    const result = applyAgentLaunchEnv(base, { childPathPrepend: ['/opt/agent/bin'] }, '', []);

    // The existing 'Path' key must be updated in place.
    expect(result.Path).toBe(
      ['/opt/agent/bin', '/opt/nodejs', '/usr/bin'].join(path.delimiter),
    );
    // A competing uppercase 'PATH' key must NOT be created.
    expect(result.PATH).toBeUndefined();
  });

  it('deduplicates entries already present in Path', () => {
    const existing = ['/opt/bin', '/usr/bin'].join(path.delimiter);
    const base = { Path: existing };
    const result = applyAgentLaunchEnv(base, { childPathPrepend: ['/opt/bin'] }, '', []);
    expect(result.Path).toBe(existing);
  });
});

describe('claude task-tool exposure', () => {
  // Claude Code >= 2.1.x moved the plan/todo capability from `TodoWrite` to the
  // `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` family, and gates that
  // family behind `CLAUDE_CODE_ENABLE_TODO_TOOLS` for the current model
  // generation. Measured on claude 2.1.247, `claude -p --output-format
  // stream-json --verbose`, reading the init frame's `tools` array:
  //
  //   --model opus   (claude-opus-5)    → Task, TaskOutput, TaskStop
  //   --model sonnet (claude-sonnet-5)  → Task, TaskOutput, TaskStop
  //   … same two, with CLAUDE_CODE_ENABLE_TODO_TOOLS=1
  //                                     → + TaskCreate, TaskGet, TaskList, TaskUpdate
  //
  // `TodoWrite` is exposed on NO model in that build. Without this variable the
  // Task→TodoWrite reducer in claude-stream.ts is dead code on every model the
  // picker offers by alias, and a Claude run can never draw the Todos card.
  it('enables the Task tool family so Claude can emit a plan', () => {
    const env = spawnEnvForAgent('claude', { PATH: '/bin' });
    expect(env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');
  });

  // The flag is the user's to override: Settings → Local CLI → Advanced env is
  // an explicit low-level CLI override and already wins over inherited env
  // (see the precedence note above spawnEnvForAgent).
  it('never overrides an explicit user value', () => {
    expect(
      spawnEnvForAgent('claude', { PATH: '/bin', CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' })
        .CLAUDE_CODE_ENABLE_TODO_TOOLS,
    ).toBe('0');
    expect(
      spawnEnvForAgent('claude', { PATH: '/bin' }, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' })
        .CLAUDE_CODE_ENABLE_TODO_TOOLS,
    ).toBe('0');
  });

  // Claude Code's flag, so only Claude Code's adapter. codebuddy/amp share the
  // `claude-stream-json` parser but are different binaries.
  it('does not leak the flag into other adapters', () => {
    expect(spawnEnvForAgent('codex', { PATH: '/bin' }).CLAUDE_CODE_ENABLE_TODO_TOOLS)
      .toBeUndefined();
    expect(spawnEnvForAgent('codebuddy', { PATH: '/bin' }).CLAUDE_CODE_ENABLE_TODO_TOOLS)
      .toBeUndefined();
  });
});

// Privacy boundary (post-PRD audit finding J1-01): a Claude Code child,
// downloading Wikimedia Commons photos, read the owner's real account email
// out of its ambient environment and put it in the download request — then
// said so in its own final chat message. These guard the daemon-side half of
// the fix: no agent child may ever learn the owner's real identity through
// its env or through `git config`.
describe('agent identity scrubbing for agent children (J1-01)', () => {
  // Never the real account email used anywhere else in this fixture or in
  // this repository's own git config — a fake, obviously-placeholder value
  // so a broken test can never itself leak something real.
  const OWNER_EMAIL = 'owner@example.invalid';
  const OWNER_NAME = 'Real Owner Name';

  const taintedBaseEnv = {
    PATH: '/bin',
    EMAIL: OWNER_EMAIL,
    GIT_AUTHOR_EMAIL: OWNER_EMAIL,
    GIT_COMMITTER_EMAIL: OWNER_EMAIL,
    GIT_AUTHOR_NAME: OWNER_NAME,
    GIT_COMMITTER_NAME: OWNER_NAME,
  };

  it('strips every identity-denylisted env var for every agent, regardless of casing', () => {
    for (const agentId of ['claude', 'codex', 'amr', 'opencode', 'mimo', 'codebuddy']) {
      const env = spawnEnvForAgent(agentId, {
        ...taintedBaseEnv,
        // A lowercase variant some shells export instead of EMAIL.
        email: OWNER_EMAIL,
      });
      for (const key of IDENTITY_ENV_DENYLIST) {
        expect(
          Object.keys(env).some((candidate) => candidate.toUpperCase() === key),
        ).toBe(false);
      }
      expect(JSON.stringify(env)).not.toContain(OWNER_EMAIL);
      expect(JSON.stringify(env)).not.toContain(OWNER_NAME);
    }
  });

  it('strips all identity-denied names after explicit profile and Settings layers, including mixed casing', () => {
    const identity = Object.fromEntries(IDENTITY_ENV_DENYLIST.map((name) => [name.toLowerCase(), 'synthetic-owner-identity']));
    for (const agentId of ['claude', 'codex', 'amr', 'opencode', 'custom-profile']) {
      for (const explicit of ['profile', 'settings']) {
        const env = spawnEnvForAgent(agentId, { PATH: '/bin' }, explicit === 'settings' ? identity : {}, {}, { adapterEnv: explicit === 'profile' ? identity : {} });
        for (const name of IDENTITY_ENV_DENYLIST) expect(Object.keys(env).some((key) => key.toUpperCase() === name)).toBe(false);
        expect(Object.values(env)).not.toContain('synthetic-owner-identity');
      }
    }
  });

  it('strips CLAUDE_CODE_USER_EMAIL from every agent child (J1-01)', () => {
    for (const agentId of ['claude', 'codex', 'amr']) {
      const env = spawnEnvForAgent(agentId, {
        PATH: '/bin',
        CLAUDE_CODE_USER_EMAIL: OWNER_EMAIL,
      }, { KEEP_ME: 'yes', CLAUDE_CODE_USER_EMAIL: OWNER_EMAIL });
      expect(env.CLAUDE_CODE_USER_EMAIL).toBeUndefined();
      expect(Object.values(env)).not.toContain(OWNER_EMAIL);
      expect(env.KEEP_ME).toBe('yes');
    }
  });

  it('keeps email-named vars an integration sets on purpose, such as the vela login fixture email', () => {
    const env = spawnEnvForAgent('amr', {
      PATH: '/bin',
      CLAUDE_CODE_USER_EMAIL: OWNER_EMAIL,
    }, { FAKE_VELA_LOGIN_USER_EMAIL: 'login-route@example.com' });
    expect(env.CLAUDE_CODE_USER_EMAIL).toBeUndefined();
    expect(env.FAKE_VELA_LOGIN_USER_EMAIL).toBe('login-route@example.com');
  });

  it('strips identity vars even when baseEnv is the full inherited process env', () => {
    // Callers may still supply a raw inherited environment to the generic
    // constructor. Identity vars must not survive that boundary, exactly like
    // explicitly configured values; createAgentRuntimeEnv also filters its base.
    const env = spawnEnvForAgent('claude', { ...process.env, ...taintedBaseEnv });
    expect(env.EMAIL).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  it('points GIT_CONFIG_GLOBAL at a daemon-owned neutral config and disables system config', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-agent-env-test-'));
    try {
      const env = spawnEnvForAgent('claude', { PATH: '/bin', OD_DATA_DIR: dataDir });

      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(env.GIT_CONFIG_GLOBAL).toBe(
        path.join(dataDir, 'agent-runtime', 'agent-git-config'),
      );
      expect(fs.existsSync(env.GIT_CONFIG_GLOBAL as string)).toBe(true);

      // The real `git` binary, run with exactly this env and no inherited
      // HOME, must resolve the neutral placeholder identity — never throw,
      // never fall through to a real ~/.gitconfig. This is what stops a
      // shelled-out `git config user.email` from handing the agent the
      // account owner's email. cwd is the freshly-created, non-git tmp dir
      // so no ambient repo-local .git/config can interfere.
      const gitBin = execFileSync('which', ['git']).toString().trim();
      const email = execFileSync(gitBin, ['config', 'user.email'], {
        env,
        cwd: dataDir,
      }).toString().trim();
      const name = execFileSync(gitBin, ['config', 'user.name'], {
        env,
        cwd: dataDir,
      }).toString().trim();

      expect(email).toBe(AGENT_NEUTRAL_GIT_IDENTITY.email);
      expect(name).toBe(AGENT_NEUTRAL_GIT_IDENTITY.name);
      expect(email).not.toBe(OWNER_EMAIL);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not override an explicit GIT_CONFIG_GLOBAL set through Advanced CLI env', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-agent-env-test-'));
    try {
      const env = spawnEnvForAgent(
        'claude',
        { PATH: '/bin', OD_DATA_DIR: dataDir },
        { GIT_CONFIG_GLOBAL: '/explicit/user-configured-path' },
      );
      expect(env.GIT_CONFIG_GLOBAL).toBe('/explicit/user-configured-path');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('writes the neutral git config under the daemon data root even when Advanced CLI env overrides OD_DATA_DIR', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-agent-env-test-'));
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-agent-env-override-'));
    try {
      const env = spawnEnvForAgent(
        'claude',
        { PATH: '/bin', OD_DATA_DIR: dataDir },
        { OD_DATA_DIR: overrideDir },
      );
      expect(env.GIT_CONFIG_GLOBAL).toBe(path.join(dataDir, 'agent-runtime', 'agent-git-config'));
      expect(fs.existsSync(path.join(overrideDir, 'agent-runtime'))).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  it('still disables system git config lookup when no OD_DATA_DIR is available', () => {
    const env = spawnEnvForAgent('claude', { PATH: '/bin' });
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
  });
});
