// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-store entitlement-drift detection.
 *
 * The Tier-1 reconciler (subscription-lifecycle.reconcileFailedEntitlementSyncs)
 * re-drives syncs that KNOWINGLY failed — the ones carrying
 * `metadata.entitlementSyncPending`. This module covers the SILENT-DRIFT case: a
 * sync that returned success but whose *enforced* state has since diverged from
 * what billing's Subscription (tier + add-ons) says it should be — an
 * out-of-band edit in the quota/platform store, a sync that didn't actually take
 * effect, a manual override, etc.
 *
 * Billing's Subscription is the source of truth; this reads the ACTUAL enforced
 * state from the two stores the entitlement sync fans out to:
 *   - quota service  → the 9 tracked quota LIMITS (`GET /quotas/:orgId`)
 *   - platform       → the `seats` LIMIT (`GET /organization/:orgId/seat-usage`)
 *
 * Feature entitlements (platform `org.featureEntitlements`) are NOT compared:
 * platform exposes no clean service-to-service read that returns them (they ride
 * along on token issuance / user-profile reads, not a dedicated endpoint), so
 * comparing them here would require a new platform route. Documented gap — see
 * `detectEntitlementDrift`.
 */

import type { QuotaTier } from '@pipeline-builder/api-core';
import { createLogger, createSafeClient, errorMessage, getServiceAuthHeader, VALID_QUOTA_TYPES } from '@pipeline-builder/api-core';
import { effectiveEntitlements, getBillingTimeout, getBundleCatalog } from './billing-helpers.js';
import { config } from '../config.js';

const logger = createLogger('entitlement-drift');

/** ACTUAL enforced entitlement limits read back from the quota + platform stores. */
export interface ActualEntitlements {
  /** The 9 tracked quota limits, keyed by quota type. `-1` = unlimited. */
  quotaLimits: Record<string, number>;
  /** The enforced seat limit (platform-owned). `-1` = unlimited. */
  seats: number;
}

/** Outcome of a drift check for a single subscription. */
export interface DriftResult {
  /**
   * - `match`       — enforced state equals expected; caller stamps lastReconciledAt.
   * - `drift`       — a tracked limit / seats diverged; caller re-syncs + meters.
   * - `read_failed` — a store read failed; caller SKIPS (an outage is NOT drift).
   */
  status: 'match' | 'drift' | 'read_failed';
  /** Human-readable per-field diffs, for the structured drift log. */
  drifted: string[];
  /** Low-cardinality metric dimensions that drifted: a subset of `quota` | `seats`. */
  dimensions: string[];
}

/** Read the 9 enforced quota limits from the quota service; `null` on any read failure. */
async function readEnforcedQuotaLimits(orgId: string, auth: string): Promise<Record<string, number> | null> {
  try {
    const client = createSafeClient({
      host: config.quotaService.host,
      port: config.quotaService.port,
      timeout: getBillingTimeout(),
    });
    const resp = await client.get<{ data?: { quota?: { quotas?: Record<string, { limit?: number }> } } }>(
      `/quotas/${orgId}`,
      { headers: { 'Authorization': auth, 'x-org-id': orgId } },
    );
    // `null` (network/parse error) or a non-2xx is a READ FAILURE, not "drift".
    if (!resp || resp.statusCode >= 400) return null;
    const quotas = resp.body?.data?.quota?.quotas;
    if (!quotas) return null;

    const limits: Record<string, number> = {};
    for (const t of VALID_QUOTA_TYPES) {
      const limit = quotas[t]?.limit;
      // An incomplete payload (a type missing / non-numeric) can't be safely
      // compared — treat the whole read as failed so we never false-drift.
      if (typeof limit !== 'number') return null;
      limits[t] = limit;
    }
    return limits;
  } catch (err) {
    logger.warn('Failed to read enforced quota limits', { orgId, error: errorMessage(err) });
    return null;
  }
}

/** Read the enforced seat limit from platform; `null` on any read failure. */
async function readEnforcedSeatLimit(orgId: string, auth: string): Promise<number | null> {
  try {
    const client = createSafeClient({
      host: config.platformService.host,
      port: config.platformService.port,
      timeout: getBillingTimeout(),
    });
    const resp = await client.get<{ data?: { limit?: number } }>(
      `/organization/${orgId}/seat-usage`,
      { headers: { 'Authorization': auth, 'x-org-id': orgId } },
    );
    if (!resp || resp.statusCode >= 400) return null;
    const limit = resp.body?.data?.limit;
    if (typeof limit !== 'number') return null;
    return limit;
  } catch (err) {
    logger.warn('Failed to read enforced seat limit', { orgId, error: errorMessage(err) });
    return null;
  }
}

/**
 * Read the ACTUAL enforced entitlements (quota limits + seats) for an account.
 * Returns `null` if EITHER store read fails — the caller must treat that as a
 * skip, never as drift (an unreachable store must not trigger a false re-sync).
 * `authHeader` may be `''`; a service token is minted for the target org, the
 * same way syncEntitlements does.
 */
export async function readActualEntitlements(orgId: string, authHeader: string): Promise<ActualEntitlements | null> {
  const auth = authHeader || getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'owner' });

  const quotaLimits = await readEnforcedQuotaLimits(orgId, auth);
  if (!quotaLimits) return null;

  const seats = await readEnforcedSeatLimit(orgId, auth);
  if (seats === null) return null;

  return { quotaLimits, seats };
}

/**
 * Pure comparison of EXPECTED vs ACTUAL enforced limits. Expected values come
 * from `effectiveEntitlements` (tier base + Σ bundle grants). Any tracked-limit
 * or seats mismatch is drift. Feature entitlements are not compared (no clean
 * platform read — see the module header).
 */
export function computeEntitlementDrift(
  expectedLimits: Record<string, number>,
  actual: ActualEntitlements,
): DriftResult {
  const drifted: string[] = [];
  const dimensions = new Set<string>();

  for (const t of VALID_QUOTA_TYPES) {
    const exp = expectedLimits[t];
    const act = actual.quotaLimits[t];
    if (exp !== act) {
      drifted.push(`${t}=${act} (expected ${exp})`);
      dimensions.add('quota');
    }
  }

  if (expectedLimits.seats !== actual.seats) {
    drifted.push(`seats=${actual.seats} (expected ${expectedLimits.seats})`);
    dimensions.add('seats');
  }

  return {
    status: drifted.length > 0 ? 'drift' : 'match',
    drifted,
    dimensions: [...dimensions],
  };
}

/**
 * Detect entitlement drift for one subscription: compute EXPECTED entitlements
 * from (tier + add-ons), read the ACTUAL enforced state, and compare. A store
 * read failure returns `read_failed` (fail-soft — the caller skips, never
 * re-syncs on an outage).
 */
export async function detectEntitlementDrift(
  orgId: string,
  tier: QuotaTier,
  addons: ReadonlyArray<{ bundleId: string; quantity: number }>,
  authHeader: string,
): Promise<DriftResult> {
  const { limits } = effectiveEntitlements(tier, addons, getBundleCatalog());
  const actual = await readActualEntitlements(orgId, authHeader);
  if (!actual) return { status: 'read_failed', drifted: [], dimensions: [] };
  return computeEntitlementDrift(limits, actual);
}
