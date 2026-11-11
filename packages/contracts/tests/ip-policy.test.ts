import { beforeAll, describe, expect, it } from 'vitest';
import {
  isBlockedExternalApiHostname,
  isLoopbackApiHost,
  validateBaseUrl,
} from '../src/api/connectionTest';

// The outbound SSRF predicate matrix. Every address below must never be
// dialled by a daemon path that fetches a URL it did not hard-code. IPv6 forms
// that embed or translate an IPv4 (compat, NAT64, 6to4, Teredo, SIIT) reach
// that IPv4 on hosts that route them, so they are refused outright.
const REFUSED = [
  '10.0.0.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '198.18.0.1',
  '192.0.0.1',
  '192.0.2.1',
  '192.88.99.1',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::ffff:a9fe:a9fe',
  '::ffff:10.0.0.1',
  '::7f00:1',
  '::a9fe:a9fe',
  '::127.0.0.1',
  '64:ff9b::7f00:1',
  '64:ff9b::a9fe:a9fe',
  '64:ff9b::808:808',
  '64:ff9b:1::a9fe:a9fe',
  '2002:7f00:1::',
  '2002:a9fe:a9fe::',
  '2002:5db8:d822::1',
  '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  '2001:2::1',
  '2001:10::1',
  '2001:20::1',
  '2001:db8::1',
  '100::1',
  '3fff::1',
  '5f00::1',
  'fd00:ec2::254',
  'fc00::1',
  'fe80::1',
  'fec0::1',
  '::ffff:0:7f00:1',
  'ff02::1',
  '4000::1',
  'fe80::1%en0',
  'not-an-ip',
  '',
];

const LOOPBACK = ['127.0.0.1', '127.8.8.8', '::1', '[::1]', '::ffff:7f00:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:127.0.0.1'];

const PUBLIC = ['8.8.8.8', '2606:4700:4700::1111', '::ffff:93.184.216.34', '[2a00:1450:4001:80b::200e]', '93.184.216.34.'];

describe('classifyIp', () => {
  let ipPolicy: typeof import('../src/api/ip-policy');
  beforeAll(async () => {
    ipPolicy = await import('../src/api/ip-policy');
  });

  it.each(REFUSED)('refuses %s', (address) => {
    expect(ipPolicy.classifyIp(address)).toBe('refused');
  });

  it.each(LOOPBACK)('classifies %s as loopback', (address) => {
    expect(ipPolicy.classifyIp(address)).toBe('loopback');
  });

  it.each(PUBLIC)('allows public %s', (address) => {
    expect(ipPolicy.classifyIp(address)).toBe('public');
  });

  it('parses IPv6 compression, a dotted IPv4 tail, brackets, case and one trailing dot', () => {
    expect(ipPolicy.parseIp('[::FFFF:1.2.3.4]')).toEqual({ family: 6, groups: [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304] });
    expect(ipPolicy.parseIp('10.0.0.1.')).toEqual({ family: 4, groups: [10, 0, 0, 1] });
    expect(ipPolicy.parseIp('example.com')).toBeNull();
    expect(ipPolicy.parseIp('fe80::1%lo0')).toBeNull();
    expect(ipPolicy.parseIp('010.0.0.1')).toBeNull();
    expect(ipPolicy.parseIp('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
});

describe('contracts host predicates on the shared classifier', () => {
  it.each([
    '::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:a9fe:a9fe::',
    '2001:0:4136::1',
    'fec0::1',
    '198.18.0.1',
    '::ffff:0:7f00:1',
    'ff02::1',
  ])('isBlockedExternalApiHostname(%s) is true', (host) => {
    expect(isBlockedExternalApiHostname(host)).toBe(true);
  });

  it('keeps names unblocked (callers resolve them) and loopback out of the blocked set', () => {
    expect(isBlockedExternalApiHostname('api.openai.com')).toBe(false);
    expect(isBlockedExternalApiHostname('127.0.0.1')).toBe(false);
    expect(isBlockedExternalApiHostname('8.8.8.8')).toBe(false);
  });

  it.each(['localhost', 'localhost.', 'LOCALHOST', '127.0.0.1', '[::1]', '::ffff:7f00:1'])('isLoopbackApiHost(%s) is true', (host) => {
    expect(isLoopbackApiHost(host)).toBe(true);
  });

  it('validateBaseUrl refuses IPv6 transition forms of metadata and loopback', () => {
    for (const url of ['http://[::a9fe:a9fe]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:a9fe:a9fe::]/', 'https://198.18.0.1/']) {
      expect(validateBaseUrl(url).forbidden).toBe(true);
    }
  });
});
