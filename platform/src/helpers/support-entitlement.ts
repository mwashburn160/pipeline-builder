// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether an account may open a support case, and at what response level.
 *
 * PLATFORM owns this decision, not the message service and not billing, and the
 * reason is structural rather than a preference:
 *
 *  - `supportContacts` is NOT a quota-service type (it is absent from
 *    `VALID_QUOTA_TYPES`, like `seats`), so `quotaService.check()` cannot answer
 *    it. It is a live cap compared against current usage, not a period counter.
 *  - The EFFECTIVE limit is tier base + bundles, which only billing computes —
 *    but billing already syncs it here, onto the root org's `quotas`, exactly as
 *    it syncs `seats`.
 *  - The message service, which owns the support thread, has no outbound client
 *    to either service.
 *
 * So this mirrors `seats.ts`: read the ROOT's synced limit, count live usage
 * across the subtree, compare. Nothing is fetched cross-service on the hot path.
 */

import { SUPPORT_FEATURE_FLAGS } from '@pipeline-builder/api-core';
import type { ClientSession } from 'mongoose';
import { expandOrgScope, resolveOrgLineage } from './org-hierarchy.js';
import { toOrgId } from './org-id.js';
import { Organization } from '../models/index.js';

/**
 * The BASELINE levels, worst to best.
 *
 * Premium is deliberately NOT in this list. It is an UPGRADE bought on top of a
 * baseline rather than a competing level, so the baseline resolution and the
 * premium question are separate: an account holds a baseline for all its
 * contacts and upgrades some of them. Resolving premium as "the best level
 * held" would have made every contact of a one-upgrade account look premium.
 *
 * Order is precedence: an account holding BOTH baselines (a billing drift,
 * since they are mutually exclusive both at purchase and in
 * `effectiveEntitlements`) resolves to the better one, so a mis-synced
 * entitlement never silently downgrades the response a customer paid for.
 */
const BASELINE_PRECEDENCE: readonly string[] = SUPPORT_FEATURE_FLAGS
  .filter((f) => f !== 'support_premium');

/** The upgrade flag, named once. */
const PREMIUM_FLAG = 'support_premium';

/**
 * The decision a case-open path needs.
 *
 * TWO SCOPES, deliberately, and conflating them is the bug this shape exists to
 * prevent:
 *
 * - The **allowance** is POOLED SUBTREE-WIDE. An account buys contacts once and
 *   may spend them anywhere beneath its root, exactly like seats.
 * - **Ownership and case access are OWN-ORG.** A team designates its own
 *   contacts and reassigns cases only among them, so a pooled allowance never
 *   turns into a team's cases being readable by a sibling team.
 *
 * So `limit`/`used`/`canDesignate` are subtree questions, and
 * `ownOrgContacts`/`canOpenCase` are own-org questions. They answer differently
 * for a team that has spent none of a healthy account allowance.
 */
export interface SupportEntitlement {
  /**
   * The BASELINE level flag held (`support_standard` | `support_priority`), or
   * null when none is. Never `support_premium` — that is an upgrade, reported
   * separately below, and a case's own level is the opening contact's effective
   * one rather than this.
   */
  level: string | null;
  /** Whether the account holds the premium UPGRADE at all. */
  premium: boolean;
  /**
   * How many contacts may be upgraded to premium. `-1` = unlimited. Pooled like
   * `limit`, and never more than it matters: an upgrade with no baseline contact
   * to upgrade is nothing, which is why premium `requiresAnyOf` a baseline.
   */
  premiumLimit: number;
  /** Effective contact allowance on the ROOT. `-1` = unlimited. Pooled. */
  limit: number;
  /** Live designated contacts across the whole SUBTREE — what the cap counts. */
  used: number;
  /** Live designated contacts in THIS org — who may actually own its cases. */
  ownOrgContacts: number;
  /** Whether another contact may be designated: a pooled-cap question. */
  canDesignate: boolean;
  /**
   * Whether a case may be opened here AGAINST A CONTACT SEAT.
   *
   * Own-org, NOT subtree: a team with none of its own contacts has nobody
   * entitled to own its cases, even when the account has allowance to spare.
   * Keying this off the subtree count would let any team in a healthy account
   * open cases it then has no legitimate owner for.
   *
   * ONE-TIME INCIDENTS ARE NOT WIRED, and this comment used to claim otherwise.
   * It said the case-open path "must treat this as a DISJUNCTION — contact seat
   * OR incident" as though it did; it does not. `openedWithIncident` is
   * hardcoded `false` at the open site, and billing's
   * `supportIncidentBalance` + `grantSupportIncidents` / `consumeSupportIncident`
   * have no producer and no consumer — nothing can grant a concession and
   * nothing can spend one.
   *
   * Left in place rather than deleted because incidents are a deliberate
   * product decision (a concession instrument, never a SKU), but the pieces as
   * they stand are unreachable in both directions. Wiring them is not a small
   * change: the balance is authoritative in BILLING's Mongo while this decision
   * is served from platform, so spending one means either a second sync leg
   * onto the root org (the shape `seats` and `supportContacts` already use) or a
   * cross-service write on the case-open hot path. Whoever builds it should pick
   * one deliberately and implement the grant route in the same change — a
   * concession nobody can grant is the half that makes the rest pointless.
   *
   * So for now: `false` here means no case against a contact seat, and that is
   * the whole of it.
   */
  canOpenCase: boolean;
}

/**
 * Resolve an org's support entitlement.
 *
 * Pooled at the root like seats: an account's allowance is bought once and spent
 * anywhere in its subtree, so a team does not carry its own allowance.
 */
export async function supportEntitlement(
  orgId: string,
  session?: ClientSession | null,
): Promise<SupportEntitlement> {
  const { rootOrgId } = await resolveOrgLineage(orgId);
  const root = await Organization.findById(toOrgId(rootOrgId))
    .select('quotas.supportContacts quotas.supportPremiumContacts featureEntitlements')
    .session(session ?? null)
    .lean();

  const limit = root?.quotas?.supportContacts ?? 0;
  const premiumLimit = root?.quotas?.supportPremiumContacts ?? 0;
  const held = new Set(root?.featureEntitlements ?? []);
  // Best BASELINE held wins — see BASELINE_PRECEDENCE. Premium is answered
  // separately because it is an upgrade, not a competing level.
  const level = [...BASELINE_PRECEDENCE].reverse().find((f) => held.has(f)) ?? null;
  // Both halves required, as for the baseline: the flag says the upgrade was
  // bought, the cap says how many contacts it covers.
  const premium = held.has(PREMIUM_FLAG) && premiumLimit !== 0;

  // A level flag with no allowance, or an allowance with no level, is a half-
  // synced account. Both are required: the flag says WHAT response was bought,
  // the allowance says HOW MANY people may invoke it. Granting on either alone
  // would hand out support that was not paid for, or a target with nobody
  // entitled to claim it.
  if (level === null || limit === 0) {
    // No baseline means no support at all, premium upgrade or not: there is no
    // contact for an upgrade to apply to. Reported honestly rather than as a
    // premium entitlement, so a half-synced account cannot look like one that
    // bought 24x7.
    return {
      level,
      premium: false,
      premiumLimit,
      limit,
      used: 0,
      ownOrgContacts: 0,
      canDesignate: false,
      canOpenCase: false,
    };
  }

  const { countActiveSupportContacts } = await import('@pipeline-builder/pipeline-data');
  const scope = (await expandOrgScope(rootOrgId)).map(String);
  const [used, ownOrgContacts] = await Promise.all([
    // Subtree: what the pooled cap is measured against.
    countActiveSupportContacts(scope),
    // This org only: who may own a case raised here.
    countActiveSupportContacts([String(orgId)]),
  ]);
  const within = limit === -1 || used < limit;
  return {
    level,
    premium,
    premiumLimit,
    limit,
    used,
    ownOrgContacts,
    // Room under the POOLED cap. An org at the account cap cannot nominate
    // anybody, even if it has none of its own contacts yet.
    canDesignate: within,
    // Opening needs an EXISTING own-org designation, not room for a new one: an
    // account at its cap can still open cases, and a team with spare allowance
    // but no contacts of its own cannot.
    canOpenCase: ownOrgContacts > 0,
  };
}

