// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Issuers the platform treats as AUTHORITIES for the addresses they sign in —
 * today only Google. An identity from one of them is trusted without the org
 * having DNS-verified the email's domain (see `assertSsoIdentityTrusted`), so
 * that trust must never be reachable through an admin-run IdP:
 *
 *   - the Google carve-out applies only to `provider: 'google'` over OIDC, whose
 *     discovery document is the hard-coded {@link GOOGLE_DISCOVERY_URL} (a custom
 *     discoveryUrl for Google is refused);
 *   - a generic OIDC discovery URL on a reserved host, a SAML entity id equal to
 *     a reserved issuer, or a runtime discovery/assertion issuer equal to one is
 *     refused — an attacker-run discovery document can claim ANY `issuer` it
 *     likes, and a SAML IdP's entity id is whatever the admin typed.
 *
 * Pure (no models) so the request validators can share it.
 */

/** Google's OIDC issuer, exactly as its discovery document states it. */
export const GOOGLE_ISSUER = 'https://accounts.google.com';

/** The ONLY discovery document a `provider: 'google'` config is resolved from. */
export const GOOGLE_DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';

/** Hosts whose issuer identity is reserved. */
const RESERVED_ISSUER_HOSTS = new Set(['accounts.google.com']);

/** Strip scheme + trailing slashes and lowercase, so `accounts.google.com`,
 *  `https://accounts.google.com/` and `HTTPS://Accounts.Google.com` compare equal. */
function normalizeIssuer(value: string): string {
  return value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/+$/, '');
}

/**
 * Whether `issuer` IS a reserved issuer (Google's `iss` comes in both the
 * `https://accounts.google.com` and bare `accounts.google.com` forms). A path
 * under the host — e.g. Google Workspace's SAML entity id
 * `https://accounts.google.com/o/saml2?idpid=…` — is NOT the OIDC issuer and
 * stays usable; it simply gets no carve-out (domain verification applies).
 */
export function isReservedIssuer(issuer: string | undefined | null): boolean {
  if (!issuer) return false;
  return RESERVED_ISSUER_HOSTS.has(normalizeIssuer(issuer));
}

/** Whether a (generic OIDC) discovery URL points at a reserved issuer host. */
export function isReservedDiscoveryUrl(discoveryUrl: string | undefined | null): boolean {
  if (!discoveryUrl) return false;
  try {
    return RESERVED_ISSUER_HOSTS.has(new URL(discoveryUrl.trim()).hostname.toLowerCase());
  } catch {
    // Not a URL at all — let the host check of a bare value decide.
    return RESERVED_ISSUER_HOSTS.has(normalizeIssuer(discoveryUrl).split('/')[0] ?? '');
  }
}

/** Whether a `provider: 'google'` config carries a discoveryUrl other than the canonical one. */
export function isCustomGoogleDiscoveryUrl(discoveryUrl: string | undefined | null): boolean {
  const v = discoveryUrl?.trim();
  return !!v && v.replace(/\/+$/, '') !== GOOGLE_DISCOVERY_URL;
}
