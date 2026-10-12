import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexCliEnv } from '../../src/codex-cli.js';
import { probeCodexVersion, resetCodexVersionProbeCache } from '../../src/runtimes/defs/codex.js';
import { spawnEnvForAgent } from '../../src/runtimes/env.js';
import { withoutIdentityEnv } from '../../src/runtimes/identity-env.js';

// J1-01: no agent CLI child may receive the owner's Claude account identity,
// whichever daemon path spawns it.
const OWNER_IDENTITY = {
  CLAUDE_CODE_USER_EMAIL: 'owner@example.invalid',
  CLAUDE_CODE_ACCOUNT_UUID: '00000000-0000-4000-8000-000000000001',
  CLAUDE_CODE_ORGANIZATION_UUID: '00000000-0000-4000-8000-000000000002',
};
const OWNER_VALUES = Object.values(OWNER_IDENTITY);

describe('owner identity scrub (J1-01)', () => {
  afterEach(() => {
    resetCodexVersionProbeCache();
    vi.unstubAllEnvs();
  });

  it('removes the Claude account email and ids from every agent spawn env', () => {
    for (const agentId of ['claude', 'codex', 'amr']) {
      const env = spawnEnvForAgent(agentId, { PATH: '/bin', ...OWNER_IDENTITY }, { KEEP_ME: 'yes' });
      for (const value of OWNER_VALUES) expect(Object.values(env)).not.toContain(value);
      expect(env.KEEP_ME).toBe('yes');
    }
  });

  it('removes identity names that Settings env injects in mixed case', () => {
    const env = spawnEnvForAgent('claude', { PATH: '/bin' }, {
      Claude_Code_User_Email: OWNER_IDENTITY.CLAUDE_CODE_USER_EMAIL,
      claude_code_account_uuid: OWNER_IDENTITY.CLAUDE_CODE_ACCOUNT_UUID,
    });
    for (const value of OWNER_VALUES) expect(Object.values(env)).not.toContain(value);
  });

  it('withoutIdentityEnv returns a scrubbed copy and leaves the input untouched', () => {
    const input = { PATH: '/bin', ...OWNER_IDENTITY };
    const output = withoutIdentityEnv(input);
    expect(output).toEqual({ PATH: '/bin' });
    expect(input.CLAUDE_CODE_USER_EMAIL).toBe(OWNER_IDENTITY.CLAUDE_CODE_USER_EMAIL);
  });

  it('codex management calls get the scrubbed env plus Settings env', () => {
    const env = codexCliEnv({ CODEX_HOME: '/tmp/codex-home' }, { PATH: '/bin', ...OWNER_IDENTITY });
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/tmp/codex-home' });
  });

  it.skipIf(process.platform === 'win32')('the codex version probe does not pass identity to the binary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-identity-probe-'));
    const bin = path.join(dir, 'codex');
    fs.writeFileSync(bin, '#!/bin/sh\necho "codex ${CLAUDE_CODE_USER_EMAIL:-none} ${CLAUDE_CODE_ACCOUNT_UUID:-none}"\n', { mode: 0o755 });
    for (const [key, value] of Object.entries(OWNER_IDENTITY)) vi.stubEnv(key, value);
    try {
      expect(probeCodexVersion(bin)).toBe('codex none none');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
