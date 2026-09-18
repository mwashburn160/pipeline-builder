// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time validation of the WebAuthn relying-party configuration.
 *
 * A passkey is bound to the RP ID it was created under, FOREVER: change the RP
 * ID and every credential already registered becomes unusable (the authenticator
 * simply won't offer it). There is no migration — which is exactly why the
 * values are derived from `PLATFORM_FRONTEND_URL` and never read from the
 * request. A `Host:`-derived RP ID would let anyone who can reach the service
 * mint challenges for a domain of their choosing.
 *
 * The rules below are the browser's own, asserted at boot rather than discovered
 * as an opaque `SecurityError` in the first user's ceremony:
 *   - the RP ID is a domain name, never an IP or a URL;
 *   - every accepted origin's host is the RP ID or a subdomain of it;
 *   - every origin is `https://`, with `http://localhost` (and `127.0.0.1`) the
 *     one carve-out browsers make for development.
 *
 * Deliberately dependency-free (no config import) so `config/index.ts` can call
 * it while it is still building `config`, and so tests can drive it directly.
 */

/** The RP settings a deployment signs and verifies passkey ceremonies with. */
export interface WebAuthnRpConfig {
  /** Effective relying-party id — the exact hostname, no port, no scheme. */
  rpID: string;
  /** User-visible name shown in the platform authenticator's prompt. */
  rpName: string;
  /** Origins a ceremony may come from (scheme + host + port). */
  origins: string[];
}

/** Hosts browsers treat as a secure context over plain http. */
const HTTP_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for a bare IPv4 / bracketed-IPv6 literal — never a valid RP ID. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

/** Whether `host` is the RP ID itself or a subdomain of it (the browser's rule). */
export function isRegistrableUnder(host: string, rpID: string): boolean {
  return host === rpID || host.endsWith(`.${rpID}`);
}

/**
 * Throw when the relying-party configuration would break (or silently weaken)
 * passkey ceremonies. Called at config load, so a misconfigured deploy fails to
 * boot instead of orphaning credentials later.
 */
export function assertWebAuthnConfig(cfg: WebAuthnRpConfig): void {
  const fail = (why: string): never => {
    throw new Error(
      `Invalid WebAuthn configuration: ${why}. RP ID is derived from `
      + 'PLATFORM_FRONTEND_URL (override with WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS). '
      + 'Note that changing the RP ID invalidates every passkey already registered.',
    );
  };

  if (!cfg.rpID) fail('the RP ID is empty');
  if (cfg.rpID.includes('/') || cfg.rpID.includes(':')) {
    fail(`the RP ID (${cfg.rpID}) must be a bare hostname — no scheme, path or port`);
  }
  if (isIpLiteral(cfg.rpID)) fail(`the RP ID (${cfg.rpID}) is an IP address, which browsers refuse`);
  if (!cfg.rpName) fail('the RP name is empty');
  if (cfg.origins.length === 0) fail('no origins are configured');

  for (const origin of cfg.origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return fail(`origin "${origin}" is not a URL`);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && HTTP_ALLOWED_HOSTS.has(url.hostname))) {
      fail(`origin "${origin}" must be https (only http://localhost is exempt)`);
    }
    if (!isRegistrableUnder(url.hostname, cfg.rpID)) {
      fail(`origin "${origin}" is not the RP ID (${cfg.rpID}) or a subdomain of it`);
    }
  }
}

/**
 * Derive the RP configuration from the frontend URL, honoring the optional
 * `WEBAUTHN_*` overrides. Split out of `config/index.ts` so the derivation is
 * unit-testable without re-importing the whole config module per case.
 *
 * The RP ID is the frontend's EXACT hostname (not the registrable parent
 * domain): a narrower RP ID can always be widened later by re-enrolling, while a
 * too-wide one hands every subdomain the ability to assert the credential.
 * Origins keep the port — `https://localhost:8443` and `https://localhost` are
 * different origins to the browser even though they share an RP ID.
 */
export function resolveWebAuthnConfig(env: NodeJS.ProcessEnv, frontendUrl: string): WebAuthnRpConfig {
  let host = '';
  let defaultOrigin = frontendUrl;
  try {
    const url = new URL(frontendUrl);
    host = url.hostname;
    defaultOrigin = url.origin;
  } catch {
    // Leave both unset-ish; assertWebAuthnConfig turns it into a boot failure
    // naming PLATFORM_FRONTEND_URL rather than a cryptic URL parse error.
  }
  const rpID = (env.WEBAUTHN_RP_ID || host).trim();
  const origins = (env.WEBAUTHN_ORIGINS || defaultOrigin)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    rpID,
    rpName: env.WEBAUTHN_RP_NAME || 'Pipeline Builder',
    origins,
  };
}
