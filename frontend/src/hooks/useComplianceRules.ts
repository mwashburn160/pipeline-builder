/**
 * Hook for managing compliance rules — CRUD operations with loading/error states.
 */
import { useMemo } from 'react';
import api from '@/lib/api';
import { useCrudResource } from './useCrudResource';
import type { ComplianceRule, ComplianceRuleCreate, ComplianceRuleUpdate, RuleTarget, RuleSeverity } from '@/types/compliance';

type RuleParams = { target?: RuleTarget; severity?: RuleSeverity; policyId?: string; limit?: number; offset?: number };

export function useComplianceRules() {
  const crudApi = useMemo(() => ({
    list: async (params?: RuleParams) => {
      const res = await api.getComplianceRules(params);
      return { success: res.success, data: res.data ? { items: res.data.rules, pagination: res.data.pagination } : undefined };
    },
    create: async (data: ComplianceRuleCreate) => {
      const res = await api.createComplianceRule(data);
      return { success: res.success, data: res.data ? { item: res.data.rule } : undefined };
    },
    update: async (id: string, data: ComplianceRuleUpdate) => {
      const res = await api.updateComplianceRule(id, data);
      return { success: res.success, data: res.data ? { item: res.data.rule } : undefined };
    },
    delete: (id: string) => api.deleteComplianceRule(id),
  }), []);

  const { items: rules, loading, error, total, fetch: fetchRules, create: createRule, update: updateRule, remove: deleteRule } = useCrudResource<ComplianceRule, ComplianceRuleCreate, ComplianceRuleUpdate, RuleParams>(crudApi, 'compliance rules');

  return { rules, loading, error, total, fetchRules, createRule, updateRule, deleteRule };
}
