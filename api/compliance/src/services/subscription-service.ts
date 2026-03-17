import { SYSTEM_ORG_ID, createLogger } from '@mwashburn160/api-core';
import { schema, db } from '@mwashburn160/pipeline-core';
import { eq, and, isNull } from 'drizzle-orm';

const logger = createLogger('subscription-service');

export type ComplianceRuleSubscription = typeof schema.complianceRuleSubscription.$inferSelect;

export class ComplianceRuleSubscriptionService {
  /**
   * Subscribe an org to a published rule.
   * Uses upsert (onConflictDoUpdate) to handle race conditions atomically.
   */
  async subscribe(orgId: string, ruleId: string, userId: string): Promise<ComplianceRuleSubscription> {
    if (orgId === SYSTEM_ORG_ID) {
      throw new Error('System org cannot subscribe to published rules');
    }

    return db.transaction(async (tx) => {
      // Verify rule exists, is published, active, and not soft-deleted
      const [rule] = await tx
        .select({
          id: schema.complianceRule.id,
          scope: schema.complianceRule.scope,
          isActive: schema.complianceRule.isActive,
        })
        .from(schema.complianceRule)
        .where(and(
          eq(schema.complianceRule.id, ruleId),
          isNull(schema.complianceRule.deletedAt),
        ));

      if (!rule) throw new Error('Rule not found');
      if (rule.scope !== 'published') throw new Error('Only published rules can be subscribed to');
      if (!rule.isActive) throw new Error('Cannot subscribe to an inactive rule');

      // Atomic upsert: insert or reactivate on conflict
      const [result] = await tx
        .insert(schema.complianceRuleSubscription)
        .values({ orgId, ruleId, subscribedBy: userId })
        .onConflictDoUpdate({
          target: [schema.complianceRuleSubscription.orgId, schema.complianceRuleSubscription.ruleId],
          set: {
            isActive: true,
            subscribedBy: userId,
            subscribedAt: new Date(),
            unsubscribedAt: null,
            unsubscribedBy: null,
          },
        })
        .returning();

      logger.info('Org subscribed to published rule', { orgId, ruleId, userId });
      return result;
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
          eq(schema.complianceRuleSubscription.isActive, true),
        ));

      if (!existing) throw new Error('Active subscription not found');

      await tx
        .update(schema.complianceRuleSubscription)
        .set({ isActive: false, unsubscribedAt: new Date(), unsubscribedBy: userId })
        .where(eq(schema.complianceRuleSubscription.id, existing.id));

      logger.info('Org unsubscribed from published rule', { orgId, ruleId, userId });
    });
  }

  /** List active subscriptions for an org (excludes soft-deleted rules). */
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
        eq(schema.complianceRuleSubscription.isActive, true),
        isNull(schema.complianceRule.deletedAt),
      )) as unknown as Promise<ComplianceRuleSubscription[]>;
  }

  /** List all orgs subscribed to a specific rule (system org admin view, excludes soft-deleted rules). */
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
        eq(schema.complianceRuleSubscription.isActive, true),
        isNull(schema.complianceRule.deletedAt),
      )) as unknown as Promise<ComplianceRuleSubscription[]>;
  }

  /** Get active subscription rule IDs for an org (excludes soft-deleted rules). */
  async getSubscribedRuleIds(orgId: string): Promise<string[]> {
    const subs = await db
      .select({ ruleId: schema.complianceRuleSubscription.ruleId })
      .from(schema.complianceRuleSubscription)
      .innerJoin(schema.complianceRule, eq(schema.complianceRuleSubscription.ruleId, schema.complianceRule.id))
      .where(and(
        eq(schema.complianceRuleSubscription.orgId, orgId),
        eq(schema.complianceRuleSubscription.isActive, true),
        isNull(schema.complianceRule.deletedAt),
      ));
    return subs.map(s => s.ruleId);
  }
}

export const subscriptionService = new ComplianceRuleSubscriptionService();
