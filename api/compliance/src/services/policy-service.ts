// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConflictError } from '@pipeline-builder/api-core';
import { CrudService, buildCompliancePolicyConditions, schema, withTenantTx, type CompliancePolicyFilter } from '@pipeline-builder/pipeline-data';
import { SQL, and, eq, inArray } from 'drizzle-orm';
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
    // Own keys only: `sortBy` is client input, and a plain lookup walks the
    // prototype (`?sortBy=constructor` returned a function, not a column).
    return Object.hasOwn(cols, sortBy) ? cols[sortBy] : null;
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

  /**
   * Create a policy and link the org's existing rules (by name) to it in ONE
   * transaction. The route previously wrapped `this.create(...)` in an outer
   * `withTenantTx`, but `create` opens its OWN transaction (withTenantTx does not
   * nest), so the policy row committed independently and a failure in the
   * rule-link UPDATE left a policy with no rules. Both statements now run on the
   * same `tx`. Like `CrudService.create`, it never overwrites: a live or deleted
   * policy with the same org/name/version is a 409 (restore brings a deleted one
   * back), and the rollback means no rules are re-linked either.
   */
  async createWithRules(data: CompliancePolicyInsert, ruleNames: string[] | undefined, userId: string): Promise<CompliancePolicy> {
    const safeData = this.enforceOrgId(data, /* isCreate */ true);
    const actor = userId || 'system';
    return withTenantTx(async (tx) => {
      const [created] = await tx
        .insert(schema.compliancePolicy)
        .values({ ...safeData, createdBy: actor, updatedBy: actor })
        .onConflictDoNothing({
          target: [schema.compliancePolicy.orgId, schema.compliancePolicy.name, schema.compliancePolicy.version],
        })
        .returning();
      if (!created) {
        throw new ConflictError(`A policy named "${safeData.name}" (version ${safeData.version ?? '1.0.0'}) already exists. If it was deleted, restore it instead.`);
      }

      // Link existing rules by name in a single batched UPDATE on the same tx.
      if (ruleNames && ruleNames.length > 0) {
        await tx
          .update(schema.complianceRule)
          .set({ policyId: created.id, updatedBy: actor, updatedAt: new Date() })
          .where(and(
            eq(schema.complianceRule.orgId, created.orgId),
            inArray(schema.complianceRule.name, ruleNames),
          ));
      }
      return created as CompliancePolicy;
    });
  }
}

export const compliancePolicyService = new CompliancePolicyService();
