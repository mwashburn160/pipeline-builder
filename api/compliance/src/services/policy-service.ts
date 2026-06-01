// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  CrudService,
  buildCompliancePolicyConditions,
  runWithTenantContext,
  schema,
  withTenantTx,
  type CompliancePolicyFilter,
} from '@pipeline-builder/pipeline-core';
import { SQL, and, eq, isNull } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { complianceRuleService } from './compliance-rule-service';

export type CompliancePolicy = typeof schema.compliancePolicy.$inferSelect;
export type CompliancePolicyInsert = typeof schema.compliancePolicy.$inferInsert;
export type CompliancePolicyUpdate = Partial<Omit<CompliancePolicy, 'id' | 'createdAt' | 'createdBy'>>;

export class CompliancePolicyService extends CrudService<
  CompliancePolicy,
  CompliancePolicyFilter,
  CompliancePolicyInsert,
  CompliancePolicyUpdate
> {
  protected get schema(): PgTable {
    return schema.compliancePolicy as PgTable;
  }

  protected buildConditions(filter: Partial<CompliancePolicyFilter>, orgId?: string): SQL[] {
    return buildCompliancePolicyConditions(filter, orgId);
  }

  protected getSortColumn(sortBy: string): AnyColumn | null {
    const cols: Record<string, AnyColumn> = {
      name: schema.compliancePolicy.name,
      createdAt: schema.compliancePolicy.createdAt,
      updatedAt: schema.compliancePolicy.updatedAt,
    };
    return cols[sortBy] || null;
  }

  protected getProjectColumn(): AnyColumn | null {
    return null; // Org-scoped
  }

  protected getOrgColumn(): AnyColumn {
    return schema.compliancePolicy.orgId;
  }

  protected get conflictTarget(): AnyColumn[] {
    return [schema.compliancePolicy.orgId, schema.compliancePolicy.name, schema.compliancePolicy.version];
  }

  /** Find system-org template policies available for cloning. */
  async findTemplates(): Promise<CompliancePolicy[]> {
    return this.find({ isTemplate: true }, 'system');
  }

  /**
   * Clone a template policy and its rules into a target org.
   *
   * Reads the template's rules under sysadmin scope (templates live with
   * `orgId='system'`, which the caller's RLS would otherwise hide), then
   * re-inserts each as an org-scoped rule pointing at the new policy id.
   * The new rules carry `createdBy/updatedBy = userId` and intentionally do
   * NOT preserve the template's `id` / `forkedFromRuleId` lineage — a cloned
   * template is a fresh starting point, not a tracked fork.
   */
  async cloneTemplate(
    templateId: string,
    targetOrgId: string,
    userId: string,
  ): Promise<CompliancePolicy> {
    const template = await this.findById(templateId, 'system');
    if (!template) throw new Error('Template not found');

    const cloned = await this.create({
      orgId: targetOrgId,
      name: template.name,
      description: template.description,
      version: template.version,
      isTemplate: false,
      createdBy: userId,
      updatedBy: userId,
    } as CompliancePolicyInsert, userId);

    // Look up the template's rules under sysadmin scope (template rows live
    // outside the caller's org) and copy each into the target org.
    const templateRules = await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx(async (tx) => tx
        .select()
        .from(schema.complianceRule)
        .where(and(
          eq(schema.complianceRule.policyId, template.id),
          eq(schema.complianceRule.isActive, true),
          isNull(schema.complianceRule.deletedAt),
        ))),
    );

    for (const rule of templateRules) {
      await complianceRuleService.create({
        orgId: targetOrgId,
        policyId: cloned.id,
        name: rule.name,
        description: rule.description ?? undefined,
        priority: rule.priority,
        target: rule.target,
        severity: rule.severity,
        scope: 'org',
        tags: rule.tags as string[],
        suppressNotification: rule.suppressNotification,
        field: rule.field ?? undefined,
        operator: rule.operator ?? undefined,
        value: rule.value ?? undefined,
        conditions: rule.conditions ?? undefined,
        conditionMode: rule.conditionMode ?? undefined,
        createdBy: userId,
        updatedBy: userId,
      } as unknown as Parameters<typeof complianceRuleService.create>[0], userId);
    }

    return cloned;
  }
}

export const compliancePolicyService = new CompliancePolicyService();
