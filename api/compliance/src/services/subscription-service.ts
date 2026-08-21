// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, isSystemOrgId } from '@pipeline-builder/api-core';
import { schema, withTenantTx, drizzleCount, runWithTenantContext } from '@pipeline-builder/pipeline-data';
import type { RuleScope } from '@pipeline-builder/pipeline-data';
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import { complianceRuleService } from './compliance-rule-service.js';

const logger = createLogger('subscription-service');

/**
 * Typed error codes thrown by this service. Routes map these to HTTP responses
 * via a code-keyed table (see routes/subscriptions.ts), so rewording a
 * user-facing message never silently turns a 4xx into a 500. Mirrors the
 * `RL_*` (roles-service) / `PR_*` (pipeline-registry) convention.
 */
export const CS_RULE_NOT_FOUND = 'CS_RULE_NOT_FOUND';
export const CS_SUBSCRIPTION_NOT_FOUND = 'CS_SUBSCRIPTION_NOT_FOUND';
export const CS_NOT_PUBLISHED = 'CS_NOT_PUBLISHED';
export const CS_SYSTEM_ORG = 'CS_SYSTEM_ORG';

/**
 * Curated compliance content sets whose published rules are entitlement-gated.
 * Each set `x` corresponds to published rules tagged `set:<x>` and to the
 * `compliance_<x>` billing feature flag. Kept here (not the route) so the
 * bulk-reconcile method and the subscribe-gate agree on the exact set names.
 */
export const KNOWN_CONTENT_SETS = ['standard', 'advanced'] as const;
export type ContentSet = typeof KNOWN_CONTENT_SETS[number];

const KNOWN_CONTENT_SET_NAMES: ReadonlySet<string> = new Set(KNOWN_CONTENT_SETS);

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
      throw new Error(CS_SYSTEM_ORG);
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

      if (!rule) throw new Error(CS_RULE_NOT_FOUND);
      if (rule.scope !== 'published') throw new Error(CS_NOT_PUBLISHED);

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
      throw new Error(CS_SYSTEM_ORG);
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

      if (!existing) throw new Error(CS_SUBSCRIPTION_NOT_FOUND);

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
      throw new Error(CS_SYSTEM_ORG);
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

      if (!existing) throw new Error(CS_SUBSCRIPTION_NOT_FOUND);

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
  async bulkSetActive(orgId: string, ruleIds: string[], isActive: boolean, _userId: string): Promise<string[]> {
    if (isSystemOrgId(orgId)) {
      throw new Error(CS_SYSTEM_ORG);
    }

    // Single batch update instead of N individual queries
    const result = await withTenantTx(async (tx) => tx
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
    if (affectedIds.length > 0) await invalidateRulesFor(orgId);
    return affectedIds;
  }

  /** Pin a subscription to a specific rule version snapshot. */
  async pinVersion(orgId: string, ruleId: string, userId: string): Promise<ComplianceRuleSubscription> {
    if (isSystemOrgId(orgId)) {
      throw new Error(CS_SYSTEM_ORG);
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
      if (!sub) throw new Error(CS_SUBSCRIPTION_NOT_FOUND);

      // Fetch current rule state as snapshot
      const [rule] = await tx
        .select()
        .from(schema.complianceRule)
        .where(eq(schema.complianceRule.id, ruleId));
      if (!rule) throw new Error(CS_RULE_NOT_FOUND);

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

    if (!updated) throw new Error(CS_SUBSCRIPTION_NOT_FOUND);
    await invalidateRulesFor(orgId);
    return updated;
  }

  /** Get enforced (active) subscription rule IDs for an org. */
  async getSubscribedRuleIds(orgId: string): Promise<string[]> {
    const subs = await withTenantTx(async (tx) => tx
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
  async bulkSubscribeActive(orgId: string, ruleIds: string[], userId: string): Promise<void> {
    if (isSystemOrgId(orgId)) throw new Error(CS_SYSTEM_ORG);
    if (ruleIds.length === 0) return;

    const now = new Date();
    await withTenantTx(async (tx) => tx
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
    await invalidateRulesFor(orgId);
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
  async findPublishedRuleIdsBySetTag(setTag: string): Promise<string[]> {
    const rows = await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx(async (tx) => tx
        .select({ id: schema.complianceRule.id })
        .from(schema.complianceRule)
        .where(and(
          eq(schema.complianceRule.scope, 'published' as RuleScope),
          eq(schema.complianceRule.isActive, true),
          isNull(schema.complianceRule.deletedAt),
          sql`${schema.complianceRule.tags} @> ${JSON.stringify([setTag])}::jsonb`,
        ))));
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
  ): Promise<{ activated: string[]; deactivated: string[] }> {
    // System org is not a tenant — it OWNS the library, never subscribes to it.
    if (isSystemOrgId(orgId)) return { activated: [], deactivated: [] };

    const entitled = new Set(sets);
    // Snapshot the org's currently-enforced rules ONCE so we can report only the
    // genuine transitions (and skip re-activating already-active rules).
    const currentlyActive = new Set(await this.getSubscribedRuleIds(orgId));

    const activated: string[] = [];
    const deactivated: string[] = [];

    for (const set of KNOWN_CONTENT_SETS) {
      const ruleIds = await this.findPublishedRuleIdsBySetTag(`set:${set}`);
      if (ruleIds.length === 0) continue;

      if (entitled.has(set)) {
        // Only the rules not already enforced need touching (idempotent no-op on
        // a repeat sync). Subscribe + activate them in a SINGLE batched upsert
        // rather than a subscribe + setActive round-trip per rule.
        const toActivate = ruleIds.filter((id) => !currentlyActive.has(id));
        if (toActivate.length > 0) {
          await this.bulkSubscribeActive(orgId, toActivate, userId);
          activated.push(...toActivate);
        }
      } else {
        // Only existing (non-unsubscribed) rows are matched/returned; filter to
        // the ones that were actually active so we report true deactivations.
        const affected = await this.bulkSetActive(orgId, ruleIds, false, userId);
        for (const ruleId of affected) {
          if (currentlyActive.has(ruleId)) deactivated.push(ruleId);
        }
      }
    }

    logger.info('Reconciled entitled compliance sets', {
      orgId, sets, activated: activated.length, deactivated: deactivated.length,
    });
    return { activated, deactivated };
  }
}

export const subscriptionService = new ComplianceRuleSubscriptionService();
