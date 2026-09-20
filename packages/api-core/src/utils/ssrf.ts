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

/**
 * True for loopback / private / link-local / CGNAT / cloud-metadata / ULA
 * addresses — the ranges an outbound tenant webhook must never reach.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254) // link-local incl. 169.254.169.254 metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127); // CGNAT
  }
  if (addr === '::1' || addr === '::') return true;
  if (addr.startsWith('::ffff:')) {
    const suffix = addr.slice(7);
    // Dotted form (`::ffff:127.0.0.1`) — recurse straight into the v4 checks.
    if (suffix.includes('.')) return isPrivateAddress(suffix);
    // Hex form (`::ffff:7f00:1` = 127.0.0.1, `::ffff:c0a8:1` = 192.168.0.1):
    // the low 32 bits are written as the last one/two hex groups. Fold them into
    // a dotted quad and recurse so the v4 ranges below still catch it — without
    // this the hex form slips past every check and reaches loopback/private space.
    const groups = suffix.split(':');
    const high = parseInt(groups[groups.length - 2] ?? '0', 16);
    const low = parseInt(groups[groups.length - 1] ?? '0', 16);
    if (Number.isNaN(high) || Number.isNaN(low)) return false;
    // Fold each 16-bit half into two octets (arithmetic, not bitwise, to satisfy
    // the no-bitwise lint): high → a.b, low → c.d.
    const dotted = `${Math.floor(high / 256) % 256}.${high % 256}.${Math.floor(low / 256) % 256}.${low % 256}`;
    return isPrivateAddress(dotted);
  }
  return addr.startsWith('fc') || addr.startsWith('fd') // unique-local
    || addr.startsWith('fe80'); // link-local
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
