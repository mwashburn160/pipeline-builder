// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-store entitlement-drift detection.
 *
 * A KNOWN sync failure is retried via the durable event bus (syncEntitlements
 * publishes an `entitlement.sync` retry that the billing consumer re-drives at-
 * least-once). This module covers the SILENT-DRIFT case the bus can't see: a
 * sync that returned success but whose *enforced* state has since diverged from
 * what billing's Subscription (tier + add-ons) says it should be — an
 * out-of-band edit in the quota/platform store, a sync that didn't actually take
 * effect, a manual override, etc.
 *
 * Billing's Subscription is the source of truth; this reads the ACTUAL enforced
 * state from every store the entitlement sync fans out to:
 *   - quota service  → the tracked quota LIMITS (`GET /quotas/:orgId`)
 *   - platform       → the `seats` LIMIT (`GET /organization/:orgId/seat-usage`)
 *                       and the account FEATURE entitlements
 *                       (`GET /organization/:orgId/feature-entitlements`)
 *   - compliance     → the active content sets (`GET /compliance/entitlements/:orgId`)
 *   - reporting      → the enforced retention (`GET /reports/retention-sync/:orgId`)
 *
 * Feature entitlements are compared as an unordered set: the expected set is the
 * bundle-granted features from `effectiveEntitlements`. Any difference is drift
 * on the `features` dimension. {@link reconcileEntitlementDrift} is the bounded
 * lifecycle pass that runs the comparison and re-drives the sync on drift.
 */

import { clampRetentionDays, complianceSetsForFeatures, createLogger, errorMessage, VALID_QUOTA_TYPES } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { effectiveEntitlements } from '../config/entitlements.js';
import { billingServiceAuth, getBundleCatalog } from './billing-helpers.js';
import { fetchQuotaSnapshot, fetchSeatUsage, getJson } from './downstream-client.js';
import {
  currentSubscriptionEntitlement,
  effectiveFeatureSet,
  pushComplianceSetsToCompliance,
  syncEntitlements,
} from './entitlement-sync.js';
import { MANAGEABLE_SUBSCRIPTION_STATUSES } from './subscription-status.js';
import { config } from '../config.js';
import { Subscription, type SubscriptionDocument } from '../models/subscription.js';

const logger = createLogger('entitlement-drift');

/** ACTUAL enforced entitlement limits read back from the quota + platform stores. */
export interface ActualEntitlements {
  /** The tracked quota limits (one per `VALID_QUOTA_TYPES`), keyed by quota type. `-1` = unlimited. */
  quotaLimits: Record<string, number>;
  /** The enforced seat limit (platform-owned). `-1` = unlimited. */
  seats: number;
  /** The enforced account feature entitlements (platform-owned), e.g.
   *  `advanced_reporting`. */
  features: string[];
}

/** Outcome of a drift check for a single subscription. */
export interface DriftResult {
  /**
   * - `match` — enforced state equals expected; caller stamps lastReconciledAt.
   * - `drift` — a tracked limit / seats / feature diverged; caller re-syncs + meters.
   *
   * A store READ failure is not represented here: `readActualEntitlements` returns
   * `null` on any failed read, and the caller SKIPS (an outage is NOT drift) before
   * ever calling `computeEntitlementDrift`.
   */
  status: 'match' | 'drift';
  /** Human-readable per-field diffs, for the structured drift log. */
  drifted: string[];
  /** Low-cardinality metric dimensions that drifted: a subset of `quota` | `seats` | `features`. */
  dimensions: string[];
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Read the enforced quota limits from the quota service; `null` on any read failure. */
async function readEnforcedQuotaLimits(orgId: string, auth: string): Promise<Record<string, number> | null> {
  // The downstream client owns the envelope parse + fail-soft; drift's own policy
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
  // collapses into the same `null` read-failure signal.
  const seatSnapshot = await fetchSeatUsage(orgId, auth);
  return seatSnapshot?.limit ?? null;
}

/** Read the enforced account feature entitlements from platform; `null` on any read failure. */
async function readEnforcedFeatureEntitlements(orgId: string, auth: string): Promise<string[] | null> {
  const body = await getJson<{ data?: { featureEntitlements?: unknown } }>(
    config.platformService, `/organization/${encodeURIComponent(orgId)}/feature-entitlements`, orgId, auth,
  );
  const features = body?.data?.featureEntitlements;
  // A missing / non-array payload can't be safely compared — treat the read as
  // failed so an incomplete response never false-drifts (a features-less account
  // still returns `[]`, the platform model default).
  return isStringArray(features) ? features : null;
}

/**
 * Read the compliance service's CURRENTLY-ACTIVE content sets for an org:
 * `GET /compliance/entitlements/:orgId` → `data.sets`, the distinct `set:<x>`
 * values among the org's ACTIVE published-rule subscriptions. Same service-token
 * handshake `pushComplianceSetsToCompliance` uses. Returns `null` on any read
 * failure so the drift reconciler treats an unreachable compliance service as a
 * SKIP, never as drift.
 */
export async function readEnforcedComplianceSets(orgId: string, auth: string): Promise<string[] | null> {
  const body = await getJson<{ data?: { sets?: unknown } }>(
    config.complianceService, `/compliance/entitlements/${encodeURIComponent(orgId)}`, orgId, auth,
  );
  const sets = body?.data?.sets;
  // A missing / non-string-array payload can't be safely compared — treat the
  // read as failed so an incomplete response never false-drifts (an org with no
  // active sets still returns `[]`).
  return isStringArray(sets) ? sets : null;
}

/**
 * Read the reporting service's ENFORCED retention (the `dora_settings` values the
 * sweep + query cap obey) for an org: `GET /reports/retention-sync/:orgId` →
 * `{ eventRetentionDays, doraRetentionDays }` (`null` = no override stored, the
 * reporting env default applies). Same service-token handshake as the push leg.
 * Returns `null` on any read failure so the reconciler SKIPS (never false-drifts).
 */
export async function readEnforcedRetention(
  orgId: string,
  auth: string,
): Promise<{ eventRetentionDays: number | null; doraRetentionDays: number | null } | null> {
  const body = await getJson<{ data?: { eventRetentionDays?: unknown; doraRetentionDays?: unknown } }>(
    config.reportingService, `/reports/retention-sync/${encodeURIComponent(orgId)}`, orgId, auth,
  );
  const data = body?.data;
  const valid = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v));
  if (!data || !valid(data.eventRetentionDays) || !valid(data.doraRetentionDays)) return null;
  return { eventRetentionDays: data.eventRetentionDays, doraRetentionDays: data.doraRetentionDays };
}

/**
 * Pure retention comparison: `true` when the enforced override differs from the
 * (clamped) effective retention billing pushes. A missing override (`null`) is
 * drift — billing always pushes an explicit value for a billed account.
 */
export function retentionDiffers(
  expected: { eventRetentionDays: number; doraRetentionDays: number },
  actual: { eventRetentionDays: number | null; doraRetentionDays: number | null },
): boolean {
  return expected.eventRetentionDays !== actual.eventRetentionDays
    || expected.doraRetentionDays !== actual.doraRetentionDays;
}

/**
 * Pure set-equality check for two string lists (order-independent) — used for
 * both the compliance content sets and the feature entitlements. `true` when
 * the enforced values differ from what the account is entitled to.
 */
export function setsDiffer(expected: readonly string[], actual: readonly string[]): boolean {
  const exp = new Set(expected);
  const act = new Set(actual);
  return exp.size !== act.size || [...exp].some((s) => !act.has(s));
}

/**
 * Read the ACTUAL enforced entitlements (quota limits + seats + features) for an
 * account. The three reads run concurrently; returns `null` if ANY of them fails
 * — the caller must treat that as a skip, never as drift (an unreachable store
 * must not trigger a false re-sync). `authHeader` may be `''`; a service token is
 * minted for the target org, the same way syncEntitlements does.
 */
export async function readActualEntitlements(orgId: string, authHeader: string): Promise<ActualEntitlements | null> {
  const auth = authHeader || billingServiceAuth(orgId);
  const [quotaLimits, seats, features] = await Promise.all([
    readEnforcedQuotaLimits(orgId, auth),
    readEnforcedSeatLimit(orgId, auth),
    readEnforcedFeatureEntitlements(orgId, auth),
  ]);
  if (!quotaLimits || seats === null || features === null) return null;
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
  if (setsDiffer(expectedFeatures, actual.features)) {
    const fmt = (list: readonly string[]) => `[${[...new Set(list)].sort().join(',')}]`;
    drifted.push(`features=${fmt(actual.features)} (expected ${fmt(expectedFeatures)})`);
    dimensions.add('features');
  }

  return {
    status: drifted.length > 0 ? 'drift' : 'match',
    drifted,
    dimensions: [...dimensions],
  };
}

/**
 * Low-frequency, BOUNDED pass that catches SILENT entitlement drift — the case
 * the durable-bus retry can't see. A KNOWN sync failure publishes a retry to
 * the event bus, which redelivers until it succeeds; this pass instead finds subs
 * whose sync returned success but whose ENFORCED state has
 * since diverged from what the Subscription (tier + add-ons) says it should be:
 * an out-of-band edit in the quota/platform store, a sync that didn't take
 * effect, a manual override, etc.
 *
 * Billing's Subscription is the source of truth. For each candidate we compute
 * the EXPECTED entitlements (`effectiveEntitlements`), read the ACTUAL enforced
 * state (quota limits, seats, features, compliance sets, retention),
 * and compare. On any mismatch we re-drive the SAME idempotent `syncEntitlements`
 * path + emit
 * `billing_entitlement_drift_total`. On a clean match we stamp
 * `metadata.lastReconciledAt` and do nothing else.
 *
 * BOUNDED two ways so a large customer base is amortized, not scanned every tick:
 *   1. a per-tick cap (`config.entitlementDriftMaxPerTick`), and
 *   2. a per-sub `metadata.lastReconciledAt` gate — a sub reconciled within the
 *      last `config.entitlementDriftIntervalMs` (~daily) is skipped by the query.
 * `lastReconciledAt` is stamped after every completed check (match OR drift), so
 * each sub rotates back into the window at most ~once per interval. A read
 * failure leaves it UN-stamped, so it's retried next tick (never falsely re-synced).
 *
 * FAIL-SOFT: a store read failure for one sub logs + skips that sub — an
 * unreachable store is NOT "drift". The pass never throws.
 *
 * COVERAGE: the tracked quota limits + seats + the account FEATURE entitlements
 * (`featureEntitlements`, read from platform's feature-entitlements endpoint) +
 * the COMPLIANCE content sets (standard/advanced, read from the compliance
 * service) are all compared; a drift on any surfaces on its own metric dimension
 * (`quota` | `seats` | `features` | `compliance`). The compliance leg also drives
 * the Enterprise/Unlimited cutover, whose entitled sets have no billing event.
 */
export async function reconcileEntitlementDrift(): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // Gate: only subs never reconciled, or last reconciled before the interval
  // cutoff, and not inside a read-failure backoff. Oldest-reconciled first so a
  // capped tick always makes progress through the whole base (an unsorted scan
  // could keep returning the same never-matching rows).
  const cutoff = new Date(now - config.entitlementDriftIntervalMs).toISOString();
  const candidates = await Subscription.find(
    {
      $and: [
        // Every status that can hold enforced entitlements: manageable rows
        // (their plan tier, or developer once grace-downgraded) AND terminal rows
        // (canceled/incomplete — must sit at the developer baseline; a missed
        // downgrade leaves an unpaying org over-entitled). A terminal row is
        // checked until it once confirms the baseline (`terminalReconciledAt`).
        {
          $or: [
            { status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } },
            { 'metadata.terminalReconciledAt': { $exists: false } },
          ],
        },
        {
          $or: [
            { 'metadata.lastReconciledAt': { $exists: false } },
            { 'metadata.lastReconciledAt': { $lte: cutoff } },
          ],
        },
        {
          $or: [
            { 'metadata.driftRetryAfter': { $exists: false } },
            { 'metadata.driftRetryAfter': { $lte: nowIso } },
          ],
        },
      ],
    },
    null,
    // Bound the scan at the DB level — never pull the whole base.
    { sort: { 'metadata.lastReconciledAt': 1 }, limit: config.entitlementDriftMaxPerTick },
  );

  if (candidates.length === 0) return;

  for (const subscription of candidates) {
    const subscriptionId = subscription._id.toString();
    const terminal = !(MANAGEABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status);
    try {
      // A terminal row is superseded when the org has a live subscription — that
      // row owns the org's expected state. Settle this one without touching anything.
      if (terminal && await Subscription.exists({
        orgId: subscription.orgId, status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] },
      })) {
        await stampDriftChecked(subscriptionId, true);
        continue;
      }

      // EXPECTED from the row's CURRENT state (plan tier + add-ons, or the
      // developer baseline for a lapsed/terminal row) — the same derivation the
      // entitlement-retry consumer uses.
      const entitlement = await currentSubscriptionEntitlement(subscription);
      if (!entitlement) {
        logger.error('Cannot drift-check entitlements — plan not found', {
          orgId: subscription.orgId, subscriptionId, planId: subscription.planId,
        });
        await backOffDriftCheck(subscription, 'plan_missing');
        continue;
      }
      const { tier, addons } = entitlement;
      const serviceAuth = billingServiceAuth(subscription.orgId);

      // EXPECTED (from the sub) vs ACTUAL (enforced) — the compare is pure; the
      // reads are fail-soft (null ⇒ a store was unreachable).
      const { limits: expected, features: expectedFeatures } = effectiveEntitlements(tier, addons, getBundleCatalog());
      // COMPLIANCE dimension: the content sets live in the compliance service; this
      // also drives the Enterprise/Unlimited cutover (tier-baseline flags with no
      // billing event to push them).
      const effectiveFeatures = effectiveFeatureSet(tier, addons);
      const expectedSets = complianceSetsForFeatures(effectiveFeatures);
      // ACTUAL enforced state from every store, read concurrently. RETENTION is
      // reporting's enforced override vs the clamped value the retention leg pushes.
      const [actual, actualSets, actualRetention] = await Promise.all([
        readActualEntitlements(subscription.orgId, serviceAuth),
        readEnforcedComplianceSets(subscription.orgId, serviceAuth),
        readEnforcedRetention(subscription.orgId, serviceAuth),
      ]);
      if (!actual || actualSets === null || !actualRetention) {
        // A store read failed — an outage is NOT drift. Skip WITHOUT stamping
        // lastReconciledAt (never re-sync on an unreachable store), but back off so
        // a persistently failing store doesn't pin this sub to the head of every tick.
        logger.warn('Entitlement drift check skipped — enforced-state read failed', {
          orgId: subscription.orgId, subscriptionId,
        });
        await backOffDriftCheck(subscription, 'read_failed');
        continue;
      }

      const drift = computeEntitlementDrift(expected, expectedFeatures, actual);
      const retentionDrift = retentionDiffers(
        {
          eventRetentionDays: clampRetentionDays(expected.eventRetentionDays),
          doraRetentionDays: clampRetentionDays(expected.doraRetentionDays),
        },
        actualRetention,
      );

      if (drift.status === 'drift' || retentionDrift) {
        logger.warn('Entitlement drift detected — re-syncing enforced state', {
          orgId: subscription.orgId, subscriptionId, tier, drifted: drift.drifted, retentionDrift,
        });
        // Re-drive the SAME idempotent fan-out. syncEntitlements runs it inline and,
        // if a leg fails, publishes a durable-bus retry that redelivers until it lands.
        await syncEntitlements(subscription.orgId, tier, serviceAuth, subscriptionId, addons);
        for (const dimension of drift.dimensions) {
          incCounter('billing_entitlement_drift_total', { dimension });
        }
        if (retentionDrift) incCounter('billing_entitlement_drift_total', { dimension: 'retention' });
      }

      // Compliance-set drift is re-driven SURGICALLY: re-push ONLY the entitled
      // sets (not the full four-target sync) so a compliance-only divergence — or a
      // never-pushed Enterprise cutover — is corrected without touching quota/seats.
      if (setsDiffer(expectedSets, actualSets)) {
        logger.warn('Compliance-set drift detected — re-syncing entitled sets', {
          orgId: subscription.orgId,
          subscriptionId,
          tier,
          expected: expectedSets,
          actual: actualSets,
        });
        await pushComplianceSetsToCompliance(subscription.orgId, effectiveFeatures, serviceAuth, subscriptionId);
        incCounter('billing_entitlement_drift_total', { dimension: 'compliance' });
      }

      // Stamp on a completed check (match OR post-resync) so this sub drops out
      // of the query for the next interval, and clear any read-failure backoff.
      await stampDriftChecked(subscriptionId, terminal);
    } catch (err) {
      // Never let one sub's failure abort the pass.
      logger.error('Error reconciling entitlement drift', {
        orgId: subscription.orgId, subscriptionId, error: errorMessage(err),
      });
      await backOffDriftCheck(subscription, 'error').catch(() => undefined);
    }
  }
}

/** Base delay before re-trying a drift check whose reads failed; doubles per failure. */
const DRIFT_RETRY_BASE_MS = 15 * 60 * 1000;

/**
 * Record a failed drift attempt: stamp `lastDriftAttemptAt` and push
 * `driftRetryAfter` out exponentially (capped at the reconcile interval), so an
 * unreachable store is retried with backoff instead of every tick. Surgical
 * dot-path writes so concurrent metadata markers aren't clobbered.
 */
async function backOffDriftCheck(
  subscription: Pick<SubscriptionDocument, '_id' | 'metadata'>,
  reason: string,
): Promise<void> {
  const failures = Number(subscription.metadata?.driftFailures ?? 0);
  const delay = Math.min(DRIFT_RETRY_BASE_MS * 2 ** Math.min(failures, 16), config.entitlementDriftIntervalMs);
  const now = Date.now();
  await Subscription.updateOne(
    { _id: subscription._id },
    {
      $set: {
        'metadata.lastDriftAttemptAt': new Date(now).toISOString(),
        'metadata.driftRetryAfter': new Date(now + delay).toISOString(),
      },
      $inc: { 'metadata.driftFailures': 1 },
    },
  );
  incCounter('billing_entitlement_drift_skipped_total', { reason });
}

/** Stamp a completed drift check and clear any backoff state. */
async function stampDriftChecked(subscriptionId: string, terminal: boolean): Promise<void> {
  const at = new Date().toISOString();
  await Subscription.updateOne(
    { _id: subscriptionId },
    {
      $set: {
        'metadata.lastReconciledAt': at,
        'metadata.lastDriftAttemptAt': at,
        ...(terminal ? { 'metadata.terminalReconciledAt': at } : {}),
      },
      $unset: { 'metadata.driftRetryAfter': '', 'metadata.driftFailures': '' },
    },
  );
}
