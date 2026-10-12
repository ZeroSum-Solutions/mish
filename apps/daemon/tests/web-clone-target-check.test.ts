import { describe, expect, it } from 'vitest';

import { webCloneTargetRefusal } from '../src/web-clone-target-check.js';
import { dnsError } from './helpers/web-clone-dns-stub.js';

// D15: a Website Clone target must resolve to a public address. The resolver is
// injected, so these cases make no real DNS query.
const METADATA = { kind: 'prototype', intent: 'web-clone' };
const BRIEF = 'Website URL to clone: https://clone-target.example';

describe('webCloneTargetRefusal resolver outcomes', () => {
  it('accepts a host that resolves to a public address', async () => {
    const lookup = async () => [{ address: '93.184.215.14' }];
    expect(await webCloneTargetRefusal(METADATA, BRIEF, lookup)).toBeNull();
  });

  it('refuses a host that does not resolve (ENOTFOUND)', async () => {
    const lookup = async (host: string) => { throw dnsError('ENOTFOUND', host); };
    expect(await webCloneTargetRefusal(METADATA, BRIEF, lookup)).toMatch(/not a public web address/);
  });

  it('refuses when the lookup itself errors (timeout / SERVFAIL)', async () => {
    const lookup = async (host: string) => { throw dnsError('ETIMEOUT', host); };
    expect(await webCloneTargetRefusal(METADATA, BRIEF, lookup)).toMatch(/not a public web address/);
    const servfail = async (host: string) => { throw dnsError('ESERVFAIL', host); };
    expect(await webCloneTargetRefusal(METADATA, BRIEF, servfail)).toMatch(/not a public web address/);
  });
});
