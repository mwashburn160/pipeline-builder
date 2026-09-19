// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's "require MFA" policy (#8) — the single place the stored
 * fields on {@link Organization} are turned into a decision.
 *
 * ENFORCED AT ISSUANCE, NOT PER ROUTE. A session scoped to an org that requires
 * MFA is minted at `aal: 2` or is refused outright, and it carries an
 * `mfaRequired` claim so no downstream service ever looks the policy up. That is
 * what makes the policy cheap (one read on the sign-in path, none on the request
 * path) and total (it covers every route of every service, including ones added
 * later, rather than the subset someone remembered to annotate).
 *
 * INHERITANCE mirrors the impersonation policy: the STRICTEST setting across the
 * org and its ancestors wins, so a parent account can require MFA for every team
 * beneath it and a team cannot opt out of its parent's requirement. A team may
 * still require MFA its parent does not.
 *
 * GRACE. Turning the policy on stamps `mfaGraceUntil`; until it passes, members
 * are told (the claim, and the banner the frontend renders from it) but not
 * refused. Without that, enabling the policy would sign out everyone who hadn't
 * enrolled yet — including, quite often, the admin who just enabled it.
 */

import { MFA_REQUIRED_FOR_ORG } from '../services/auth-errors.js';

/**
 * The model + id caster, loaded ON DEMAND.
 *
 * This module is imported by the request-validation schemas (for the grace-day
 * ceiling) and by every session-issuing controller (for the shared error map),
 * neither of which should drag Mongoose and the whole model graph into its
 * static import graph just to read a number or a constant. Same reasoning as
 * `auth-factors.ts`'s lazy provider dependencies.
 */
async function deps() {
  const [models, orgId] = await Promise.all([
    import('../models/index.js'),
    import('./org-id.js'),
  ]);
  return { Organization: models.Organization, toOrgId: orgId.toOrgId };
}

/** Default grace period offered when an admin turns the policy on. */
export const DEFAULT_MFA_GRACE_DAYS = 14;

/** Maximum grace an admin may choose — beyond this the policy is decorative. */
export const MAX_MFA_GRACE_DAYS = 90;

/** The stored policy fields of one org document. */
export interface StoredMfaPolicy {
  requireMfa?: boolean;
  mfaRequiredSince?: Date | null;
  mfaGraceUntil?: Date | null;
  idpEnforcesMfa?: boolean;
}

/** The resolved policy for an org — what the UI shows and issuance enforces. */
export interface EffectiveMfaPolicy {
  /** Whether MFA is required at all (this org's own setting, or an ancestor's). */
  requireMfa: boolean;
  /** Whether the requirement BITES right now (required, and past any grace). */
  enforced: boolean;
  /** End of the grace period, when one is still running. */
  graceUntil?: Date;
  /** When the requirement was turned on (the strictest contributing org's). */
  requiredSince?: Date;
  /** The ancestor org whose setting is in force, when it isn't this org's own. */
  inheritedFrom?: string;
  /** This org's own stored setting, regardless of what an ancestor imposes —
   *  so an admin can see why their "off" isn't taking effect. */
  own: boolean;
  /** The org states its IdP enforces MFA, so an SSO sign-in reaches `aal: 2`.
   *  NOT inherited: it is a statement about THIS org's own IdP. */
  idpEnforcesMfa: boolean;
}

/** Depth cap for the ancestor walk — the same defensive bound api-core's
 *  lineage resolver uses, so a mis-parented cycle can't spin here either. */
const MAX_ANCESTOR_DEPTH = 32;

/**
 * Every ancestor of `orgId`, nearest first. Walks `parentOrgId` one hop at a
 * time (a cycle or a missing document simply ends the walk) and returns the
 * policy fields in the same pass, so the caller needs no second query.
 */
async function ancestorPolicies(orgId: string): Promise<Array<StoredMfaPolicy & { _id: string }>> {
  const { Organization, toOrgId } = await deps();
  const out: Array<StoredMfaPolicy & { _id: string }> = [];
  const seen = new Set<string>([orgId]);
  let current = orgId;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const doc = await Organization.findById(toOrgId(current))
      .select('parentOrgId requireMfa mfaRequiredSince mfaGraceUntil').lean() as (StoredMfaPolicy & { _id: unknown; parentOrgId?: string | null }) | null;
    const parent = doc?.parentOrgId;
    if (!parent || seen.has(String(parent))) return out;
    seen.add(String(parent));
    const parentDoc = await Organization.findById(toOrgId(String(parent)))
      .select('requireMfa mfaRequiredSince mfaGraceUntil').lean() as (StoredMfaPolicy & { _id: unknown }) | null;
    if (!parentDoc) return out;
    out.push({ ...parentDoc, _id: String(parentDoc._id) });
    current = String(parent);
  }
  return out;
}

/** Whether a stored policy is currently ENFORCED (on, and out of grace). */
function isEnforcedNow(policy: StoredMfaPolicy, now: Date): boolean {
  if (policy.requireMfa !== true) return false;
  return !policy.mfaGraceUntil || policy.mfaGraceUntil.getTime() <= now.getTime();
}

/**
 * Resolve the effective policy for `orgId`. Reads the org and — only when it has
 * a parent — its ancestors; a flat org (every org today) costs one read.
 *
 * Fails OPEN on a lineage read error: degrading to the org's own setting is the
 * same choice token issuance makes for entitlements, and the alternative (a
 * transient read blip refusing every sign-in for the account) is far worse than
 * briefly missing a parent's stricter requirement.
 */
export async function resolveEffectiveMfaPolicy(orgId: string, now: Date = new Date()): Promise<EffectiveMfaPolicy> {
  const { Organization, toOrgId } = await deps();
  const org = await Organization.findById(toOrgId(orgId))
    .select('requireMfa mfaRequiredSince mfaGraceUntil idpEnforcesMfa parentOrgId').lean() as (StoredMfaPolicy & { parentOrgId?: string | null }) | null;
  const own = org?.requireMfa === true;
  const base: EffectiveMfaPolicy = {
    requireMfa: own,
    enforced: org ? isEnforcedNow(org, now) : false,
    ...(org?.mfaGraceUntil && org.mfaGraceUntil.getTime() > now.getTime() ? { graceUntil: org.mfaGraceUntil } : {}),
    ...(org?.mfaRequiredSince ? { requiredSince: org.mfaRequiredSince } : {}),
    own,
    idpEnforcesMfa: org?.idpEnforcesMfa === true,
  };
  if (!org?.parentOrgId) return base;

  let docs: Array<StoredMfaPolicy & { _id: string }>;
  try {
    docs = await ancestorPolicies(orgId);
  } catch {
    return base; // Own setting only (see the JSDoc).
  }
  if (docs.length === 0) return base;

  let resolved = base;
  for (const doc of docs) {
    if (doc.requireMfa !== true) continue;
    const enforced = isEnforcedNow(doc, now);
    // Strictest wins: an ENFORCED ancestor beats a grace-period local setting,
    // and a required-but-in-grace ancestor beats "not required at all".
    if (enforced && !resolved.enforced) {
      const { graceUntil: _dropped, ...rest } = resolved;
      resolved = {
        ...rest,
        requireMfa: true,
        enforced: true,
        ...(doc.mfaRequiredSince ? { requiredSince: doc.mfaRequiredSince } : {}),
        inheritedFrom: doc._id,
      };
    } else if (!resolved.requireMfa) {
      resolved = {
        ...resolved,
        requireMfa: true,
        ...(doc.mfaGraceUntil && doc.mfaGraceUntil.getTime() > now.getTime() ? { graceUntil: doc.mfaGraceUntil } : {}),
        ...(doc.mfaRequiredSince ? { requiredSince: doc.mfaRequiredSince } : {}),
        inheritedFrom: doc._id,
      };
    }
  }
  return resolved;
}

/** Whether `orgId`'s IdP is marked as enforcing MFA (so SSO through it is
 *  `aal: 2`). Own setting only — it describes THIS org's provider. */
export async function idpEnforcesMfa(orgId: string): Promise<boolean> {
  try {
    const { Organization, toOrgId } = await deps();
    const org = await Organization.findById(toOrgId(orgId)).select('idpEnforcesMfa').lean();
    return (org as { idpEnforcesMfa?: boolean } | null)?.idpEnforcesMfa === true;
  } catch {
    // Fail CLOSED on assurance, OPEN on the sign-in: an unreadable setting means
    // the session is `aal: 1`, not that the SSO login fails. Understating the
    // level is always safe — a route that needs more will ask for it.
    return false;
  }
}

/**
 * The `withController` error-map entry every session-ISSUING controller shares,
 * so the org policy's refusal reads identically on the password, social, SSO,
 * passkey, authenticator, refresh, switch-org and device paths — one 401 with
 * `code: 'MFA_REQUIRED'`, which the frontend turns into "go and enrol" rather
 * than "your session died".
 */
export const MFA_POLICY_ERROR_MAP = {
  [MFA_REQUIRED_FOR_ORG]: {
    status: 401,
    message: 'Your organization requires two-factor authentication — sign in with a passkey, or enrol an authenticator app',
    code: 'MFA_REQUIRED',
  },
} as const;
