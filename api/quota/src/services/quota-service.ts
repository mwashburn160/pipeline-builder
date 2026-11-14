// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, enforcedQuotaLimit, isValidTier, QUOTA_TIERS, ValidationError, VALID_QUOTA_TYPES, nextQuotaResetDate } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaReserveResult, QuotaTier } from '@pipeline-builder/api-core';
import { applyPooledQuotas, pooledStatusFromRows, pooledStatusOrFallback, QuotaPoolUnavailableError, resolveIncrementRoot } from './pooled-quota.js';
import type { PoolRow } from './pooled-quota.js';
import { fetchStorageBytes } from './storage-usage.js';
import { expandOrgScope, findOrgWithHierarchy, resolveRootOrgId } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import {
  applyQuotaLimits,
  atRiskPercent,
  buildOrgQuotaResponse,
  buildDefaultOrgQuotaResponse,
  buildReserveResult,
  computeQuotaStatus,
  defaultLimitExpr,
  defaultLimitFor,
  effectiveLimit,
  effectiveLimitExpr,
  enforcedLimitExpr,
  periodDaysFor,
} from '../helpers/quota-helpers.js';
import type { OrgQuotaResponse, QuotaStatus } from '../helpers/quota-helpers.js';
import { Organization } from '../models/organization.js';

const logger = createLogger('quota-service');

// Error classes

/** Thrown when an organization document is not found in MongoDB. */
export class OrgNotFoundError extends Error {
  constructor(orgId?: string) {
    super(orgId ? `Organization not found: ${orgId}` : 'Organization not found');
    this.name = 'OrgNotFoundError';
  }
}

// Result types

/** Data accepted by the update method. */
interface UpdateOrgData {
  name?: string;
  slug?: string;
  tier?: string;
  quotas?: Partial<Record<QuotaType, number>>;
}

/** Pagination options for list endpoints. */
interface ListOrgsOptions {
  limit?: number;
  offset?: number;
}

/**
 * Hard upper bound on a single {@link QuotaService.findAll} page. A caller that
 * omits `limit` (or passes something larger) is clamped to this so an unbounded
 * `Organization.find()` can never pull the entire collection into memory.
 */
const FIND_ALL_MAX_LIMIT = 1000;

/** Options for the decrement flow. */
interface DecrementOptions {
  /**
   * The `resetAt` timestamp the caller observed at reserve time. When set,
   * the decrement is only applied if the current `resetAt` still matches —
   * preventing rollbacks from stealing from the next period after a roll-over.
   */
  resetAtSnapshot?: string;
}

/**
 * The `$set` stage every increment runs: add `amount` to `usage.<type>.used`,
 * but treat an EXPIRED period as if `used` were 0 and advance `resetAt` by
 * `resetDays` in the same breath.
 *
 * Driven entirely by `$$NOW` so the stage and the caller's filter `$expr` see
 * the exact same server-side timestamp, and so the period boundary is set by
 * Mongo rather than by a captured `new Date()` on whichever API node handled
 * the request.
 *
 * The `$ifNull` around `used` is load-bearing: a subdoc with `resetAt` set but
 * `used` ABSENT made `$add` yield null, so `used` was written as null and every
 * later `$add: [null, amount]` stayed null — the counter silently stopped
 * incrementing AND stopped enforcing.
 *
 * Shared by the flat-org increment and the own-counter half of the pooled one
 * (the root's own row, or a team's attribution row), so they can never drift on
 * period roll-over.
 */
function resetIfExpiredStage(quotaType: QuotaType, amount: number, resetDays: number): Record<string, unknown> {
  const usagePath = `usage.${quotaType}`;
  const expired = { $lte: [`$${usagePath}.resetAt`, '$$NOW'] };
  return {
    $set: {
      [`${usagePath}.used`]: {
        $cond: { if: expired, then: amount, else: { $add: [{ $ifNull: [`$${usagePath}.used`, 0] }, amount] } },
      },
      [`${usagePath}.resetAt`]: {
        $cond: {
          if: expired,
          then: { $dateAdd: { startDate: '$$NOW', unit: 'day', amount: resetDays } },
          else: `$${usagePath}.resetAt`,
        },
      },
      // CAPTURE THE CAP at the period boundary, in the same atomic update that
      // rolls the counter — so the snapshot and the window can never disagree.
      // Every reader then takes `max(snapshot, current)` (`effectiveLimit`, and
      // `liveFitsExpr` in the increment filters), which is what stops a
      // mid-period downgrade stranding an account over a cap it already spent
      // against (a month-long refusal for `cpuCredits`, which rolls monthly).
      // Mid-period the snapshot is left alone: an UPGRADE still lands
      // immediately because the max picks the larger.
      [`${usagePath}.limitAtPeriodStart`]: {
        $cond: {
          if: expired,
          then: `$quotas.${quotaType}`,
          else: { $ifNull: [`$${usagePath}.limitAtPeriodStart`, `$quotas.${quotaType}`] },
        },
      },
    },
  };
}

/**
 * Does an increment of `amount` into a LIVE period fit? The period binds on the
 * {@link effectiveLimitExpr} (caps only rise mid-period) of the current limit
 * and the counter's `limitAtPeriodStart`: unlimited if that is -1, otherwise
 * `used + amount` under it widened by the type's soft band
 * ({@link enforcedLimitExpr}). An EXPIRED period starts afresh at the current
 * limit, so its branch uses `enforcedLimitExpr(quotaType, limitExpr)` directly.
 *
 * Before this the filters bound on the CURRENT limit alone, so the snapshot the
 * update stage carefully captures was read by the status views and ignored by
 * enforcement: after a mid-period downgrade from 1000 to 100, an account at 400
 * read `allowed: true, remaining: 600` and had every reservation refused — the
 * exact stranding the snapshot exists to prevent, for a month on `cpuCredits`.
 */
function liveFitsExpr(quotaType: QuotaType, limitExpr: unknown, counterPath: string, amount: number): unknown {
  const effective = effectiveLimitExpr(limitExpr, `$${counterPath}.limitAtPeriodStart`);
  // `$ifNull` like the update stages: a subdoc with `resetAt` set but `used`
  // ABSENT made `$add` yield null, so `used` was written as null and every later
  // `$add: [null, amount]` stayed null — the counter silently stopped
  // incrementing AND stopped enforcing.
  const after = { $add: [{ $ifNull: [`$${counterPath}.used`, 0] }, amount] };
  return { $or: [{ $eq: [effective, -1] }, { $lte: [after, enforcedLimitExpr(quotaType, effective)] }] };
}

/**
 * The pooled-counter half of a pooled increment, as one `$set` stage over the
 * ROOT document: add `amount` to `poolUsage.<type>`, rolling an expired period
 * exactly like {@link resetIfExpiredStage}.
 *
 * A counter that has never started (no `resetAt`) is SEEDED from the root's own
 * live usage — that is what the account consumed while it was still flat, and
 * starting the pool at 0 would hand a fresh allowance to an org the moment it
 * created its first team. The seeded counter inherits the own period's
 * `resetAt` so the two roll over together.
 *
 * Every expression reads the PRE-update document, so the same stage composes
 * with the own-usage stage in one update when the root itself is the caller.
 */
function poolIncrementStage(quotaType: QuotaType, amount: number, resetDays: number): Record<string, unknown> {
  const pool = `poolUsage.${quotaType}`;
  const own = `usage.${quotaType}`;
  const started = { $eq: [{ $type: `$${pool}.resetAt` }, 'date'] };
  const expired = { $lte: [`$${pool}.resetAt`, '$$NOW'] };
  const ownLive = { $gt: [`$${own}.resetAt`, '$$NOW'] };
  const nextReset = { $dateAdd: { startDate: '$$NOW', unit: 'day', amount: resetDays } };
  return {
    $set: {
      [`${pool}.used`]: {
        $cond: {
          if: started,
          then: { $cond: { if: expired, then: amount, else: { $add: [{ $ifNull: [`$${pool}.used`, 0] }, amount] } } },
          else: { $add: [{ $cond: { if: ownLive, then: { $ifNull: [`$${own}.used`, 0] }, else: 0 } }, amount] },
        },
      },
      [`${pool}.resetAt`]: {
        $cond: {
          if: started,
          then: { $cond: { if: expired, then: nextReset, else: `$${pool}.resetAt` } },
          else: { $cond: { if: ownLive, then: `$${own}.resetAt`, else: nextReset } },
        },
      },
      // The pooled counter captures its period's cap exactly as the per-org one
      // does. A root with teams is the account most likely to BUY and CANCEL
      // packs, so it is the population most exposed to a mid-period reduction
      // stranding it over a cap it already spent against — leaving the pooled
      // half unprotected would have put the protection on the wrong counter.
      [`${pool}.limitAtPeriodStart`]: {
        $cond: {
          if: { $and: [started, { $not: expired }] },
          then: { $ifNull: [`$${pool}.limitAtPeriodStart`, `$quotas.${quotaType}`] },
          else: `$quotas.${quotaType}`,
        },
      },
    },
  };
}

/**
 * The filter `$expr` admitting a pooled increment: the ROOT's limit (its tier's
 * preset when unset) is unlimited, or the pool's CURRENT usage — 0 for an
 * expired period, the seed for an unstarted one — plus `amount` fits under the
 * ENFORCED cap. A LIVE pool period binds on {@link liveFitsExpr} (its
 * `limitAtPeriodStart` snapshot honoured); an expired or unstarted one starts
 * at the current limit. Mirrors {@link poolIncrementStage}'s branches exactly,
 * so the check and the write can never disagree about which period they are in.
 */
function poolFitsExpr(quotaType: QuotaType, amount: number): Record<string, unknown> {
  const pool = `poolUsage.${quotaType}`;
  const own = `usage.${quotaType}`;
  const limitExpr = { $ifNull: [`$quotas.${quotaType}`, defaultLimitExpr(quotaType)] };
  const freshCap = enforcedLimitExpr(quotaType, limitExpr);
  const started = { $eq: [{ $type: `$${pool}.resetAt` }, 'date'] };
  const live = { $and: [started, { $gt: [`$${pool}.resetAt`, '$$NOW'] }] };
  const unstartedUsed = { $cond: { if: { $gt: [`$${own}.resetAt`, '$$NOW'] }, then: { $ifNull: [`$${own}.used`, 0] }, else: 0 } };
  return {
    $or: [
      { $eq: [limitExpr, -1] },
      // Live pool period: current pooled usage under the period's effective cap.
      { $and: [live, liveFitsExpr(quotaType, limitExpr, pool, amount)] },
      // Expired pool period: the amount alone, against the current limit.
      { $and: [started, { $not: [live] }, { $lte: [amount, freshCap] }] },
      // Unstarted pool: seeded from the root's own live usage, current limit.
      { $and: [{ $not: [started] }, { $lte: [{ $add: [unstartedUsed, amount] }, freshCap] }] },
    ],
  };
}

/** An increment's result plus WHERE it was enforced (for the usage ledger + threshold notices). */
export interface IncrementOutcome extends QuotaReserveResult {
  /** The account the units count against: the pool root, or the org itself when flat. */
  rootOrgId: string;
  /**
   * Refunds only: false when nothing was given back because the period rolled
   * over between reserve and refund (the result is then the current state).
   */
  applied?: boolean;
}

/** What a metered (partially admitted) increment did: units counted vs served-but-over-cap. */
export interface MeteredOutcome extends IncrementOutcome {
  counted: number;
  overshoot: number;
}

/** Conditional writes one metered increment may spend chasing a contended cap. */
const METERED_ATTEMPTS = 4;

/** One breached dimension for one ACCOUNT (pool root), as the at-risk scan reports it. */
export interface AtRiskEntry {
  orgId: string;
  name: string;
  slug: string;
  tier?: string;
  type: QuotaType;
  used: number;
  limit: number;
  percent: number;
}

// Service class

/**
 * Quota service encapsulating all Mongoose operations for organizations.
 *
 * Provides:
 * - findAtRisk()  every account at/over a threshold, evaluated by pool
 * - findAll()  one page of every organisation with quotas (admin view)
 * - findOwnByOrgId()  one org's OWN numbers, no pooling
 * - findByOrgId()  single-org quota summary (pooled)
 * - getQuotaStatus()  per-type status for an org
 * - update()  update name/slug/tier/limits
 * - resetUsage()  zero-out usage counters
 * - delete()  drop the org document entirely
 * - incrementUsage() / incrementMetered()  atomic increment with limit enforcement
 * - decrementUsage()  roll back a previously reserved increment
 */
export class QuotaService {
  // Read operations

  /**
   * Every account at or above `threshold` percent on any counted dimension,
   * evaluated BY POOL.
   *
   * This cannot be done from `findAll`, which returns each org's OWN summarized
   * numbers — the wrong ones twice over for a pooled account. A team's own
   * limits are -1, so it reads as "unlimited" and was skipped entirely; and a
   * root shows only its own usage rather than the subtree's, so an account
   * sitting at 95% of its pooled cap looked idle and alerting never fired. The
   * per-org `/quotas/:orgId/at-risk` route already resolves the pool; this is
   * the cross-org scan catching up, through the SAME `pooledStatusFromRows`
   * enforcement uses, so the gate and the alert cannot disagree.
   *
   * Reports the ROOT, once per breached dimension — the root is the account.
   * Paged against Mongo so memory per round-trip stays flat, but grouped before
   * being judged, because a team and its root can land on different pages.
   */
  async findAtRisk(threshold: number, pageSize: number): Promise<AtRiskEntry[]> {
    type ScanRow = PoolRow & { _id: string; slug?: string; parentOrgId?: string | null };

    // Paged on `_id` — UNIQUE, so skip/limit pages are disjoint and complete.
    // It was paged on `name`, which is not unique: Mongo does not order ties
    // stably across separate queries, so two orgs sharing a name on a page
    // boundary could each be returned twice or not at all — a duplicated team
    // row double-counts its usage into the pool's fallback sum, a dropped root
    // silently leaves its account out of the scan. The result is re-sorted by
    // percent below, so the scan order is irrelevant to the caller. The page
    // size is clamped ONCE and the same figure drives the stride and the
    // exhaustion test, so a caller passing more than the clamp cannot end the
    // walk after the first page.
    const size = Math.min(pageSize, FIND_ALL_MAX_LIMIT);
    const rows: ScanRow[] = [];
    for (let offset = 0; ; offset += size) {
      const page = await Organization.find()
        .select('name slug tier quotas usage poolUsage parentOrgId')
        .sort({ _id: 1 })
        .skip(offset)
        .limit(size)
        .lean() as unknown as ScanRow[];
      for (const r of page) rows.push({ ...r, _id: String(r._id) });
      if (page.length < size) break; // collection exhausted
    }

    const byId = new Map(rows.map((r) => [r._id, r]));
    /** Walk to the pool root. Cycle-guarded: a corrupted parent chain must not
     *  hang the scan, so a repeat visit stops at the last good node. */
    const rootOf = (row: ScanRow): string => {
      const seen = new Set<string>([row._id]);
      let cur = row;
      while (cur.parentOrgId) {
        const parent = byId.get(cur.parentOrgId);
        if (!parent || seen.has(parent._id)) break;
        seen.add(parent._id);
        cur = parent;
      }
      return cur._id;
    };

    const pools = new Map<string, ScanRow[]>();
    for (const row of rows) {
      const root = rootOf(row);
      const group = pools.get(root);
      if (group) group.push(row); else pools.set(root, [row]);
    }

    const computed: AtRiskEntry[] = [];
    for (const [rootOrgId, group] of pools) {
      const root = byId.get(rootOrgId);
      if (!root) continue;
      for (const type of VALID_QUOTA_TYPES) {
        const status = pooledStatusFromRows(group, rootOrgId, type);
        if (!status || status.unlimited) continue;
        const percent = atRiskPercent(status);
        if (percent >= threshold) {
          computed.push({
            orgId: rootOrgId,
            name: root.name ?? '',
            slug: root.slug ?? '',
            tier: root.tier,
            type,
            used: status.used,
            limit: status.limit,
            percent,
          });
        }
      }
    }
    computed.sort((a, b) => b.percent - a.percent);
    return computed;
  }

  /**
   * An org's OWN quota numbers, with NO pooling: its own row's limits and its
   * own usage counters. For the per-team usage breakdown (billing's
   * `team_usage_analytics`), where every row must be that team's consumption —
   * {@link findByOrgId} reports the pool for every member of it, so reading it
   * per team printed the account total on every row. Not an enforcement view:
   * a team's own limits are -1 by design.
   */
  async findOwnByOrgId(orgId: string): Promise<OrgQuotaResponse> {
    const org = await Organization.findById(toOrgId(orgId)).select('name slug tier quotas usage').lean();
    if (!org) return buildDefaultOrgQuotaResponse(orgId);
    return buildOrgQuotaResponse(org as unknown as Parameters<typeof buildOrgQuotaResponse>[0]);
  }

  /**
   * One page of every org's quotas, plus the total org count for paging. Used
   * by the operator `GET /quotas/all` (`orgs:read`).
   *
   * Sorted by name with `_id` as the tiebreak: names are not unique, and an
   * offset-paged sort on a non-unique key can repeat or skip the tied rows
   * across page boundaries.
   */
  async findAll(options: ListOrgsOptions = {}): Promise<{ organizations: OrgQuotaResponse[]; total: number }> {
    const query = Organization.find()
      .select('name slug tier quotas usage')
      .sort({ name: 1, _id: 1 });

    if (options.offset !== undefined) query.skip(options.offset);
    // Always bound the page — a caller that omits `limit` must never get an
    // unbounded scan of the whole collection; clamp to FIND_ALL_MAX_LIMIT.
    query.limit(Math.min(options.limit ?? FIND_ALL_MAX_LIMIT, FIND_ALL_MAX_LIMIT));

    const [orgs, total] = await Promise.all([query.lean(), Organization.countDocuments()]);
    return { organizations: orgs.map((org) => buildOrgQuotaResponse(org)), total };
  }

  /**
   * Fetch quota information for a single organization.
   * Default-when-unknown-org behaviour: a logged-in caller from an org that
   * has not yet been provisioned in the quota service still gets a usable
   * response (tier=developer, defaults from config) so the dashboard renders.
   * This is a READ-ONLY multi-tenant fallback — it does NOT create the org
   * document. There is no lazy provisioning: the platform service owns org
   * creation, and `incrementUsage` on a missing org throws `OrgNotFoundError`
   * (it never inserts a document). So an unprovisioned org reads defaults here
   * but cannot reserve/enforce quota until the platform has created it.
   */
  async findByOrgId(orgId: string): Promise<OrgQuotaResponse> {
    type OrgRow = Parameters<typeof buildOrgQuotaResponse>[0];
    const lookup = await findOrgWithHierarchy<OrgRow>(orgId, 'tier quotas usage name slug');
    if (!lookup.self) return buildDefaultOrgQuotaResponse(orgId);
    const own = buildOrgQuotaResponse(lookup.self);

    // Pooled org (a root with teams, or a team): every counted dimension reports
    // the ROOT's limit against the pool's usage — the same numbers the root and
    // each of its teams see, and the same ones increment enforces.
    // Flat orgs stop here after the single lookup query. See pooled-quota.ts.
    const response = await applyPooledQuotas(orgId, own, lookup);
    await this.fillStorageUsage(response);
    return response;
  }

  /**
   * Fill `storageBytes.used` from the registry's live measurement (nothing
   * increments it, so the stored counter is always 0). A pool reports its whole
   * subtree's storage against the pooled cap; a flat org its own namespace.
   * Fail-soft: an unmeasurable registry leaves the 0 in place.
   */
  private async fillStorageUsage(response: OrgQuotaResponse): Promise<void> {
    const slot = response.quotas.storageBytes;
    if (!slot) return;
    try {
      const scope = response.pool ? await expandOrgScope(response.pool.rootOrgId) : [response.orgId];
      const bytes = await fetchStorageBytes(scope);
      if (bytes === null) return;
      slot.used = bytes;
      slot.remaining = slot.limit === -1 ? -1 : Math.max(0, slot.limit - bytes);
    } catch (err) {
      logger.debug('Storage usage not filled', { orgId: response.orgId, err: String(err) });
    }
  }

  /**
   * Fill a storage status's `used` with the ACCOUNT's measured total — the whole
   * pool's storage against the pooled cap, which is exactly the figure the
   * dashboard reports.
   *
   * Storage is measured, not metered, so the stored counter is structurally 0
   * and this single-type path reported "0 bytes used" to every caller. That
   * includes the registry's push gate, which is precisely why the gate measures
   * a namespace itself — and why a tier's storage figure has been a
   * per-namespace ceiling rather than an account budget: a five-team account
   * could hold five times its headline figure, and one $19.99 Storage Pack
   * raised every namespace's ceiling at once.
   *
   * Putting the account total here is what makes an account budget enforceable
   * without a fan-out on the token-issuance hot path: the gate still reads one
   * number, and the per-org registry readings are already cached.
   *
   * Fail-soft: an unmeasurable registry leaves the 0 in place, and the gate's
   * own fail-closed rule decides what to do with an unverifiable figure.
   */
  private async withAccountStorage(orgId: string, status: QuotaStatus): Promise<QuotaStatus> {
    try {
      // The pool ROOT's subtree, not this org's own: a team's storage counts
      // toward the account, which is the whole point of an account budget.
      const scope = await expandOrgScope(await resolveRootOrgId(orgId));
      const bytes = await fetchStorageBytes(scope);
      if (bytes === null) return status;
      return {
        ...status,
        used: bytes,
        remaining: status.limit === -1 ? -1 : Math.max(0, status.limit - bytes),
        allowed: status.limit === -1 || bytes < enforcedQuotaLimit('storageBytes', status.limit),
      };
    } catch (err) {
      logger.debug('Account storage total not filled', { orgId, err: String(err) });
      return status;
    }
  }

  /**
   * Get the status of a single quota type for an organization.
   * Computes limit, usage, remaining capacity, and reset date.
   */
  async getQuotaStatus(orgId: string, quotaType: QuotaType): Promise<QuotaStatus> {
    // Pooled orgs (a root with teams, or a team) report the ROOT's limit +
    // subtree usage so the gate read matches the shared-cap enforcement on
    // increment. A resolution failure degrades to the last-known pooled cap, or
    // — for a team, whose own limits are -1 — raises
    // {@link QuotaPoolUnavailableError} rather than reporting "unlimited".
    const lookup = await findOrgWithHierarchy<PoolRow>(orgId, `tier quotas.${quotaType} usage.${quotaType}`);
    const pooled = await pooledStatusOrFallback(orgId, lookup, quotaType);
    if (pooled) return quotaType === 'storageBytes' ? this.withAccountStorage(orgId, pooled) : pooled;

    const org = lookup.self;
    const limit = org?.quotas?.[quotaType] ?? defaultLimitFor(org?.tier, quotaType);
    const stored = org?.usage?.[quotaType];
    // `limitAtPeriodStart` rides along: dropping it here made this — the gate
    // read every service's `checkQuota` makes — ignore the period snapshot the
    // dashboard honours, so the two disagreed after a mid-period downgrade.
    const usage = stored
      ? { used: stored.used ?? 0, resetAt: stored.resetAt ?? nextQuotaResetDate(periodDaysFor(quotaType)), limitAtPeriodStart: stored.limitAtPeriodStart }
      : { used: 0, resetAt: nextQuotaResetDate(periodDaysFor(quotaType)) };

    // Storage is MEASURED, so the stored counter is structurally 0 and this
    // single-type path would report "0 bytes used" to every caller — including
    // the registry's push gate, which is why that gate measures a namespace
    // itself. Filling it here puts the ACCOUNT total (the whole pool's storage
    // against the pooled cap, exactly what the dashboard shows) at the one place
    // enforcement reads, with the quota service's own per-org cache amortising
    // the fan-out. Fail-soft: an unmeasurable registry leaves the 0, and the
    // gate's own fail-closed rule decides what to do about it.
    if (quotaType === 'storageBytes') {
      return this.withAccountStorage(orgId, computeQuotaStatus(limit, usage, quotaType));
    }

    return computeQuotaStatus(limit, usage, quotaType);
  }

  // Write operations

  /**
   * Update an organization's name, slug, tier, and/or quota limits.
   * @throws {OrgNotFoundError} when the org document does not exist
   * @throws {ValidationError} when an invalid tier is supplied
   */
  async update(orgId: string, data: UpdateOrgData): Promise<OrgQuotaResponse> {
    const org = await Organization.findById(toOrgId(orgId));
    if (!org) throw new OrgNotFoundError(orgId);

    // A team's tier is inherited and its limits are -1 by design: the caps are
    // pooled at the root. Writing them on the team would be silently ignored by
    // enforcement (which reads the root), so reject it outright.
    if ((data.tier !== undefined || data.quotas !== undefined) && org.parentOrgId) {
      throw new ValidationError(
        `Organization ${orgId} is a team: its tier and quota limits are pooled at its root organization. Edit the root organization instead.`,
      );
    }

    if (data.name !== undefined) org.name = data.name;
    if (data.slug !== undefined) org.slug = data.slug;

    if (data.tier !== undefined) {
      if (!isValidTier(data.tier)) {
        throw new ValidationError(`Invalid tier: ${data.tier}`);
      }
      const tier: QuotaTier = data.tier;
      org.tier = tier;
      applyQuotaLimits(org, QUOTA_TIERS[tier].limits);
    }
    if (data.quotas) applyQuotaLimits(org, data.quotas);

    await org.save();

    logger.info('Quota updated', { orgId });
    return buildOrgQuotaResponse(org);
  }

  /**
   * Reset usage counters for one or all quota types.
   * @throws {OrgNotFoundError} when the org document does not exist
   */
  async resetUsage(orgId: string, quotaType?: string): Promise<OrgQuotaResponse> {
    const org = await Organization.findById(toOrgId(orgId));
    if (!org) throw new OrgNotFoundError(orgId);

    // Fresh Date per slot — otherwise mutating one slot's resetAt would mutate
    // every other slot's via shared reference. A pool ROOT's pooled counter is
    // reset with it: that counter is what the shared cap binds on, so zeroing
    // only the root's own row would free nothing. (Resetting a TEAM moves only
    // its own attribution counter — reset the root to free pooled capacity.)
    //
    // The reset date is computed PER TYPE rather than once: an all-types reset
    // spans windows of different length now that `cpuCredits` is monthly, so one
    // shared date would hand credits a three-day period (or every other quota a
    // thirty-day one, depending which way it was computed).
    const types = quotaType ? [quotaType as QuotaType] : VALID_QUOTA_TYPES;
    for (const k of types) {
      const resetDate = nextQuotaResetDate(periodDaysFor(k));
      // A reset starts a NEW period, so the snapshot is the cap as it stands now
      // — otherwise an operator reset would carry a stale ceiling forward.
      org.usage[k] = { used: 0, resetAt: new Date(resetDate), limitAtPeriodStart: org.quotas[k] };
      if (org.poolUsage?.[k]?.resetAt) org.poolUsage[k] = { used: 0, resetAt: new Date(resetDate) };
    }

    await org.save();

    logger.info('Quota usage reset', { orgId, quotaType: quotaType || 'all' });
    return buildOrgQuotaResponse(org);
  }

  /**
   *  delete the org's Mongo document entirely. Idempotent: deleting
   * an already-missing org returns false (rather than throwing), which is
   * the right shape for the platform's cascade orchestrator (it doesn't
   * care whether the cleanup was a no-op).
   */
  async delete(orgId: string): Promise<boolean> {
    const result = await Organization.deleteOne({ _id: toOrgId(orgId) });
    if (result.deletedCount > 0) {
      logger.info('Quota org deleted', { orgId });
      return true;
    }
    return false;
  }

  /**
   * Increment usage for a quota type.
   *
   * Handles these distinct flows (there is no limit bypass: the only callers
   * are services, and a service metering a tenant must never waive its cap):
   * 1. **Auto-reset**  atomically resets expired periods before incrementing.
   * 2. **Flat org**  one conditional update on the org's own document that only
   *    succeeds when its own limit allows.
   * 3. **Pooled org** (a root with teams, or a team)  one conditional update on
   *    the ROOT document's pooled counter against the root's limit
   *    ({@link incrementPooled}); the org's own counter follows as attribution.
   *
   * @throws {OrgNotFoundError} when the org document does not exist
   * @throws {QuotaPoolUnavailableError} for a team whose root can't be resolved
   */
  async incrementUsage(orgId: string, quotaType: QuotaType, amount: number): Promise<IncrementOutcome> {
    // ----- Org → team hierarchy: the shared root cap, enforced atomically -----
    // A resolution failure is handled INSIDE resolveIncrementRoot: a team (own
    // limits -1) gets a 503, a root/flat org falls through to its own row. It is
    // deliberately NOT swallowed here — falling through for a team would hit the
    // per-org `$expr`, which its -1 limits make a no-op.
    const rootOrgId = await resolveIncrementRoot(orgId, quotaType);
    if (rootOrgId) return this.incrementPooled(orgId, rootOrgId, quotaType, amount);

    // ----- Atomic reset-if-expired + increment with limit check -----
    // Single pipeline-update driven by `$$NOW` so the filter `$expr` and the
    // `$set` `$cond` see the exact same server-side timestamp. The next-reset
    // value is computed from `$$NOW` via `$dateAdd` so the period boundary
    // is set by the server, not a captured `new Date()` from the API node.
    const usagePath = `usage.${quotaType}`;
    const resetDays = periodDaysFor(quotaType);
    // Coalesce a MISSING stored limit to the org's TIER preset — Mongoose
    // `default:` only fires on insert, so a newly-added quota type on an
    // un-backfilled org doc would otherwise match no branch and hard-429 (the
    // read + pooled paths apply the same default).
    const limitExpr = { $ifNull: [`$quotas.${quotaType}`, defaultLimitExpr(quotaType)] };
    // The cap a FRESH period's fit is measured against: the current limit, or
    // for a banded type the soft band above it (api-core `enforcedQuotaLimit`).
    // A live period binds on `liveFitsExpr` instead (the snapshot honoured).
    const capExpr = enforcedLimitExpr(quotaType, limitExpr);
    const org = await Organization.findOneAndUpdate(
      {
        _id: toOrgId(orgId),
        $expr: {
          $or: [
            { $eq: [limitExpr, -1] },
            // Period expired: amount alone must fit within limit (post-reset).
            {
              $and: [
                { $lte: [`$${usagePath}.resetAt`, '$$NOW'] },
                { $lte: [amount, capExpr] },
              ],
            },
            // Period not expired: current used + amount must fit under the
            // PERIOD's effective cap (its start-of-period snapshot honoured).
            { $and: [{ $gt: [`$${usagePath}.resetAt`, '$$NOW'] }, liveFitsExpr(quotaType, limitExpr, usagePath, amount)] },
          ],
        },
      },
      [resetIfExpiredStage(quotaType, amount, resetDays)],
      // `updatePipeline: true` is REQUIRED for aggregation-pipeline (array)
      // updates as of Mongoose 9 — without it the driver throws "Cannot pass an
      // array to query updates", which surfaces as a 500 on every increment.
      { returnDocument: 'after', updatePipeline: true },
    );

    // `findOneAndUpdate` returns null when the filter didn't match — could be
    // "quota exceeded" or "org missing". Disambiguate with a single read so
    // the caller (route) can choose between 429 and 404 cleanly.
    if (!org) {
      const existing = await Organization.findById(toOrgId(orgId));
      if (!existing) throw new OrgNotFoundError(orgId);

      // The EFFECTIVE limit (the period's snapshot honoured), as the filter
      // judged it — `incrementMetered` sizes its retry from this figure.
      const status = computeQuotaStatus(
        existing.quotas[quotaType] ?? defaultLimitFor(existing.tier, quotaType),
        existing.usage[quotaType] ?? { used: 0, resetAt: nextQuotaResetDate(periodDaysFor(quotaType)) },
      );
      return { ...buildReserveResult(quotaType, status.limit, status.used, status.resetAt, 'exceeded'), rootOrgId: orgId };
    }

    // Default a MISSING stored limit exactly as the exceeded/read paths do.
    // Without it the success path returned `limit: undefined` and
    // `remaining: Math.max(0, undefined - used)` = NaN, which flowed out to
    // every reserveQuota caller and the `/quotas` read surface. Reported as the
    // EFFECTIVE limit, the one the reservation was admitted under.
    // The period is live after the write, so its snapshot applies.
    const usage = org.usage[quotaType];
    const limit = effectiveLimit(org.quotas[quotaType] ?? defaultLimitFor(org.tier, quotaType), usage.limitAtPeriodStart);
    return { ...buildReserveResult(quotaType, limit, usage.used ?? 0, usage.resetAt, 'allowed'), rootOrgId: orgId };
  }

  /**
   * The METERED increment behind the per-pod batch flush (api-core
   * quota-increment-batcher): apply `amount` with PARTIAL admission.
   *
   * `incrementUsage` is all-or-nothing — right for a reservation, wrong for a
   * second's worth of already-served requests summed together: refusing all 40
   * because 38 fit would under-count 38 real calls. So the sum is tried whole
   * (the common case, one conditional write); when it does not fit, the refusal
   * reports where the counter stands, the part that fits under the ENFORCED cap
   * is retried, and the rest is `overshoot` — served, never counted, recorded in
   * the ledger. Each attempt is the same atomic conditional update, so the
   * counter can never pass the cap however many replicas race; a lost race
   * just re-reads and retries with the smaller fit, up to
   * {@link METERED_ATTEMPTS} times, after which the remainder is overshoot.
   *
   * @throws {OrgNotFoundError} / {QuotaPoolUnavailableError} as `incrementUsage`
   */
  async incrementMetered(orgId: string, quotaType: QuotaType, amount: number): Promise<MeteredOutcome> {
    let want = amount;
    let last: IncrementOutcome | undefined;
    for (let attempt = 0; attempt < METERED_ATTEMPTS && want > 0; attempt++) {
      last = await this.incrementUsage(orgId, quotaType, want);
      if (!last.exceeded) return { ...last, counted: want, overshoot: amount - want };
      const { limit, used } = last.quota;
      const fit = limit === -1 ? want : enforcedQuotaLimit(quotaType, limit) - used;
      if (fit <= 0) break;
      want = Math.min(want, fit);
    }
    // `last` is set: the loop runs at least once for amount ≥ 1.
    return { ...last!, counted: 0, overshoot: amount };
  }

  /**
   * The pooled increment: ONE conditional update on the ROOT document moves the
   * pool counter (`poolUsage.<type>`) only when the root's limit allows. That
   * single-document atomicity is the whole enforcement — the root and every
   * team race on the same counter, so N concurrent increments at the cap admit
   * exactly the remaining capacity. (The old shape — sum the subtree, then
   * increment the org's own row — let concurrent teams each pass the pre-check
   * and jointly overshoot.)
   *
   * The org's OWN counter then follows unconditionally, as attribution for the
   * per-team breakdown; for the root it is the same update. A failed own write
   * after a granted pool write is logged, never a refusal — the unit is
   * already counted where the cap binds.
   *
   * The returned `resetAt` is the POOL's, so a refund's `resetAtSnapshot`
   * names the period the pool counter is in.
   */
  private async incrementPooled(
    orgId: string,
    rootOrgId: string,
    quotaType: QuotaType,
    amount: number,
  ): Promise<IncrementOutcome> {
    const resetDays = periodDaysFor(quotaType);
    const isRoot = rootOrgId === orgId;
    const stages = [poolIncrementStage(quotaType, amount, resetDays)];
    if (isRoot) stages.push(resetIfExpiredStage(quotaType, amount, resetDays));

    const root = await Organization.findOneAndUpdate(
      { _id: toOrgId(rootOrgId), $expr: poolFitsExpr(quotaType, amount) },
      stages,
      { returnDocument: 'after', updatePipeline: true },
    );

    if (!root) {
      const existing = await Organization.findById(toOrgId(rootOrgId)).select('tier quotas usage poolUsage').lean() as unknown as PoolRow | null;
      if (!existing) throw new OrgNotFoundError(rootOrgId);
      const status = pooledStatusFromRows([{ ...existing, _id: rootOrgId }], rootOrgId, quotaType);
      const limit = status?.limit ?? defaultLimitFor(existing.tier, quotaType);
      return { ...buildReserveResult(quotaType, limit, status?.used ?? 0, status?.resetAt, 'exceeded'), rootOrgId };
    }

    if (!isRoot) {
      try {
        await Organization.updateOne(
          { _id: toOrgId(orgId) },
          [resetIfExpiredStage(quotaType, amount, resetDays)],
          { updatePipeline: true },
        );
      } catch (err) {
        logger.warn('Pooled increment granted but the team\'s own counter did not follow', {
          orgId, rootOrgId, quotaType, amount, err: String(err),
        });
      }
    }

    // The EFFECTIVE pooled limit (the live pool period's snapshot honoured),
    // the one the reservation was admitted under.
    const pool = root.poolUsage?.[quotaType];
    const limit = effectiveLimit(root.quotas?.[quotaType] ?? defaultLimitFor(root.tier, quotaType), pool?.limitAtPeriodStart);
    return { ...buildReserveResult(quotaType, limit, pool?.used ?? amount, pool?.resetAt, 'allowed'), rootOrgId };
  }

  /**
   * Roll back a previously reserved increment. Used by the pre-flight
   * `reserve + commit` pattern in routes that gate on `incrementUsage`
   * before the action: if the action fails, the route calls this to give
   * the slot back. Floors at 0 to keep the counter non-negative even if
   * the period reset happens between reserve and rollback.
   *
   * When `resetAtSnapshot` is supplied, the decrement is conditional: it
   * only applies when the stored `resetAt` still matches. If the period
   * rolled over between reserve and rollback the decrement is a no-op so
   * we don't steal capacity from the new period. For a pooled org the
   * snapshot is the POOL's `resetAt` (what the reservation returned) and the
   * pool counter is what is given back; the org's own counter follows.
   *
   * Idempotent: if the org doesn't exist, returns null silently so the
   * route can roll back without surfacing secondary errors when the
   * original action's failure was "org not found" or similar.
   */
  async decrementUsage(
    orgId: string,
    quotaType: QuotaType,
    amount: number,
    { resetAtSnapshot }: DecrementOptions = {},
  ): Promise<IncrementOutcome | null> {
    let rootOrgId: string | null = null;
    try {
      rootOrgId = await resolveIncrementRoot(orgId, quotaType);
    } catch (err) {
      // A refund must never 503. An unresolvable pool only means the pooled
      // half can't be given back; the own counter still is.
      if (!(err instanceof QuotaPoolUnavailableError)) throw err;
      logger.warn('Pooled refund: root unresolvable, refunding the org\'s own counter only', { orgId, quotaType });
    }
    if (rootOrgId) return this.decrementPooled(orgId, rootOrgId, quotaType, amount, resetAtSnapshot);
    return this.decrementOwn(orgId, quotaType, amount, resetAtSnapshot);
  }

  /** A `$set` stage subtracting `amount` from `<path>.used`, floored at 0. */
  private static subtractStage(path: string, amount: number): Record<string, unknown> {
    // Clamp to 0 so a rollback after a between-reserve-and-rollback period
    // reset doesn't go negative.
    return { $set: { [`${path}.used`]: { $max: [0, { $subtract: [`$${path}.used`, amount] }] } } };
  }

  private async decrementPooled(
    orgId: string,
    rootOrgId: string,
    quotaType: QuotaType,
    amount: number,
    resetAtSnapshot?: string,
  ): Promise<IncrementOutcome | null> {
    const pool = `poolUsage.${quotaType}`;
    const filter: Record<string, unknown> = { _id: toOrgId(rootOrgId) };
    if (resetAtSnapshot) filter.$expr = { $eq: [`$${pool}.resetAt`, new Date(resetAtSnapshot)] };
    const isRoot = rootOrgId === orgId;
    const stages = [QuotaService.subtractStage(pool, amount)];
    if (isRoot) stages.push(QuotaService.subtractStage(`usage.${quotaType}`, amount));

    const root = await Organization.findOneAndUpdate(filter, stages, { returnDocument: 'after', updatePipeline: true });
    if (!root) {
      // Root gone, or the pool period rolled over between reserve and refund
      // (nothing to give back in the new period). Report the current state.
      const existing = await Organization.findById(toOrgId(rootOrgId)).select('tier quotas usage poolUsage').lean() as unknown as PoolRow | null;
      if (!existing) return null;
      const status = pooledStatusFromRows([{ ...existing, _id: rootOrgId }], rootOrgId, quotaType);
      logger.info('Decrement skipped: pool period rolled over', { orgId, rootOrgId, quotaType, snapshot: resetAtSnapshot });
      return {
        ...buildReserveResult(quotaType, status?.limit ?? defaultLimitFor(existing.tier, quotaType), status?.used ?? 0, status?.resetAt, 'allowed'),
        rootOrgId,
        applied: false,
      };
    }
    if (!isRoot) {
      try {
        await Organization.updateOne({ _id: toOrgId(orgId) }, [QuotaService.subtractStage(`usage.${quotaType}`, amount)], { updatePipeline: true });
      } catch (err) {
        logger.warn('Pooled refund applied but the team\'s own counter did not follow', { orgId, rootOrgId, quotaType, err: String(err) });
      }
    }
    const limit = root.quotas?.[quotaType] ?? defaultLimitFor(root.tier, quotaType);
    const p = root.poolUsage?.[quotaType];
    return { ...buildReserveResult(quotaType, limit, p?.used ?? 0, p?.resetAt, 'allowed'), rootOrgId, applied: true };
  }

  /** The flat-org refund: the org's own counter, snapshot-conditional. */
  private async decrementOwn(
    orgId: string,
    quotaType: QuotaType,
    amount: number,
    resetAtSnapshot?: string,
  ): Promise<IncrementOutcome | null> {
    const usagePath = `usage.${quotaType}`;

    const filter: Record<string, unknown> = { _id: toOrgId(orgId) };
    if (resetAtSnapshot) {
      const snap = new Date(resetAtSnapshot);
      filter.$expr = { $eq: [`$${usagePath}.resetAt`, snap] };
    }

    const org = await Organization.findOneAndUpdate(
      filter,
      [QuotaService.subtractStage(usagePath, amount)],
      // Pipeline (array) update — see incrementUsage: Mongoose 9 requires
      // `updatePipeline: true` or it throws "Cannot pass an array to query updates".
      { returnDocument: 'after', updatePipeline: true },
    );

    if (!org) {
      // Either the org is gone (legitimate idempotent no-op) or the
      // snapshot mismatch fired (period rolled over). Disambiguate so the
      // caller sees the actually-current quota state.
      if (resetAtSnapshot) {
        const existing = await Organization.findById(toOrgId(orgId));
        if (!existing) return null;

        const limit = existing.quotas[quotaType] ?? defaultLimitFor(existing.tier, quotaType);
        const usage = existing.usage[quotaType] ?? {
          used: 0,
          resetAt: nextQuotaResetDate(periodDaysFor(quotaType)),
        };
        logger.info('Decrement skipped: period rolled over', {
          orgId,
          quotaType,
          snapshot: resetAtSnapshot,
          currentResetAt: usage.resetAt?.toISOString(),
        });
        return { ...buildReserveResult(quotaType, limit, usage.used, usage.resetAt, 'allowed'), rootOrgId: orgId, applied: false };
      }
      return null;
    }

    // Default a MISSING stored limit exactly as the exceeded/read paths do.
    // Without it the success path returned `limit: undefined` and
    // `remaining: Math.max(0, undefined - used)` = NaN, which flowed out to
    // every reserveQuota caller and the `/quotas` read surface.
    const limit = org.quotas[quotaType] ?? defaultLimitFor(org.tier, quotaType);
    const usage = org.usage[quotaType];
    return { ...buildReserveResult(quotaType, limit, usage.used ?? 0, usage.resetAt, 'allowed'), rootOrgId: orgId, applied: true };
  }
}

/**
 * Singleton instance of QuotaService.
 *
 * @example
 * ```typescript
 * import { quotaService } from '../services/quota-service.js';
 *
 * const quota = await quotaService.findByOrgId(orgId);
 * ```
 */
export const quotaService = new QuotaService();
