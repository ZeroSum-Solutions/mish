import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnEnvForAgent } from '../../src/runtimes/env.js';
import { codexCliEnv } from '../../src/codex-cli.js';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
import { qwenAgentDef } from '../../src/runtimes/defs/qwen.js';

// Only constructed synthetic values reach the child. The PATH shim prints names,
// never values; it is an actual subprocess, not a provider or daemon run.
describe('declared inherited agent environment', () => {
  it.skipIf(process.platform === 'win32')('withholds unrelated ambient names from a real PATH-shim child while preserving declared dependencies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-env-names-'));
    try {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'od-env-recorder'), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(Object.keys(process.env).sort()));\n', { mode: 0o700 });
      const base = {
        PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
        HOME: root, OD_DATA_DIR: root, OD_NODE_BIN: process.execPath,
        OD_DAEMON_URL: 'http://127.0.0.1:1', OD_SANDBOX_MODE: '1',
        ANTHROPIC_API_KEY: 'synthetic-anthropic', OPENAI_API_KEY: 'synthetic-openai',
        CODEX_API_KEY: 'synthetic-codex', CLAUDE_CONFIG_DIR: root, CODEX_HOME: root,
        HTTPS_PROXY: 'http://127.0.0.1:2', NODE_EXTRA_CA_CERTS: '',
        EMAIL: 'synthetic@example.invalid', OD_API_TOKEN: 'synthetic-broad',
        MM_ENV_CANARY_UNUSED: 'synthetic-unused', STRIPE_SECRET_KEY: 'synthetic-unrelated',
      };
      for (const agent of ['claude', 'codex', 'amr', 'opencode', 'antigravity', 'custom-profile']) {
        const env = spawnEnvForAgent(agent, base, {}, {}, {
          adapterEnv: { OD_OPAQUE_CLIENT_CAPABILITY: 'synthetic-runtime-capability' },
        });
        const names = JSON.parse(execFileSync('od-env-recorder', { cwd: root, env, encoding: 'utf8' })) as string[];
        expect(names, agent).not.toContain('MM_ENV_CANARY_UNUSED');
        expect(names, agent).not.toContain('STRIPE_SECRET_KEY');
        expect(names, agent).not.toContain('EMAIL');
        expect(names, agent).not.toContain('OD_API_TOKEN');
        for (const name of ['PATH', 'HOME', 'OD_DATA_DIR', 'OD_NODE_BIN', 'GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'OD_OPAQUE_CLIENT_CAPABILITY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HTTPS_PROXY']) {
          expect(names, `${agent}:${name}`).toContain(name);
        }
      }
      expect(base.MM_ENV_CANARY_UNUSED).toBe('synthetic-unused');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps explicit adapter/profile env before Settings overrides while identity stripping still wins', () => {
    const env = spawnEnvForAgent('custom-profile', { PATH: '/bin', AMBIENT_ONLY: 'unused' }, {
      CUSTOM_PROFILE_AUTH: 'settings', EXPLICIT_NEW_CLI_OPTION: 'yes', EMAIL: 'synthetic@example.invalid',
    }, {}, { adapterEnv: { CUSTOM_PROFILE_AUTH: 'profile', PROFILE_ONLY: 'yes', EMAIL: 'synthetic@example.invalid' } });
    expect(env.CUSTOM_PROFILE_AUTH).toBe('settings');
    expect(env.PROFILE_ONLY).toBe('yes');
    expect(env.EXPLICIT_NEW_CLI_OPTION).toBe('yes');
    expect(env.EMAIL).toBeUndefined();
    expect(env.AMBIENT_ONLY).toBeUndefined();
  });

  it('matches inherited names case-insensitively, without prefix wildcards or proxy-source leakage', () => {
    const env = spawnEnvForAgent('claude', { Path: '/bin', openai_api_key: 'synthetic', OPENAI_API_KEY_EXTRA: 'unused', OPENAI_APı_KEY: 'unused' }, {}, {
      https_proxy: 'http://127.0.0.1:2', UNRELATED_PROXY_SOURCE_SECRET: 'unused',
    });
    expect(env.Path).toBe('/bin');
    expect(env.openai_api_key).toBe('synthetic');
    expect(env.OPENAI_API_KEY_EXTRA).toBeUndefined();
    expect(env.OPENAI_APı_KEY).toBeUndefined();
    expect(env.UNRELATED_PROXY_SOURCE_SECRET).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:2');
  });

  it('does not inherit a stale automatic run capability in non-run agent or management children', () => {
    const base = { PATH: '/bin', OD_TOOL_TOKEN: 'synthetic-stale', od_tool_token_issuer_origin: 'http://127.0.0.1:1' };
    for (const env of [spawnEnvForAgent('claude', base, {}, {}), codexCliEnv({}, base)]) {
      expect(Object.keys(env).filter((name) => ['OD_TOOL_TOKEN', 'OD_TOOL_TOKEN_ISSUER_ORIGIN'].includes(name.toUpperCase()))).toEqual([]);
    }
  });

  it('requires complete cloud-route configuration to be deliberate rather than inheriting a mode without its credentials', () => {
    const route = { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1', AWS_PROFILE: 'synthetic-profile', GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/adc.json' };
    expect(spawnEnvForAgent('claude', { PATH: '/bin', ...route }, {}, {})).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
    expect(spawnEnvForAgent('claude', { PATH: '/bin', ...route }, {}, {})).not.toHaveProperty('CLAUDE_CODE_USE_VERTEX');
    expect(spawnEnvForAgent('claude', { PATH: '/bin', ...route }, {}, {})).not.toHaveProperty('CLAUDE_CODE_USE_FOUNDRY');
    expect(spawnEnvForAgent('claude', { PATH: '/bin' }, route, {})).toMatchObject(route);
  });

  it('keeps profile and Settings proxy precedence across differently cased ambient names', () => {
    const env = spawnEnvForAgent('claude', { https_proxy: 'http://127.0.0.1:1' }, { HtTpS_PrOxY: 'http://127.0.0.1:3' }, {}, { adapterEnv: { HTTPS_PROXY: 'http://127.0.0.1:2' } });
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:3');
    expect(env.HtTpS_PrOxY).toBeUndefined();
    if (process.platform !== 'win32') expect(env.https_proxy).toBe('http://127.0.0.1:3');
  });

  it('preserves the declared supported provider auth names uniformly without inheriting undeclared neighbors', () => {
    const auth = Object.fromEntries(['AZURE_OPENAI_API_KEY', 'CURSOR_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'XAI_API_KEY', 'QODER_PERSONAL_ACCESS_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'].map((name) => [name, 'synthetic']));
    for (const agent of ['claude', 'codex', 'qoder', 'qwen', 'hermes', 'antigravity']) {
      const env = spawnEnvForAgent(agent, { ...auth, UNRELATED_VENDOR_KEY: 'unused' }, {}, {});
      expect(env).toMatchObject(auth);
      expect(env.UNRELATED_VENDOR_KEY).toBeUndefined();
    }
  });

  it('retains the declared Vela API origin for ambient child compatibility without forwarding similarly named inputs', () => {
    const env = spawnEnvForAgent('amr', { PATH: '/bin', VELA_API_URL: 'http://127.0.0.1:1', VELA_API_URL_EXTRA: 'unused' }, {}, {});
    expect(env.VELA_API_URL).toBe('http://127.0.0.1:1');
    expect(env.VELA_API_URL_EXTRA).toBeUndefined();
  });

  it('keeps an ambient MMD routes file through the real Claude model-discovery seam without forwarding similarly named inputs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-env-mmd-discovery-'));
    try {
      const routesFile = path.join(root, 'routes.json');
      fs.writeFileSync(routesFile, JSON.stringify({ routes: { 'synthetic-mmd-route-model': { primary: {} } } }), { mode: 0o600 });
      const env = spawnEnvForAgent('claude', { PATH: '/bin', HOME: root, OD_DATA_DIR: root, MMD_MODEL_ROUTES_FILE: routesFile, MMD_MODEL_ROUTES_FILE_EXTRA: 'unused' }, {}, {});
      const models = await claudeAgentDef.fetchModels('unused-no-child-or-provider-call', env);
      expect(models?.map(model => model.id)).toContain('synthetic-mmd-route-model');
      expect(env.MMD_MODEL_ROUTES_FILE).toBe(routesFile);
      expect(env.MMD_MODEL_ROUTES_FILE_EXTRA).toBeUndefined();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps an ambient Qwen settings file through the real model-discovery seam without forwarding similarly named inputs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-env-qwen-discovery-'));
    try {
      const settingsFile = path.join(root, 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({ model: 'synthetic-qwen-settings-model' }), { mode: 0o600 });
      const env = spawnEnvForAgent('qwen', { PATH: '/bin', HOME: root, OD_DATA_DIR: root, QWEN_SETTINGS_FILE: settingsFile, QWEN_SETTINGS_FILE_EXTRA: 'unused' }, {}, {});
      const models = await qwenAgentDef.fetchModels('unused-no-child-or-provider-call', env);
      expect(models?.map(model => model.id)).toContain('synthetic-qwen-settings-model');
      expect(env.QWEN_SETTINGS_FILE).toBe(settingsFile);
      expect(env.QWEN_SETTINGS_FILE_EXTRA).toBeUndefined();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('applies the same inherited-name boundary to Codex management calls', () => {
    const env = codexCliEnv({ CUSTOM_AUTH: 'synthetic', EMAIL: 'synthetic@example.invalid' }, {
      PATH: '/bin', CODEX_HOME: '/synthetic', OPENAI_API_KEY: 'synthetic', UNRELATED_SECRET: 'unused',
    });
    expect(env.UNRELATED_SECRET).toBeUndefined();
    expect(env.CUSTOM_AUTH).toBe('synthetic');
    expect(env.OPENAI_API_KEY).toBe('synthetic');
    expect(env.CODEX_HOME).toBe('/synthetic');
    expect(env.EMAIL).toBeUndefined();
  });
});
