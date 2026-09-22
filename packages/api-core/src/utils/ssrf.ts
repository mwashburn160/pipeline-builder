// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared SSRF guard for user/tenant-supplied outbound URLs (webhook targets,
 * callbacks, …). Promoted to api-core so every service that lets an org point
 * the platform at an arbitrary URL enforces the SAME denylist instead of each
 * re-deriving it (the compliance notifier and the platform alert relay both
 * consume this).
 *
 * The guard resolves the host up front and rejects any address that is — or
 * resolves to — a loopback / private / link-local / unique-local / carrier-grade
 * NAT / cloud-metadata range, so a tenant can't aim a webhook at
 * `169.254.169.254` or an in-cluster service.
 *
 * TWO POSTURES, ONE SURVIVOR. `assertSafeUrl` only *validates* a URL: it
 * resolves the host, checks the addresses and then throws the hostname away.
 * Anything that goes on to `fetch(url)` re-resolves DNS and can therefore be
 * pointed at a private address between the check and the connect (classic
 * DNS rebinding). {@link safeFetch} is the posture that actually holds: it
 * resolves, PINS the vetted IP into the socket's `lookup`, refuses redirects,
 * and caps both the response size and the wall-clock time.
 *
 * So: use {@link safeFetch} for every outbound request to a user/tenant-supplied
 * URL. `assertSafeUrl` is for NON-FETCH validation only — rejecting a bad URL at
 * create/update time before it is ever stored. Never pair it with `fetch`.
 */

import { lookup } from 'dns/promises';
import { request as httpRequest } from 'http';
import { request as httpsRequest, type RequestOptions } from 'https';
import { isIP } from 'net';

/** IPv4 ranges that are NOT publicly routable unicast: [first octets as a 32-bit int, prefix length]. */
const IPV4_NON_GLOBAL: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments (incl. 192.0.0.192 metadata on some clouds)
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255 broadcast
];

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
}

const IPV4_NON_GLOBAL_INT = IPV4_NON_GLOBAL.map(([base, bits]) => [ipv4ToInt(base)!, bits] as const);

function isNonGlobalV4(n: number): boolean {
  return IPV4_NON_GLOBAL_INT.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    return n >= base && n < base + size;
  });
}

/** Parse an IPv6 literal into its eight 16-bit groups (null when malformed). */
function parseIpv6(ip: string): number[] | null {
  let addr = ip.split('%')[0]; // drop a zone id (fe80::1%eth0)
  // An embedded dotted IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) → two groups.
  const tail = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (tail) {
    const n = ipv4ToInt(tail[1]);
    if (n === null) return null;
    addr = `${addr.slice(0, -tail[1].length)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const zeros = 8 - head.length - rest.length;
  if (zeros < 1) return null;
  return [...head, ...new Array<number>(zeros).fill(0), ...rest];
}

const v4FromGroups = (hi: number, lo: number): number => hi * 65536 + lo;

/**
 * True for any address that is NOT publicly routable unicast — the ranges an
 * outbound tenant webhook must never reach.
 *
 * An ALLOWLIST, not a denylist: an IPv6 address is acceptable only inside the
 * global-unicast block `2000::/3` (so link-local `fe80::/10`, site-local
 * `fec0::/10`, unique-local `fc00::/7`, multicast, loopback, unspecified and
 * every future special range are refused by default). Formats that EMBED an
 * IPv4 address are unwrapped and judged by that address — IPv4-mapped
 * `::ffff:0:0/96` (dotted or hex), NAT64 `64:ff9b::/96` and 6to4 `2002::/16` —
 * so `::ffff:7f00:1` or `2002:a9fe:a9fe::` can't smuggle loopback or the
 * metadata endpoint past the check. Anything unparseable is refused.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = ipv4ToInt(addr);
  if (v4 !== null) return isNonGlobalV4(v4);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return true; // out-of-range octet

  const g = parseIpv6(addr);
  if (!g) return true; // not an address we can reason about → refuse

  // IPv4-mapped ::ffff:a.b.c.d
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isNonGlobalV4(v4FromGroups(g[6], g[7]));
  }
  // NAT64 well-known prefix 64:ff9b::/96 — the target is the embedded IPv4.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isNonGlobalV4(v4FromGroups(g[6], g[7]));
  }
  // 6to4 2002:V4HI:V4LO::/48 — the tunnel endpoint is the embedded IPv4.
  if (g[0] === 0x2002) return isNonGlobalV4(v4FromGroups(g[1], g[2]));

  // Only global unicast 2000::/3 from here on.
  if (g[0] < 0x2000 || g[0] > 0x3fff) return true;
  // …minus its special-purpose carve-outs:
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID…)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // 3fff::/20 documentation
  return false;
}

/** Options for {@link assertSafeUrl}. */
export interface SafeUrlOptions {
  /** Allowed URL protocols (default: `['https:']`). */
  protocols?: string[];
}

/**
 * A DNS-resolved, SSRF-vetted target to connect to by PINNED IP.
 */
export interface PinnedTarget {
  /** Original hostname — preserved for the Host header and TLS SNI. */
  host: string;
  /** The exact validated IP the socket must connect to (no re-resolution). */
  address: string;
  family: number;
  port: number;
  /** `'https:'` or `'http:'`. */
  protocol: string;
}

/**
 * Resolve and vet an outbound URL, returning the pinned target to connect to.
 *
 * Rejects a URL that is malformed, uses a disallowed protocol, or points at a
 * private/loopback/link-local/metadata address (by IP literal or by DNS
 * resolution). Rejects if ANY resolution is private (defence in depth), then
 * pins the first vetted address so the connection can never reach an address
 * this function did not approve.
 */
export async function resolveSafeTarget(rawUrl: string, opts: SafeUrlOptions = {}): Promise<PinnedTarget> {
  const protocols = opts.protocols ?? ['https:'];
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error('invalid url'); }
  if (!protocols.includes(u.protocol)) {
    throw new Error(`url must use ${protocols.map((p) => p.replace(/:$/, '')).join('/')}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? Number(u.port) : (u.protocol === 'http:' ? 80 : 443);
  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isPrivateAddress(host)) throw new Error('url targets a private address');
    return { host, address: host, family: literalFamily, port, protocol: u.protocol };
  }
  let addrs: { address: string; family: number }[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new Error('url host did not resolve'); }
  if (addrs.length === 0) throw new Error('url host did not resolve');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('url resolves to a private address');
  return { host, address: addrs[0].address, family: addrs[0].family, port, protocol: u.protocol };
}

/**
 * VALIDATION ONLY — never pair this with a `fetch`.
 *
 * Resolves the host and throws when the URL is malformed, uses a disallowed
 * protocol, or resolves to a private/loopback/link-local/metadata address. Use
 * it to reject a bad URL at create/update time (before it is stored), or in any
 * other place where nothing is about to connect. For an actual outbound request
 * use {@link safeFetch}, which pins the address it vetted — validating here and
 * then letting `fetch` re-resolve is a DNS-rebinding TOCTOU hole.
 */
export async function assertSafeUrl(rawUrl: string, opts: SafeUrlOptions = {}): Promise<void> {
  await resolveSafeTarget(rawUrl, opts);
}

/** Default wall-clock cap for one {@link safeFetch} request. */
export const SAFE_FETCH_TIMEOUT_MS = 10_000;
/** Default response-body cap for {@link safeFetch} (5 MiB). */
export const SAFE_FETCH_MAX_BYTES = 5 * 1024 * 1024;

/** Options for {@link safeFetch}. */
export interface SafeFetchOptions extends SafeUrlOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Caller abort (composed with `timeoutMs`). */
  signal?: AbortSignal;
  /** Wall-clock cap for the whole request (default {@link SAFE_FETCH_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Body-size cap; exceeding it aborts and throws (default {@link SAFE_FETCH_MAX_BYTES}). */
  maxResponseBytes?: number;
}

/** Normalized response from {@link safeFetch}. */
export interface SafeFetchResponse {
  /** True only for a 2xx. A refused redirect is never `ok`. */
  ok: boolean;
  status: number;
  statusText: string;
  /** True when the origin answered with a 3xx — REFUSED, never followed. */
  redirected: boolean;
  headers: Record<string, string>;
  /** Raw body bytes (empty for a refused redirect, whose body is discarded). */
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

/**
 * SSRF-safe outbound request to a user/tenant-supplied URL.
 *
 * - resolves + vets the host, then PINS the exact validated IP into the socket
 *   `lookup` so `net.connect` never re-resolves — this is what defeats DNS
 *   rebinding. SNI + Host stay the original hostname so TLS verification is
 *   unchanged.
 * - REFUSES redirects: `http(s).request` never follows one, and a 3xx comes back
 *   as `{ redirected: true, ok: false }` for the caller to record as a failure.
 * - caps the response body ({@link SafeFetchOptions.maxResponseBytes}) and the
 *   wall clock ({@link SafeFetchOptions.timeoutMs}).
 *
 * Throws on a rejected URL, a transport error, a timeout, or an oversized body.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const maxBytes = opts.maxResponseBytes ?? SAFE_FETCH_MAX_BYTES;
  const pin = await resolveSafeTarget(rawUrl, opts);
  const u = new URL(rawUrl);
  const body = opts.body === undefined
    ? undefined
    : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8'));

  // Compose the caller's abort with our own deadline so whichever fires first wins.
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  const options: RequestOptions = {
    method: opts.method ?? 'GET',
    hostname: pin.host,
    port: pin.port,
    path: `${u.pathname}${u.search}`,
    servername: pin.protocol === 'https:' ? pin.host : undefined,
    signal,
    headers: {
      ...opts.headers,
      ...(body ? { 'Content-Length': String(body.byteLength) } : {}),
    },
    // Pin the vetted IP: net.connect uses this instead of re-resolving the host.
    lookup: ((_hostname: string, _lookupOpts: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
      cb(null, pin.address, pin.family);
    }) as unknown as RequestOptions['lookup'],
  };

  const send = pin.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<SafeFetchResponse>((resolve, reject) => {
    const clientReq = send(options, (res) => {
      const status = res.statusCode ?? 0;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      const redirected = status >= 300 && status < 400;
      if (redirected) {
        // Never follow, never buffer — drain so the socket can be released.
        res.resume();
        res.on('end', () => resolve(makeResponse(status, res.statusMessage, headers, Buffer.alloc(0), true)));
        res.on('error', reject);
        return;
      }
      // Early reject on a declared oversize before buffering anything.
      const declared = Number(headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        reject(new Error(`Response body exceeds ${maxBytes} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > maxBytes) {
          res.destroy();
          reject(new Error(`Response body exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(makeResponse(status, res.statusMessage, headers, Buffer.concat(chunks), false)));
      res.on('error', reject);
    });
    clientReq.on('error', reject);
    clientReq.end(body);
  });
}

function makeResponse(
  status: number,
  statusText: string | undefined,
  headers: Record<string, string>,
  body: Buffer,
  redirected: boolean,
): SafeFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusText ?? '',
    redirected,
    headers,
    body,
    text: () => body.toString('utf8'),
    json: <T>() => JSON.parse(body.toString('utf8')) as T,
  };
}
