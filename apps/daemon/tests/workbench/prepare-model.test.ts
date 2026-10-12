import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { closeDatabase, insertConversation, insertProject, openDatabase } from '../../src/db.js';
import { amrModelLoadingCache } from '../../src/runtimes/amr-model-cache.js';
import { resolveAmrModelProbe } from '../../src/runtimes/amr-model-probe.js';
import { readAppConfig } from '../../src/app-config.js';
import { amrAgentDef } from '../../src/runtimes/defs/amr.js';
import { getRememberedLiveModels, rememberLiveModels } from '../../src/runtimes/models.js';
import { claimSessionAdmission, readConversationCursor } from '../../src/workbench/admission.js';
import { prepareModelAdmission } from '../../src/workbench/prepare-model.js';

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown>, next: null as Record<string, unknown> | null }));
vi.mock('../../src/app-config.js', async original => ({ ...await original<typeof import('../../src/app-config.js')>(), readAppConfig: async () => {
  const snapshot = config.current;
  if (config.next) { config.current = config.next; config.next = null; }
  return snapshot;
} }));
let dir: string | undefined;
afterEach(() => {
  closeDatabase(); vi.unstubAllEnvs(); config.next = null; amrModelLoadingCache.resetForTests();
  rememberLiveModels('amr', [], 'feature-test'); rememberLiveModels('amr', [], 'test');
  if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined;
});
function fixture(mode = 'models') {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-cold-catalog-'));
  const executable = path.join(dir, 'vela-fixture.ts'), callsPath = path.join(dir, 'calls.jsonl');
  // Generated isolated CLI fixture; only the supported preset/list catalog commands are accepted.
  fs.writeFileSync(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nif (JSON.stringify(args) !== JSON.stringify(['model','list','--all','--format','json']) && JSON.stringify(args) !== JSON.stringify(['model','preset','--format','json'])) process.exit(9);\nappendFileSync(process.env.FIXTURE_CALLS!, JSON.stringify({args,profile:process.env.VELA_PROFILE})+'\\n');\nif(process.env.FIXTURE_MODE==='failed') process.exit(1);\nconsole.log(JSON.stringify({source:args[1]==='preset'?'preset':'remote',data:process.env.FIXTURE_MODE==='empty'?[]:process.env.FIXTURE_MODE==='next'?[{id:'public_model_next_account',default:true,enabled:true,inputPriceUsdPerMillion:1}]:process.env.FIXTURE_MODE==='multiple'?[{id:'public_model_next_account',default:true,enabled:true,inputPriceUsdPerMillion:1},{id:'public_model_scoped_concrete',enabled:true,inputPriceUsdPerMillion:1}]:[{id:'public_model_scoped_concrete',default:true,enabled:process.env.FIXTURE_MODE!=='disabled',inputPriceUsdPerMillion:1}]}));\n`, { mode: 0o700 });
  vi.stubEnv('MISH_AMR_PROFILE', 'test');
  vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir);
  rememberLiveModels('amr', [], 'feature-test');
  rememberLiveModels('amr', [{ id: 'other-profile', label: 'Other', default: true }], 'test');
  config.current = { agentId: 'amr', agentModels: { amr: { model: 'default' } }, agentCliEnv: { amr: { MISH_AMR_PROFILE: 'feature-test', VELA_BIN: executable, HOME: dir, FIXTURE_CALLS: callsPath, FIXTURE_MODE: mode } } };
  const db = openDatabase(dir, { dataDir: path.join(dir, 'runtime') });
  insertProject(db, { id: 'p', name: 'Cold', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 's', projectId: 'p', title: 'Cold', createdAt: 1, updatedAt: 1 });
  const input = { db, dataDir: dir, body: { projectId: 'p', conversationId: 's', message: 'Unattended routine input' }, fallbackAgentId: 'amr', getAgentDef: () => amrAgentDef };
  const calls = () => fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { db, input, calls };
}
it('awaits a cold scoped catalog before a routine-style default admission without detecting all agents', async () => {
  const { db, input, calls } = fixture();
  const value = await prepareModelAdmission(input);
  expect(value).toMatchObject({ choice: { agentId: 'amr', modelId: 'default' }, effectiveModel: 'scoped-concrete' });
  expect(calls()).toContainEqual({ args: ['model', 'preset', '--format', 'json'], profile: 'feature-test' });
  expect(calls().every(call => call.profile === 'feature-test')).toBe(true);
  expect(getRememberedLiveModels('amr', 'test')[0]?.id).toBe('other-profile');
  expect(readConversationCursor(db, 's').sequence).toBe(0);
  expect(claimSessionAdmission(db, 'cold-routine', value.prepared!).effectiveModel).toBe('scoped-concrete');
  await prepareModelAdmission({ ...input, body: { ...input.body, agentId: 'amr', model: 'default' } });
  expect(calls().filter(call => call.args[1] === 'preset')).toHaveLength(1);
});
it.each(['empty', 'failed'])('refuses an unavailable cold %s catalog without borrowing another profile or advancing the cursor', async mode => {
  const { db, input, calls } = fixture(mode);
  await expect(prepareModelAdmission(input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(calls().filter(call => call.args[1] === 'preset')).toHaveLength(1);
  expect(readConversationCursor(db, 's').sequence).toBe(0);
});
it('does not refresh or rewrite a locked same-run effective model after its catalog goes cold', async () => {
  const { db, input, calls } = fixture();
  const value = await prepareModelAdmission(input);
  const locked = claimSessionAdmission(db, 'locked', value.prepared!);
  rememberLiveModels('amr', [], 'feature-test');
  const recovered = await prepareModelAdmission({ ...input, locked, sameRunId: 'locked' });
  expect(recovered.effectiveModel).toBe('scoped-concrete'); expect(calls().filter(call => call.args[1] === 'preset')).toHaveLength(1);
  expect(readConversationCursor(db, 's').sequence).toBe(1);
});

it('keeps the selected AMR launch profile and catalog scope on one Settings snapshot', async () => {
  const { input, calls } = fixture();
  const initialConfig = config.current;
  const env = (initialConfig.agentCliEnv as { amr: Record<string, string> }).amr;
  // Settings changes immediately after admission reads its first snapshot.
  config.next = { ...initialConfig, agentCliEnv: { amr: { ...env, MISH_AMR_PROFILE: 'test' } } };
  const value = await prepareModelAdmission({
    ...input, body: { ...input.body, agentId: 'amr', model: 'scoped-concrete' },
  });
  expect(value.effectiveModel).toBe('scoped-concrete');
  expect(calls().length).toBeGreaterThan(0);
  expect(calls().every(call => call.profile === 'feature-test')).toBe(true);
  expect(getRememberedLiveModels('amr', 'test')[0]?.id).toBe('other-profile');
});

function changeCatalog(mode: string, credential?: string) {
  const amr = (config.current.agentCliEnv as { amr: Record<string, string> }).amr;
  config.current = { ...config.current, agentCliEnv: { amr: { ...amr, FIXTURE_MODE: mode, ...(credential ? { VELA_RUNTIME_KEY: credential, VELA_LINK_URL: 'https://fixture-account.invalid' } : {}) } } };
}
it('refreshes a warm profile default under the current account credential catalog key', async () => {
  const { input, calls } = fixture(); changeCatalog('models', 'fixture-account-a');
  expect((await prepareModelAdmission(input)).effectiveModel).toBe('scoped-concrete');
  changeCatalog('next', 'fixture-account-b');
  expect((await prepareModelAdmission(input)).effectiveModel).toBe('next-account');
  expect(calls().filter(call => call.args[1] === 'preset')).toHaveLength(2);
  expect(calls().every(call => call.profile === 'feature-test')).toBe(true);
});
it('honors account-plan catalog invalidation even when a profile default is remembered', async () => {
  const { input } = fixture(); expect((await prepareModelAdmission(input)).effectiveModel).toBe('scoped-concrete');
  const probe = await resolveAmrModelProbe({ dataDir: input.dataDir, env: process.env, readAppConfig });
  amrModelLoadingCache.invalidate(probe.cacheKey); changeCatalog('next');
  expect((await prepareModelAdmission(input)).effectiveModel).toBe('next-account');
});
it.each(['empty', 'failed', 'disabled'])('rejects a warm explicit choice when current account catalog is %s', async mode => {
  const { db, input } = fixture(mode);
  rememberLiveModels('amr', [{ id: 'scoped-concrete', label: 'Previous account', default: true }], 'feature-test');
  await expect(prepareModelAdmission({ ...input, body: { ...input.body, agentId: 'amr', model: 'scoped-concrete' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(readConversationCursor(db, 's').sequence).toBe(0);
});
it('preserves an explicit configured model while validating the current advertised catalog', async () => {
  const { input } = fixture('multiple');
  config.current = { ...config.current, agentModels: { amr: { model: 'scoped-concrete' } } };
  expect((await prepareModelAdmission(input)).effectiveModel).toBe('scoped-concrete');
});
