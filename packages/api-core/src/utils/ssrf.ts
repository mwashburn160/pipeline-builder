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
 * DNS-rebinding note: the up-front resolve validates the *initial* host only.
 * Node's global `fetch` (undici) re-resolves DNS for a redirect target
 * independently, so callers MUST send with `redirect: 'manual'` and treat any
 * 3xx as a failed delivery — see {@link SSRF_FETCH_INIT}. Pinning the exact
 * resolved IP for the connection would need a custom undici dispatcher (not a
 * dependency here); refusing redirects closes the practical rebinding pivot.
 */

import { lookup } from 'dns/promises';
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
 * Reject a URL that is malformed, uses a disallowed protocol, or points at a
 * private/loopback/link-local/metadata address (by IP literal or by DNS
 * resolution). Throws a plain `Error` with a caller-safe message on rejection;
 * resolves silently when the URL is safe to fetch.
 */
export async function assertSafeUrl(rawUrl: string, opts: SafeUrlOptions = {}): Promise<void> {
  const protocols = opts.protocols ?? ['https:'];
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error('invalid url'); }
  if (!protocols.includes(u.protocol)) {
    throw new Error(`url must use ${protocols.map((p) => p.replace(/:$/, '')).join('/')}`);
  }
  const host = u.hostname;
  if (isIP(host) && isPrivateAddress(host)) throw new Error('url targets a private address');
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new Error('url host did not resolve'); }
  if (addrs.length === 0) throw new Error('url host did not resolve');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('url resolves to a private address');
}

/**
 * `fetch` init fragment every SSRF-guarded call MUST spread so a redirect can't
 * pivot to an unvalidated (and re-resolved) host. Callers treat a 3xx / opaque
 * redirect response as a failed delivery rather than following it.
 */
export const SSRF_FETCH_INIT = { redirect: 'manual' as const };

/** True when a `fetch` Response is (or was) a redirect the caller must refuse. */
export function isRefusedRedirect(resp: { type?: string; status: number }): boolean {
  return resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400);
}
