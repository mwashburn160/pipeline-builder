// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading an org's support entitlement from platform.
 *
 * This is the message service's FIRST outbound internal call, so it is worth
 * saying why it exists rather than keeping the decision local. Measured:
 *
 *  - `supportContacts` is not a `QuotaType` (absent from `VALID_QUOTA_TYPES`,
 *    like `seats`), so the quota client cannot answer it;
 *  - the effective limit is tier base + bundles, which only billing computes —
 *    but billing already syncs it onto the root org, so PLATFORM can answer
 *    without a further hop;
 *  - this service owns the support thread and therefore the moment a case is
 *    opened, so the decision has to reach it somehow.
 *
 * DEGRADED MODE is the important part. If this read fails, the support message
 * is still created — only the CASE RECORD and its response target are skipped.
 * Fail closed on the promise, open on reachability:
 *
 *  - Refusing to accept a support message because platform is unreachable
 *    denies support at precisely the moment a customer most needs it, and the
 *    outage is ours.
 *  - Creating a case anyway would promise a response target nobody has verified
 *    was bought, and would freeze an unknown `level` onto the row.
 *
 * So the tenant's message always lands; what degrades is the case semantics on
 * top of it. The gap is observable (`support_entitlement_unavailable_total`)
 * rather than silent, because a persistent failure means support messages are
 * quietly arriving without targets.
 *
 * A LAST-KNOWN-GOOD CACHE sits in front of that fallback, so the common failure
 * — a restart, a deploy, a brief blip — resolves correctly and the case is
 * created as normal. Only a cold or expired cache degrades to "no case". The
 * cache is consulted ONLY on failure, never instead of the live read, so
 * entitlement changes are never delayed by it.
 */

import { createCacheService, createLogger, envInt, errorMessage, getServiceAuthHeader, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';

const logger = createLogger('support-entitlement-client');

/** Bounded so a hung platform cannot wedge the support send behind it. */
const TIMEOUT_MS = envInt('SUPPORT_ENTITLEMENT_TIMEOUT_MS', 3000, { min: 1 });

/**
 * Last-known-good entitlement, used ONLY when the live read fails.
 *
 * This is a FALLBACK cache, not a read-through one, and the distinction is the
 * whole point: a healthy platform is consulted on every send, so buying or
 * cancelling support takes effect immediately. A read-through cache would delay
 * every entitlement change by up to the TTL — including a cancellation, which is
 * the direction that gives support away.
 *
 * The TTL therefore bounds only how long a PLATFORM OUTAGE can keep honouring a
 * stale answer. 15 minutes is long enough to cover a deploy or a restart and
 * short enough that a cancelled account stops being served within one.
 */
const entitlementCache = createCacheService(
  'support-entitlement:',
  envInt('SUPPORT_ENTITLEMENT_CACHE_TTL_SECONDS', 900, { min: 1 }),
);

/** Platform's answer. Mirrors `SupportEntitlement` in platform's helper. */
export interface SupportEntitlementView {
  /** `support_standard` | `support_priority` | `support_premium`, or null. */
  level: string | null;
  /**
   * Whether the account holds the premium UPGRADE, and for how many contacts.
   *
   * Separate from `level` because premium is an upgrade bought ON TOP of a
   * baseline, not a competing level: an account holds one baseline for all its
   * contacts and upgrades some of them. A case's frozen `level` is therefore the
   * OPENING CONTACT's effective level — premium when that contact is upgraded,
   * the baseline otherwise — which is why both halves have to cross the wire.
   */
  premium: boolean;
  premiumLimit: number;
  /** Pooled allowance on the root. `-1` = unlimited. */
  limit: number;
  /** Live contacts across the subtree — what the pooled cap measures. */
  used: number;
  /** Live contacts in THIS org — who may own a case raised here. */
  ownOrgContacts: number;
  canDesignate: boolean;
  /** Whether a case may be opened here against a contact seat. */
  canOpenCase: boolean;
}

/**
 * Read the org's support entitlement, or `null` when platform could not answer.
 *
 * `null` is the DEGRADED signal and is deliberately indistinguishable from the
 * caller's point of view — unreachable, timed out, non-2xx and malformed all
 * collapse to it, because the caller's response is the same in every case and a
 * richer error would only invite it to guess.
 *
 * Never throws: a support send must not fail because of this read.
 */
export async function fetchSupportEntitlement(orgId: string): Promise<SupportEntitlementView | null> {
  const { platformHost, platformPort } = Config.get('server').services;
  const url = `http://${platformHost}:${platformPort}/internal/support/entitlement/${encodeURIComponent(orgId)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        // Service principal, not the user's token: this is an internal read of
        // an entitlement the USER is not allowed to query directly.
        //
        // `role: 'member'` is least privilege per the service-token contract —
        // this is a read, so a leaked token must not be able to act as an admin
        // in the target org.
        'Authorization': getServiceAuthHeader({ serviceName: 'message', orgId: SYSTEM_ORG_ID, role: 'member' }),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      degraded('non_ok', { status: res.status, orgId });
      // Awaited deliberately: inside the `try`, an un-awaited rejection would
      // escape the catch below and break this function's never-throws contract.
      return await lastKnownGood(orgId, 'non_ok');
    }
    const body = await res.json() as { data?: Partial<SupportEntitlementView> } | Partial<SupportEntitlementView>;
    const view = (body as { data?: Partial<SupportEntitlementView> }).data ?? body as Partial<SupportEntitlementView>;
    // Validate rather than trust: a shape change upstream must degrade, not
    // produce a case with `level: undefined` frozen onto it forever.
    if (typeof view?.canOpenCase !== 'boolean' || (view.level !== null && typeof view.level !== 'string')) {
      degraded('malformed', { orgId });
      return null; // NOT cached: a shape change is our bug, and masking it with a stale grant would hide a broken contract.
    }
    const resolved: SupportEntitlementView = {
      level: view.level ?? null,
      // Defaulted rather than required: a platform that predates the upgrade
      // answers without these, and reading that as "no premium" is correct and
      // safe. Only `canOpenCase` and `level` are load-bearing enough to reject
      // a body over (see above).
      premium: view.premium === true,
      premiumLimit: typeof view.premiumLimit === 'number' ? view.premiumLimit : 0,
      limit: typeof view.limit === 'number' ? view.limit : 0,
      used: typeof view.used === 'number' ? view.used : 0,
      ownOrgContacts: typeof view.ownOrgContacts === 'number' ? view.ownOrgContacts : 0,
      canDesignate: view.canDesignate === true,
      canOpenCase: view.canOpenCase,
    };
    // Cache BOTH outcomes. A cached "no entitlement" matters as much as a
    // cached grant: without it an outage would turn an unentitled org into one
    // whose next send degrades, which reads to staff like a different problem.
    await entitlementCache.set(orgId, resolved).catch(() => undefined);
    return resolved;
  } catch (err) {
    degraded('unreachable', { orgId, error: errorMessage(err) });
    return lastKnownGood(orgId, 'unreachable');
  }
}

/**
 * The cached answer, or `null` to degrade.
 *
 * Returning a stale grant is deliberate and bounded: within the TTL, honouring
 * the last answer platform gave is strictly better than dropping a paying
 * customer's case on the floor because of our own outage. Past it, we stop
 * guessing.
 */
async function lastKnownGood(orgId: string, reason: string): Promise<SupportEntitlementView | null> {
  const cached = await entitlementCache.get<SupportEntitlementView>(orgId).catch(() => null);
  if (!cached) {
    incCounter('support_entitlement_degraded_total', { reason, cache: 'miss' });
    return null;
  }
  incCounter('support_entitlement_degraded_total', { reason, cache: 'hit' });
  logger.warn('Serving LAST-KNOWN-GOOD support entitlement after a failed read', {
    orgId, reason, level: cached.level, canOpenCase: cached.canOpenCase,
  });
  return cached;
}

/**
 * Record a degraded read.
 *
 * Counted AND logged: the metric makes a persistent failure alertable, and the
 * log carries the reason, because "support cases stopped being created" is
 * otherwise invisible — the messages keep arriving and look fine.
 */
function degraded(reason: string, fields: Record<string, unknown>): void {
  incCounter('support_entitlement_unavailable_total', { reason });
  logger.warn('Support entitlement unavailable — message will be sent WITHOUT a case record', { reason, ...fields });
}
