// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { COMPLIANCE_CONTENT_SETS, createLogger, ForbiddenError, isSystemOrgId, ValidationError } from '@pipeline-builder/api-core';
import { schema, withTenantTx, drizzleCount, runWithTenantContext } from '@pipeline-builder/pipeline-data';
import type { RuleScope } from '@pipeline-builder/pipeline-data';
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import { complianceRuleService } from './compliance-rule-service.js';
import { entitlementWatermarkStore } from './entitlement-watermark-store.js';

const logger = createLogger('subscription-service');

/** A transaction handle from `withTenantTx` (the entitlement reconcile runs its
 *  primitives on ONE such tx so check + apply + record commit together). */
export type SubscriptionTx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

/** Run `fn` on `tx` when given, else in a fresh tenant transaction. */
function onTx<T>(tx: SubscriptionTx | undefined, fn: (t: SubscriptionTx) => Promise<T>): Promise<T> {
  return tx ? fn(tx) : withTenantTx(fn);
}

/**
 * Typed errors thrown by this service. They are AppErrors, so `withRoute`
 * answers each with its own status + message and a reworded message can never
 * degrade a 4xx into a 500.
 */
export class SubscriptionRuleNotFoundError extends ValidationError {
  constructor() {
    super('Rule not found');
    this.name = 'SubscriptionRuleNotFoundError';
  }
}

export class SubscriptionNotFoundError extends ValidationError {
  constructor() {
    super('Subscription not found');
    this.name = 'SubscriptionNotFoundError';
  }
}

export class RuleNotPublishedError extends ValidationError {
  constructor() {
    super('Only published rules can be subscribed to');
    this.name = 'RuleNotPublishedError';
  }
}

export class SystemOrgSubscriptionError extends ForbiddenError {
  constructor() {
    super('System org cannot manage rule subscriptions');
    this.name = 'SystemOrgSubscriptionError';
  }
}

const KNOWN_CONTENT_SET_NAMES: ReadonlySet<string> = new Set(COMPLIANCE_CONTENT_SETS);

/** Coerce a jsonb `tags` column (unknown at the type level) to a string[]. */
function tagsOf(tags: unknown): string[] {
  return Array.isArray(tags) ? (tags as string[]) : [];
}

/** Whether a rule's tags carry ANY `set:<x>` marker (curated/entitlement-gated). */
function hasSetTag(tags: unknown): boolean {
  return tagsOf(tags).some((t) => t.startsWith('set:'));
}

/** Distinct KNOWN content-set NAMES (`standard`/`advanced`) among a rule's tags. */
function setNamesFromTags(tags: unknown): string[] {
  const out: string[] = [];
  for (const t of tagsOf(tags)) {
    if (!t.startsWith('set:')) continue;
    const name = t.slice('set:'.length);
    if (KNOWN_CONTENT_SET_NAMES.has(name)) out.push(name);
  }
  return out;
}

/**
 * Invalidate the per-org rules cache after a subscription mutation.
 * `findActiveByOrgAndTarget` is cached per `orgId:target` and otherwise has no
 * way to learn that the subscription set changed.
 */
async function invalidateRulesFor(orgId: string): Promise<void> {
  try {
    await complianceRuleService.invalidateRulesCache(orgId);
  } catch (err) {
    // Non-fatal — cache will self-expire at TTL even if invalidation fails.
    logger.warn('Failed to invalidate rules cache after subscription mutation', { orgId, err });
  }
}

export type ComplianceRuleSubscription = typeof schema.complianceRuleSubscription.$inferSelect;

/**
 * Manages an org's subscriptions to published compliance rules. Subscriptions
 * default to inactive — the org must explicitly activate before the rule's
 * enforcement kicks in. Mutations invalidate the per-org rules cache.
 */
export class ComplianceRuleSubscriptionService {
  /**
   * Subscribe an org to a published rule.
   * Subscriptions start as inactive — the org must explicitly activate to enforce.
   * Uses upsert (onConflictDoUpdate) to handle race conditions atomically.
   */
  async subscribe(orgId: string, ruleId: string, userId: string): Promise<ComplianceRuleSubscription> {
    if (isSystemOrgId(orgId)) {
      throw new SystemOrgSubscriptionError();
    }

    const sub = await withTenantTx(async (tx) => {
      // Verify rule exists, is published, and not soft-deleted
      const [rule] = await tx
        .select({
          id: schema.complianceRule.id,
          scope: schema.complianceRule.scope,
        })
        .from(schema.complianceRule)
        .where(and(
          eq(schema.complianceRule.id, ruleId),
          isNull(schema.complianceRule.deletedAt),
        ));

      if (!rule) throw new SubscriptionRuleNotFoundError();
      if (rule.scope !== 'published') throw new RuleNotPublishedError();

      // Atomic upsert: insert (inactive) or re-subscribe on conflict
      const [result] = await tx
        .insert(schema.complianceRuleSubscription)
        .values({ orgId, ruleId, subscribedBy: userId, isActive: false })
        .onConflictDoUpdate({
          target: [schema.complianceRuleSubscription.orgId, schema.complianceRuleSubscription.ruleId],
          set: {
            isActive: false,
            subscribedBy: userId,
            subscribedAt: new Date(),
            unsubscribedAt: null,
            unsubscribedBy: null,
          },
        })
        .returning();

      logger.info('Org subscribed to published rule (inactive)', { orgId, ruleId, userId });
      return result;
    });
    await invalidateRulesFor(orgId);
    return sub;
  }

  /**
   * Activate or deactivate a subscribed rule for an org.
   * Only active subscriptions are enforced during validation.
   */
  async setActive(orgId: string, ruleId: string, isActive: boolean, userId: string): Promise<ComplianceRuleSubscription> {
    if (isSystemOrgId(orgId)) {
      throw new SystemOrgSubscriptionError();
    }

    const updated = await withTenantTx(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.complianceRuleSubscription)
        .where(and(
          eq(schema.complianceRuleSubscription.orgId, orgId),
          eq(schema.complianceRuleSubscription.ruleId, ruleId),
          isNull(schema.complianceRuleSubscription.unsubscribedAt),
        ));

      if (!existing) throw new SubscriptionNotFoundError();

      const [row] = await tx
        .update(schema.complianceRuleSubscription)
        .set({ isActive })
        .where(eq(schema.complianceRuleSubscription.id, existing.id))
        .returning();

      logger.info('Subscription state changed', { action: isActive ? 'activated' : 'deactivated', orgId, ruleId, userId });
      return row;
    });
    await invalidateRulesFor(orgId);
    return updated;
  }

  /**
   * Unsubscribe an org from a published rule (soft delete).
   */
  async unsubscribe(orgId: string, ruleId: string, userId: string): Promise<void> {
    if (isSystemOrgId(orgId)) {
      throw new SystemOrgSubscriptionError();
    }

    await withTenantTx(async (tx) => {
      const [existing] = await tx
        .select({ id: schema.complianceRuleSubscription.id })
        .from(schema.complianceRuleSubscription)
        .where(and(
          eq(schema.complianceRuleSubscription.orgId, orgId),
          eq(schema.complianceRuleSubscription.ruleId, ruleId),
          isNull(schema.complianceRuleSubscription.unsubscribedAt),
        ));

      if (!existing) throw new SubscriptionNotFoundError();

      await tx
        .update(schema.complianceRuleSubscription)
        .set({ isActive: false, unsubscribedAt: new Date(), unsubscribedBy: userId })
        .where(eq(schema.complianceRuleSubscription.id, existing.id));

      logger.info('Org unsubscribed from published rule', { orgId, ruleId, userId });
    });
    await invalidateRulesFor(orgId);
  }

  /**
   * Paginated list of an org's subscriptions (active + inactive, excludes
   * unsubscribed and soft-deleted rules). Selects all subscription columns so
   * newer fields (`pinnedVersion`, `pausedUntil`, etc.) survive without having
   * to update the projection every schema bump. LIMIT/OFFSET + COUNT run in SQL
   * so we never load the whole table just to slice a page.
   */
  async findByOrg(orgId: string, limit: number, offset: number): Promise<{ subscriptions: ComplianceRuleSubscription[]; total: number }> {
    const whereClause = and(
      eq(schema.complianceRuleSubscription.orgId, orgId),
      isNull(schema.complianceRuleSubscription.unsubscribedAt),
      isNull(schema.complianceRule.deletedAt),
    );

    return withTenantTx(async (tx) => {
      const [countResult] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.complianceRuleSubscription)
        .innerJoin(schema.complianceRule, eq(schema.complianceRuleSubscription.ruleId, schema.complianceRule.id))
        .where(whereClause)
        .then((r: unknown[]) => drizzleCount(r));

      const rows = await tx
        .select()
        .from(schema.complianceRuleSubscription)
        .innerJoin(schema.complianceRule, eq(schema.complianceRuleSubscription.ruleId, schema.complianceRule.id))
        .where(whereClause)
        .limit(limit)
        .offset(offset);

      const subscriptions = rows.map((r: { compliance_rule_subscriptions: ComplianceRuleSubscription }) => r.compliance_rule_subscriptions);
      return { subscriptions, total: countResult?.count ?? 0 };
    });
  }

  /** List all orgs subscribed to a specific rule (system org admin view). */
  async findSubscribers(ruleId: string): Promise<ComplianceRuleSubscription[]> {
    return withTenantTx(async (tx) => tx
      .select()
      .from(schema.complianceRuleSubscription)
      .innerJoin(schema.complianceRule, eq(schema.complianceRuleSubscription.ruleId, schema.complianceRule.id))
      .where(and(
        eq(schema.complianceRuleSubscription.ruleId, ruleId),
        isNull(schema.complianceRuleSubscription.unsubscribedAt),
        isNull(schema.complianceRule.deletedAt),
      ))
      .then((rows) => rows.map((r: { compliance_rule_subscriptions: ComplianceRuleSubscription }) => r.compliance_rule_subscriptions)));
  }

  /**
   * Auto-subscribe an org to all published rules (inactive by default).
   * Called during org onboarding so new orgs see the full catalog in their subscriptions.
   * Skips rules the org is already subscribed to.
   */
  async autoSubscribeToPublished(orgId: string, userId: string = 'system'): Promise<number> {
    if (isSystemOrgId(orgId)) return 0;

    // Fetch all active published rules (scope='published' is only allowed for system org)
    const publishedRulesRaw = await withTenantTx(async (tx) => tx
      .select({ id: schema.complianceRule.id, tags: schema.complianceRule.tags })
      .from(schema.complianceRule)
      .where(and(
        eq(schema.complianceRule.scope, 'published' as RuleScope),
        eq(schema.complianceRule.isActive, true),
        isNull(schema.complianceRule.deletedAt),
      )));

    // Onboarding auto-subscribes ONLY the baseline (un-tagged) catalog. Curated,
    // entitlement-gated libraries (`set:*`-tagged rules) must NOT be handed out
    // here — subscribing a new org to them would leak the paid catalog into the
    // subscriptions list and (if later mass-activated) enforce it for free.
    // Entitled sets are activated by the entitlement lifecycle
    // (`syncEntitledSets`), never by onboarding.
    const publishedRules = publishedRulesRaw.filter((r: { tags: unknown }) => !hasSetTag(r.tags));

    if (publishedRules.length === 0) return 0;

    // Batch insert all subscriptions in a single query, skipping conflicts
    const values = publishedRules.map(rule => ({
      orgId,
      ruleId: rule.id,
      subscribedBy: userId,
      isActive: false,
    }));

    const result = await withTenantTx(async (tx) => tx
      .insert(schema.complianceRuleSubscription)
      .values(values)
      .onConflictDoNothing({ target: [schema.complianceRuleSubscription.orgId, schema.complianceRuleSubscription.ruleId] })
      .returning({ id: schema.complianceRuleSubscription.id }));

    const subscribed = result.length;
    logger.info('Auto-subscribed org to published rules', { orgId, total: publishedRules.length, subscribed });
    if (subscribed > 0) await invalidateRulesFor(orgId);
    return subscribed;
  }

  /**
   * Bulk activate/deactivate subscriptions.
   * Returns the ruleIds actually toggled (rows that matched and were updated) —
   * NOT the requested set. Callers deriving a count use `affectedIds.length`;
   * callers auditing per-rule posture changes (see routes/subscriptions.ts) must
   * iterate the returned ids so events are emitted only for rules that changed.
   */
  async bulkSetActive(orgId: string, ruleIds: string[], isActive: boolean, _userId: string, inTx?: SubscriptionTx): Promise<string[]> {
    if (isSystemOrgId(orgId)) {
      throw new SystemOrgSubscriptionError();
    }

    // Single batch update instead of N individual queries. With `inTx` the caller
    // owns the transaction AND the post-commit cache invalidation.
    const result = await onTx(inTx, async (tx) => tx
      .update(schema.complianceRuleSubscription)
      .set({ isActive })
      .where(and(
        eq(schema.complianceRuleSubscription.orgId, orgId),
        inArray(schema.complianceRuleSubscription.ruleId, ruleIds),
        isNull(schema.complianceRuleSubscription.unsubscribedAt),
      ))
      .returning({ ruleId: schema.complianceRuleSubscription.ruleId }));

    const affectedIds = result.map((r) => r.ruleId);
    logger.info('Bulk subscription state changed', { action: isActive ? 'activated' : 'deactivated', orgId, requested: ruleIds.length, updated: affectedIds.length });
    if (affectedIds.length > 0 && !inTx) await invalidateRulesFor(orgId);
    return affectedIds;
  }

  /** Pin a subscription to a specific rule version snapshot. */
  async pinVersion(orgId: string, ruleId: string, userId: string): Promise<ComplianceRuleSubscription> {
    if (isSystemOrgId(orgId)) {
      throw new SystemOrgSubscriptionError();
    }

    const updated = await withTenantTx(async (tx) => {
      // Fetch the subscription
      const [sub] = await tx
        .select()
        .from(schema.complianceRuleSubscription)
        .where(and(
          eq(schema.complianceRuleSubscription.orgId, orgId),
          eq(schema.complianceRuleSubscription.ruleId, ruleId),
          isNull(schema.complianceRuleSubscription.unsubscribedAt),
        ));
      if (!sub) throw new SubscriptionNotFoundError();

      // Fetch current rule state as snapshot
      const [rule] = await tx
        .select()
        .from(schema.complianceRule)
        .where(eq(schema.complianceRule.id, ruleId));
      if (!rule) throw new SubscriptionRuleNotFoundError();

      // Snapshot the entire rule row so any field the engine cares about
      // (effectiveFrom/Until, priority, tags, target, etc.) survives even
      // if the upstream rule is later edited or deleted.
      const snapshot = {
        ...rule,
        pinnedAt: new Date().toISOString(),
        pinnedBy: userId,
      };

      const [row] = await tx
        .update(schema.complianceRuleSubscription)
        .set({ pinnedVersion: snapshot })
        .where(eq(schema.complianceRuleSubscription.id, sub.id))
        .returning();

      logger.info('Subscription pinned to rule version', { orgId, ruleId, userId });
      return row;
    });
    await invalidateRulesFor(orgId);
    return updated;
  }

  /** Unpin a subscription (use latest rule version). */
  async unpinVersion(orgId: string, ruleId: string): Promise<ComplianceRuleSubscription> {
    const [updated] = await withTenantTx(async (tx) => tx
      .update(schema.complianceRuleSubscription)
      .set({ pinnedVersion: null })
      .where(and(
        eq(schema.complianceRuleSubscription.orgId, orgId),
        eq(schema.complianceRuleSubscription.ruleId, ruleId),
        isNull(schema.complianceRuleSubscription.unsubscribedAt),
      ))
      .returning());

    if (!updated) throw new SubscriptionNotFoundError();
    await invalidateRulesFor(orgId);
    return updated;
  }

  /** Get enforced (active) subscription rule IDs for an org. */
  async getSubscribedRuleIds(orgId: string, inTx?: SubscriptionTx): Promise<string[]> {
    const subs = await onTx(inTx, async (tx) => tx
      .select({ ruleId: schema.complianceRuleSubscription.ruleId })
      .from(schema.complianceRuleSubscription)
      .innerJoin(schema.complianceRule, eq(schema.complianceRuleSubscription.ruleId, schema.complianceRule.id))
      .where(and(
        eq(schema.complianceRuleSubscription.orgId, orgId),
        eq(schema.complianceRuleSubscription.isActive, true),
        isNull(schema.complianceRuleSubscription.unsubscribedAt),
        isNull(schema.complianceRule.deletedAt),
      )));
    return subs.map(s => s.ruleId);
  }

  /**
   * The distinct content-set NAMES (`standard`/`advanced`) the org is currently
   * ENFORCING — i.e. the `set:<x>` tags on the published rules the org has an
   * ACTIVE, non-unsubscribed subscription to. This is the drift-read counterpart
   * of the `PUT` entitlement sync: billing GETs it and diffs against the sets it
   * expects the org to hold, re-driving the push on mismatch.
   *
   * Runs under sysadmin scope (published rules don't share the caller's orgId),
   * same pattern as `findPublishedById` / `findPublishedRuleIdsBySetTag`.
   */
  async getActiveEntitledSets(orgId: string): Promise<string[]> {
    if (isSystemOrgId(orgId)) return [];
    const rows = await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx(async (tx) => tx
        .select({ tags: schema.complianceRule.tags })
        .from(schema.complianceRuleSubscription)
        .innerJoin(schema.complianceRule, eq(schema.complianceRuleSubscription.ruleId, schema.complianceRule.id))
        .where(and(
          eq(schema.complianceRuleSubscription.orgId, orgId),
          eq(schema.complianceRuleSubscription.isActive, true),
          isNull(schema.complianceRuleSubscription.unsubscribedAt),
          eq(schema.complianceRule.scope, 'published' as RuleScope),
          eq(schema.complianceRule.isActive, true),
          isNull(schema.complianceRule.deletedAt),
        ))));
    const sets = new Set<string>();
    for (const row of rows as Array<{ tags: unknown }>) {
      for (const name of setNamesFromTags(row.tags)) sets.add(name);
    }
    return [...sets].sort();
  }

  /**
   * Batch subscribe + activate every rule in `ruleIds` for an org in ONE upsert
   * (instead of a subscribe + setActive round-trip per rule). Used by the
   * entitlement reconcile, where the whole set is granted at once. A member's
   * prior manual unsubscribe is resurrected (unsubscribedAt cleared) exactly as
   * `subscribe` would, and the rules cache is invalidated once for the batch.
   */
  async bulkSubscribeActive(orgId: string, ruleIds: string[], userId: string, inTx?: SubscriptionTx): Promise<void> {
    if (isSystemOrgId(orgId)) throw new SystemOrgSubscriptionError();
    if (ruleIds.length === 0) return;

    const now = new Date();
    await onTx(inTx, async (tx) => tx
      .insert(schema.complianceRuleSubscription)
      .values(ruleIds.map((ruleId) => ({ orgId, ruleId, subscribedBy: userId, isActive: true })))
      .onConflictDoUpdate({
        target: [schema.complianceRuleSubscription.orgId, schema.complianceRuleSubscription.ruleId],
        set: {
          isActive: true,
          subscribedBy: userId,
          subscribedAt: now,
          unsubscribedAt: null,
          unsubscribedBy: null,
        },
      }));
    logger.info('Bulk subscribed + activated entitled rules', { orgId, count: ruleIds.length });
    if (!inTx) await invalidateRulesFor(orgId);
  }

  /**
   * IDs of the published (system-org) rules carrying a given `set:<x>` tag.
   *
   * The catalog libraries are curated system-org rows tagged `set:standard` /
   * `set:advanced`; billing entitlement drives which of those an org enforces.
   * `tags` is a jsonb string[] — the `@>` containment operator matches rows
   * whose array CONTAINS the tag (index-friendly, exact-token, not substring).
   * Runs under sysadmin scope because published rules do not share the caller's
   * orgId (same pattern as `findPublishedById` / `listPublishedCatalog`).
   */
  async findPublishedRuleIdsBySetTag(setTag: string, inTx?: SubscriptionTx): Promise<string[]> {
    const query = (tx: SubscriptionTx) => tx
      .select({ id: schema.complianceRule.id })
      .from(schema.complianceRule)
      .where(and(
        eq(schema.complianceRule.scope, 'published' as RuleScope),
        eq(schema.complianceRule.isActive, true),
        isNull(schema.complianceRule.deletedAt),
        sql`${schema.complianceRule.tags} @> ${JSON.stringify([setTag])}::jsonb`,
      ));
    // A caller-supplied tx is already sysadmin-scoped (the entitlement reconcile).
    const rows = inTx
      ? await query(inTx)
      : await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(query));
    return rows.map((r: { id: string }) => r.id);
  }

  /**
   * Idempotent bulk reconcile of an org's curated-set subscriptions against the
   * sets it is currently ENTITLED to (the machine `PUT /entitlements/:orgId`
   * handshake from billing).
   *
   * For every KNOWN content set:
   *  - ENTITLED (`x ∈ sets`): subscribe + activate every `set:<x>`-tagged
   *    published rule the org isn't already enforcing. Reuses `subscribe` +
   *    `setActive` (rather than a raw upsert) so a member's manual unsubscribe
   *    is resurrected and the rules cache is invalidated exactly as a normal
   *    subscribe would. Already-active rules are skipped — no flicker, no audit
   *    noise on a repeat sync.
   *  - NOT entitled (`x ∉ sets`): deactivate the org's existing subscriptions to
   *    those rules via `bulkSetActive(false)`. Rows are RETAINED (not deleted),
   *    so re-granting the set simply reactivates them.
   *
   * Enforcement (`/compliance/validate`) is entitlement-unaware and reads only
   * ACTIVE subscriptions, so keeping this reconcile correct is what makes a
   * lapsed add-on stop enforcing at period-end.
   *
   * Returns the rule ids whose ACTIVE state actually CHANGED (so the caller can
   * audit real posture changes only). A no-op re-sync returns empty arrays.
   */
  async syncEntitledSets(
    orgId: string,
    sets: string[],
    userId: string = 'system',
    opts: { occurredAt?: Date } = {},
  ): Promise<{ skipped: boolean; activated: string[]; deactivated: string[] }> {
    // System org is not a tenant — it OWNS the library, never subscribes to it.
    if (isSystemOrgId(orgId)) return { skipped: false, activated: [], deactivated: [] };

    const entitled = new Set(sets);
    // ONE sysadmin-scoped transaction (the `:orgId` is the target root org, not
    // the caller's) under a per-org advisory lock: the watermark CHECK, the
    // reconcile, and the watermark RECORD commit together, so two pushes racing
    // for the same org serialize — the later one reads the earlier one's
    // committed watermark instead of both passing the check and applying in
    // arbitrary order (a stale push could otherwise revert a newer state).
    const result = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`compliance-entitlement:${orgId}`}))`);

      if (opts.occurredAt) {
        const last = await entitlementWatermarkStore.getLastOccurredAt(tx, orgId);
        if (last && opts.occurredAt.getTime() <= last.getTime()) {
          return { skipped: true, activated: [] as string[], deactivated: [] as string[] };
        }
      }

      // Snapshot the org's currently-enforced rules ONCE so we can report only the
      // genuine transitions (and skip re-activating already-active rules).
      const currentlyActive = new Set(await this.getSubscribedRuleIds(orgId, tx));
      const activated: string[] = [];
      const deactivated: string[] = [];

      for (const set of COMPLIANCE_CONTENT_SETS) {
        const ruleIds = await this.findPublishedRuleIdsBySetTag(`set:${set}`, tx);
        if (ruleIds.length === 0) continue;

        if (entitled.has(set)) {
          // Only the rules not already enforced need touching (idempotent no-op on
          // a repeat sync). Subscribe + activate them in a SINGLE batched upsert.
          const toActivate = ruleIds.filter((id) => !currentlyActive.has(id));
          if (toActivate.length > 0) {
            await this.bulkSubscribeActive(orgId, toActivate, userId, tx);
            activated.push(...toActivate);
          }
        } else {
          // Only existing (non-unsubscribed) rows are matched/returned; filter to
          // the ones that were actually active so we report true deactivations.
          const affected = await this.bulkSetActive(orgId, ruleIds, false, userId, tx);
          for (const ruleId of affected) {
            if (currentlyActive.has(ruleId)) deactivated.push(ruleId);
          }
        }
      }

      if (opts.occurredAt) await entitlementWatermarkStore.record(tx, orgId, opts.occurredAt);
      return { skipped: false, activated, deactivated };
    }));

    // Invalidate AFTER commit so no reader re-caches the pre-commit rule set.
    if (result.activated.length > 0 || result.deactivated.length > 0) await invalidateRulesFor(orgId);

    logger.info('Reconciled entitled compliance sets', {
      orgId, sets, skipped: result.skipped, activated: result.activated.length, deactivated: result.deactivated.length,
    });
    return result;
  }
}

export const subscriptionService = new ComplianceRuleSubscriptionService();
