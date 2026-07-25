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
 *                       and the account FEATURE entitlements
 *                       (`GET /organization/:orgId/feature-entitlements`)
 *
 * Feature entitlements (platform `org.featureEntitlements`, e.g. `sso`/`audit_log`)
 * are compared alongside the numeric limits: the expected set is the union of
 * bundle-granted features from `effectiveEntitlements`, and the actual set is read
 * from the platform feature-entitlements endpoint (the feature sibling of
 * seat-usage). Any set difference is drift on the `features` dimension.
 */

import { createLogger, createSafeClient, errorMessage, getServiceAuthHeader, VALID_QUOTA_TYPES } from '@pipeline-builder/api-core';
import { getBillingTimeout } from './billing-helpers.js';
import { fetchQuotaSnapshot, fetchSeatUsage } from './quota-client.js';
import { config } from '../config.js';

const logger = createLogger('entitlement-drift');

/** ACTUAL enforced entitlement limits read back from the quota + platform stores. */
export interface ActualEntitlements {
  /** The 9 tracked quota limits, keyed by quota type. `-1` = unlimited. */
  quotaLimits: Record<string, number>;
  /** The enforced seat limit (platform-owned). `-1` = unlimited. */
  seats: number;
  /** The enforced account feature entitlements (platform-owned), e.g. `sso`. */
  features: string[];
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
  /** Low-cardinality metric dimensions that drifted: a subset of `quota` | `seats` | `features`. */
  dimensions: string[];
}

/** Read the 9 enforced quota limits from the quota service; `null` on any read failure. */
async function readEnforcedQuotaLimits(orgId: string, auth: string): Promise<Record<string, number> | null> {
  // Shared quota-client owns the envelope parse + fail-soft; drift's own policy
  // (below) is that an INCOMPLETE snapshot is a read failure, not drift.
  const snapshot = await fetchQuotaSnapshot(orgId, auth);
  if (!snapshot) return null;

  const limits: Record<string, number> = {};
  for (const t of VALID_QUOTA_TYPES) {
    const limit = snapshot.quotas?.[t]?.limit;
    // An incomplete payload (a type missing / non-numeric) can't be safely
    // compared — treat the whole read as failed so we never false-drift.
    if (typeof limit !== 'number') return null;
    limits[t] = limit;
  }
  return limits;
}

/** Read the enforced seat limit from platform; `null` on any read failure. */
async function readEnforcedSeatLimit(orgId: string, auth: string): Promise<number | null> {
  // `fetchSeatUsage` returns `limit: null` on a missing/non-numeric value, which
  // collapses to the same `null` read-failure signal the old inline reader gave.
  const seatSnapshot = await fetchSeatUsage(orgId, auth);
  return seatSnapshot?.limit ?? null;
}

/** Read the enforced account feature entitlements from platform; `null` on any read failure. */
async function readEnforcedFeatureEntitlements(orgId: string, auth: string): Promise<string[] | null> {
  try {
    const client = createSafeClient({
      host: config.platformService.host,
      port: config.platformService.port,
      timeout: getBillingTimeout(),
    });
    const resp = await client.get<{ data?: { featureEntitlements?: unknown } }>(
      `/organization/${orgId}/feature-entitlements`,
      { headers: { 'Authorization': auth, 'x-org-id': orgId } },
    );
    if (!resp || resp.statusCode >= 400) return null;
    const features = resp.body?.data?.featureEntitlements;
    // A missing / non-array payload can't be safely compared — treat the read as
    // failed so an incomplete response never false-drifts (a features-less account
    // still returns `[]`, the platform model default).
    if (!Array.isArray(features) || !features.every((f) => typeof f === 'string')) return null;
    return features as string[];
  } catch (err) {
    logger.warn('Failed to read enforced feature entitlements', { orgId, error: errorMessage(err) });
    return null;
  }
}

/**
 * Read the ACTUAL enforced entitlements (quota limits + seats + features) for an
 * account. Returns `null` if ANY store read fails — the caller must treat that as
 * a skip, never as drift (an unreachable store must not trigger a false re-sync).
 * `authHeader` may be `''`; a service token is minted for the target org, the
 * same way syncEntitlements does.
 */
export async function readActualEntitlements(orgId: string, authHeader: string): Promise<ActualEntitlements | null> {
  const auth = authHeader || getServiceAuthHeader({ serviceName: 'billing', orgId, role: 'owner' });

  const quotaLimits = await readEnforcedQuotaLimits(orgId, auth);
  if (!quotaLimits) return null;

  const seats = await readEnforcedSeatLimit(orgId, auth);
  if (seats === null) return null;

  const features = await readEnforcedFeatureEntitlements(orgId, auth);
  if (features === null) return null;

  return { quotaLimits, seats, features };
}

/**
 * Pure comparison of EXPECTED vs ACTUAL enforced entitlements. Expected values
 * come from `effectiveEntitlements` (tier base + Σ bundle grants): `expectedLimits`
 * are the numeric limits (+ `seats`) and `expectedFeatures` is the union of
 * bundle-granted feature flags. Any tracked-limit, seats, or feature-set mismatch
 * is drift. The feature comparison is order-independent (set equality).
 */
export function computeEntitlementDrift(
  expectedLimits: Record<string, number>,
  expectedFeatures: readonly string[],
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

  // Feature entitlements are an unordered SET — compare membership, not order.
  const expected = new Set(expectedFeatures);
  const enforced = new Set(actual.features);
  const featuresDiffer =
    expected.size !== enforced.size || [...expected].some((f) => !enforced.has(f));
  if (featuresDiffer) {
    const fmt = (s: Set<string>) => `[${[...s].sort().join(',')}]`;
    drifted.push(`features=${fmt(enforced)} (expected ${fmt(expected)})`);
    dimensions.add('features');
  }

  return {
    status: drifted.length > 0 ? 'drift' : 'match',
    drifted,
    dimensions: [...dimensions],
  };
}
