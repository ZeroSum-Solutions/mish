// One IP classifier for every daemon path that dials a URL it did not
// hard-code (outbound SSRF guard). Pure TypeScript: no `node:net`, so the web
// app and the daemon share the exact same table.
//
// Invariant: an address is `public` only when it is globally routable unicast.
// Every special-purpose range below is `refused`, and so is every IPv6 form
// that embeds or translates to an IPv4 address (compat, NAT64, 6to4, Teredo,
// SIIT). An IPv4-mapped address (`::ffff:a.b.c.d`) dials that IPv4, so it takes
// the IPv4 class. 127/8 and ::1 are `loopback`; callers decide whether a
// user-typed endpoint may use loopback. Anything that is not an IP literal
// (a hostname, a zone id, a malformed literal) is `refused`: a caller must
// resolve a name first and classify each answer.

export type IpClass = 'public' | 'loopback' | 'refused';

export interface ParsedIp {
  family: 4 | 6;
  /** IPv4: four octets. IPv6: eight 16-bit groups. */
  groups: number[];
}

function normalizeIpText(text: string): string {
  let host = String(text).trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // FQDN form: one trailing dot is the same host.
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function parseIpv4Octets(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Strict dotted decimal. A leading zero is octal to some resolvers and
    // decimal to others, so it is not an IP we can classify.
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function parseIpv6Groups(text: string): number[] | null {
  if (!text.includes(':') || text.includes('%')) return null;
  let body = text;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d+(?:\.\d+){3})$/.exec(body);
  if (dotted) {
    const octets = parseIpv4Octets(dotted[2] ?? '');
    if (!octets) return null;
    tail.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
    const head = dotted[1] ?? '';
    body = head.endsWith('::') ? head : head.slice(0, -1);
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (half === '') return [];
    const out: number[] = [];
    for (const group of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = parseHalf(halves[0] ?? '');
  const right = halves.length === 2 ? parseHalf(halves[1] ?? '') : [];
  if (!left || !right) return null;
  const known = left.length + right.length + tail.length;
  if (halves.length === 1) {
    return known === 8 ? [...left, ...tail] : null;
  }
  if (known > 7) return null;
  return [...left, ...new Array<number>(8 - known).fill(0), ...right, ...tail];
}

/**
 * Parse an IP literal. Strips `[ ]`, lowercases and strips one trailing dot.
 * Accepts strict dotted-decimal IPv4 and IPv6 with `::` and a dotted IPv4
 * tail. Returns null for a hostname, a zone id (`fe80::1%en0`) or bad input.
 */
export function parseIp(text: string): ParsedIp | null {
  if (typeof text !== 'string') return null;
  const host = normalizeIpText(text);
  if (!host) return null;
  if (host.includes(':')) {
    const groups = parseIpv6Groups(host);
    return groups ? { family: 6, groups } : null;
  }
  const octets = parseIpv4Octets(host);
  return octets ? { family: 4, groups: octets } : null;
}

type Cidr = { bits: number[]; prefix: number; width: 8 | 16 };

function toBits(groups: number[], width: 8 | 16): number[] {
  const bits: number[] = [];
  for (const group of groups) {
    for (let shift = width - 1; shift >= 0; shift -= 1) bits.push((group >> shift) & 1);
  }
  return bits;
}

function cidr(network: string, prefix: number): Cidr {
  const parsed = parseIp(network);
  if (!parsed) throw new Error(`ip-policy: bad network ${network}`);
  const width = parsed.family === 4 ? 8 : 16;
  return { bits: toBits(parsed.groups, width), prefix, width };
}

function inCidr(bits: number[], range: Cidr): boolean {
  for (let i = 0; i < range.prefix; i += 1) {
    if (bits[i] !== range.bits[i]) return false;
  }
  return true;
}

/** IPv4 special-purpose ranges that are never dialled (127/8 is handled as loopback). */
const REFUSED_V4: readonly Cidr[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
].map(([network, prefix]) => cidr(network as string, prefix as number));

const LOOPBACK_V4 = cidr('127.0.0.0', 8);

/** IPv6 special-purpose ranges inside or outside 2000::/3 that are never dialled. */
const REFUSED_V6: readonly Cidr[] = [
  ['::ffff:0:0:0', 96], // SIIT IPv4-translated
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['64:ff9b:1::', 48], // NAT64 local-use prefix
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:2::', 48], // benchmarking
  ['2001:10::', 28], // ORCHID
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment routing SIDs
  ['fc00::', 7], // unique local (includes fd00:ec2::254 metadata)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
].map(([network, prefix]) => cidr(network as string, prefix as number));

const GLOBAL_UNICAST_V6 = cidr('2000::', 3);
const MAPPED_V6 = cidr('::ffff:0:0', 96);
const COMPAT_V6 = cidr('::', 96);

function classifyIpv4(octets: number[]): IpClass {
  const bits = toBits(octets, 8);
  if (inCidr(bits, LOOPBACK_V4)) return 'loopback';
  return REFUSED_V4.some((range) => inCidr(bits, range)) ? 'refused' : 'public';
}

function classifyIpv6(groups: number[]): IpClass {
  const bits = toBits(groups, 16);
  if (inCidr(bits, MAPPED_V6)) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return classifyIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return 'loopback';
  // ::, and the deprecated IPv4-compatible ::a.b.c.d.
  if (inCidr(bits, COMPAT_V6)) return 'refused';
  if (REFUSED_V6.some((range) => inCidr(bits, range))) return 'refused';
  // Only global unicast is ever dialled; everything else is reserved.
  return inCidr(bits, GLOBAL_UNICAST_V6) ? 'public' : 'refused';
}

/**
 * Classify an IP literal for outbound fetches: `public`, `loopback` or
 * `refused`. See the module invariant. A string that is not an IP literal is
 * `refused`.
 */
export function classifyIp(text: string): IpClass {
  const parsed = parseIp(text);
  if (!parsed) return 'refused';
  return parsed.family === 4 ? classifyIpv4(parsed.groups) : classifyIpv6(parsed.groups);
}
