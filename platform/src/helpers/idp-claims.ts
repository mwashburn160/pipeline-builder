// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GROUP-claim extraction for just-in-time provisioning.
 *
 * Kept dependency-free (no models, no config) so both ends can use it: the OIDC
 * engine reads groups off a validated `id_token`, and the SCIM group endpoints
 * normalize the group names they are handed through the SAME rules, so a
 * group spelled `Engineering` by one protocol and `engineering` by the other
 * resolves to one mapping.
 */

/** Claim consulted when the org's IdP config names none. */
export const DEFAULT_GROUPS_CLAIM = 'groups';

/** Longest group value we will consider. A hostile IdP could otherwise push
 *  arbitrarily long strings through the mapping lookup and into audit details. */
const MAX_GROUP_LEN = 256;

/** Most groups any one token may carry. Beyond this the extras are dropped —
 *  the mapping query is bounded rather than growing with an IdP's directory. */
const MAX_GROUPS = 100;

/**
 * The lookup key for a group value: trimmed and lowercased.
 *
 * IdPs are inconsistent about case (`Engineering` from one connection,
 * `engineering` from another), so matching is case-insensitive — and the mapping
 * collection stores this key with a unique index so an org cannot register both
 * spellings and get a different Role set depending on which one the IdP sent.
 */
export function groupKey(group: string): string {
  return group.trim().toLowerCase();
}

/**
 * Whether a provider can carry group claims at all.
 *
 * Google is the documented exception for the first release: its OIDC id_tokens
 * carry no group claim (group data lives behind the Workspace Admin SDK, a
 * different credential entirely), so a mapping configured there could only ever
 * match nothing. `github` is not an OpenID provider and never reaches this path.
 */
export function providerSupportsGroups(provider: string): boolean {
  return provider !== 'google' && provider !== 'github';
}

/**
 * Read the group list out of a validated id_token's claims.
 *
 * Accepts the two shapes IdPs actually emit for `claimName`:
 *   - an ARRAY of strings (Okta, Keycloak, Cognito's `cognito:groups`);
 *   - a single space- or comma-separated STRING (some SAML-bridged OIDC
 *     connections, and `scope`-style encodings).
 * Anything else (a number, an object, a nested array) yields no groups rather
 * than a coerced value — a mapping must never be driven by a claim we had to
 * guess at. Values are trimmed, de-duplicated case-insensitively, length-capped
 * and count-capped.
 *
 * The returned values keep the IdP's original spelling (they are echoed into the
 * audit trail); match with {@link groupKey}.
 */
export function extractGroupClaim(
  claims: Record<string, unknown> | null | undefined,
  claimName?: string,
): string[] {
  if (!claims) return [];
  const raw = claims[(claimName ?? DEFAULT_GROUPS_CLAIM).trim() || DEFAULT_GROUPS_CLAIM];

  let candidates: unknown[];
  if (Array.isArray(raw)) candidates = raw;
  else if (typeof raw === 'string') candidates = raw.split(/[\s,]+/);
  else return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_GROUP_LEN) continue;
    const key = groupKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}
