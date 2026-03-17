import {
  CrudService,
  buildComplianceRuleConditions,
  schema,
  db,
  type ComplianceRuleFilter,
  type RuleTarget,
} from '@mwashburn160/pipeline-core';
import { SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

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
   * Includes system-org global rules.
   */
  async findActiveByOrgAndTarget(orgId: string, target: RuleTarget): Promise<ComplianceRule[]> {
    return this.find({ target, isActive: true } as Partial<ComplianceRuleFilter>, orgId);
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
    await this.recordHistory(created.id, created.orgId, 'created', null, userId);
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
      await this.recordHistory(id, orgId, 'updated', existing, userId);
    }
    return updated;
  }

  async delete(id: string, orgId: string, userId: string): Promise<ComplianceRule | null> {
    const existing = await this.findById(id, orgId);
    const deleted = await super.delete(id, orgId, userId);
    if (deleted && existing) {
      await this.recordHistory(id, orgId, 'deleted', existing, userId);
    }
    return deleted;
  }
}

export const complianceRuleService = new ComplianceRuleService();
