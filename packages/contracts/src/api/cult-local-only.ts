// Remix into project: the one rule that decides whether a request may receive licensed Cult UI Pro
// source (`GET /api/cult/r/*`, `GET /api/cult/copy/*`). It is pure so the daemon route and the web
// sidecar's tests apply the very same decision (docs/legal/cult-ui-pro-rights.md).
//
// A request is served only when it provably comes from this machine:
// - the TCP peer is loopback, the Host header names a loopback host, and any Origin is a loopback
//   origin;
// - every client a forwarding header names (`X-Forwarded-For`, `Forwarded: for=`) is loopback. The
//   web sidecar proxy appends the client it accepted to `X-Forwarded-For` on every request, so a
//   LAN browser behind it is named here;
// - no forwarding header carries host, scheme or port information (`X-Forwarded-Host`,
//   `X-Forwarded-Proto`, `X-Forwarded-Port`, `Forwarded: host=/proto=`). A proxy that sends those
//   relays a Host the client chose (Next's dev rewrite proxy sets `X-Forwarded-Host` from the
//   client's Host and passes a client-sent `X-Forwarded-For` through untouched), so nothing it
//   says about the client can be trusted. Our own sidecar sends none of them, and neither do a
//   browser, `npx shadcn` or `od` talking to this machine directly.
//
// - the Host the browser asked the web sidecar for (`X-OD-Client-Host`, which the sidecar always
//   overwrites with the Host it received, because it sends the daemon's own Host upstream) names a
//   loopback host. Without it a page that DNS-rebinds its own name to 127.0.0.1 reaches the sidecar
//   from a loopback peer, and the sidecar's rewritten Host would hide the foreign name.
//
// Limit: a TCP-level forwarder (`ssh -R`, `socat`, `ngrok tcp`) that terminates on this machine
// hands over a plain loopback connection with no header at all; no rule here can detect it.

/** The request header the web sidecar sets to the Host its client asked for (see above). */
export const CULT_CLIENT_HOST_HEADER = 'x-od-client-host';

export interface CultLocalRequest {
  /** The TCP peer address (`req.socket.remoteAddress`). */
  peer: string | undefined;
  /** Reads one request header (case-insensitive), `undefined` when absent. */
  header: (name: string) => string | undefined;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isLoopbackIpv4(value: string): boolean {
  const match = IPV4.exec(value);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255) && match[1] === '127';
}

/** `127.0.0.0/8`, `::1` (any spelling), `::ffff:127.x.y.z`, and `localhost`. */
export function isLoopbackAddress(raw: string): boolean {
  const value = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (value.startsWith('::ffff:')) return isLoopbackIpv4(value.slice('::ffff:'.length));
  return isLoopbackIpv4(value);
}

/** A `host[:port]` / `[v6]:port` / `"quoted"` node → its bare host or address. */
function bareHost(raw: string): string {
  const node = raw.trim().replace(/^"|"$/g, '');
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(node);
  if (bracketed) return bracketed[1] ?? '';
  const withPort = /^([^:]+):\d+$/.exec(node);
  return withPort ? (withPort[1] ?? '') : node;
}

function isLoopbackOrigin(origin: string): boolean {
  const match = /^https?:\/\/(\[[^\]]+\]|[^/:?#@]+)(?::\d+)?\/?$/i.exec(origin.trim());
  return match !== null && isLoopbackAddress(match[1] ?? '');
}

/** Null when the request may receive licensed source; otherwise the reason it may not. */
export function cultLocalOnlyRefusal(req: CultLocalRequest): string | null {
  if (req.peer === undefined || !isLoopbackAddress(req.peer)) return 'the request peer is not loopback';
  const host = req.header('host');
  if (host === undefined || !isLoopbackAddress(bareHost(host))) return 'the Host header is not a loopback host';
  const origin = req.header('origin');
  if (origin !== undefined && !isLoopbackOrigin(origin)) return 'the Origin is not a loopback origin';
  const clientHost = req.header(CULT_CLIENT_HOST_HEADER);
  if (clientHost !== undefined && !isLoopbackAddress(bareHost(clientHost))) return 'the browser asked the web proxy for a host that is not loopback';

  for (const name of ['x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port']) {
    if (req.header(name) !== undefined) return `a proxy relayed it with ${name}, which carries a client-chosen Host`;
  }
  const clients: string[] = [];
  const xff = req.header('x-forwarded-for');
  if (xff !== undefined) clients.push(...xff.split(','));
  const forwarded = req.header('forwarded');
  if (forwarded !== undefined) {
    for (const pair of forwarded.split(/[;,]/)) {
      const eq = pair.indexOf('=');
      const key = (eq < 0 ? pair : pair.slice(0, eq)).trim().toLowerCase();
      if (key === 'for') clients.push(pair.slice(eq + 1));
      else if (key === 'host' || key === 'proto') return `a proxy relayed it with Forwarded ${key}=, which carries a client-chosen Host`;
    }
  }
  if (clients.some((client) => !isLoopbackAddress(bareHost(client)))) return 'a forwarded client is not loopback';
  return null;
}
