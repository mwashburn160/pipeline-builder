// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org authenticator policy — an allowlist of passkey MODELS (AAGUIDs).
 *
 * REGISTRATION. A member whose active org (or an ancestor) sets an allowlist
 * registers passkeys under DIRECT attestation, verified against the FIDO
 * Metadata Service (`services/fido-mds.ts`); a model that is not allowlisted,
 * whose attestation can't be verified, or that MDS reports compromised is
 * refused.
 *
 * SIGN-IN — DOESN'T COUNT, RATHER THAN REFUSED. A passkey that is not on the
 * active org's list still identifies its owner, but in that org it counts as
 * `aal: 1`, so it cannot satisfy the org's MFA requirement (an org that
 * enforces MFA therefore refuses the session at issuance, exactly as for a
 * password alone). Refusing the sign-in outright was rejected: passkeys that
 * predate the policy would lock out passkey-only accounts in EVERY org they
 * belong to, including orgs with no allowlist at all — and an account could not
 * even sign in to register a compliant model. Applied in `utils/token.ts` at the
 * one issuance chokepoint, so refresh and switch-org re-apply it too.
 *
 * INHERITANCE — strictest wins: every non-empty list along the org's lineage
 * applies, i.e. their INTERSECTION. A team can narrow its parent's list but
 * never widen it.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { readOrgPolicyLineage } from './org-policy-lineage.js';
import { incCounter } from '../observability/metrics.js';
import type { SessionAuth } from '../services/session/access-tokens.js';

const logger = createLogger('authenticator-policy');

/** The all-zero AAGUID an authenticator reports when it names no model. */
export const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

/** Most AAGUIDs an org may allowlist — a curated list, not a catalog dump. */
export const MAX_ALLOWED_AAGUIDS = 100;

const AAGUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Canonical (lowercase, hyphenated) form of an AAGUID, or `null` when it isn't
 * one — or is the all-zero AAGUID, which names no model and so can never be
 * allowlisted.
 */
export function normalizeAaguid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!AAGUID_PATTERN.test(v) || v === ZERO_AAGUID) return null;
  return v;
}

/** The resolved policy for one org. */
export interface EffectiveAuthenticatorPolicy {
  /** Models members may use; `null` = any model. May be EMPTY when ancestor lists don't overlap. */
  allowed: string[] | null;
  /** This org's OWN stored list (empty = none set). */
  own: string[];
  /** Ancestors whose lists also apply, nearest first. */
  inheritedFrom: string[];
}

/** Intersect every non-empty list along the lineage (nearest first). */
export function combineAllowlists(lists: ReadonlyArray<readonly string[] | undefined>): string[] | null {
  let allowed: string[] | null = null;
  for (const list of lists) {
    if (!list || list.length === 0) continue;
    const normalized = list.map((v) => normalizeAaguid(v)).filter((v): v is string => v !== null);
    allowed = allowed === null ? [...new Set(normalized)] : allowed.filter((v) => normalized.includes(v));
  }
  return allowed;
}

/** Resolve the effective allowlist for `orgId`. Throws on a read error (callers pick the failure mode). */
export async function resolveEffectiveAuthenticatorPolicy(orgId: string): Promise<EffectiveAuthenticatorPolicy> {
  const docs = await readOrgPolicyLineage<{ allowedAuthenticatorAaguids?: string[] }>(orgId, 'allowedAuthenticatorAaguids');
  const own = docs[0]?.allowedAuthenticatorAaguids ?? [];
  return {
    allowed: combineAllowlists(docs.map((d) => d.allowedAuthenticatorAaguids)),
    own: [...own],
    inheritedFrom: docs.slice(1).filter((d) => (d.allowedAuthenticatorAaguids ?? []).length > 0).map((d) => d._id),
  };
}

/** Whether `aaguid` satisfies a resolved policy. */
export function aaguidPermitted(policy: Pick<EffectiveAuthenticatorPolicy, 'allowed'>, aaguid: string | undefined): boolean {
  if (policy.allowed === null) return true;
  const normalized = normalizeAaguid(aaguid);
  return normalized !== null && policy.allowed.includes(normalized);
}

/**
 * The session's assurance IN `orgId`: a passkey session (`amr` has `webauthn`,
 * `aal: 2`) whose model is not on the org's allowlist is lowered to `aal: 1`.
 * Every other session is returned untouched.
 *
 * Fails CLOSED on assurance, OPEN on the sign-in: when the policy can't be
 * read, the passkey counts as `aal: 1` for this issuance (understating the
 * level is always safe — a route or an org policy that needs more will ask).
 */
export async function applyAuthenticatorPolicy(auth: SessionAuth, orgId: string): Promise<SessionAuth> {
  if (auth.aal < 2 || !auth.amr.includes('webauthn')) return auth;
  let permitted: boolean;
  try {
    permitted = aaguidPermitted(await resolveEffectiveAuthenticatorPolicy(orgId), auth.aaguid);
  } catch (error) {
    logger.warn('Authenticator policy read failed; counting the passkey as aal 1', { orgId, error });
    permitted = false;
  }
  if (permitted) return auth;
  incCounter('platform_authenticator_policy_demotions_total');
  return { ...auth, aal: 1 };
}
