import { createCacheService } from '@mwashburn160/api-core';
import {
  CrudService,
  buildComplianceRuleConditions,
  schema,
  db,
  type ComplianceRuleFilter,
  type RuleTarget,
  type RuleScope,
} from '@mwashburn160/pipeline-core';
import { SQL, eq, and, inArray, desc, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

/** Cache for active rules per org+target. Rules change infrequently. */
const RULES_CACHE_TTL = parseInt(process.env.COMPLIANCE_RULES_CACHE_TTL_SECONDS || '60', 10);
const rulesCache = createCacheService('compliance:rules:', RULES_CACHE_TTL);

export type ComplianceRule = typeof schema.complianceRule.$inferSelect;
export type ComplianceRuleInsert = typeof schema.complianceRule.$inferInsert;
export type ComplianceRuleUpdate = Partial<Omit<ComplianceRule, 'id' | 'createdAt' | 'createdBy'>>;

export class ComplianceRuleService extends CrudService<
  ComplianceRule,
  ComplianceRuleFilter,
  ComplianceRuleInsert,
  ComplianceRuleUpdate
> {
  protected get schema(): PgTable {
    return schema.complianceRule as PgTable;
  }

  protected buildConditions(filter: Partial<ComplianceRuleFilter>, orgId?: string): SQL[] {
    return buildComplianceRuleConditions(filter, orgId);
  }

  protected getSortColumn(sortBy: string): AnyColumn | null {
    const cols: Record<string, AnyColumn> = {
      name: schema.complianceRule.name,
      priority: schema.complianceRule.priority,
      severity: schema.complianceRule.severity,
      createdAt: schema.complianceRule.createdAt,
      updatedAt: schema.complianceRule.updatedAt,
    };
    return cols[sortBy] || null;
  }

  protected getProjectColumn(): AnyColumn | null {
    return null; // Org-scoped
  }

  protected getOrgColumn(): AnyColumn {
    return schema.complianceRule.orgId;
  }

  protected get conflictTarget(): AnyColumn[] {
    return [schema.complianceRule.orgId, schema.complianceRule.name];
  }

  /**
   * Fetch active rules for an org+target, ordered by priority DESC.
   * Includes the org's own rules and any subscribed published rules.
   * Results are cached per org+target (configurable TTL).
   */
  async findActiveByOrgAndTarget(orgId: string, target: RuleTarget): Promise<ComplianceRule[]> {
    const cacheKey = `${orgId}:${target}`;
    return rulesCache.getOrSet(cacheKey, async () => {
      // 1. Org's own rules
      const orgRules = await this.find({ target, isActive: true } as Partial<ComplianceRuleFilter>, orgId);

      // 2. Get subscribed published rule IDs
      const subscriptions = await db
        .select({ ruleId: schema.complianceRuleSubscription.ruleId })
        .from(schema.complianceRuleSubscription)
        .where(and(
          eq(schema.complianceRuleSubscription.orgId, orgId),
          eq(schema.complianceRuleSubscription.isActive, true),
        ));

      if (subscriptions.length === 0) return orgRules;

      // 3. Fetch the actual published rules
      const subscribedRuleIds = subscriptions.map(s => s.ruleId);
      const publishedRules = await db
        .select()
        .from(schema.complianceRule)
        .where(and(
          inArray(schema.complianceRule.id, subscribedRuleIds),
          eq(schema.complianceRule.target, target),
          eq(schema.complianceRule.isActive, true),
          eq(schema.complianceRule.scope, 'published' as RuleScope),
        ));

      // 4. Merge, deduplicate by ID
      const seenIds = new Set(orgRules.map(r => r.id));
      const merged = [...orgRules];
      for (const rule of publishedRules) {
        if (!seenIds.has(rule.id)) {
          merged.push(rule as ComplianceRule);
          seenIds.add(rule.id);
        }
      }
      return merged;
    });
  }

  /** Invalidate cached rules for an org (called after rule mutations or subscription changes). */
  async invalidateRulesCache(orgId: string): Promise<void> {
    await rulesCache.invalidatePattern(`${orgId}:*`);
  }

  /**
   * Invalidate cached rules for all orgs subscribed to a published rule.
   * Called after a published rule is mutated so subscribers pick up the change.
   */
  private async invalidateSubscriberCaches(ruleId: string): Promise<void> {
    const subscribers = await db
      .select({ orgId: schema.complianceRuleSubscription.orgId })
      .from(schema.complianceRuleSubscription)
      .where(and(
        eq(schema.complianceRuleSubscription.ruleId, ruleId),
        eq(schema.complianceRuleSubscription.isActive, true),
      ));

    await Promise.all(subscribers.map(s => this.invalidateRulesCache(s.orgId)));
  }

  /** Fetch paginated rule change history for a specific rule. */
  async findRuleHistory(
    ruleId: string,
    orgId: string,
    options: { limit: number; offset: number },
  ): Promise<{ history: unknown[]; total: number }> {
    const conditions = and(
      eq(schema.complianceRuleHistory.ruleId, ruleId),
      eq(schema.complianceRuleHistory.orgId, orgId),
    );

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceRuleHistory)
      .where(conditions) as unknown as [{ count: number }];

    const history = await db
      .select()
      .from(schema.complianceRuleHistory)
      .where(conditions)
      .orderBy(desc(schema.complianceRuleHistory.changedAt))
      .limit(options.limit)
      .offset(options.offset);

    return { history, total: countResult?.count ?? 0 };
  }

  /** Fetch all rules belonging to a policy. */
  async findByPolicy(policyId: string, orgId: string): Promise<ComplianceRule[]> {
    return this.find({ policyId, isActive: true } as Partial<ComplianceRuleFilter>, orgId);
  }

  /**
   * Record a rule change in the history table.
   * Called automatically by overridden create/update/delete.
   */
  async recordHistory(
    ruleId: string,
    orgId: string,
    changeType: string,
    previousState: unknown,
    userId: string,
  ): Promise<void> {
    await db.insert(schema.complianceRuleHistory).values({
      ruleId,
      orgId,
      changeType,
      previousState: previousState as Record<string, unknown>,
      changedBy: userId,
    });
  }

  // Override mutations to record history

  async create(data: ComplianceRuleInsert, userId: string): Promise<ComplianceRule> {
    const created = await super.create(data, userId);
    this.recordHistory(created.id, created.orgId, 'created', null, userId).catch(() => { /* non-fatal */ });
    this.invalidateRulesCache(created.orgId).catch(() => { /* non-fatal */ });
    if (created.scope === 'published') {
      this.invalidateSubscriberCaches(created.id).catch(() => { /* non-fatal */ });
    }
    return created;
  }

  async update(
    id: string,
    data: Partial<ComplianceRuleUpdate>,
    orgId: string,
    userId: string,
  ): Promise<ComplianceRule | null> {
    const existing = await this.findById(id, orgId);
    const updated = await super.update(id, data, orgId, userId);
    if (updated && existing) {
      this.recordHistory(id, orgId, 'updated', existing, userId).catch(() => { /* non-fatal */ });
      this.invalidateRulesCache(orgId).catch(() => { /* non-fatal */ });
      if (existing.scope === 'published') {
        this.invalidateSubscriberCaches(id).catch(() => { /* non-fatal */ });
      }
    }
    return updated;
  }

  async delete(id: string, orgId: string, userId: string): Promise<ComplianceRule | null> {
    const existing = await this.findById(id, orgId);
    const deleted = await super.delete(id, orgId, userId);
    if (deleted && existing) {
      this.recordHistory(id, orgId, 'deleted', existing, userId).catch(() => { /* non-fatal */ });
      this.invalidateRulesCache(orgId).catch(() => { /* non-fatal */ });
      if (existing.scope === 'published') {
        this.invalidateSubscriberCaches(id).catch(() => { /* non-fatal */ });
      }
    }
    return deleted;
  }
}

export const complianceRuleService = new ComplianceRuleService();
