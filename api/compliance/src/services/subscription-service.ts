import { SYSTEM_ORG_ID, createLogger } from '@mwashburn160/api-core';
import { schema, db } from '@mwashburn160/pipeline-core';
import type { RuleScope } from '@mwashburn160/pipeline-core';
import { eq, and, isNull } from 'drizzle-orm';

const logger = createLogger('subscription-service');

export type ComplianceRuleSubscription = typeof schema.complianceRuleSubscription.$inferSelect;

export class ComplianceRuleSubscriptionService {
  /**
   * Subscribe an org to a published rule.
   * Subscriptions start as inactive — the org must explicitly activate to enforce.
   * Uses upsert (onConflictDoUpdate) to handle race conditions atomically.
   */
  async subscribe(orgId: string, ruleId: string, userId: string): Promise<ComplianceRuleSubscription> {
    if (orgId === SYSTEM_ORG_ID) {
      throw new Error('System org cannot subscribe to published rules');
    }

    return db.transaction(async (tx) => {
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

      if (!rule) throw new Error('Rule not found');
      if (rule.scope !== 'published') throw new Error('Only published rules can be subscribed to');

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
  }

  /**
   * Activate or deactivate a subscribed rule for an org.
   * Only active subscriptions are enforced during validation.
   */
  async setActive(orgId: string, ruleId: string, isActive: boolean, userId: string): Promise<ComplianceRuleSubscription> {
    if (orgId === SYSTEM_ORG_ID) {
      throw new Error('System org cannot manage subscriptions');
    }

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.complianceRuleSubscription)
        .where(and(
          eq(schema.complianceRuleSubscription.orgId, orgId),
          eq(schema.complianceRuleSubscription.ruleId, ruleId),
          isNull(schema.complianceRuleSubscription.unsubscribedAt),
        ));

      if (!existing) throw new Error('Subscription not found');

      const [updated] = await tx
        .update(schema.complianceRuleSubscription)
        .set({ isActive })
        .where(eq(schema.complianceRuleSubscription.id, existing.id))
        .returning();

      logger.info(`Subscription ${isActive ? 'activated' : 'deactivated'}`, { orgId, ruleId, userId });
      return updated;
    });
  }

  /**
   * Unsubscribe an org from a published rule (soft delete).
   */
  async unsubscribe(orgId: string, ruleId: string, userId: string): Promise<void> {
    if (orgId === SYSTEM_ORG_ID) {
      throw new Error('System org cannot manage subscriptions');
    }

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: schema.complianceRuleSubscription.id })
        .from(schema.complianceRuleSubscription)
        .where(and(
          eq(schema.complianceRuleSubscription.orgId, orgId),
          eq(schema.complianceRuleSubscription.ruleId, ruleId),
          isNull(schema.complianceRuleSubscription.unsubscribedAt),
        ));

      if (!existing) throw new Error('Subscription not found');

      await tx
        .update(schema.complianceRuleSubscription)
        .set({ isActive: false, unsubscribedAt: new Date(), unsubscribedBy: userId })
        .where(eq(schema.complianceRuleSubscription.id, existing.id));

      logger.info('Org unsubscribed from published rule', { orgId, ruleId, userId });
    });
  }

  /** List all subscriptions for an org (active + inactive, excludes unsubscribed and soft-deleted rules). */
  async findByOrg(orgId: string): Promise<ComplianceRuleSubscription[]> {
    return db
      .select({
        id: schema.complianceRuleSubscription.id,
        orgId: schema.complianceRuleSubscription.orgId,
        ruleId: schema.complianceRuleSubscription.ruleId,
        subscribedBy: schema.complianceRuleSubscription.subscribedBy,
        subscribedAt: schema.complianceRuleSubscription.subscribedAt,
        isActive: schema.complianceRuleSubscription.isActive,
        unsubscribedAt: schema.complianceRuleSubscription.unsubscribedAt,
        unsubscribedBy: schema.complianceRuleSubscription.unsubscribedBy,
      })
      .from(schema.complianceRuleSubscription)
      .innerJoin(schema.complianceRule, eq(schema.complianceRuleSubscription.ruleId, schema.complianceRule.id))
      .where(and(
        eq(schema.complianceRuleSubscription.orgId, orgId),
        isNull(schema.complianceRuleSubscription.unsubscribedAt),
        isNull(schema.complianceRule.deletedAt),
      )) as unknown as Promise<ComplianceRuleSubscription[]>;
  }

  /** List all orgs subscribed to a specific rule (system org admin view). */
  async findSubscribers(ruleId: string): Promise<ComplianceRuleSubscription[]> {
    return db
      .select({
        id: schema.complianceRuleSubscription.id,
        orgId: schema.complianceRuleSubscription.orgId,
        ruleId: schema.complianceRuleSubscription.ruleId,
        subscribedBy: schema.complianceRuleSubscription.subscribedBy,
        subscribedAt: schema.complianceRuleSubscription.subscribedAt,
        isActive: schema.complianceRuleSubscription.isActive,
        unsubscribedAt: schema.complianceRuleSubscription.unsubscribedAt,
        unsubscribedBy: schema.complianceRuleSubscription.unsubscribedBy,
      })
      .from(schema.complianceRuleSubscription)
      .innerJoin(schema.complianceRule, eq(schema.complianceRuleSubscription.ruleId, schema.complianceRule.id))
      .where(and(
        eq(schema.complianceRuleSubscription.ruleId, ruleId),
        isNull(schema.complianceRuleSubscription.unsubscribedAt),
        isNull(schema.complianceRule.deletedAt),
      )) as unknown as Promise<ComplianceRuleSubscription[]>;
  }

  /**
   * Auto-subscribe an org to all published rules (inactive by default).
   * Called during org onboarding so new orgs see the full catalog in their subscriptions.
   * Skips rules the org is already subscribed to.
   */
  async autoSubscribeToPublished(orgId: string, userId: string = 'system'): Promise<number> {
    if (orgId === SYSTEM_ORG_ID) return 0;

    // Fetch all active published rules
    const publishedRules = await db
      .select({ id: schema.complianceRule.id })
      .from(schema.complianceRule)
      .where(and(
        eq(schema.complianceRule.orgId, SYSTEM_ORG_ID),
        eq(schema.complianceRule.scope, 'published' as RuleScope),
        eq(schema.complianceRule.isActive, true),
        isNull(schema.complianceRule.deletedAt),
      ));

    if (publishedRules.length === 0) return 0;

    let subscribed = 0;
    for (const rule of publishedRules) {
      try {
        await db
          .insert(schema.complianceRuleSubscription)
          .values({ orgId, ruleId: rule.id, subscribedBy: userId, isActive: false })
          .onConflictDoNothing({ target: [schema.complianceRuleSubscription.orgId, schema.complianceRuleSubscription.ruleId] });
        subscribed++;
      } catch {
        // Skip individual failures (e.g. race condition)
      }
    }

    logger.info('Auto-subscribed org to published rules', { orgId, total: publishedRules.length, subscribed });
    return subscribed;
  }

  /** Get enforced (active) subscription rule IDs for an org. */
  async getSubscribedRuleIds(orgId: string): Promise<string[]> {
    const subs = await db
      .select({ ruleId: schema.complianceRuleSubscription.ruleId })
      .from(schema.complianceRuleSubscription)
      .innerJoin(schema.complianceRule, eq(schema.complianceRuleSubscription.ruleId, schema.complianceRule.id))
      .where(and(
        eq(schema.complianceRuleSubscription.orgId, orgId),
        eq(schema.complianceRuleSubscription.isActive, true),
        isNull(schema.complianceRuleSubscription.unsubscribedAt),
        isNull(schema.complianceRule.deletedAt),
      ));
    return subs.map(s => s.ruleId);
  }
}

export const subscriptionService = new ComplianceRuleSubscriptionService();
