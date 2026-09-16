// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's impersonation policy — the ONE place its defaults live.
 *
 * Why a resolver rather than a Mongoose `default:`: organizations are read
 * through `.lean()` throughout this codebase, which bypasses hydration and
 * returns raw BSON. A schema default therefore never fires for an existing
 * document; the field simply reads as `undefined`, and the EFFECTIVE default
 * becomes whatever `??` each call site happens to write. Two call sites that
 * disagree would silently give new and existing orgs different policies.
 * (`api/quota/src/models/organization.ts` documents the same trap: its Mongoose
 * defaults are "dead for real orgs".)
 *
 * So the stored fields carry no default, and every read goes through here.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { toOrgId } from './org-id.js';
import { Organization, User } from '../models/index.js';

const logger = createLogger('impersonation-policy');

export type ImpersonationPolicy = 'open' | 'consent' | 'denied';
export const IMPERSONATION_POLICIES: readonly ImpersonationPolicy[] = ['open', 'consent', 'denied'];

/**
 * The policy an org gets when it has never set one.
 *
 * `consent`: gated out of the box. Support loses the ability to view an account
 * without asking — that is the intended posture, not an accident of the default.
 */
export const DEFAULT_IMPERSONATION_POLICY: ImpersonationPolicy = 'consent';

/** Whether a challenge may be sent to the impersonated user, when never set. */
export const DEFAULT_ALLOW_SELF_APPROVAL = true;

export interface ResolvedImpersonationPolicy {
  policy: ImpersonationPolicy;
  allowSelfApproval: boolean;
}

/**
 * Resolve the effective policy from an org document, which may be a `.lean()`
 * result missing both fields. Anything unrecognised also falls back to the
 * default rather than being trusted — an unknown mode must never read as `open`.
 */
export function resolveImpersonationPolicy(
  org: { impersonationPolicy?: unknown; allowSelfApproval?: unknown } | null | undefined,
): ResolvedImpersonationPolicy {
  const raw = org?.impersonationPolicy;
  const policy = (IMPERSONATION_POLICIES as readonly unknown[]).includes(raw)
    ? (raw as ImpersonationPolicy)
    : DEFAULT_IMPERSONATION_POLICY;
  const allowSelfApproval = typeof org?.allowSelfApproval === 'boolean'
    ? org.allowSelfApproval
    : DEFAULT_ALLOW_SELF_APPROVAL;
  return { policy, allowSelfApproval };
}

/**
 * The minimum number of sysadmin accounts `denied` requires.
 *
 * Under `denied`, emergency (break-glass) access needs a SECOND sysadmin to
 * approve it — four-eyes. On a deployment with fewer than two sysadmins there is
 * no second pair of eyes, so `denied` would make emergency access impossible
 * rather than merely expensive. That is a lockout, not a control.
 */
export const MIN_SYSADMINS_FOR_DENIED = 2;

/**
 * Whether `denied` can be selected right now. Checked when the policy is SET,
 * so the lockout is refused up front instead of discovered during an incident.
 */
export async function canSelectDeniedPolicy(): Promise<boolean> {
  const sysadmins = await User.countDocuments({ isSuperAdmin: true });
  return sysadmins >= MIN_SYSADMINS_FOR_DENIED;
}

// ---------------------------------------------------------------------------
// Effective policy across the org → team hierarchy: STRICTEST WINS.
// ---------------------------------------------------------------------------

/** Strictness order. A higher rank protects the org's data more. */
const STRICTNESS: Record<ImpersonationPolicy, number> = { open: 0, consent: 1, denied: 2 };

/** The stricter of two policies. */
function stricter(a: ImpersonationPolicy, b: ImpersonationPolicy): ImpersonationPolicy {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/**
 * Combine an org's own resolved policy with its parent's. A team may TIGHTEN
 * beyond its parent but never loosen below it: the policy is the stricter of
 * the two, and self-approval is allowed only if BOTH allow it.
 *
 * Mirrors compliance, where a parent's `propagateToChildren` blocking rules bind
 * its teams — a team can add rules but cannot opt out of the parent's. Without
 * this, a parent's `consent` would protect only the members of teams that did
 * not happen to choose `open`.
 */
export function combineStrictest(
  own: ResolvedImpersonationPolicy,
  parent: ResolvedImpersonationPolicy,
): ResolvedImpersonationPolicy {
  return {
    policy: stricter(own.policy, parent.policy),
    allowSelfApproval: own.allowSelfApproval && parent.allowSelfApproval,
  };
}

/** The most protective policy there is — what an unreadable hierarchy resolves to. */
export const STRICTEST_POLICY: ResolvedImpersonationPolicy = { policy: 'denied', allowSelfApproval: false };

export interface EffectiveImpersonationPolicy extends ResolvedImpersonationPolicy {
  /** The org's own stored setting, before inheritance. */
  own: ResolvedImpersonationPolicy;
  /**
   * Set when the effective policy is stricter than `own` because of the parent,
   * so an admin who chose `open` can see WHY it isn't open.
   */
  inheritedFrom?: string;
  /**
   * False when the parent could not be read. The policy is then STRICTEST_POLICY
   * — never looser than reality — but a caller must be able to tell "the org
   * chose denied" from "we failed to read it". In particular, emergency access
   * must not escalate to four-eyes on an UNRESOLVED policy: that requirement is
   * justified by an org choosing `denied`, not by a database blip, and applying
   * it here would turn a transient failure into a lockout.
   */
  resolved: boolean;
}

/**
 * Resolve the policy that actually governs impersonation of a member of `orgId`.
 *
 * Nesting is one level deep, so this is at most two reads. When the org names a
 * parent that cannot be loaded — the lookup throws, or `parentOrgId` dangles —
 * the result FAILS CLOSED to the strictest policy with `resolved: false`, rather
 * than falling back to the team's own setting. Falling back would be a false
 * pass: a team set to `open` under a `consent` parent would read as `open`
 * precisely when we couldn't check. (Compliance fails its scan for the same
 * reason — see api/compliance/src/helpers/org-hierarchy-client.ts.)
 */
export async function resolveEffectiveImpersonationPolicy(orgId: string): Promise<EffectiveImpersonationPolicy> {
  const org = await Organization.findById(toOrgId(orgId))
    .select('impersonationPolicy allowSelfApproval parentOrgId').lean();
  const own = resolveImpersonationPolicy(org);

  const parentOrgId = (org as { parentOrgId?: string | null } | null)?.parentOrgId;
  if (!parentOrgId) return { ...own, own, resolved: true };

  let parent: unknown;
  try {
    parent = await Organization.findById(toOrgId(parentOrgId))
      .select('impersonationPolicy allowSelfApproval').lean();
  } catch (err) {
    logger.warn('Parent policy lookup failed — failing closed to strictest', { orgId, parentOrgId, error: String(err) });
    return { ...STRICTEST_POLICY, own, resolved: false };
  }
  if (!parent) {
    // A dangling parentOrgId is a data-integrity problem, not a transient one.
    logger.error('Org names a parent that does not exist — failing closed to strictest', { orgId, parentOrgId });
    return { ...STRICTEST_POLICY, own, resolved: false };
  }

  const effective = combineStrictest(own, resolveImpersonationPolicy(parent as never));
  const tightenedByParent = effective.policy !== own.policy || effective.allowSelfApproval !== own.allowSelfApproval;
  return {
    ...effective,
    own,
    ...(tightenedByParent ? { inheritedFrom: String(parentOrgId) } : {}),
    resolved: true,
  };
}
