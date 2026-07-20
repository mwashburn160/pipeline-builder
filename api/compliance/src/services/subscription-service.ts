// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, isSystemOrgId } from '@pipeline-builder/api-core';
import { schema, withTenantTx, drizzleCount } from '@pipeline-builder/pipeline-data';
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
    const publishedRules = await withTenantTx(async (tx) => tx
      .select({ id: schema.complianceRule.id })
      .from(schema.complianceRule)
      .where(and(
        eq(schema.complianceRule.scope, 'published' as RuleScope),
        eq(schema.complianceRule.isActive, true),
        isNull(schema.complianceRule.deletedAt),
      )));

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
}

export const subscriptionService = new ComplianceRuleSubscriptionService();
