// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  CrudService,
  buildCompliancePolicyConditions,
  schema,
  type CompliancePolicyFilter,
} from '@mwashburn160/pipeline-core';
import { SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

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

  /** Clone a template policy and its rules into a target org. */
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

    return cloned;
  }
}

export const compliancePolicyService = new CompliancePolicyService();
