import assert from 'node:assert/strict';
import test from 'node:test';

import { createJevCredentialResolver, preflightJevCredential, resolveVerifyPolicy, TYPESAFE_API_KEY_ENV } from '../src/verify-policy.ts';

test('resolveVerifyPolicy: no flags at all defaults a build to strict', () => {
  assert.deepEqual(resolveVerifyPolicy({ legacyVerifyJev: false, legacyVerifyStrict: false, routeOnly: false }), { mode: 'strict' });
});

test('resolveVerifyPolicy: explicit --verify-mode strict/advisory/after/off pass through untouched', () => {
  for (const mode of ['strict', 'advisory', 'after', 'off'] as const) {
    assert.deepEqual(
      resolveVerifyPolicy({ verifyMode: mode, legacyVerifyJev: false, legacyVerifyStrict: false, routeOnly: false }),
      { mode },
    );
  }
});

test('resolveVerifyPolicy: --verify-mode after checks but never blocks publish, and runs after the fill', () => {
  // The policy result carries only `mode`; there is no separate `blocksPublish`/`runsCheck` flag
  // on this type (see every other mode's assertion above) — `after`'s own semantics (never blocks,
  // checked after the page publishes) live in `run.ts`'s `verifyAfterPublish` option and its
  // `preview` event, not in this pure resolver.
  assert.deepEqual(resolveVerifyPolicy({ verifyMode: 'after', legacyVerifyJev: false, legacyVerifyStrict: false, routeOnly: false }), { mode: 'after' });
});

test('resolveVerifyPolicy: --verify-strict with --verify-mode after is a conflict too', () => {
  const result = resolveVerifyPolicy({ verifyMode: 'after', legacyVerifyJev: true, legacyVerifyStrict: true, routeOnly: false });
  assert.ok('error' in result);
  assert.match(result.error, /--verify-strict conflicts with --verify-mode after/);
});

test('resolveVerifyPolicy: --route-only overrides --verify-mode after too', () => {
  assert.deepEqual(resolveVerifyPolicy({ verifyMode: 'after', legacyVerifyJev: false, legacyVerifyStrict: false, routeOnly: true }), { mode: 'off' });
});

test('resolveVerifyPolicy: --route-only resolves off regardless of any other flag', () => {
  assert.deepEqual(resolveVerifyPolicy({ legacyVerifyJev: false, legacyVerifyStrict: false, routeOnly: true }), { mode: 'off' });
  assert.deepEqual(resolveVerifyPolicy({ verifyMode: 'strict', legacyVerifyJev: true, legacyVerifyStrict: true, routeOnly: true }), { mode: 'off' });
});

test('resolveVerifyPolicy: legacy --verify jev alone means advisory, unchanged from before this play', () => {
  assert.deepEqual(resolveVerifyPolicy({ legacyVerifyJev: true, legacyVerifyStrict: false, routeOnly: false }), { mode: 'advisory' });
});

test('resolveVerifyPolicy: legacy --verify jev --verify-strict together still means strict', () => {
  assert.deepEqual(resolveVerifyPolicy({ legacyVerifyJev: true, legacyVerifyStrict: true, routeOnly: false }), { mode: 'strict' });
});

test('resolveVerifyPolicy: bare --verify-strict with no --verify jev and no --verify-mode still resolves strict', () => {
  // strict is the build default now, so this old (previously rejected) combination is no longer
  // a meaningful conflict — it asks for exactly what already happens.
  assert.deepEqual(resolveVerifyPolicy({ legacyVerifyJev: false, legacyVerifyStrict: true, routeOnly: false }), { mode: 'strict' });
});

test('resolveVerifyPolicy: --verify-strict with --verify-mode advisory is a conflict, not a silent pick', () => {
  const result = resolveVerifyPolicy({ verifyMode: 'advisory', legacyVerifyJev: true, legacyVerifyStrict: true, routeOnly: false });
  assert.ok('error' in result);
  assert.match(result.error, /--verify-strict conflicts with --verify-mode advisory/);
});

test('resolveVerifyPolicy: --verify-strict with --verify-mode off is a conflict too', () => {
  const result = resolveVerifyPolicy({ verifyMode: 'off', legacyVerifyJev: true, legacyVerifyStrict: true, routeOnly: false });
  assert.ok('error' in result);
  assert.match(result.error, /--verify-strict conflicts with --verify-mode off/);
});

test('resolveVerifyPolicy: --verify-strict with --verify-mode strict is not a conflict', () => {
  assert.deepEqual(
    resolveVerifyPolicy({ verifyMode: 'strict', legacyVerifyJev: true, legacyVerifyStrict: true, routeOnly: false }),
    { mode: 'strict' },
  );
});

test('preflightJevCredential: off never calls the resolver', async () => {
  let calls = 0;
  const result = await preflightJevCredential('off', async () => {
    calls += 1;
    throw new Error('should never be reached');
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 0);
});

test('preflightJevCredential: strict resolves the credential and reports ok on success', async () => {
  const result = await preflightJevCredential('strict', async () => 'fake-key');
  assert.deepEqual(result, { ok: true });
});

test('preflightJevCredential: advisory resolves the credential too, not just strict', async () => {
  const result = await preflightJevCredential('advisory', async () => 'fake-key');
  assert.deepEqual(result, { ok: true });
});

test('preflightJevCredential: after resolves the credential too — the check still runs, just later', async () => {
  const result = await preflightJevCredential('after', async () => 'fake-key');
  assert.deepEqual(result, { ok: true });
});

test('preflightJevCredential: a resolver failure fails closed with a clear reason, never the key', async () => {
  const result = await preflightJevCredential('strict', async () => {
    throw new Error('zsvault returned no value for typesafe_api_key');
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.error, /--verify-mode strict needs a Jev credential/);
  assert.match(result.error, /zsvault returned no value for typesafe_api_key/);
});

test('preflightJevCredential: advisory failure is reported the same way as strict', async () => {
  const result = await preflightJevCredential('advisory', async () => {
    throw new Error('network unreachable');
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.error, /--verify-mode advisory needs a Jev credential/);
});

test('createJevCredentialResolver: the environment variable wins, the vault is never called', async () => {
  let vaultCalls = 0;
  const resolver = createJevCredentialResolver({ [TYPESAFE_API_KEY_ENV]: 'env-key' }, async () => {
    vaultCalls += 1;
    return 'vault-key';
  });
  assert.equal(await resolver(), 'env-key');
  assert.equal(vaultCalls, 0);
});

test('createJevCredentialResolver: falls back to the vault when the environment variable is unset', async () => {
  let vaultCalls = 0;
  const resolver = createJevCredentialResolver({}, async () => {
    vaultCalls += 1;
    return 'vault-key';
  });
  assert.equal(await resolver(), 'vault-key');
  assert.equal(vaultCalls, 1);
});

test('createJevCredentialResolver: an empty or whitespace-only environment variable also falls back to the vault', async () => {
  for (const value of ['', '   ']) {
    let vaultCalls = 0;
    const resolver = createJevCredentialResolver({ [TYPESAFE_API_KEY_ENV]: value }, async () => {
      vaultCalls += 1;
      return 'vault-key';
    });
    assert.equal(await resolver(), 'vault-key');
    assert.equal(vaultCalls, 1);
  }
});

test('createJevCredentialResolver: a vault failure propagates as-is when the environment variable is unset', async () => {
  const resolver = createJevCredentialResolver({}, async () => {
    throw new Error('zsvault returned no value for typesafe_api_key');
  });
  await assert.rejects(resolver(), /zsvault returned no value for typesafe_api_key/);
});
