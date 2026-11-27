// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading an org's support entitlement from platform.
 *
 * Why the decision is read from platform rather than kept local:
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

import {
  callInternal,
  createCacheService,
  createLogger,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  PLATFORM_INTERNAL,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { config } from '../config.js';

const logger = createLogger('support-entitlement-client');

/** Bounded so a hung platform cannot wedge the support send behind it. */
const TIMEOUT_MS = config.support.entitlementTimeoutMs;

/** The entitlement is a handful of fields; anything larger is not an answer. */
const MAX_RESPONSE_BYTES = 64 * 1024;

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
  config.support.entitlementCacheTtlSeconds,
);

/** Platform's answer. Mirrors `SupportEntitlement` in platform's helper. */
export interface SupportEntitlementView {
  /**
   * The BASELINE level held (`support_standard` | `support_priority`), or null.
   * Never `support_premium`: premium is the upgrade reported separately below.
   */
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
  try {
    // The shared client: pooled keep-alive sockets, the per-target circuit
    // breaker (an open breaker fails fast and lands in the catch below as
    // `unreachable`) and a bounded response body. Retries are OFF — one bounded
    // attempt is the contract, so a sick platform costs a send TIMEOUT_MS, not a
    // multiple of it.
    const client = new InternalHttpClient({ host: platformHost, port: platformPort, timeout: TIMEOUT_MS }, { maxResponseBytes: MAX_RESPONSE_BYTES });
    const res = await callInternal(client, PLATFORM_INTERNAL.supportEntitlement, {
      params: { orgId },
      options: {
        headers: {
          // Service principal, not the user's token: this is an internal read of
          // an entitlement the USER is not allowed to query directly.
          //
          // `role: 'member'` is least privilege per the service-token contract —
          // this is a read, so a leaked token must not be able to act as an admin
          // in the target org.
          Authorization: getServiceAuthHeader({ serviceName: 'message', orgId: SYSTEM_ORG_ID, role: 'member' }),
        },
        maxRetries: 0,
        maxRateLimitRetries: 0,
      },
    });
    if (!res.ok && res.reason !== 'invalid-response') {
      // Awaited deliberately: inside the `try`, an un-awaited rejection would
      // escape the catch below and break this function's never-throws contract.
      return await lastKnownGood(orgId, 'non_ok', { status: res.reason === 'status' ? res.status : undefined, orgId });
    }
    // Validate rather than trust: a shape change upstream must degrade, not
    // produce a case with `level: undefined` frozen onto it forever. The
    // contract requires every field platform's `SupportEntitlement` carries.
    if (!res.ok) {
      degraded('malformed', { orgId }, null);
      return null; // NOT cached: a shape change is our bug, and masking it with a stale grant would hide a broken contract.
    }
    const resolved: SupportEntitlementView = { ...res.data };
    // Cache BOTH outcomes. A cached "no entitlement" matters as much as a
    // cached grant: without it an outage would turn an unentitled org into one
    // whose next send degrades, which reads to staff like a different problem.
    await entitlementCache.set(orgId, resolved).catch(() => undefined);
    return resolved;
  } catch (err) {
    return lastKnownGood(orgId, 'unreachable', { orgId, error: errorMessage(err) });
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
async function lastKnownGood(orgId: string, reason: string, fields: Record<string, unknown>): Promise<SupportEntitlementView | null> {
  const cached = await entitlementCache.get<SupportEntitlementView>(orgId).catch(() => null);
  incCounter('support_entitlement_degraded_total', { reason, cache: cached ? 'hit' : 'miss' });
  degraded(reason, { ...fields, cache: cached ? 'hit' : 'miss' }, cached ?? null);
  return cached ?? null;
}

/**
 * Record a degraded read.
 *
 * Counted AND logged: the metric makes a persistent failure alertable, and the
 * log carries the reason, because "support cases stopped being created" is
 * otherwise invisible — the messages keep arriving and look fine.
 *
 * Logged AFTER the cache is consulted, so the line says what actually happens:
 * `served` is the last-known-good answer the case decision is then made from,
 * or null when the message really goes out without a case record.
 */
function degraded(reason: string, fields: Record<string, unknown>, served: SupportEntitlementView | null): void {
  incCounter('support_entitlement_unavailable_total', { reason });
  if (served) {
    logger.warn('Support entitlement unavailable — using the LAST-KNOWN-GOOD cached entitlement; the case decision is made from it', {
      reason, ...fields, level: served.level, canOpenCase: served.canOpenCase,
    });
    return;
  }
  logger.warn('Support entitlement unavailable — message will be sent WITHOUT a case record', { reason, ...fields });
}
